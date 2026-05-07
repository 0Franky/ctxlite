/**
 * Integration smoke test: assembles a realistic message tree using the
 * REAL `@opencode-ai/sdk` types (Part, ToolPart, ToolStateCompleted), invokes
 * the plugin's exported `server()` factory exactly as opencode would, then
 * asserts that the live message tree was mutated correctly.
 *
 * This is the "wiring" test — pure logic is covered by the unit tests; here
 * we verify that the plugin's hook payload contract (Part union type guards,
 * mutation of `state.time.compacted`, idempotency on the live tree) is
 * compatible with the SDK shapes opencode actually emits.
 */

import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import type { AssistantMessage, Message, Part, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk"

import plugin from "../src/index.ts"

// --- Builders for SDK-shaped values ---------------------------------------

let nextId = 0
function id(prefix: string): string {
  return `${prefix}_${++nextId}`
}

interface BuildToolPartArgs {
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly output: string
  readonly compacted?: boolean
  readonly sessionID: string
  readonly messageID: string
}

function buildToolPart(args: BuildToolPartArgs): ToolPart {
  const state: ToolStateCompleted = {
    status: "completed",
    input: args.input,
    output: args.output,
    title: args.tool,
    metadata: {},
    time: args.compacted ? { start: 0, end: 1, compacted: 1 } : { start: 0, end: 1 },
  }
  return {
    id: id("part"),
    sessionID: args.sessionID,
    messageID: args.messageID,
    type: "tool",
    callID: id("call"),
    tool: args.tool,
    state,
  }
}

interface BuildAssistantMessageArgs {
  readonly sessionID: string
  readonly parts: ReadonlyArray<{ readonly tool: string; readonly input: Record<string, unknown>; readonly output: string; readonly compacted?: boolean }>
}

function buildAssistantMessage(args: BuildAssistantMessageArgs): { info: Message; parts: Part[] } {
  const messageID = id("msg")
  const info: AssistantMessage = {
    id: messageID,
    sessionID: args.sessionID,
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
  const parts: Part[] = args.parts.map((p) =>
    buildToolPart({
      tool: p.tool,
      input: p.input,
      output: p.output,
      ...(p.compacted !== undefined ? { compacted: p.compacted } : {}),
      sessionID: args.sessionID,
      messageID,
    }),
  )
  return { info, parts }
}

/**
 * Convenience: load the plugin with given options and return the bound
 * messages-transform hook ready to call.
 */
async function loadHook(
  options: Record<string, unknown> = { logLevel: "silent" },
): Promise<NonNullable<Hooks["experimental.chat.messages.transform"]>> {
  const hooks = await plugin.server(
    {
      // Minimal PluginInput stub — the plugin doesn't read these fields.
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
  if (!hook) throw new Error("plugin did not register the expected hook")
  return hook
}

/** Find a part by callID inside a message tree. */
function findPart(messages: ReadonlyArray<{ parts: ReadonlyArray<Part> }>, callID: string): ToolPart | undefined {
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.callID === callID) return part
    }
  }
  return undefined
}

// --- The actual smoke tests ----------------------------------------------

describe("smoke: end-to-end plugin invocation against real SDK types", () => {
  test("Read → Edit → Read sequence: first Read gets compacted on the live tree", async () => {
    const sessionID = "sess_smoke_1"
    const m1 = buildAssistantMessage({
      sessionID,
      parts: [{ tool: "read", input: { filePath: "/tmp/auth.ts" }, output: "<file content v1>" }],
    })
    const m2 = buildAssistantMessage({
      sessionID,
      parts: [{ tool: "edit", input: { filePath: "/tmp/auth.ts", oldString: "X", newString: "Y" }, output: "diff" }],
    })
    const m3 = buildAssistantMessage({
      sessionID,
      parts: [{ tool: "read", input: { filePath: "/tmp/auth.ts" }, output: "<file content v2>" }],
    })

    const r1CallID = (m1.parts[0] as ToolPart).callID
    const e1CallID = (m2.parts[0] as ToolPart).callID
    const r2CallID = (m3.parts[0] as ToolPart).callID

    const messages = [m1, m2, m3]
    const hook = await loadHook()
    await hook({}, { messages })

    // First Read must be compacted.
    const r1 = findPart(messages, r1CallID)
    expect(r1?.state.status).toBe("completed")
    expect((r1?.state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)

    // The Edit (the prior Read got invalidated by it) must remain live —
    // its content is the diff, still useful to the model.
    const e1 = findPart(messages, e1CallID)
    expect((e1?.state as ToolStateCompleted).time.compacted).toBeUndefined()

    // The current (most recent) Read must remain live.
    const r2 = findPart(messages, r2CallID)
    expect((r2?.state as ToolStateCompleted).time.compacted).toBeUndefined()
  })

  test("idempotent: second invocation produces no further mutation", async () => {
    const sessionID = "sess_smoke_2"
    const messages = [
      buildAssistantMessage({
        sessionID,
        parts: [{ tool: "read", input: { filePath: "/tmp/x.ts" }, output: "v1" }],
      }),
      buildAssistantMessage({
        sessionID,
        parts: [{ tool: "edit", input: { filePath: "/tmp/x.ts", oldString: "a", newString: "b" }, output: "diff" }],
      }),
      buildAssistantMessage({
        sessionID,
        parts: [{ tool: "read", input: { filePath: "/tmp/x.ts" }, output: "v2" }],
      }),
    ]
    const hook = await loadHook()

    await hook({}, { messages })
    const firstPassCompactedTimestamps = messages.flatMap((m) =>
      m.parts.flatMap((p) => (p.type === "tool" && p.state.status === "completed" ? [p.state.time.compacted ?? 0] : [])),
    )

    // Run again on the same tree.
    await hook({}, { messages })
    const secondPassCompactedTimestamps = messages.flatMap((m) =>
      m.parts.flatMap((p) => (p.type === "tool" && p.state.status === "completed" ? [p.state.time.compacted ?? 0] : [])),
    )

    expect(secondPassCompactedTimestamps).toEqual(firstPassCompactedTimestamps)
  })

  test("untracked tool name does not get mutated even if filePath argshape matches", async () => {
    const sessionID = "sess_smoke_3"
    const messages = [
      buildAssistantMessage({
        sessionID,
        parts: [{ tool: "custom_reader", input: { filePath: "/tmp/x.ts" }, output: "v1" }],
      }),
      buildAssistantMessage({
        sessionID,
        parts: [{ tool: "custom_reader", input: { filePath: "/tmp/x.ts" }, output: "v2" }],
      }),
    ]

    const hook = await loadHook({ tools: ["read", "edit"], logLevel: "silent" })
    await hook({}, { messages })

    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeUndefined()
        }
      }
    }
  })

  test("fail-open: malformed input does not throw; tree is unchanged", async () => {
    const hook = await loadHook()

    // Pass a structurally invalid `output` shape — the hook must catch.
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hook({}, { messages: null as any }),
    ).resolves.toBeUndefined()
  })

  test("preserveOldestMessages: parts in the protected oldest window are never compacted", async () => {
    const sessionID = "sess_smoke_oldest"
    const messages = [
      buildAssistantMessage({
        sessionID,
        parts: [{ tool: "read", input: { filePath: "/tmp/k.ts" }, output: "v1" }],
      }),
      buildAssistantMessage({
        sessionID,
        parts: [{ tool: "edit", input: { filePath: "/tmp/k.ts", oldString: "X", newString: "Y" }, output: "diff" }],
      }),
      buildAssistantMessage({
        sessionID,
        parts: [{ tool: "read", input: { filePath: "/tmp/k.ts" }, output: "v2" }],
      }),
    ]

    const r1CallID = (messages[0].parts[0] as ToolPart).callID
    const e1CallID = (messages[1].parts[0] as ToolPart).callID

    // Protect the first 2 messages: the read+edit pair must stay live even
    // though the read would normally be invalidated.
    const hook = await loadHook({ preserveOldestMessages: 2, logLevel: "silent" })
    await hook({}, { messages })

    const r1 = findPart(messages, r1CallID)
    const e1 = findPart(messages, e1CallID)
    expect((r1?.state as ToolStateCompleted).time.compacted).toBeUndefined()
    expect((e1?.state as ToolStateCompleted).time.compacted).toBeUndefined()
  })

  test("minMessagesForActivation: hook is a no-op below threshold", async () => {
    const sessionID = "sess_smoke_min"
    const messages = [
      buildAssistantMessage({
        sessionID,
        parts: [{ tool: "read", input: { filePath: "/tmp/m.ts" }, output: "v1" }],
      }),
      buildAssistantMessage({
        sessionID,
        parts: [{ tool: "edit", input: { filePath: "/tmp/m.ts", oldString: "X", newString: "Y" }, output: "diff" }],
      }),
    ]

    const hook = await loadHook({ minMessagesForActivation: 5, logLevel: "silent" })
    await hook({}, { messages })

    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeUndefined()
        }
      }
    }
  })

  test("non-completed parts (running tool calls) are ignored", async () => {
    const sessionID = "sess_smoke_5"
    const m1 = buildAssistantMessage({
      sessionID,
      parts: [{ tool: "read", input: { filePath: "/tmp/y.ts" }, output: "v1" }],
    })

    // Manually build a "running" part — should be ignored entirely.
    const runningPart: ToolPart = {
      id: id("part"),
      sessionID,
      messageID: m1.info.id,
      type: "tool",
      callID: id("call"),
      tool: "read",
      state: {
        status: "running",
        input: { filePath: "/tmp/y.ts" },
        time: { start: 0 },
      },
    }
    const m2: { info: Message; parts: Part[] } = {
      info: m1.info,
      parts: [runningPart],
    }

    const m3 = buildAssistantMessage({
      sessionID,
      parts: [{ tool: "read", input: { filePath: "/tmp/y.ts" }, output: "v2" }],
    })

    const r1CallID = (m1.parts[0] as ToolPart).callID
    const messages = [m1, m2, m3]

    const hook = await loadHook()
    await hook({}, { messages })

    // First Read should be compacted as duplicate of Read in m3
    // (the running part is ignored entirely so no Edit signal).
    const r1 = findPart(messages, r1CallID)
    expect((r1?.state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)

    // Running part untouched.
    expect(runningPart.state.status).toBe("running")
  })
})
