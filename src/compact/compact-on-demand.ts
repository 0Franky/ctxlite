/**
 * Pure compaction planner: resolves selector → affected set, applies safety
 * invariant and massive-op guard. Returns a CompactionPlan. No mutations, no I/O.
 *
 * The mutation step (setting state.time.compacted on actual Part objects) is
 * deliberately NOT done here — it lives in the adapter layer (index.ts) so
 * all side-effectful code stays in one place.
 */

import type { CompactPlanItem, CompactionPlan, CompactSelector } from "../types.ts"
import { type SelectablePart, matchSelector } from "./selector.ts"

const LARGE_OP_PART_THRESHOLD = 20
const LARGE_OP_TOKEN_THRESHOLD = 10_000

/**
 * The "most recent live tool_result per tracked path/binary" safety set.
 * These parts must never be compacted even if explicitly listed in partIds.
 *
 * The caller pre-computes this set from the full message tree using the same
 * logic as the transform hook's invalidation pass:
 *   — for file tools: the last non-compacted part for each (tool, path) key
 *   — for bash: the last non-compacted part for each command key
 *
 * Passing a Set of protected partIds here keeps this function pure.
 */
export function planCompaction(
  parts: readonly SelectablePart[],
  selector: CompactSelector,
  protectedPartIds: ReadonlySet<string>,
  totalMessages: number,
  confirmLargeOperation: boolean,
): CompactionPlan {
  // Step 1: resolve selector.
  const matched = matchSelector(parts, selector, totalMessages)

  // Step 2: apply safety invariant — exclude protected parts even if listed.
  const safeAffected = matched.filter((p) => !protectedPartIds.has(p.partId))

  const totalTokens = safeAffected.reduce((s, p) => s + p.tokens, 0)

  // Step 3: massive-op guard.
  const isMassive =
    safeAffected.length > LARGE_OP_PART_THRESHOLD || totalTokens > LARGE_OP_TOKEN_THRESHOLD

  if (isMassive && !confirmLargeOperation) {
    const message =
      `Large operation: ${safeAffected.length} parts / ${totalTokens} tokens. ` +
      `Set confirmLargeOperation: true to apply.`
    const items: CompactPlanItem[] = safeAffected.map((p) => ({
      part_id: p.partId,
      type: p.type,
      tokens: p.tokens,
      reason: (p.flags ?? []).join(", ") || "selected",
    }))
    return {
      affectedItems: items,
      tokensRecoveredEstimate: totalTokens,
      requiresConfirmation: true,
      confirmationMessage: message,
    }
  }

  const items: CompactPlanItem[] = safeAffected.map((p) => ({
    part_id: p.partId,
    type: p.type,
    tokens: p.tokens,
    reason: (p.flags ?? []).join(", ") || "selected",
  }))

  return {
    affectedItems: items,
    tokensRecoveredEstimate: totalTokens,
    requiresConfirmation: false,
  }
}
