/**
 * Layer C: focused tests for matchSelector.
 *
 * Covers combining filter.type + filter.largerThanTokens, the most common
 * multi-predicate use case.
 */

import { describe, expect, test } from "bun:test"
import { matchSelector } from "../src/compact/selector.ts"
import type { SelectablePart } from "../src/compact/selector.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePart(overrides: Partial<SelectablePart> & { partId: string }): SelectablePart {
  return {
    messageIdx: 0,
    partIdx: 0,
    type: "tool_result",
    tool: "read",
    tokens: 100,
    flags: [],
    alreadyCompacted: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Combined filter: type + largerThanTokens
// ---------------------------------------------------------------------------

describe("matchSelector — combined type + largerThanTokens", () => {
  test("returns only parts that satisfy BOTH type=tool_result AND tokens > threshold", () => {
    const parts: SelectablePart[] = [
      // Matches both criteria.
      makePart({ partId: "big-tool", type: "tool_result", tokens: 2000 }),
      // Right type but too small.
      makePart({ partId: "small-tool", type: "tool_result", tokens: 50 }),
      // Big enough but wrong type.
      makePart({ partId: "big-text", type: "text", tokens: 2000 }),
      // Already compacted — must be excluded regardless.
      makePart({ partId: "compacted", type: "tool_result", tokens: 2000, alreadyCompacted: true }),
    ]

    const result = matchSelector(
      parts,
      {
        filter: {
          type: "tool_result",
          largerThanTokens: 100,
        },
      },
      10,
    )

    const ids = result.map((p) => p.partId)
    expect(ids).toEqual(["big-tool"])
  })
})

// ---------------------------------------------------------------------------
// olderThanMessages filter
// ---------------------------------------------------------------------------

describe("matchSelector — olderThanMessages", () => {
  test("excludes parts from messages within the N most recent messages", () => {
    // Total messages = 10. olderThanMessages = 3 → cutoff at index 7.
    // Only parts with messageIdx < 7 pass.
    const parts: SelectablePart[] = [
      makePart({ partId: "old", messageIdx: 5 }),
      makePart({ partId: "recent", messageIdx: 8 }),
    ]

    const result = matchSelector(parts, { filter: { olderThanMessages: 3 } }, 10)

    const ids = result.map((p) => p.partId)
    expect(ids).toContain("old")
    expect(ids).not.toContain("recent")
  })
})
