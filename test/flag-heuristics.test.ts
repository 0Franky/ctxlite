/**
 * Layer C: focused tests for the 5 heuristic flag functions.
 * Tests one non-trivial case per flag; trivial getters and passthroughs skipped.
 */

import { describe, expect, test } from "bun:test"
import type { FlatPart } from "../src/dump/flag-heuristics.ts"
import {
  flagDeadReasoning,
  flagLargeError,
  flagSupersededToolResult,
} from "../src/dump/flag-heuristics.ts"
import type { ResolvedOptions } from "../src/types.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePart(overrides: Partial<FlatPart> & { partId: string; type: FlatPart["type"] }): FlatPart {
  const base: FlatPart = {
    messageIdx: 0,
    partIdx: 0,
    alreadyCompacted: false,
    eligible: true,
    ...overrides,
  }
  return base
}

const RESOLVED_OPTS: ResolvedOptions = {
  tools: new Set(["read", "edit", "write", "bash"]),
  logLevel: "silent",
  preserveRecentMessages: 0,
}

// ---------------------------------------------------------------------------
// dead-reasoning
// ---------------------------------------------------------------------------

describe("flagDeadReasoning", () => {
  test("flags reasoning part when no productive tool call in next 10 messages", () => {
    // Reasoning at messageIdx=0; no productive tool calls anywhere in the list.
    const parts: FlatPart[] = [
      makePart({ partId: "reason-1", type: "reasoning", messageIdx: 0, text: "long plan" }),
      // A tool at messageIdx=12 is beyond the 10-message window.
      makePart({
        partId: "tool-1",
        type: "tool",
        tool: "read",
        messageIdx: 12,
        eligible: true,
        output: "some output",
      }),
    ]

    const flags = new Map<string, Set<string>>()
    flagDeadReasoning(parts, flags)

    expect(flags.get("reason-1")?.has("dead-reasoning")).toBe(true)
  })

  test("does NOT flag reasoning when a productive tool call follows within 10 messages", () => {
    const parts: FlatPart[] = [
      makePart({ partId: "reason-1", type: "reasoning", messageIdx: 0, text: "plan" }),
      makePart({
        partId: "tool-1",
        type: "tool",
        tool: "edit",
        messageIdx: 5,
        eligible: true,
        output: "wrote file",
      }),
    ]

    const flags = new Map<string, Set<string>>()
    flagDeadReasoning(parts, flags)

    expect(flags.has("reason-1")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// superseded-tool-result
// ---------------------------------------------------------------------------

describe("flagSupersededToolResult", () => {
  test("flags a read tool_result that is superseded by a later edit on the same path", () => {
    // read /a.ts at partIdx=0, then edit /a.ts at partIdx=1 in the same message → read is stale.
    const parts: FlatPart[] = [
      makePart({
        partId: "read-1",
        type: "tool",
        tool: "read",
        messageIdx: 0,
        partIdx: 0,
        input: { filePath: "/a.ts" },
        output: "content v1",
        eligible: true,
      }),
      makePart({
        partId: "edit-1",
        type: "tool",
        tool: "edit",
        messageIdx: 0,
        partIdx: 1,
        input: { filePath: "/a.ts", oldString: "x", newString: "y" },
        output: "ok",
        eligible: true,
      }),
    ]

    const flags = new Map<string, Set<string>>()
    flagSupersededToolResult(parts, flags, RESOLVED_OPTS)

    expect(flags.get("read-1")?.has("superseded-tool-result")).toBe(true)
    // The edit itself should NOT be flagged — it's the most recent.
    expect(flags.has("edit-1")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// large-error
// ---------------------------------------------------------------------------

describe("flagLargeError", () => {
  test("flags a tool_result that is an error AND exceeds 800 estimated tokens", () => {
    // 801 * 3.5 ≈ 2803 chars — well over the 800-token threshold.
    const bigErrorOutput = "Error: something went wrong\n" + "x".repeat(2803)

    const parts: FlatPart[] = [
      makePart({
        partId: "err-1",
        type: "tool",
        tool: "bash",
        messageIdx: 0,
        output: bigErrorOutput,
        eligible: true,
      }),
    ]

    const flags = new Map<string, Set<string>>()
    flagLargeError(parts, flags)

    expect(flags.get("err-1")?.has("large-error")).toBe(true)
  })

  test("does NOT flag a small error output (below threshold)", () => {
    const smallErrorOutput = "Error: oops"

    const parts: FlatPart[] = [
      makePart({
        partId: "err-2",
        type: "tool",
        tool: "read",
        messageIdx: 0,
        output: smallErrorOutput,
        eligible: true,
      }),
    ]

    const flags = new Map<string, Set<string>>()
    flagLargeError(parts, flags)

    expect(flags.has("err-2")).toBe(false)
  })
})
