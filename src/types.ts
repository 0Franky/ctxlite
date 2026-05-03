/**
 * Internal types for ctxlite. Independent from opencode types so the pure logic
 * (invalidation, path extraction) can be tested in isolation.
 *
 * The plugin entrypoint adapts opencode's MessageV2/Part shapes onto these.
 */

/**
 * Tools whose tool_result content represents a file snapshot we want to manage.
 * `"write"` is included because a write fully replaces file content, making
 * every prior read/edit/write on the same path stale.
 */
export type FileToolKind = "read" | "edit" | "apply_patch" | "write"

/**
 * Inclusive line range. `end === undefined` means open-ended ("until EOF").
 * Lines are 1-indexed (matching opencode's `offset` semantics: `offset` is the
 * starting line number, `limit` is the count).
 */
export interface FileRange {
  readonly start: number
  readonly end: number | undefined
}

/** A normalized reference to a file mentioned by a tool input. */
export interface FileRef {
  /** Normalized absolute path (forward slashes). May be empty if extraction failed gracefully. */
  readonly path: string
  /** Line range affected by the tool call. Edits use a sentinel "any" range. */
  readonly range: FileRange
}

/**
 * A minimal view of a tool_result part — only the fields ctxlite needs.
 * The plugin entrypoint maps opencode's ToolPart onto this shape.
 */
export interface ToolPartView {
  /** Tool name as registered in the registry, e.g. "read", "edit", "write", "bash". */
  readonly tool: string
  /** Parsed input the tool was invoked with. */
  readonly input: Record<string, unknown>
  /** The text output produced by the tool call. Empty string if none. */
  readonly output: string
  /** Whether the part is in the "completed" state and not already compacted. */
  readonly eligible: boolean
  /** Set when ctxlite (or another mechanism) already invalidated this part. */
  readonly alreadyCompacted: boolean
}

/** Coordinates of a single ToolPart inside the message history. */
export interface PartLocation {
  readonly messageIdx: number
  readonly partIdx: number
}

/** A decision produced by the invalidation analyzer. */
export interface InvalidationDecision {
  readonly location: PartLocation
  /** Why the part is being invalidated. Surfaced in logs for debugging. */
  readonly reason:
    | "edit-supersedes-prior-read"
    | "read-superset-supersedes-prior-read"
    | "edit-supersedes-prior-edit"
    | "duplicate-read"
    | "write-supersedes-prior"
    | "error-superseded-by-success"
    | "bash-error-superseded-by-success"
    | "duplicate-bash"
}

/** Configuration honored by the plugin. */
export interface CtxliteOptions {
  /**
   * Tools to track. Defaults to `["read", "edit"]`. Add `"apply_patch"` once
   * patch-text path extraction is implemented.
   */
  readonly tools?: readonly string[]
  /** Verbosity. `"silent"` suppresses all output. */
  readonly logLevel?: "silent" | "info" | "debug"
  /**
   * Skip tool_results within the most recent N messages. Default 0
   * (only the part being constructed is implicitly skipped via `eligible`).
   */
  readonly preserveRecentMessages?: number
}

export interface ResolvedOptions {
  readonly tools: ReadonlySet<string>
  readonly logLevel: "silent" | "info" | "debug"
  readonly preserveRecentMessages: number
}

// ---------------------------------------------------------------------------
// Layer C: ctxlite_dump and ctxlite_compact types
// ---------------------------------------------------------------------------

/** Human-readable flag names produced by heuristic analysis. */
export type FlagName =
  | "dead-reasoning"
  | "superseded-tool-result"
  | "large-error"
  | "oversized-bash-output"
  | "duplicate-text"
// "unused-mcp-description" deferred for v1 (tool-call-counter not cheaply available)

/** A part that carries one or more heuristic flags. */
export interface FlaggedPart {
  readonly partId: string
  readonly messageIdx: number
  readonly partIdx: number
  readonly type: string
  /** Tool name if type === "tool", else undefined. */
  readonly tool?: string
  readonly tokens: number
  readonly flags: readonly FlagName[]
  /** Short content preview (up to 200 chars). */
  readonly preview: string
}

/** Verbosity level for dump output. */
export type DumpVerbosity = "minimal" | "normal" | "verbose"

/** Options accepted by the dump logic. */
export interface DumpOptions {
  readonly verbosity: DumpVerbosity
  /** Whether to attempt startup overhead reporting. */
  readonly include_startup: boolean
}

/** A single message-level row in the dump. */
export interface DumpMessage {
  readonly messageIdx: number
  readonly messageId: string
  readonly role: string
  readonly parts: readonly DumpPart[]
}

/** A single part row in the dump. */
export interface DumpPart {
  readonly partId: string
  readonly type: string
  readonly tool?: string
  readonly tokens: number
  readonly alreadyCompacted: boolean
  readonly flags: readonly FlagName[]
  readonly preview: string
}

/** Fully-computed dump data (pure; no I/O). */
export interface DumpData {
  readonly sessionId: string
  readonly generatedAt: number
  readonly totalTokens: number
  readonly usedPct: number
  /** Hardcoded fallback context window; 200_000 if not derivable. */
  readonly contextWindowTokens: number
  readonly messages: readonly DumpMessage[]
  readonly topOffenders: readonly Array<{ partId: string; tokens: number; type: string; tool?: string }>
  readonly cleanupCandidates: readonly FlaggedPart[]
  readonly nAlreadyCompacted: number
}

// ---------------------------------------------------------------------------
// Layer C: ctxlite_compact types
// ---------------------------------------------------------------------------

/** Filter criteria for selecting parts to compact. */
export interface CompactFilter {
  readonly type?: "text" | "reasoning" | "tool_use" | "tool_result"
  readonly tool?: string
  readonly olderThanMessages?: number
  readonly largerThanTokens?: number
  readonly flaggedAs?: readonly string[]
}

/** Selector used by ctxlite_compact. */
export interface CompactSelector {
  readonly partIds?: readonly string[]
  readonly filter?: CompactFilter
}

/** An item in the compaction plan with rationale. */
export interface CompactPlanItem {
  readonly part_id: string
  readonly type: string
  readonly tokens: number
  readonly reason: string
}

/** Result of planCompaction: what would be (or was) compacted. */
export interface CompactionPlan {
  readonly affectedItems: readonly CompactPlanItem[]
  readonly tokensRecoveredEstimate: number
  /** True if massive-op guard was triggered. */
  readonly requiresConfirmation: boolean
  readonly confirmationMessage?: string
}
