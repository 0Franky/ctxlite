/**
 * Exhaustive tests for the cache-friendly knobs:
 *   - preserveOldestMessages: protect the first N messages from any mutation
 *   - minMessagesForActivation: hook is a no-op until N messages exist
 *
 * Both knobs exist to keep the Anthropic prompt cache hot. The cache is
 * byte-identical-prefix: mutating any past tool_result invalidates every
 * cache breakpoint after that point. These tests verify that the protected
 * region stays byte-stable across re-invocations and across realistic
 * read+edit patterns.
 */

import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import type { AssistantMessage, Message, Part, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk"

import plugin from "../src/index.ts"

// --- Builders ----------------------------------------------------------------

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

function buildMessage(sessionID: string, parts: ReadonlyArray<ToolPartSpec>): { info: Message; parts: Part[] } {
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
  options: Record<string, unknown> = { logLevel: "silent" },
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
  if (!hook) throw new Error("hook not registered")
  return hook
}

/** Snapshot the `compacted` field of every completed tool part, indexed by callID. */
function snapshotCompacted(messages: ReadonlyArray<{ parts: ReadonlyArray<Part> }>): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>()
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "tool" && p.state.status === "completed") {
        out.set(p.callID, p.state.time.compacted)
      }
    }
  }
  return out
}

// --- Test scenarios ----------------------------------------------------------

