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
