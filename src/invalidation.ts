import { extractBashRef, extractFileRef, isErrorOutput, rangeContains, rangesEqual } from "./extract-path.ts"
import type { FileRange, InvalidationDecision, PartLocation, ResolvedOptions, ToolPartView } from "./types.ts"

/**
 * Coordinates of a tool_result currently providing live content for a path.
 * Compacted parts are NOT in this set: their `output` already reads as
 * "[Old tool result content cleared]" and so they cannot supersede or be
 * superseded by content comparisons.
 */
interface ActiveView {
  readonly location: PartLocation
  readonly tool: "read" | "edit" | "apply_patch" | "write"
  readonly range: FileRange
}

/**
 * State kept per bash command key for the bash error-retry and duplicate
 * detectors. Tracks prior errored locations and the most recent live (non-
 * compacted) output keyed by location so duplicate detection can compare.
 */
interface BashKeyState {
  /** Locations of errored (isErrorOutput === true) bash results, not yet superseded. */
  erroredLocations: PartLocation[]
  /** All live (non-compacted) entries: location + output, for duplicate detection. */
  liveEntries: Array<{ location: PartLocation; output: string }>
}

/**
 * The complete input view of a single ToolPart that the analyzer needs:
 * its location, the tool view, plus a flag indicating whether opencode (or a
 * prior ctxlite run) already invalidated the output via `state.time.compacted`.
 */
export interface AnalyzerInput {
  readonly location: PartLocation
  readonly view: ToolPartView
}

/**
 * Decide which past ToolPart entries should be marked as compacted.
 *
 * Algorithm — single forward pass:
 *
 *   For every completed tool_result of a tracked file-touching tool we
 *   maintain a per-path "active set" of live (non-compacted) views.
 *
 *   • Edit / apply_patch on a path: every live prior view for that path
 *     becomes stale (file content changed) → emit decisions against them.
 *     If the edit itself is live, it becomes the sole new active view;
 *     if it is already compacted, the active set for that path is cleared.
 *
 *   • Read on a path: the new range is compared to prior live reads; any
 *     prior read fully covered by the new range is superseded. The new
 *     read joins the active set unless it is already compacted.
 *
 *   • Already-compacted parts still PARTICIPATE in the walk (a compacted
 *     Edit still indicates the file changed, so prior reads must be
 *     invalidated) but never RECEIVE a decision (it would be a no-op).
 *
 *   • The most recent live view for every path is implicitly preserved:
 *     it is processed last; the algorithm only decides against PRIOR
 *     entries; therefore the current live view is never targeted.
 *
 * The function is pure: it produces a list of decisions and never mutates
 * its inputs. The plugin entrypoint applies decisions onto the live tree.
 *
 * Idempotent: re-running on a history that has already been processed
 * yields zero new decisions, because every previously-targeted part is
 * now `alreadyCompacted` and decisions against it are filtered out.
 */
