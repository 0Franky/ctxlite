/**
 * Heuristic flag functions for ctxlite_dump.
 * All functions are pure: no I/O, no side effects.
 *
 * Flags implemented (5 of 6):
 *   dead-reasoning          — reasoning part with no productive follow-up in next 10 messages
 *   superseded-tool-result  — reuses decideInvalidations from invalidation.ts
 *   large-error             — error tool_result > 800 tokens
 *   oversized-bash-output   — bash tool_result > 2000 tokens and not the most recent for its key
 *   duplicate-text          — exact-match (whitespace-collapsed) text part seen before
 *
 * Deferred: unused-mcp-description — requires tool-call-counter not cheaply available in v1.
 */

import { extractBashRef, isErrorOutput } from "../extract-path.ts"
import { decideInvalidations } from "../invalidation.ts"
import type { AnalyzerInput, ResolvedOptions } from "../types.ts"
import { estimateTokens } from "./token-estimate.ts"

/** Minimal shape the flag functions need from an already-walked message tree. */
export interface FlatPart {
  readonly partId: string
  readonly messageIdx: number
  readonly partIdx: number
  readonly type: "text" | "reasoning" | "tool"
  readonly tool?: string
  readonly text?: string
  readonly input?: Record<string, unknown>
  readonly output?: string
  readonly alreadyCompacted: boolean
  readonly eligible: boolean
}

/** Map from partId → flag names (mutable during flag computation). */
export type FlagMap = Map<string, Set<string>>

/**
 * Flag 1 — dead-reasoning
 *
 * A reasoning part is considered "dead" if none of the next 10 messages
 * contain an edit/write/successful tool_call (i.e. a completed tool with
 * non-error output). The heuristic: if the AI reasoned but produced no
 * artifact within 10 messages, that reasoning chain is unlikely to be
 * referenced again.
 *
 * IMPORTANT: All flags are computed fresh on each dump call — they are
 * NOT persisted. A "dead-reasoning" flag may disappear in a later dump if
 * productive tool calls are added within 10 messages of the reasoning part.
 * Think of flags as a current-state diagnostic, not a historical record.
 */
export function flagDeadReasoning(parts: readonly FlatPart[], flags: FlagMap): void {
  // Build an index: messageIdx → does the message contain a "productive" tool call?
  // "Productive" = completed tool with non-empty, non-error output.
  const productiveMessages = new Set<number>()
  for (const p of parts) {
    if (p.type === "tool" && p.eligible && !p.alreadyCompacted) {
      const output = p.output ?? ""
      if (output.length > 0 && !isErrorOutput(p.tool ?? "", output)) {
        productiveMessages.add(p.messageIdx)
      }
    }
  }

  for (const p of parts) {
    if (p.type !== "reasoning") continue
    if (p.alreadyCompacted) continue

    // Check if there's a productive tool call in the same message
    // or in the next 9 messages after the reasoning part.
    let hasFollowUp = false
    for (let delta = 0; delta <= 10; delta++) {
      if (productiveMessages.has(p.messageIdx + delta)) {
        hasFollowUp = true
        break
      }
    }

    if (!hasFollowUp) {
      addFlag(flags, p.partId, "dead-reasoning")
    }
  }
}

/**
 * Flag 2 — superseded-tool-result
 *
 * Reuses ctxlite's existing invalidation walk (decideInvalidations) to find
 * tool_results that are already stale per the Phase 2 rules.
 * Only adds the flag; does not mutate any state.
 */
export function flagSupersededToolResult(
  parts: readonly FlatPart[],
  flags: FlagMap,
  options: ResolvedOptions,
): void {
  // Build AnalyzerInput[] from the flat parts (tool parts only).
  const analyzerInputs: AnalyzerInput[] = []
  for (const p of parts) {
    if (p.type !== "tool") continue
    analyzerInputs.push({
      location: { messageIdx: p.messageIdx, partIdx: p.partIdx },
      view: {
        tool: p.tool ?? "",
        input: p.input ?? {},
        output: p.output ?? "",
        eligible: p.eligible,
        alreadyCompacted: p.alreadyCompacted,
      },
    })
  }

  const decisions = decideInvalidations(analyzerInputs, options)

  // Build a lookup: "messageIdx:partIdx" → partId
  const locationToPartId = new Map<string, string>()
  for (const p of parts) {
    locationToPartId.set(`${p.messageIdx}:${p.partIdx}`, p.partId)
  }

  for (const d of decisions) {
    const key = `${d.location.messageIdx}:${d.location.partIdx}`
    const partId = locationToPartId.get(key)
    if (partId !== undefined) {
      addFlag(flags, partId, "superseded-tool-result")
    }
  }
}

