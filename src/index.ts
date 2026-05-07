/**
 * ctxlite — opencode plugin
 *
 * Registers two hooks and two custom tools:
 *
 * Hooks:
 *   • experimental.chat.messages.transform — invalidates stale tool_results of
 *     `read` and `edit` for the same file path (Phase 1/2 logic).
 *
 * Custom tools (Layer C):
 *   • ctxlite_dump    — snapshots context to markdown + JSON, returns ≤200-token summary.
 *   • ctxlite_compact — surgical removal of parts via selector; dryRun default.
 *
 * Tool registration: opencode plugin `Hooks.tool` field maps string keys to
 * `ToolDefinition` values (from @opencode-ai/plugin `tool()` helper with zod schemas).
 * The ToolContext.sessionID is used to fetch the message tree via client.session.messages().
 *
 * TODO: add slash-command wrappers in .opencode/commands/ctxlite-dump.md and
 * ctxlite-compact.md (thin markdown wrappers) once the plugin is stable.
 *
 * Properties:
 *   • Pure mutation in-process — no extra LLM calls, no extra round trips.
 *   • Idempotent — re-applying on an already-processed history is a no-op.
 *   • Fail-open — any unexpected error is caught; opencode keeps running with
 *     the unchanged history rather than aborting the user's session.
 *   • Type-safe — all opencode shapes are checked at runtime before mutation.
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { randomBytes } from "node:crypto"

import { tool, type Hooks, type Plugin, type PluginInput, type PluginOptions } from "@opencode-ai/plugin"
import type { Part, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk"

import { DEFAULT_TRACKED_TOOLS, extractBashRef, extractFileRef } from "./extract-path.ts"
import { decideInvalidations, type AnalyzerInput } from "./invalidation.ts"
import type { CompactSelector, CtxliteOptions, ResolvedOptions, ToolPartView } from "./types.ts"
import { buildDump, type RawMessage } from "./dump/dump.ts"
import { serializeMarkdown } from "./dump/format-markdown.ts"
import { serializeJson } from "./dump/format-json.ts"
import { estimateTokens } from "./dump/token-estimate.ts"
import { type SelectablePart, normalizePartType } from "./compact/selector.ts"
import { planCompaction } from "./compact/compact-on-demand.ts"
import {
  addToRegistry,
  cleanupOldEntries,
  defaultRegistryPath,
  getCompactedForSession,
  loadRegistry,
  saveRegistry,
} from "./registry.ts"

// ---------------------------------------------------------------------------
// Option resolution (Phase 1/2)
// ---------------------------------------------------------------------------

const DEFAULT_LOG_LEVEL: ResolvedOptions["logLevel"] = "info"
/** Dump files older than 7 days are deleted at boot (TTL cleanup). */
const DUMP_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Registry sessions older than 30 days are pruned at boot. */
const REGISTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

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

  const registryPath =
    typeof opts.registryPath === "string" && opts.registryPath.length > 0
      ? opts.registryPath
      : defaultRegistryPath()

  return {
    tools,
    logLevel,
    preserveRecentMessages: nonNegativeInt(opts.preserveRecentMessages),
    preserveOldestMessages: nonNegativeInt(opts.preserveOldestMessages),
    minMessagesForActivation: nonNegativeInt(opts.minMessagesForActivation),
    registryPath,
  }
}

// ---------------------------------------------------------------------------
// Phase 1/2 helpers
// ---------------------------------------------------------------------------

function isToolPart(part: Part): part is ToolPart {
  return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "tool"
}

function isCompleted(part: ToolPart): part is ToolPart & { state: ToolStateCompleted } {
  return part.state.status === "completed"
}

function toView(part: ToolPart & { state: ToolStateCompleted }): ToolPartView {
  return {
    tool: part.tool,
    input: part.state.input ?? {},
    output: typeof part.state.output === "string" ? part.state.output : "",
    eligible: true,
    alreadyCompacted: typeof part.state.time.compacted === "number" && part.state.time.compacted > 0,
  }
}