describe("preserveOldestMessages — protected prefix invariant", () => {
  test("default 0: behaves identically to no-option (sanity baseline)", async () => {
    const sid = "p1"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/a.ts", oldString: "X", newString: "Y" }, output: "diff" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v2" }]),
    ]
    const hook = await loadHook()
    await hook({}, { messages })
    // First read invalidated by the edit in message 1.
    expect((messages[0].parts[0] as ToolPart).state.status === "completed" ? (messages[0].parts[0] as ToolPart).state.time.compacted : 0).toBeGreaterThan(0)
  })

  test("preserveOldestMessages = full length: complete no-op even when invalidations would apply", async () => {
    const sid = "p2"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/a.ts", oldString: "X", newString: "Y" }, output: "diff" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v2" }]),
    ]
    const hook = await loadHook({ preserveOldestMessages: 3, logLevel: "silent" })
    const before = snapshotCompacted(messages)
    await hook({}, { messages })
    const after = snapshotCompacted(messages)
    expect(after).toEqual(before)
  })

  test("preserveOldestMessages > length: clamped, behaves as full-length no-op", async () => {
    const sid = "p3"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/a.ts", oldString: "X", newString: "Y" }, output: "diff" }]),
    ]
    const hook = await loadHook({ preserveOldestMessages: 999, logLevel: "silent" })
    await hook({}, { messages })
    for (const m of messages) {
      for (const p of m.parts) {
        if (p.type === "tool" && p.state.status === "completed") {
          expect(p.state.time.compacted).toBeUndefined()
        }
      }
    }
  })

  test("read in protected zone is not invalidated by edit outside zone", async () => {
    // Realistic cache-friendly scenario: protect bootstrap, allow pruning later.
    const sid = "p4"
    const protectedRead = { tool: "read", input: { filePath: "/cfg.json" }, output: "{ initial }" }
    const lateEdit = { tool: "edit", input: { filePath: "/cfg.json", oldString: "X", newString: "Y" }, output: "diff" }
    const messages = [
      buildMessage(sid, [protectedRead]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/other.ts" }, output: "..." }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/other2.ts" }, output: "..." }]),
      buildMessage(sid, [lateEdit]),
    ]
    const protectedCallID = (messages[0].parts[0] as ToolPart).callID
    const hook = await loadHook({ preserveOldestMessages: 2, logLevel: "silent" })
    await hook({}, { messages })
    const protectedPart = messages[0].parts[0] as ToolPart
    expect(protectedPart.callID).toBe(protectedCallID)
    expect((protectedPart.state as ToolStateCompleted).time.compacted).toBeUndefined()
  })

  test("edit OUTSIDE protected zone still invalidates read OUTSIDE protected zone", async () => {
    // The protection must only apply to messages within the bound, not weaken
    // the analyzer for the rest of the conversation.
    const sid = "p5"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/b.ts" }, output: "vb1" }]),
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/b.ts", oldString: "X", newString: "Y" }, output: "diff" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/b.ts" }, output: "vb2" }]),
    ]
    const protectedReadCallID = (messages[0].parts[0] as ToolPart).callID
    const targetReadCallID = (messages[1].parts[0] as ToolPart).callID

    const hook = await loadHook({ preserveOldestMessages: 1, logLevel: "silent" })
    await hook({}, { messages })

    // /a.ts read is in the protected zone — must remain live.
    const protectedRead = messages[0].parts[0] as ToolPart
    expect(protectedRead.callID).toBe(protectedReadCallID)
    expect((protectedRead.state as ToolStateCompleted).time.compacted).toBeUndefined()

    // /b.ts first read is OUTSIDE protection — must be invalidated by the edit.
    const targetRead = messages[1].parts[0] as ToolPart
    expect(targetRead.callID).toBe(targetReadCallID)
    expect((targetRead.state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)
  })

  test("preserveOldest + preserveRecent overlapping: empty window, full no-op", async () => {
    const sid = "p6"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/a.ts", oldString: "X", newString: "Y" }, output: "diff" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v2" }]),
    ]
    // Oldest=2 + Recent=2 → window is [2, max(2, 1)) = [2, 2) = empty.
    const hook = await loadHook({
      preserveOldestMessages: 2,
      preserveRecentMessages: 2,
      logLevel: "silent",
    })
    await hook({}, { messages })
    for (const m of messages) {
      for (const p of m.parts) {
        if (p.type === "tool" && p.state.status === "completed") {
          expect(p.state.time.compacted).toBeUndefined()
        }
      }
    }
  })

  test("partial overlap: small valid window still produces decisions inside it", async () => {
    const sid = "p7"
    // 5 messages with a read+edit pair inside the unprotected window.
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/x.ts" }, output: "old" }]), // 0 protected
      buildMessage(sid, [{ tool: "read", input: { filePath: "/y.ts" }, output: "y1" }]), // 1 in window
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/y.ts", oldString: "a", newString: "b" }, output: "diff" }]), // 2 in window
      buildMessage(sid, [{ tool: "read", input: { filePath: "/y.ts" }, output: "y2" }]), // 3 protected by recent
      buildMessage(sid, [{ tool: "read", input: { filePath: "/z.ts" }, output: "z1" }]), // 4 protected by recent
    ]
    const hook = await loadHook({
      preserveOldestMessages: 1,
      preserveRecentMessages: 2,
      logLevel: "silent",
    })
    await hook({}, { messages })

    // Message 0: protected oldest — untouched.
    expect((messages[0].parts[0] as ToolPart).state.status === "completed" && (messages[0].parts[0] as ToolPart).state.time.compacted).toBeFalsy()

    // Message 1: read /y.ts — invalidated by edit at message 2 (both in window).
    expect(((messages[1].parts[0] as ToolPart).state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)

    // Message 3, 4: protected recent — untouched even though the edit at 2 would also affect /y.ts read at 3.
    expect(((messages[3].parts[0] as ToolPart).state as ToolStateCompleted).time.compacted).toBeUndefined()
    expect(((messages[4].parts[0] as ToolPart).state as ToolStateCompleted).time.compacted).toBeUndefined()
  })

  test("idempotent under preserveOldestMessages: protected prefix is byte-stable across re-runs", async () => {
    // The whole point: cache prefix must not shift between turns.
    const sid = "p8"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/b.ts" }, output: "vb1" }]),
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/b.ts", oldString: "X", newString: "Y" }, output: "diff" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/b.ts" }, output: "vb2" }]),
    ]

    const hook = await loadHook({ preserveOldestMessages: 1, logLevel: "silent" })
    await hook({}, { messages })
    const snap1 = snapshotCompacted(messages)
    await hook({}, { messages })
    const snap2 = snapshotCompacted(messages)
    await hook({}, { messages })
    const snap3 = snapshotCompacted(messages)

    expect(snap2).toEqual(snap1)
    expect(snap3).toEqual(snap1)
  })

  test("non-integer / negative input is coerced to 0", async () => {
    const sid = "p9"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/a.ts", oldString: "X", newString: "Y" }, output: "diff" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v2" }]),
    ]
    // Invalid inputs should fall back to 0 (no protection).
    const hook = await loadHook({
      preserveOldestMessages: -5 as unknown as number,
      preserveRecentMessages: "ten" as unknown as number,
      minMessagesForActivation: NaN as unknown as number,
      logLevel: "silent",
    })
    await hook({}, { messages })
    expect(((messages[0].parts[0] as ToolPart).state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)
  })
})

