import type { FileRange, FileRef, FileToolKind } from "./types.ts"

/**
 * Single source of truth for the file-touching tools ctxlite recognizes.
 * Adding support for a new tool requires:
 *   1. Adding its name here.
 *   2. Adding a case in `extractFileRef` below.
 *   3. (Optional) Adding it to `DEFAULT_TRACKED_TOOLS` if it should be tracked
 *      by default; otherwise users opt in via the `tools` config option.
 */
export const KNOWN_FILE_TOOLS: readonly FileToolKind[] = ["read", "edit", "apply_patch"]

/**
 * Tools enabled by default when the user does not override `options.tools`.
 * `apply_patch` is excluded because v1 cannot extract paths from `patchText`.
 */
export const DEFAULT_TRACKED_TOOLS: readonly FileToolKind[] = ["read", "edit"]

/**
 * Range that matches "every line of the file".
 * Used for Edit/apply_patch (whole-file affected) and for Read calls without
 * an explicit `offset`/`limit` (full-file read).
 */
export const FULL_RANGE: FileRange = { start: 1, end: undefined }

/**
 * Normalize a filesystem path so different spellings of the same file
 * produce the same key. opencode tools accept absolute paths only and the
 * runtime resolves them, but defensive normalization protects against
 * inconsistent casing on Windows and stray backslashes.
 */
export function normalizePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) return ""
  let p = input.replace(/\\/g, "/")
  // Collapse duplicate separators ("C:\\foo\\\\bar" → "C:/foo/bar").
  p = p.replace(/\/{2,}/g, "/")
  // Strip trailing slash unless it's a root ("/" or "C:/").
  if (p.length > 1 && p.endsWith("/") && !/^[A-Za-z]:\/$/.test(p)) {
    p = p.slice(0, -1)
  }
  // Lowercase Windows drive letters for stable comparison.
  p = p.replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
  return p
}

/**
 * Convert opencode's `offset` (1-indexed start line) and `limit` (line count)
 * into a `FileRange`. Defensive against non-number values.
 */
function buildRange(offset: unknown, limit: unknown): FileRange {
  const start = typeof offset === "number" && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 1
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return { start, end: undefined }
  }
  const end = start + Math.floor(limit) - 1
  return { start, end: end < start ? start : end }
}

/**
 * Extract a `FileRef` from the input of a known file-touching tool.
 *
 * Returns `null` for unsupported tools, or when the input lacks a usable
 * `filePath` (e.g. malformed model output). The caller treats `null` as
 * "skip this part" and never throws — extraction is best-effort.
 */
export function extractFileRef(toolName: string, input: Record<string, unknown> | null | undefined): FileRef | null {
  if (input === null || input === undefined || typeof input !== "object") return null

  switch (toolName) {
    case "read": {
      const filePath = input["filePath"]
      if (typeof filePath !== "string" || filePath.length === 0) return null
      return {
        path: normalizePath(filePath),
        range: buildRange(input["offset"], input["limit"]),
      }
    }
    case "edit": {
      const filePath = input["filePath"]
      if (typeof filePath !== "string" || filePath.length === 0) return null
      // Edit can affect any line — treat as full-file invalidator.
      return { path: normalizePath(filePath), range: FULL_RANGE }
    }
    case "apply_patch": {
      // Path extraction from patchText is not implemented in v1.
      // The patch parser lives in opencode/src/patch and parsing it correctly
      // requires reproducing logic outside this plugin; deferred until tier 2.
      return null
    }
    default:
      return null
  }
}

/**
 * `true` iff `outer` covers every line of `inner`. Both ranges must share a
 * path; the caller checks that. An open-ended `end` (undefined) means EOF —
 * any closed range is a subset of an open-ended range that starts no later.
 */
export function rangeContains(outer: FileRange, inner: FileRange): boolean {
  if (inner.start < outer.start) return false
  if (outer.end === undefined) return true // outer is open-ended → covers everything from outer.start.
  if (inner.end === undefined) return false // inner extends to EOF, outer doesn't → not contained.
  return inner.end <= outer.end
}

/** Structural equality of two `FileRange` values. */
export function rangesEqual(a: FileRange, b: FileRange): boolean {
  return a.start === b.start && a.end === b.end
}
