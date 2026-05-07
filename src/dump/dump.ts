/**
 * Pure dump builder: takes a message tree, computes per-part token costs,
 * runs heuristic flags, and returns a DumpData structure ready for
 * serialization. No I/O here.
 */

import { DEFAULT_TRACKED_TOOLS } from "../extract-path.ts"
import type {
  DumpData,
  DumpMessage,
  DumpOptions,
  DumpPart,
  FlagName,
  FlaggedPart,
  ResolvedOptions,
} from "../types.ts"
import { flagDeadReasoning, flagDuplicateText, flagLargeError, flagOversizedBashOutput, flagSupersededToolResult, type FlatPart } from "./flag-heuristics.ts"
import { estimateTokens } from "./token-estimate.ts"

/**
 * Fallback context window size used when not derivable from SDK input.
 * opencode's default context window for Claude models is 200k tokens.
 */
const FALLBACK_CONTEXT_WINDOW = 200_000

const TOP_OFFENDERS_COUNT = 10

/** Truncate a string to maxLen, appending "…" if trimmed. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 1) + "…"
}

/** Stringify a value for token estimation. */
function stringify(v: unknown): string {
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v) ?? ""
  } catch {
    return String(v)
  }
}

/** Derive a short preview from a part's primary text field. */
function makePreview(part: FlatPart, maxLen = 200): string {
  let raw = ""
  if (part.type === "text" || part.type === "reasoning") {
    raw = part.text ?? ""
  } else if (part.type === "tool") {
    raw = part.output ?? stringify(part.input)
  }
  return truncate(raw.replace(/\s+/g, " ").trim(), maxLen)
}

/** Estimate token count for a FlatPart based on its primary content field. */
function partTokens(p: FlatPart): number {
  if (p.type === "text" || p.type === "reasoning") {
    return estimateTokens(p.text ?? "")
  }
  if (p.type === "tool") {
    const outputTokens = estimateTokens(p.output ?? "")
    const inputTokens = estimateTokens(stringify(p.input))
    return outputTokens + inputTokens
  }
  return 0
}

/**
 * Minimal SDK-shape that buildDump accepts.
 * The plugin entrypoint maps opencode's Part array onto this.
 */
export interface RawMessage {
  readonly info: {
    readonly id: string
    readonly role: string
    readonly sessionID?: string
  }
  readonly parts: ReadonlyArray<{
    readonly id: string
    readonly type: string
    readonly tool?: string
    readonly callID?: string
    readonly text?: string
    readonly state?: {
      readonly status?: string
      readonly input?: Record<string, unknown>
      readonly output?: string
      readonly time?: { readonly compacted?: number }
    }
  }>
}

/**
 * Build the complete dump data structure from a session's raw message array.
 *
 * @param messages  Array from the session.messages() API (or transform hook output).
 * @param sessionId Caller-supplied session identifier.
 * @param opts      Dump options.
 */