describe("minMessagesForActivation — warm-up gate", () => {
  test("below threshold: hook is a complete no-op", async () => {
    const sid = "m1"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/a.ts", oldString: "X", newString: "Y" }, output: "diff" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v2" }]),
    ]
    const hook = await loadHook({ minMessagesForActivation: 10, logLevel: "silent" })
    const before = snapshotCompacted(messages)
    await hook({}, { messages })
    const after = snapshotCompacted(messages)
    expect(after).toEqual(before)
  })

  test("at exact threshold: hook activates", async () => {
    const sid = "m2"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/a.ts", oldString: "X", newString: "Y" }, output: "diff" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v2" }]),
    ]
    const hook = await loadHook({ minMessagesForActivation: 3, logLevel: "silent" })
    await hook({}, { messages })
    expect(((messages[0].parts[0] as ToolPart).state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)
  })

  test("above threshold: hook activates fully", async () => {
    const sid = "m3"
    const messages = Array.from({ length: 6 }, (_, i) =>
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: `v${i}` }]),
    )
    const hook = await loadHook({ minMessagesForActivation: 4, logLevel: "silent" })
    await hook({}, { messages })

    // Six reads of the same file with no offset/limit → all but the last are duplicate-read.
    const compactedCount = messages.filter((m) =>
      m.parts.some(
        (p) => p.type === "tool" && p.state.status === "completed" && (p.state as ToolStateCompleted).time.compacted,
      ),
    ).length
    expect(compactedCount).toBe(5)
  })

  test("default 0: always active", async () => {
    const sid = "m4"
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/a.ts" }, output: "v2" }]),
    ]
    const hook = await loadHook({ logLevel: "silent" })
    await hook({}, { messages })
    expect(((messages[0].parts[0] as ToolPart).state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)
  })

  test("warm-up + protect oldest: realistic 'don't fight the cache' configuration", async () => {
    const sid = "m5"
    // Realistic 8-turn session: bootstrap reads + later edit/read pattern.
    const messages = [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/cfg.json" }, output: "{boot}" }]), // 0
      buildMessage(sid, [{ tool: "read", input: { filePath: "/agents.md" }, output: "agents..." }]), // 1
      buildMessage(sid, [{ tool: "read", input: { filePath: "/plan.md" }, output: "plan..." }]), // 2
      buildMessage(sid, [{ tool: "read", input: { filePath: "/feature.ts" }, output: "code v1" }]), // 3
      buildMessage(sid, [{ tool: "read", input: { filePath: "/feature.ts" }, output: "code v1" }]), // 4 dup of 3
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/feature.ts", oldString: "X", newString: "Y" }, output: "diff" }]), // 5
      buildMessage(sid, [{ tool: "read", input: { filePath: "/feature.ts" }, output: "code v2" }]), // 6
      buildMessage(sid, [{ tool: "read", input: { filePath: "/feature.ts" }, output: "code v2" }]), // 7
    ]

    const hook = await loadHook({
      preserveOldestMessages: 3,
      minMessagesForActivation: 6,
      logLevel: "silent",
    })
    await hook({}, { messages })

    // Messages 0-2: protected. Untouched.
    for (let i = 0; i < 3; i++) {
      expect(((messages[i].parts[0] as ToolPart).state as ToolStateCompleted).time.compacted).toBeUndefined()
    }
    // Message 3: outside protected, BUT also outside the analyzer window only IF we
    // had asymmetric behavior. preserveOldest=3 → walk starts at idx 3. The read at 3 is the
    // FIRST view in the walk. The duplicate read at 4 should mark 3 as duplicate-read.
    expect(((messages[3].parts[0] as ToolPart).state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)
    // Message 4: itself live until message 5's edit invalidates it.
    expect(((messages[4].parts[0] as ToolPart).state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)
    // Message 6 is invalidated by the duplicate read at 7.
    expect(((messages[6].parts[0] as ToolPart).state as ToolStateCompleted).time.compacted).toBeGreaterThan(0)
    // Message 7 (most recent live) survives.
    expect(((messages[7].parts[0] as ToolPart).state as ToolStateCompleted).time.compacted).toBeUndefined()
  })
})