function collectAnalyzerInputs(
  messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Part> }>,
  preserveRecentMessages: number,
  preserveOldestMessages: number,
): AnalyzerInput[] {
  const out: AnalyzerInput[] = []
  const start = Math.min(preserveOldestMessages, messages.length)
  const end = Math.max(start, messages.length - preserveRecentMessages)
  for (let mi = start; mi < end; mi++) {
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
 * Extract the sessionID from the message payload. The transform hook input
 * doesn't carry it directly, but every Message and ToolPart in opencode
 * includes a sessionID field. Returns null if no message exposes one (very
 * unusual; the plugin then skips registry replay for that turn).
 */
function extractSessionID(
  messages: ReadonlyArray<{ readonly info?: { readonly sessionID?: string }; readonly parts: ReadonlyArray<Part> }>,
): string | null {
  for (const msg of messages) {
    const fromInfo = msg.info?.sessionID
    if (typeof fromInfo === "string" && fromInfo.length > 0) return fromInfo
    for (const part of msg.parts) {
      const sid = (part as unknown as { sessionID?: unknown }).sessionID
      if (typeof sid === "string" && sid.length > 0) return sid
    }
  }
  return null
}

/**
 * Apply pending compactions from the registry by mutating part state
 * in-place on the payload that opencode is about to send to the provider.
 *
 * Like `applyDecisions`, this depends on the transform hook receiving the
 * same object references opencode will then serialize — proven by the
 * smoke tests against the real SDK shape.
 */
function applyRegistryCompactions(
  messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Part> }>,
  pendingPartIds: ReadonlySet<string>,
): number {
  if (pendingPartIds.size === 0) return 0
  const now = Date.now()
  let applied = 0
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (!isToolPart(part) || !isCompleted(part)) continue
      const partId = (part as unknown as { id?: string }).id
      if (typeof partId !== "string" || !pendingPartIds.has(partId)) continue
      if (typeof part.state.time.compacted === "number" && part.state.time.compacted > 0) continue
      part.state.time.compacted = now
      applied++
    }
  }
  return applied
}

/**
 * Apply invalidation decisions by mutating part state in-place.
 * 
 * WARNING: This depends on the experimental `chat.messages.transform` hook 
 * passing the same object references (not deep copies). If the opencode 
 * framework changes semantics, mutations become silent no-ops.
 * Mitigation: we return `mutations` count; the caller can detect zero
 * mutations and log a warning.
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
  console.log(`[ctxlite] ${message}`)
}

function summarize(decisions: ReadonlyArray<{ reason: string }>): string {
  const counts = new Map<string, number>()
  for (const d of decisions) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1)
  return [...counts.entries()].map(([reason, n]) => `${reason}=${n}`).join(", ")
}

// ---------------------------------------------------------------------------
// Layer C helpers
// ---------------------------------------------------------------------------

/** Default dump directory: OS temp dir / ctxlite-dumps. */
function defaultDumpDir(): string {
  return path.join(os.tmpdir(), "ctxlite-dumps")
}

/**
 * Idempotent TTL cleanup: delete dump files older than DUMP_TTL_MS.
 * Fail-open: any error is swallowed so boot is never blocked.
 */
async function cleanupOldDumps(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir)
    const now = Date.now()
    for (const entry of entries) {
      try {
        const full = path.join(dir, entry)
        const s = await stat(full)
        if (now - s.mtimeMs > DUMP_TTL_MS) {
          await rm(full, { force: true })
        }
      } catch {
        // individual file failure: skip
      }
    }
  } catch {
    // directory doesn't exist or unreadable: skip
  }
}

/**
 * Map a full opencode message list to the RawMessage shape expected by buildDump.
 */
