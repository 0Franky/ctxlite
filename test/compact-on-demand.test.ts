/**
 * Layer C: focused tests for planCompaction.
 *
 * Covers:
 *   1. Safety invariant — most-recent live tool_result is excluded even when
 *      explicitly listed in partIds.
 *   2. Massive-op guard — >20 parts forces requiresConfirmation=true regardless
 *      of the confirmLargeOperation argument.
 */

import { describe, expect, test } from "bun:test"
import { planCompaction } from "../src/compact/compact-on-demand.ts"
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
// Safety invariant
// ---------------------------------------------------------------------------

describe("planCompaction — safety invariant", () => {
  test("most-recent live part is excluded even when explicitly listed in partIds", () => {
    const protected1 = makePart({ partId: "protected-1", messageIdx: 5 })
    const stale1 = makePart({ partId: "stale-1", messageIdx: 2 })

    const parts: SelectablePart[] = [stale1, protected1]
    const protectedIds = new Set(["protected-1"])

    const plan = planCompaction(
      parts,
      { partIds: ["stale-1", "protected-1"] },
      protectedIds,
      10,
      false,
    )

    const ids = plan.affectedItems.map((i) => i.part_id)
    expect(ids).toContain("stale-1")
    expect(ids).not.toContain("protected-1")
  })
})

// ---------------------------------------------------------------------------
// Massive-op guard
// ---------------------------------------------------------------------------

describe("planCompaction — massive-op guard", () => {
  test("more than 20 parts forces requiresConfirmation=true without confirmLargeOperation", () => {
    // Build 21 unprotected parts.
    const parts: SelectablePart[] = Array.from({ length: 21 }, (_, i) =>
      makePart({ partId: `part-${i}`, messageIdx: i, tokens: 100 }),
    )

    const plan = planCompaction(
      parts,
      { filter: { type: "tool_result" } },
      new Set<string>(),
      30,
      false, // confirmLargeOperation not set
    )

    expect(plan.requiresConfirmation).toBe(true)
    expect(plan.confirmationMessage).toMatch(/confirmLargeOperation/)
    // All 21 parts are still reported in the preview.
    expect(plan.affectedItems).toHaveLength(21)
  })

  test("more than 20 parts proceeds normally when confirmLargeOperation=true", () => {
    const parts: SelectablePart[] = Array.from({ length: 21 }, (_, i) =>
      makePart({ partId: `part-${i}`, messageIdx: i, tokens: 100 }),
    )

    const plan = planCompaction(
      parts,
      { filter: { type: "tool_result" } },
      new Set<string>(),
      30,
      true, // confirmed
    )

    expect(plan.requiresConfirmation).toBe(false)
    expect(plan.affectedItems).toHaveLength(21)
  })
})
