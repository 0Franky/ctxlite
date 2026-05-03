/**
 * ctxlite — opencode plugin
 *
 * Hooks `experimental.chat.messages.transform` to invalidate stale tool_results
 * of `read` and `edit` for the same file path. Sets `state.time.compacted` on
 * targeted parts so opencode's existing rendering path
 * (`MessageV2.toModelMessagesEffect`) automatically replaces their `output`
 * with the standard "[Old tool result content cleared]" stub.
 *
 * Properties:
 *   • Pure mutation in-process — no extra LLM calls, no extra round trips.
 *   • Idempotent — re-applying on an already-processed history is a no-op.
 *   • Fail-open — any unexpected error is caught; opencode keeps running with
 *     the unchanged history rather than aborting the user's session.
 *   • Type-safe — all opencode shapes are checked at runtime before mutation.
 */

import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { Part, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk"

import { DEFAULT_TRACKED_TOOLS } from "./extract-path.ts"
import { decideInvalidations, type AnalyzerInput } from "./invalidation.ts"
import type { CtxliteOptions, ResolvedOptions, ToolPartView } from "./types.ts"

const DEFAULT_LOG_LEVEL: ResolvedOptions["logLevel"] = "info"

/**
 * Validate and normalize user-provided options. Unknown values are ignored
 * silently — config that pre-dates a tool/option name should not crash the
 * session.
 */
function resolveOptions(raw: PluginOptions | undefined): ResolvedOptions {
  const opts = (raw ?? {}) as Partial<CtxliteOptions> & Record<string, unknown>

  const toolsInput = Array.isArray(opts.tools) ? opts.tools : DEFAULT_TRACKED_TOOLS
  const tools = new Set<string>()
  for (const item of toolsInput) {
    if (typeof item === "string" && item.length > 0) tools.add(item)
  }
  if (tools.size === 0) for (const t of DEFAULT_TRACKED_TOOLS) tools.add(t)

  const logLevel: ResolvedOptions["logLevel"] =
    opts.logLevel === "silent" || opts.logLevel === "info" || opts.logLevel === "debug"
      ? opts.logLevel
      : DEFAULT_LOG_LEVEL

  const preserveRecent =
    typeof opts.preserveRecentMessages === "number" &&
    Number.isFinite(opts.preserveRecentMessages) &&
    opts.preserveRecentMessages >= 0
      ? Math.floor(opts.preserveRecentMessages)
      : 0

  return { tools, logLevel, preserveRecentMessages: preserveRecent }
}

/** Type guard: is this Part a ToolPart? */
function isToolPart(part: Part): part is ToolPart {
  return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "tool"
}

/** Type guard: is this ToolPart in the `completed` state? */
function isCompleted(part: ToolPart): part is ToolPart & { state: ToolStateCompleted } {
  return part.state.status === "completed"
}

/** Build the analyzer view of a completed ToolPart. */
function toView(part: ToolPart & { state: ToolStateCompleted }): ToolPartView {
  return {
    tool: part.tool,
    input: part.state.input ?? {},
    output: typeof part.state.output === "string" ? part.state.output : "",
    eligible: true,
    alreadyCompacted: typeof part.state.time.compacted === "number" && part.state.time.compacted > 0,
  }
}

/**
 * Walk the message tree and collect every analyzable ToolPart with its
 * coordinates. Parts in the most recent N messages can be skipped via
 * `preserveRecentMessages` (defensive option for users who fear race
 * conditions with mid-flight tool calls; default 0 — eligible-only is enough).
 */
function collectAnalyzerInputs(
  messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Part> }>,
  preserveRecentMessages: number,
): AnalyzerInput[] {
  const out: AnalyzerInput[] = []
  const cutoff = Math.max(0, messages.length - preserveRecentMessages)
  for (let mi = 0; mi < cutoff; mi++) {
    const msg = messages[mi]
    if (msg === undefined) continue
    const parts = msg.parts
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi]
      if (part === undefined) continue
      if (!isToolPart(part)) continue
      if (!isCompleted(part)) continue
      out.push({
        location: { messageIdx: mi, partIdx: pi },
        view: toView(part),
      })
    }
  }
  return out
}

/**
 * Mutating apply: walk decisions and set `state.time.compacted = Date.now()`
 * on every targeted ToolPart. Safe even if the same part is targeted twice
 * (idempotent at the property level).
 */
function applyDecisions(
  messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Part> }>,
  decisions: ReadonlyArray<{ readonly location: { messageIdx: number; partIdx: number } }>,
): number {
  const now = Date.now()
  let mutations = 0
  for (const decision of decisions) {
    const msg = messages[decision.location.messageIdx]
    if (msg === undefined) continue
    const part = msg.parts[decision.location.partIdx]
    if (part === undefined || !isToolPart(part) || !isCompleted(part)) continue
    if (typeof part.state.time.compacted === "number" && part.state.time.compacted > 0) continue
    part.state.time.compacted = now
    mutations++
  }
  return mutations
}

const log = (level: ResolvedOptions["logLevel"], wanted: "info" | "debug", message: string): void => {
  if (level === "silent") return
  if (wanted === "debug" && level !== "debug") return
  // Single line, prefixed for grep-ability in opencode logs.
  console.log(`[ctxlite] ${message}`)
}

const server: Plugin = async (_input: PluginInput, rawOptions?: PluginOptions): Promise<Hooks> => {
  const options = resolveOptions(rawOptions)

  log(
    options.logLevel,
    "info",
    `loaded — tools=[${[...options.tools].join(",")}] preserveRecent=${options.preserveRecentMessages}`,
  )

  return {
    "experimental.chat.messages.transform": async (_hookInput, output) => {
      try {
        if (!output || !Array.isArray(output.messages) || output.messages.length === 0) return

        const inputs = collectAnalyzerInputs(output.messages, options.preserveRecentMessages)
        if (inputs.length === 0) return

        const decisions = decideInvalidations(inputs, options)
        if (decisions.length === 0) {
          log(options.logLevel, "debug", `no invalidations across ${inputs.length} tool_results`)
          return
        }

        const applied = applyDecisions(output.messages, decisions)
        log(
          options.logLevel,
          "info",
          `invalidated ${applied} stale tool_result(s) across ${inputs.length} eligible — reasons: ${summarize(decisions)}`,
        )
      } catch (error) {
        // Fail-open: log and proceed unchanged. ctxlite must NEVER break a session.
        const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        log(options.logLevel, "info", `ERROR (fail-open) — ${msg}`)
      }
    },
  }
}

function summarize(decisions: ReadonlyArray<{ reason: string }>): string {
  const counts = new Map<string, number>()
  for (const d of decisions) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1)
  return [...counts.entries()].map(([reason, n]) => `${reason}=${n}`).join(", ")
}

// opencode requires `id` for file:// plugins (see opencode/src/plugin/shared.ts:313)
// and `server` as the main hook factory.
export default {
  id: "ctxlite",
  server,
}
