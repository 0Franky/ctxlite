/**
 * End-to-end tests for the registry-backed compaction persistence.
 *
 * These tests verify the full path:
 *   ctxlite_compact (via plugin tool) → writes to registry on disk
 *   transform hook (next turn)        → reads registry, mutates payload
 *   re-run                              → idempotent (no double-compaction)
 *
 * They use the real opencode SDK types (Part, ToolPart, Message) to make
 * sure the contract is verified against the actual SDK shape, not a
 * private mock. Same approach as smoke-integration.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import type { Hooks } from "@opencode-ai/plugin"
import type { AssistantMessage, Message, Part, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk"

import plugin from "../src/index.ts"
import { addToRegistry, loadRegistry, saveRegistry, type RegistryV1 } from "../src/registry.ts"

let tmpDir: string
let registryPath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "ctxlite-persist-test-"))
  registryPath = path.join(tmpDir, "compactions.json")
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// --- Builders ---------------------------------------------------------------

let nextId = 0
function id(prefix: string): string {
  return `${prefix}_${++nextId}`
}

interface ToolPartSpec {
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly output: string
  readonly compacted?: boolean
}

function buildToolPart(spec: ToolPartSpec, sessionID: string, messageID: string): ToolPart {
  const state: ToolStateCompleted = {
    status: "completed",
    input: spec.input,
    output: spec.output,
    title: spec.tool,
    metadata: {},
    time: spec.compacted ? { start: 0, end: 1, compacted: 1 } : { start: 0, end: 1 },
  }
  return {
    id: id("part"),
    sessionID,
    messageID,
    type: "tool",
    callID: id("call"),
    tool: spec.tool,
    state,
  }
}

function buildMessage(
  sessionID: string,
  parts: ReadonlyArray<ToolPartSpec>,
): { info: Message; parts: Part[] } {
  const messageID = id("msg")
  const info: AssistantMessage = {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID: "",
    cost: 0,
    path: { cwd: "", root: "" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test",
    providerID: "test",
    mode: "build",
  }
  return { info, parts: parts.map((p) => buildToolPart(p, sessionID, messageID)) }
}

async function loadHook(
  options: Record<string, unknown>,
): Promise<NonNullable<Hooks["experimental.chat.messages.transform"]>> {
  const hooks = await plugin.server(
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: undefined as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      project: undefined as any,
      directory: process.cwd(),
      worktree: process.cwd(),
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:0"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      $: undefined as any,
    },
    options,
  )
  const hook = hooks["experimental.chat.messages.transform"]
  if (!hook) throw new Error("transform hook not registered")
  return hook
}

function partOf(messages: ReadonlyArray<{ parts: ReadonlyArray<Part> }>, partId: string): ToolPart | undefined {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "tool" && (p as unknown as { id: string }).id === partId) return p
    }
  }
  return undefined
}

// --- Tests ------------------------------------------------------------------

describe("registry replay — desktop and web both fall through this path", () => {
  test("entry in registry → transform marks the matching part compacted", async () => {
    const sid = "sess_replay_1"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/b.ts" }, output: "v2" }]),
    ]
    const targetId = (messages[0].parts[0] as ToolPart & { id: string }).id

    const reg: RegistryV1 = { version: 1, sessions: {} }
    addToRegistry(reg, sid, [targetId])
    await saveRegistry(registryPath, reg)

    const hook = await loadHook({ registryPath, logLevel: "silent" })
    await hook({}, { messages })

    const target = partOf(messages, targetId)
    expect((target?.state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)

    // The other part must remain live.
    const other = messages[1].parts[0] as ToolPart
    expect((other.state as ToolStateCompleted).time.compacted).toBeUndefined()
  })

  test("replay is unaffected by minMessagesForActivation (warm-up gate doesn't apply)", async () => {
    // Even with a high warm-up gate, registry-driven compactions go through.
    const sid = "sess_replay_warmup"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/x.ts" }, output: "small" }]),
    ]
    const targetId = (messages[0].parts[0] as ToolPart & { id: string }).id

    const reg: RegistryV1 = { version: 1, sessions: {} }
    addToRegistry(reg, sid, [targetId])
    await saveRegistry(registryPath, reg)

    const hook = await loadHook({
      registryPath,
      minMessagesForActivation: 100,
      logLevel: "silent",
    })
    await hook({}, { messages })

    const target = partOf(messages, targetId)
    expect((target?.state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)
  })

  test("replay is unaffected by preserveOldestMessages", async () => {
    // Even with the oldest messages "protected", explicit user compactions apply.
    const sid = "sess_replay_oldest"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/y.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/z.ts" }, output: "v2" }]),
    ]
    const targetId = (messages[0].parts[0] as ToolPart & { id: string }).id

    const reg: RegistryV1 = { version: 1, sessions: {} }
    addToRegistry(reg, sid, [targetId])
    await saveRegistry(registryPath, reg)

    const hook = await loadHook({
      registryPath,
      preserveOldestMessages: 5,
      logLevel: "silent",
    })
    await hook({}, { messages })

    const target = partOf(messages, targetId)
    expect((target?.state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)
  })

  test("registry entry for a different sessionID is ignored", async () => {
    const sid = "sess_replay_iso_real"
    const otherSid = "sess_other"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
    ]
    const targetId = (messages[0].parts[0] as ToolPart & { id: string }).id

    const reg: RegistryV1 = { version: 1, sessions: {} }
    addToRegistry(reg, otherSid, [targetId]) // wrong session
    await saveRegistry(registryPath, reg)

    const hook = await loadHook({ registryPath, logLevel: "silent" })
    await hook({}, { messages })

    const target = partOf(messages, targetId)
    expect((target?.state as ToolStateCompleted).time.compacted).toBeUndefined()
  })

  test("idempotent: replaying the same registry twice does not double-mutate", async () => {
    const sid = "sess_replay_idemp"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
    ]
    const targetId = (messages[0].parts[0] as ToolPart & { id: string }).id

    const reg: RegistryV1 = { version: 1, sessions: {} }
    addToRegistry(reg, sid, [targetId])
    await saveRegistry(registryPath, reg)

    const hook = await loadHook({ registryPath, logLevel: "silent" })

    await hook({}, { messages })
    const ts1 = (partOf(messages, targetId)?.state as ToolStateCompleted).time.compacted
    await hook({}, { messages })
    const ts2 = (partOf(messages, targetId)?.state as ToolStateCompleted).time.compacted

    // Second replay must NOT update the timestamp (already compacted).
    expect(ts2).toBe(ts1)
  })

  test("missing registry file → no-op, hook still works for normal invalidation", async () => {
    const sid = "sess_replay_no_reg"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/a.ts", oldString: "X", newString: "Y" }, output: "diff" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v2" }]),
    ]
    // Use a path that doesn't exist; loadRegistry returns empty on miss.
    const hook = await loadHook({
      registryPath: path.join(tmpDir, "never-created.json"),
      logLevel: "silent",
    })
    await hook({}, { messages })

    // Normal Layer A/B kicked in: first read superseded by the edit.
    const firstRead = messages[0].parts[0] as ToolPart
    expect((firstRead.state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)
  })

  test("corrupted registry → no-op, hook still works (fail-open)", async () => {
    const sid = "sess_replay_corrupt"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
    ]
    // Write garbage to the registry file.
    const fs = await import("node:fs/promises")
    await fs.writeFile(registryPath, "{{{ not json", "utf8")

    const hook = await loadHook({ registryPath, logLevel: "silent" })
    // Must not throw.
    await hook({}, { messages })

    const target = messages[0].parts[0] as ToolPart
    expect((target.state as ToolStateCompleted).time.compacted).toBeUndefined()
  })

  test("registry replay survives a 'restart': second loadHook reads the same file", async () => {
    // Simulates desktop restart: a new opencode process / new plugin instance
    // reads the same registry file and applies the pending compactions.
    const sid = "sess_replay_restart"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
    ]
    const targetId = (messages[0].parts[0] as ToolPart & { id: string }).id

    // Pretend the previous session wrote to the registry, then exited.
    const reg: RegistryV1 = { version: 1, sessions: {} }
    addToRegistry(reg, sid, [targetId])
    await saveRegistry(registryPath, reg)

    // New plugin instance loaded fresh.
    const hook = await loadHook({ registryPath, logLevel: "silent" })
    await hook({}, { messages })

    const target = partOf(messages, targetId)
    expect((target?.state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)

    // The on-disk registry is unchanged by the replay (read-only operation
    // for the transform hook).
    const onDisk = JSON.parse(await readFile(registryPath, "utf8"))
    expect(onDisk.sessions[sid].partIds).toContain(targetId)
  })
})
