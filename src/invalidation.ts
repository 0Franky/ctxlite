import { extractFileRef, rangeContains, rangesEqual } from "./extract-path.ts"
import type { FileRange, InvalidationDecision, PartLocation, ResolvedOptions, ToolPartView } from "./types.ts"

/**
 * Coordinates of a tool_result currently providing live content for a path.
 * Compacted parts are NOT in this set: their `output` already reads as
 * "[Old tool result content cleared]" and so they cannot supersede or be
 * superseded by content comparisons.
 */
interface ActiveView {
  readonly location: PartLocation
  readonly tool: "read" | "edit" | "apply_patch"
  readonly range: FileRange
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

  for (const entry of parts) {
    const { view, location } = entry
    if (!view.eligible) continue
    if (!options.tools.has(view.tool)) continue

    const ref = extractFileRef(view.tool, view.input)
    if (ref === null) continue

    if (view.tool === "edit" || view.tool === "apply_patch") {
      const active = activeByPath.get(ref.path)
      if (active !== undefined) {
        for (const prior of active) {
          decisions.push({
            location: prior.location,
            reason: prior.tool === "read" ? "edit-supersedes-prior-read" : "edit-supersedes-prior-edit",
          })
        }
      }
      // Replace the active set: only keep the edit itself, and only if it's live.
      activeByPath.set(
        ref.path,
        view.alreadyCompacted ? [] : [{ location, tool: view.tool, range: ref.range }],
      )
      continue
    }

    if (view.tool === "read") {
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
      if (!view.alreadyCompacted) {
        surviving.push({ location, tool: "read", range: ref.range })
      }
      activeByPath.set(ref.path, surviving)
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