export function buildDump(
  messages: ReadonlyArray<RawMessage>,
  sessionId: string,
  opts: DumpOptions,
): DumpData {
  // --- flatten parts -------------------------------------------------------
  const flatParts: FlatPart[] = []
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (msg === undefined) continue
    for (let pi = 0; pi < msg.parts.length; pi++) {
      const p = msg.parts[pi]
      if (p === undefined) continue

      // Normalize part type to the 3 categories we analyze.
      let type: "text" | "reasoning" | "tool"
      if (p.type === "text") type = "text"
      else if (p.type === "reasoning") type = "reasoning"
      else if (p.type === "tool") type = "tool"
      else continue // skip step-start, step-finish, etc.

      const state = p.state
      const alreadyCompacted =
        typeof state?.time?.compacted === "number" && state.time.compacted > 0

      flatParts.push({
        partId: p.id,
        messageIdx: mi,
        partIdx: pi,
        type,
        tool: p.tool,
        text: p.text,
        input: state?.input,
        output: state?.output,
        alreadyCompacted,
        eligible: state?.status === "completed",
      })
    }
  }

  // --- run flag heuristics --------------------------------------------------
  const flagMap = new Map<string, Set<string>>()
  const resolvedOpts: ResolvedOptions = {
    tools: new Set(DEFAULT_TRACKED_TOOLS),
    logLevel: "silent",
    preserveRecentMessages: 0,
  }

  flagDeadReasoning(flatParts, flagMap)
  flagSupersededToolResult(flatParts, flagMap, resolvedOpts)
  flagLargeError(flatParts, flagMap)
  flagOversizedBashOutput(flatParts, flagMap)
  flagDuplicateText(flatParts, flagMap)

  // --- compute token costs --------------------------------------------------
  const tokensByPartId = new Map<string, number>()
  let totalTokens = 0
  let nAlreadyCompacted = 0
  for (const p of flatParts) {
    const t = partTokens(p)
    tokensByPartId.set(p.partId, t)
    totalTokens += t
    if (p.alreadyCompacted) nAlreadyCompacted++
  }

  // --- build message/part tree (O(N) with Map index) -----------------------
  // Build a Map keyed on "messageIdx:partIdx" for O(1) lookup instead of O(N²) find().
  const partIndex = new Map<string, typeof flatParts[number]>()
  for (const fp of flatParts) {
    partIndex.set(`${fp.messageIdx}:${fp.partIdx}`, fp)
  }

  const dumpMessages: DumpMessage[] = []
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (msg === undefined) continue
    const dumpParts: DumpPart[] = []
    for (let pi = 0; pi < msg.parts.length; pi++) {
      const p = msg.parts[pi]
      if (p === undefined) continue
      const fp = partIndex.get(`${mi}:${pi}`)
      if (fp === undefined) continue
      const tokens = tokensByPartId.get(fp.partId) ?? 0
      const partFlags = [...(flagMap.get(fp.partId) ?? [])] as FlagName[]
      dumpParts.push({
        partId: fp.partId,
        type: fp.type,
        tool: fp.tool,
        tokens,
        alreadyCompacted: fp.alreadyCompacted,
        flags: partFlags,
        preview: makePreview(fp, opts.verbosity === "verbose" ? 200 : 80),
      })
    }
    dumpMessages.push({
      messageIdx: mi,
      messageId: msg.info.id,
      role: msg.info.role,
      parts: dumpParts,
    })
  }

  // --- top offenders (by token cost, non-compacted) -------------------------
  const sortedByTokens = flatParts
    .filter((p) => !p.alreadyCompacted)
    .sort((a, b) => (tokensByPartId.get(b.partId) ?? 0) - (tokensByPartId.get(a.partId) ?? 0))
    .slice(0, TOP_OFFENDERS_COUNT)

  const topOffenders = sortedByTokens.map((p) => ({
    partId: p.partId,
    tokens: tokensByPartId.get(p.partId) ?? 0,
    type: p.type,
    tool: p.tool,
  }))

  // --- cleanup candidates (all flagged, non-compacted) ----------------------
  const cleanupCandidates: FlaggedPart[] = []
  for (const p of flatParts) {
    const partFlags = flagMap.get(p.partId)
    if (partFlags === undefined || partFlags.size === 0) continue
    if (p.alreadyCompacted) continue
    cleanupCandidates.push({
      partId: p.partId,
      messageIdx: p.messageIdx,
      partIdx: p.partIdx,
      type: p.type,
      tool: p.tool,
      tokens: tokensByPartId.get(p.partId) ?? 0,
      flags: [...partFlags] as FlagName[],
      preview: makePreview(p, 80),
    })
  }
  // Sort by token cost descending so the biggest wins appear first.
  cleanupCandidates.sort((a, b) => b.tokens - a.tokens)

  const contextWindowTokens = FALLBACK_CONTEXT_WINDOW
  const usedPct = contextWindowTokens > 0 ? Math.round((totalTokens / contextWindowTokens) * 100 * 10) / 10 : 0

  return {
    sessionId,
    generatedAt: Date.now(),
    totalTokens,
    usedPct,
    contextWindowTokens,
    messages: dumpMessages,
    topOffenders,
    cleanupCandidates,
    nAlreadyCompacted,
  }
}
