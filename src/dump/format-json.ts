/**
 * Pure serializer: DumpData → JSON string.
 * Mirrors the markdown content in machine-readable form.
 */

import type { DumpData, DumpVerbosity } from "../types.ts"

interface JsonDump {
  version: "1.0"
  session_id: string
  generated_at: string
  context: {
    window_tokens: number
    used_tokens: number
    used_pct: number
  }
  summary: {
    n_messages: number
    n_parts: number
    n_already_compacted: number
    cleanup_candidates_count: number
  }
  messages: unknown[]
  top_offenders: unknown[]
  cleanup_candidates: unknown[]
}

/**
 * Serialize DumpData to a structured JSON string.
 *
 * Verbosity controls how much part-level detail is included:
 *   minimal → messages array omitted, only top_offenders + cleanup_candidates
 *   normal  → messages included with previews
 *   verbose → messages included with full previews
 */
export function serializeJson(data: DumpData, verbosity: DumpVerbosity): string {
  const nParts = data.messages.reduce((s, m) => s + m.parts.length, 0)

  const out: JsonDump = {
    version: "1.0",
    session_id: data.sessionId,
    generated_at: new Date(data.generatedAt).toISOString(),
    context: {
      window_tokens: data.contextWindowTokens,
      used_tokens: data.totalTokens,
      used_pct: data.usedPct,
    },
    summary: {
      n_messages: data.messages.length,
      n_parts: nParts,
      n_already_compacted: data.nAlreadyCompacted,
      cleanup_candidates_count: data.cleanupCandidates.length,
    },
    messages:
      verbosity === "minimal"
        ? []
        : data.messages.map((m) => ({
            message_idx: m.messageIdx,
            message_id: m.messageId,
            role: m.role,
            parts: m.parts.map((p) => ({
              part_id: p.partId,
              type: p.type,
              tool: p.tool,
              tokens: p.tokens,
              already_compacted: p.alreadyCompacted,
              flags: p.flags,
              preview: p.preview,
            })),
          })),
    top_offenders: data.topOffenders.map((o, i) => ({
      rank: i + 1,
      part_id: o.partId,
      type: o.type,
      tool: o.tool,
      tokens: o.tokens,
    })),
    cleanup_candidates: data.cleanupCandidates.map((c) => ({
      part_id: c.partId,
      message_idx: c.messageIdx,
      type: c.type,
      tool: c.tool,
      tokens: c.tokens,
      flags: c.flags,
      preview: c.preview,
    })),
  }

  return JSON.stringify(out, null, 2)
}
