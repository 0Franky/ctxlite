/**
 * Test fixtures: minimal builders for AnalyzerInput shapes used by the
 * invalidation analyzer. Independent from opencode types so tests can run
 * without bringing in the full SDK surface.
 */

import type { AnalyzerInput } from "../src/invalidation.ts"
import type { ResolvedOptions, ToolPartView } from "../src/types.ts"

export const DEFAULT_OPTS: ResolvedOptions = {
  tools: new Set(["read", "edit", "apply_patch"]),
  logLevel: "silent",
  preserveRecentMessages: 0,
}

export interface ReadFixtureArgs {
  readonly path: string
  readonly offset?: number
  readonly limit?: number
  readonly compacted?: boolean
}

export interface EditFixtureArgs {
  readonly path: string
  readonly compacted?: boolean
}

let nextIdx = 0

/** Reset the auto-incrementing partIdx (call at the start of each test). */
export function resetIdx(): void {
  nextIdx = 0
}

function makeView(tool: string, input: Record<string, unknown>, compacted: boolean): ToolPartView {
  return {
    tool,
    input,
    eligible: true,
    alreadyCompacted: compacted,
  }
}

export function readPart(args: ReadFixtureArgs): AnalyzerInput {
  const input: Record<string, unknown> = { filePath: args.path }
  if (args.offset !== undefined) input["offset"] = args.offset
  if (args.limit !== undefined) input["limit"] = args.limit
  return {
    location: { messageIdx: 0, partIdx: nextIdx++ },
    view: makeView("read", input, args.compacted ?? false),
  }
}

export function editPart(args: EditFixtureArgs): AnalyzerInput {
  return {
    location: { messageIdx: 0, partIdx: nextIdx++ },
    view: makeView(
      "edit",
      { filePath: args.path, oldString: "X", newString: "Y" },
      args.compacted ?? false,
    ),
  }
}

export function applyPatchPart(compacted = false): AnalyzerInput {
  return {
    location: { messageIdx: 0, partIdx: nextIdx++ },
    view: makeView("apply_patch", { patchText: "*** Begin Patch\n*** End Patch" }, compacted),
  }
}