function toRawMessages(
  messages: Array<{ info: { id: string; role: string; sessionID?: string }; parts: Part[] }>,
): RawMessage[] {
  return messages.map((m) => ({
    info: { id: m.info.id, role: m.info.role, sessionID: m.info.sessionID },
    parts: m.parts.map((p) => {
      const base = p as Record<string, unknown>
      const state = (base["state"] ?? {}) as Record<string, unknown>
      const stateTime = (state["time"] ?? {}) as Record<string, unknown>
      return {
        id: typeof base["id"] === "string" ? base["id"] : "",
        type: typeof base["type"] === "string" ? base["type"] : "",
        tool: typeof base["tool"] === "string" ? base["tool"] : undefined,
        callID: typeof base["callID"] === "string" ? base["callID"] : undefined,
        text: typeof base["text"] === "string" ? base["text"] : undefined,
        state: {
          status: typeof state["status"] === "string" ? state["status"] : undefined,
          input:
            state["input"] !== null && typeof state["input"] === "object"
              ? (state["input"] as Record<string, unknown>)
              : undefined,
          output: typeof state["output"] === "string" ? state["output"] : undefined,
          time: {
            compacted:
              typeof stateTime["compacted"] === "number" ? stateTime["compacted"] : undefined,
          },
        },
      }
    }),
  }))
}

/**
 * Build a set of protectedPartIds for ctxlite_compact:
 * the most-recent live tool_result for each tracked path/bash key.
 *
 * Strategy: re-run the invalidation walk and collect every part that is NOT
 * in the decision set (these are the "survivors"). Among those, the most-
 * recent live part per path is implicitly the last one seen in forward order.
 * We protect all survivors that are live.
 */
function buildProtectedSet(
  messages: Array<{ parts: Part[] }>,
): Set<string> {
  // Walk all tool parts and find the last live part per (tool, path/key).
  const lastLiveByFileKey = new Map<string, string>() // key → partId
  const lastLiveByBashKey = new Map<string, string>()

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (!isToolPart(part) || !isCompleted(part)) continue
      if (typeof part.state.time.compacted === "number" && part.state.time.compacted > 0) continue
      const partId = (part as unknown as { id: string }).id
      if (!partId) continue

      if (part.tool === "bash") {
        const ref = extractBashRef(part.state.input)
        if (ref !== null) lastLiveByBashKey.set(ref.key, partId)
      } else {
        const ref = extractFileRef(part.tool, part.state.input)
        if (ref !== null) {
          // Use only path as key (not tool:path), consistent with Phase 1/2
          // where an edit on a path supersedes prior reads on the same path.
          const key = ref.path
          lastLiveByFileKey.set(key, partId)
        }
      }
    }
  }

  const protected_ = new Set<string>()
  for (const id of lastLiveByFileKey.values()) protected_.add(id)
  for (const id of lastLiveByBashKey.values()) protected_.add(id)
  return protected_
}

/**
 * Convert full Part objects to SelectablePart for the compact selector.
 * Token estimation is done here (I/O-free callers remain pure).
 */