describe("interaction matrix — sanity grid", () => {
  // Same 4-message pattern; vary only the knobs.
  function makeMessages(): Array<{ info: Message; parts: Part[] }> {
    const sid = "grid"
    return [
      buildMessage(sid, [{ tool: "read", input: { filePath: "/g.ts" }, output: "v1" }]),
      buildMessage(sid, [{ tool: "edit", input: { filePath: "/g.ts", oldString: "a", newString: "b" }, output: "diff" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/g.ts" }, output: "v2" }]),
      buildMessage(sid, [{ tool: "read", input: { filePath: "/g.ts" }, output: "v2" }]),
    ]
  }

  // Each entry: knobs + expected number of compacted parts on the 4-message base.
  const cases: Array<{ name: string; opts: Record<string, unknown>; expected: number }> = [
    { name: "no knobs", opts: {}, expected: 2 }, // read@0 (edit-supersedes), read@2 (duplicate)
    { name: "preserveOldest=1", opts: { preserveOldestMessages: 1 }, expected: 1 }, // read@0 protected
    { name: "preserveOldest=2", opts: { preserveOldestMessages: 2 }, expected: 1 }, // read@0 protected, read@2 still dup with read@3
    { name: "preserveOldest=3", opts: { preserveOldestMessages: 3 }, expected: 0 }, // only msg 3 in window, nothing to compare
    { name: "preserveRecent=1", opts: { preserveRecentMessages: 1 }, expected: 1 }, // read@3 protected, read@2 still invalidated by edit
    { name: "preserveRecent=2", opts: { preserveRecentMessages: 2 }, expected: 1 }, // read@2,3 protected, read@0 still invalidated by edit@1
    { name: "minActivation=5", opts: { minMessagesForActivation: 5 }, expected: 0 }, // below threshold, no-op
    { name: "minActivation=4", opts: { minMessagesForActivation: 4 }, expected: 2 }, // exactly threshold
  ]

  for (const c of cases) {
    test(c.name, async () => {
      const messages = makeMessages()
      const hook = await loadHook({ ...c.opts, logLevel: "silent" })
      await hook({}, { messages })
      const compacted = messages
        .flatMap((m) => m.parts)
        .filter(
          (p) =>
            p.type === "tool" &&
            p.state.status === "completed" &&
            typeof (p.state as ToolStateCompleted).time.compacted === "number" &&
            ((p.state as ToolStateCompleted).time.compacted as number) > 0,
        ).length
      expect(compacted).toBe(c.expected)
    })
  }
})