/**
 * Flag 3 — large-error
 *
 * A tool_result that isErrorOutput AND has > 800 tokens. Large error outputs
 * waste context without providing actionable information beyond their first
 * few lines.
 */
export function flagLargeError(parts: readonly FlatPart[], flags: FlagMap): void {
  const THRESHOLD = 800
  for (const p of parts) {
    if (p.type !== "tool") continue
    if (p.alreadyCompacted) continue
    const output = p.output ?? ""
    if (isErrorOutput(p.tool ?? "", output) && estimateTokens(output) > THRESHOLD) {
      addFlag(flags, p.partId, "large-error")
    }
  }
}

/**
 * Flag 4 — oversized-bash-output
 *
 * A bash tool_result > 2000 tokens that is NOT the most recent live result
 * for its command-key. Most-recent is kept intact (it may still be relevant);
 * older large bash outputs are candidates for cleanup.
 */
export function flagOversizedBashOutput(parts: readonly FlatPart[], flags: FlagMap): void {
  const THRESHOLD = 2000
  // Two passes: first collect most-recent live part per key, then flag older ones.
  const latestLiveByKey = new Map<string, string>() // key → partId of most recent live
  for (const p of parts) {
    if (p.type !== "tool" || p.tool !== "bash") continue
    if (p.alreadyCompacted) continue
    const bashRef = extractBashRef(p.input ?? null)
    if (bashRef === null) continue
    // Forward pass: last one wins = most recent.
    latestLiveByKey.set(bashRef.key, p.partId)
  }

  for (const p of parts) {
    if (p.type !== "tool" || p.tool !== "bash") continue
    if (p.alreadyCompacted) continue
    const output = p.output ?? ""
    if (estimateTokens(output) <= THRESHOLD) continue
    const bashRef = extractBashRef(p.input ?? null)
    if (bashRef === null) continue
    // Flag only if it's NOT the most recent for its key.
    if (latestLiveByKey.get(bashRef.key) !== p.partId) {
      addFlag(flags, p.partId, "oversized-bash-output")
    }
  }
}

/**
 * Flag 5 — duplicate-text
 *
 * Text parts with identical trimmed+whitespace-collapsed content as a prior
 * text part. Exact-match only (no Jaccard for v1).
 * Skips very short parts (< 20 chars) to avoid false positives on common
 * single-line text like "OK" or "Done".
 */
export function flagDuplicateText(parts: readonly FlatPart[], flags: FlagMap): void {
  const MIN_LEN = 20
  const seen = new Map<string, string>() // normalized → first partId
  for (const p of parts) {
    if (p.type !== "text") continue
    if (p.alreadyCompacted) continue
    const text = p.text ?? ""
    const normalized = text.trim().replace(/\s+/g, " ")
    if (normalized.length < MIN_LEN) continue
    const prior = seen.get(normalized)
    if (prior === undefined) {
      seen.set(normalized, p.partId)
    } else {
      // Both the duplicate and the original could be flagged, but we only
      // flag the later occurrence so the first stays as the canonical copy.
      addFlag(flags, p.partId, "duplicate-text")
    }
  }
}

// Flag 6 — unused-mcp-description: DEFERRED for v1.
// Requires tracking which MCP tool descriptions are actually referenced by
// the model. This needs a tool-call-counter that is not cheaply available
// from the plugin's message transform hook. Deferred to Layer D.

function addFlag(flags: FlagMap, partId: string, flag: string): void {
  let set = flags.get(partId)
  if (set === undefined) {
    set = new Set()
    flags.set(partId, set)
  }
  set.add(flag)
}