function toSelectableParts(
  messages: Array<{ parts: Part[] }>,
  flagsByPartId: Map<string, string[]>,
): SelectablePart[] {
  const out: SelectablePart[] = []
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (!msg) continue
    for (let pi = 0; pi < msg.parts.length; pi++) {
      const p = msg.parts[pi] as Record<string, unknown>
      if (!p) continue
      const partId = typeof p["id"] === "string" ? p["id"] : ""
      if (!partId) continue
      const sdkType = typeof p["type"] === "string" ? p["type"] : ""
      const state = (p["state"] ?? {}) as Record<string, unknown>
      const status = typeof state["status"] === "string" ? state["status"] : undefined
      const alreadyCompacted =
        typeof (state["time"] as Record<string, unknown> | undefined)?.["compacted"] === "number" &&
        ((state["time"] as Record<string, unknown>)["compacted"] as number) > 0

      const output = typeof state["output"] === "string" ? state["output"] : ""
      const inputStr =
        state["input"] !== null && typeof state["input"] === "object"
          ? JSON.stringify(state["input"])
          : ""
      const text = typeof p["text"] === "string" ? p["text"] : ""
      const tokens =
        sdkType === "tool"
          ? estimateTokens(output) + estimateTokens(inputStr)
          : estimateTokens(text)

      out.push({
        partId,
        messageIdx: mi,
        partIdx: pi,
        type: normalizePartType(sdkType, status),
        tool: typeof p["tool"] === "string" ? p["tool"] : undefined,
        tokens,
        flags: flagsByPartId.get(partId) ?? [],
        alreadyCompacted,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

const server: Plugin = async (input: PluginInput, rawOptions?: PluginOptions): Promise<Hooks> => {
  const options = resolveOptions(rawOptions)
  const client = input.client

  log(
    options.logLevel,
    "info",
    `loaded — tools=[${[...options.tools].join(",")}] ` +
      `preserveRecent=${options.preserveRecentMessages} ` +
      `preserveOldest=${options.preserveOldestMessages} ` +
      `minActivation=${options.minMessagesForActivation}`,
  )

  // Boot-time TTL cleanup (fail-open, async fire-and-forget).
  cleanupOldDumps(defaultDumpDir()).catch(() => undefined)

  // Registry: prune sessions whose `compactedAt` is older than 30 days.
  ;(async () => {
    try {
      const reg = await loadRegistry(options.registryPath)
      const before = Object.keys(reg.sessions).length
      if (before === 0) return
      const { removed } = cleanupOldEntries(reg, REGISTRY_TTL_MS)
      if (removed > 0) {
        await saveRegistry(options.registryPath, reg)
        log(options.logLevel, "info", `registry: pruned ${removed} stale session(s)`)
      }
    } catch {
      // fail-open
    }
  })()

  const hooks: Hooks = {
    // -----------------------------------------------------------------------
    // Phase 1/2: stale invalidation transform hook
    // -----------------------------------------------------------------------
    "experimental.chat.messages.transform": async (_hookInput, output) => {
      try {
        if (!output || !Array.isArray(output.messages) || output.messages.length === 0) return

        // Registry replay: applied unconditionally (regardless of warm-up
        // gate or preserve* knobs). These are explicit user decisions made
        // via ctxlite_compact and must take effect immediately.
        const sessionID = extractSessionID(output.messages)
        if (sessionID !== null) {
          try {
            const reg = await loadRegistry(options.registryPath)
            const pending = getCompactedForSession(reg, sessionID)
            const applied = applyRegistryCompactions(output.messages, pending)
            if (applied > 0) {
              log(
                options.logLevel,
                "info",
                `registry: applied ${applied} pending compaction(s) for session ${sessionID}`,
              )
            }
          } catch (regErr) {
            const m = regErr instanceof Error ? `${regErr.name}: ${regErr.message}` : String(regErr)
            log(options.logLevel, "info", `registry replay failed (fail-open) — ${m}`)
          }
        }

        if (output.messages.length < options.minMessagesForActivation) {
          log(
            options.logLevel,
            "debug",
            `skipped — ${output.messages.length} messages < minMessagesForActivation=${options.minMessagesForActivation}`,
          )
          return
        }

        const inputs = collectAnalyzerInputs(
          output.messages,
          options.preserveRecentMessages,
          options.preserveOldestMessages,
        )
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
        const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        log(options.logLevel, "info", `ERROR (fail-open) — ${msg}`)
      }
    },

    // -----------------------------------------------------------------------
    // Layer C: custom tools
    // -----------------------------------------------------------------------
    tool: {
      ctxlite_dump: tool({
        description:
          "Snapshot the current session's context usage to markdown + JSON files. " +
          "Returns a summary with token counts, top offenders, and cleanup candidates. " +
          "Use ctxlite_compact to act on flagged parts.",
        args: {
          output_dir: tool.schema.string().optional().describe("Output directory. Default: OS tmpdir/ctxlite-dumps/"),
          include_startup: tool.schema.boolean().optional().describe("Include startup overhead section. Default true (best-effort)."),
          verbosity: tool.schema.enum(["minimal", "normal", "verbose"]).optional().describe("Output verbosity. Default: normal"),
        },
        async execute(args, context) {
          try {
            const verbosity = (args.verbosity ?? "normal") as "minimal" | "normal" | "verbose"
            const dumpDir = typeof args.output_dir === "string" ? args.output_dir : defaultDumpDir()
            const sessionId = context.sessionID

            // Fetch session messages via SDK client.
            const messagesResult = await client.session.messages({
              path: { id: sessionId },
            })
            if (messagesResult.error) {
              return JSON.stringify({
                error: "Failed to fetch session messages",
                detail: String(messagesResult.error),
              })
            }

            const rawMessages = (messagesResult.data ?? []) as Array<{
              info: { id: string; role: string; sessionID?: string }
              parts: Part[]
            }>

            const dumpMessages = toRawMessages(rawMessages)
            const dumpData = buildDump(dumpMessages, sessionId, {
              verbosity,
              include_startup: args.include_startup ?? true,
            })

            // Ensure output directory exists.
            await mkdir(dumpDir, { recursive: true })

            const rnd = randomBytes(4).toString("hex")
            const ts = Date.now()
            const baseName = `dump_${ts}_${rnd}`
            const mdPath = path.join(dumpDir, `${baseName}.md`)
            const jsonPath = path.join(dumpDir, `${baseName}.json`)

            const mdContent = serializeMarkdown(dumpData, verbosity)
            const jsonContent = serializeJson(dumpData, verbosity)

            await writeFile(mdPath, mdContent, "utf8")
            await writeFile(jsonPath, jsonContent, "utf8")

            const summary = {
              markdown_path: mdPath,
              json_path: jsonPath,
              summary: {
                total_tokens: dumpData.totalTokens,
                used_pct: dumpData.usedPct,
                n_messages: dumpData.messages.length,
                n_parts: dumpData.messages.reduce((s, m) => s + m.parts.length, 0),
                n_already_compacted: dumpData.nAlreadyCompacted,
                top_offenders: dumpData.topOffenders.slice(0, 5).map((o) => ({
                  part_id: o.partId,
                  tokens: o.tokens,
                  type: o.tool ? `${o.type}(${o.tool})` : o.type,
                })),
                cleanup_candidates_count: dumpData.cleanupCandidates.length,
              },
            }

            return JSON.stringify(summary)
          } catch (err) {
            // Fail-open: return structured error, never throw.
            return JSON.stringify({
              error: "ctxlite_dump failed",
              detail: err instanceof Error ? err.message : String(err),
            })
          }
        },
      }),

      ctxlite_compact: tool({
        description:
          "Surgical context compaction: mark selected parts as compacted so opencode " +
          "renders them as '[Old tool result content cleared]'. " +
          "dryRun defaults to true — inspect the preview before applying. " +
          "Safety: the most recent live tool_result per tracked path is always preserved.",
        args: {
          selector: tool.schema
            .object({
              partIds: tool.schema.array(tool.schema.string()).optional().describe("Explicit part IDs to compact"),
              filter: tool.schema
                .object({
                  type: tool.schema
                    .enum(["text", "reasoning", "tool_use", "tool_result"])
                    .optional()
                    .describe("Part type to match"),
                  tool: tool.schema.string().optional().describe("Tool name to match (for tool_result)"),
                  olderThanMessages: tool.schema.number().optional().describe("Only parts from messages older than N most recent"),
                  largerThanTokens: tool.schema.number().optional().describe("Only parts with tokens > this value"),
                  flaggedAs: tool.schema.array(tool.schema.string()).optional().describe("Only parts with all of these ctxlite flags"),
                })
                .optional(),
            })
            .describe("Selector for parts to compact"),
          dryRun: tool.schema.boolean().optional().describe("Preview only, no mutation. Default: true"),
          confirmLargeOperation: tool.schema
            .boolean()
            .optional()
            .describe("Required to apply operations affecting >20 parts or >10000 tokens"),
        },
        async execute(args, context) {
          try {
            const dryRun = args.dryRun !== false // default true
            const confirmLargeOperation = args.confirmLargeOperation === true
            const sessionId = context.sessionID

            // Fetch session messages.
            const messagesResult = await client.session.messages({
              path: { id: sessionId },
            })
            if (messagesResult.error) {
              return JSON.stringify({
                error: "Failed to fetch session messages",
                detail: String(messagesResult.error),
              })
            }

            const rawMessages = (messagesResult.data ?? []) as Array<{
              info: { id: string; role: string; sessionID?: string }
              parts: Part[]
            }>

            // Build selectable parts (with token estimates and flags).
            // For compact, we don't need full heuristic flags unless flaggedAs filter is used.
            // Since we can't get flags cheaply here (would need full buildDump run),
            // we build them lazily — run buildDump only when flaggedAs is used.
            const selector = args.selector as CompactSelector
            const needsFlags =
              selector.filter?.flaggedAs !== undefined && selector.filter.flaggedAs.length > 0

            let flagsByPartId = new Map<string, string[]>()
            if (needsFlags) {
              const rawForDump = toRawMessages(rawMessages)
              const dumpData = buildDump(rawForDump, sessionId, {
                verbosity: "minimal",
                include_startup: false,
              })
              for (const candidate of dumpData.cleanupCandidates) {
                flagsByPartId.set(candidate.partId, [...candidate.flags])
              }
            }

            const selectableParts = toSelectableParts(
              rawMessages as Array<{ parts: Part[] }>,
              flagsByPartId,
            )

            const protectedIds = buildProtectedSet(rawMessages as Array<{ parts: Part[] }>)

            const plan = planCompaction(
              selectableParts,
              selector,
              protectedIds,
              rawMessages.length,
              confirmLargeOperation,
            )

            if (plan.requiresConfirmation || dryRun) {
              // Preview mode (also forced when requiresConfirmation).
              return JSON.stringify({
                mode: plan.requiresConfirmation ? "dry_run_forced" : "dry_run",
                would_compact: plan.affectedItems.length,
                tokens_recovered_estimate: plan.tokensRecoveredEstimate,
                requires_confirmation: plan.requiresConfirmation,
                message: plan.confirmationMessage,
                parts: plan.affectedItems,
              })
            }

            // Persist via the on-disk registry. The transform hook reads it
            // on every subsequent turn and re-applies the mutations to the
            // outgoing payload. This works on both desktop and web because
            // it doesn't depend on opencode's HTTP API at all.
            const targetIds = plan.affectedItems.map((i) => i.part_id)
            const reg = await loadRegistry(options.registryPath)
            const { added, total } = addToRegistry(reg, sessionId, targetIds)
            await saveRegistry(options.registryPath, reg)

            // Also mutate the in-memory copy that the next transform-hook
            // invocation will receive. This is best-effort; the registry
            // is the source of truth.
            const compacted = applyRegistryCompactions(
              rawMessages as Array<{ parts: Part[] }>,
              new Set(targetIds),
            )

            log(
              options.logLevel,
              "info",
              `ctxlite_compact: registered ${added} new partId(s), ` +
                `${total} total in registry for this session, ` +
                `${compacted} mutated in-memory, ~${plan.tokensRecoveredEstimate} tokens estimated`,
            )

            return JSON.stringify({
              mode: "applied",
              registered: added,
              total_in_registry: total,
              compacted_in_memory: compacted,
              tokens_recovered_estimate: plan.tokensRecoveredEstimate,
              registry_path: options.registryPath,
            })
          } catch (err) {
            return JSON.stringify({
              error: "ctxlite_compact failed",
              detail: err instanceof Error ? err.message : String(err),
            })
          }
        },
      }),
    },
  }

  return hooks
}

// opencode requires `id` for file:// plugins (see opencode/src/plugin/shared.ts:313)
// and `server` as the main hook factory.
export default {
  id: "ctxlite",
  server,
}