export function decideInvalidations(parts: readonly AnalyzerInput[], options: ResolvedOptions): InvalidationDecision[] {
  const decisions: InvalidationDecision[] = []
  const activeByPath = new Map<string, ActiveView[]>()
  /** Per-path errored locations (for error-superseded-by-success, file tools). */
  const erroredByPath = new Map<string, PartLocation[]>()
  /** Per-bash-key state (error-retry + duplicate detectors). */
  const bashByKey = new Map<string, BashKeyState>()

  for (const entry of parts) {
    const { view, location } = entry
    if (!view.eligible) continue
    if (!options.tools.has(view.tool)) continue

    // ------------------------------------------------------------------ bash
    if (view.tool === "bash") {
      const bashRef = extractBashRef(view.input)
      if (bashRef === null) continue

      const key = bashRef.key
      if (!bashByKey.has(key)) bashByKey.set(key, { erroredLocations: [], liveEntries: [] })
      // Non-null assertion is safe: we just set it above.
      const state = bashByKey.get(key)!

      const thisIsError = isErrorOutput("bash", view.output)

      if (!thisIsError && view.output.length > 0) {
        // Detector: bash-error-superseded-by-success — invalidate all prior errored
        if (state.erroredLocations.length > 0) {
          for (const errLoc of state.erroredLocations) {
            decisions.push({ location: errLoc, reason: "bash-error-superseded-by-success" })
          }
          state.erroredLocations = []
        }

        // Detector: duplicate-bash — if same non-empty output seen in an adjacent
        // message (within 2 indices), invalidate the prior. Non-adjacent duplicates
        // are preserved: the same command run far apart likely had different intent.
        const survivingLive: typeof state.liveEntries = []
        for (const prior of state.liveEntries) {
          const distance = location.messageIdx - prior.location.messageIdx
          if (
            distance > 0 &&
            distance <= 2 &&
            prior.output === view.output &&
            prior.output.length > 0
          ) {
            decisions.push({ location: prior.location, reason: "duplicate-bash" })
          } else {
            survivingLive.push(prior)
          }
        }
        if (!view.alreadyCompacted) survivingLive.push({ location, output: view.output })
        state.liveEntries = survivingLive
      } else if (thisIsError) {
        // Record as errored (only if not already compacted — compacted cannot be superseded meaningfully)
        if (!view.alreadyCompacted) {
          state.erroredLocations.push(location)
        }
        // Errored entries don't join liveEntries for duplicate detection.
      }
      // If output is empty and not an error, treat as no-op for both detectors.
      continue
    }

    // ------------------------------------------------------------- file tools
    const ref = extractFileRef(view.tool, view.input)
    if (ref === null) continue

    if (view.tool === "edit" || view.tool === "apply_patch" || view.tool === "write") {
      const active = activeByPath.get(ref.path)
      if (active !== undefined) {
        for (const prior of active) {
          const reason =
            view.tool === "write"
              ? "write-supersedes-prior"
              : prior.tool === "read"
                ? "edit-supersedes-prior-read"
                : "edit-supersedes-prior-edit"
          decisions.push({ location: prior.location, reason })
        }
      }
      // Any errored entries for this path are now stale too (file was rewritten).
      // Clear them so they don't get re-invalidated by the error-retry detector.
      erroredByPath.set(ref.path, [])
      // Replace the active set: only keep this part if it's live.
      activeByPath.set(
        ref.path,
        view.alreadyCompacted ? [] : [{ location, tool: view.tool as "edit" | "apply_patch" | "write", range: ref.range }],
      )
      continue
    }

    if (view.tool === "read") {
      const thisIsError = isErrorOutput("read", view.output)

      const active = activeByPath.get(ref.path) ?? []
      const surviving: ActiveView[] = []
      for (const prior of active) {
        if (prior.tool === "read" && rangeContains(ref.range, prior.range)) {
          decisions.push({
            location: prior.location,
            reason: rangesEqual(ref.range, prior.range) ? "duplicate-read" : "read-superset-supersedes-prior-read",
          })
          continue
        }
        surviving.push(prior)
      }
      if (!view.alreadyCompacted && !thisIsError) {
        surviving.push({ location, tool: "read", range: ref.range })
      }
      activeByPath.set(ref.path, surviving)

      // Error-retry detector for read.
      if (!thisIsError) {
        const errored = erroredByPath.get(ref.path)
        if (errored !== undefined && errored.length > 0) {
          for (const errLoc of errored) {
            decisions.push({ location: errLoc, reason: "error-superseded-by-success" })
          }
          erroredByPath.set(ref.path, [])
        }
      } else if (!view.alreadyCompacted) {
        // This read errored — record it.
        const existing = erroredByPath.get(ref.path) ?? []
        existing.push(location)
        erroredByPath.set(ref.path, existing)
      }
      continue
    }
  }

  // Filter out decisions that would target an already-compacted part — those
  // are no-ops and would be confusing in the log. We do this after the walk
  // (rather than skipping them inline) to keep the algorithm symmetric and
  // make idempotency reasoning straightforward.
  //
  // O(n+m) instead of O(n*m): build an index once and look up each decision.
  const compactedKeys = new Set<string>()
  for (const p of parts) {
    if (p.view.alreadyCompacted) compactedKeys.add(locationKey(p.location))
  }
  return decisions.filter((d) => !compactedKeys.has(locationKey(d.location)))
}

function locationKey(loc: PartLocation): string {
  return `${loc.messageIdx}:${loc.partIdx}`
}
