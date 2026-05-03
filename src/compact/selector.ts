/**
 * Pure selector: given a flat part list and a CompactSelector, returns the
 * matched subset. No mutations, no I/O.
 */

import type { CompactFilter, CompactSelector, FlagName } from "../types.ts"
import { estimateTokens } from "../dump/token-estimate.ts"

/** Minimal shape the selector needs. */
export interface SelectablePart {
  readonly partId: string
  readonly messageIdx: number
  readonly partIdx: number
  /** Normalized part type ("text" | "reasoning" | "tool_use" | "tool_result") */
  readonly type: string
  readonly tool?: string
  readonly tokens: number
  /** Flags already computed by heuristics, if available. */
  readonly flags?: readonly string[]
  readonly alreadyCompacted: boolean
}

/**
 * Map the SDK-level part type to the selector type vocabulary.
 * SDK "text" → "text", "reasoning" → "reasoning", "tool" → depends on role.
 * In the opencode model the Part type "tool" covers both tool_use (pending/running)
 * and tool_result (completed/error). We map completed tool parts to "tool_result"
 * and all others to "tool_use".
 */
export function normalizePartType(sdkType: string, status?: string): string {
  if (sdkType === "text") return "text"
  if (sdkType === "reasoning") return "reasoning"
  if (sdkType === "tool") {
    if (status === "completed" || status === "error") return "tool_result"
    return "tool_use"
  }
  return sdkType
}

/** Compute token count for an already-resolved SelectablePart. */
export function selectableTokens(rawOutput: string, rawInput: string): number {
  return estimateTokens(rawOutput) + estimateTokens(rawInput)
}

/**
 * Match a flat list of selectable parts against a CompactSelector.
 * Returns only the parts that satisfy ALL active criteria.
 *
 * For `partIds`: a part must be in the list.
 * For `filter`: all non-undefined filter fields must be satisfied.
 * When both `partIds` and `filter` are present, both must match.
 */
export function matchSelector(
  parts: readonly SelectablePart[],
  selector: CompactSelector,
  totalMessages: number,
): SelectablePart[] {
  const { partIds, filter } = selector
  const partIdSet = partIds !== undefined ? new Set(partIds) : null

  return parts.filter((p) => {
    // Already-compacted parts are never re-targeted.
    if (p.alreadyCompacted) return false

    // partIds filter.
    if (partIdSet !== null && !partIdSet.has(p.partId)) return false

    // Sub-filter fields.
    if (filter !== undefined) {
      if (!matchFilter(p, filter, totalMessages)) return false
    }

    return true
  })
}

function matchFilter(p: SelectablePart, filter: CompactFilter, totalMessages: number): boolean {
  // type filter
  if (filter.type !== undefined && p.type !== filter.type) return false

  // tool filter (only applies to tool_result / tool_use)
  if (filter.tool !== undefined && p.tool !== filter.tool) return false

  // olderThanMessages: part's message is older than the N most recent messages
  if (filter.olderThanMessages !== undefined) {
    const cutoff = totalMessages - filter.olderThanMessages
    if (p.messageIdx >= cutoff) return false
  }

  // largerThanTokens
  if (filter.largerThanTokens !== undefined && p.tokens <= filter.largerThanTokens) return false

  // flaggedAs: part must have ALL requested flags
  if (filter.flaggedAs !== undefined && filter.flaggedAs.length > 0) {
    const partFlags = new Set<string>(p.flags ?? [])
    for (const flag of filter.flaggedAs as FlagName[]) {
      if (!partFlags.has(flag)) return false
    }
  }

  return true
}
