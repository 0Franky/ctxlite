/**
 * Test fixtures: minimal builders for AnalyzerInput shapes used by the
 * invalidation analyzer. Independent from opencode types so tests can run
 * without bringing in the full SDK surface.
 */

import type { AnalyzerInput } from "../src/invalidation.ts"
import type { ResolvedOptions, ToolPartView } from "../src/types.ts"

export const DEFAULT_OPTS: ResolvedOptions = {
  tools: new Set(["read", "edit", "apply_patch", "write", "bash"]),
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

function makeView(tool: string, input: Record<string, unknown>, compacted: boolean, output = ""): ToolPartView {
  return {
    tool,
    input,
    output,
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

export interface WriteFixtureArgs {
  readonly path: string
  readonly compacted?: boolean
  readonly output?: string
}

export function writePart(args: WriteFixtureArgs): AnalyzerInput {
  return {
    location: { messageIdx: 0, partIdx: nextIdx++ },
    view: makeView("write", { filePath: args.path }, args.compacted ?? false, args.output ?? ""),
  }
}

export interface BashFixtureArgs {
  readonly command: string
  readonly cwd?: string
  readonly output?: string
  readonly compacted?: boolean
}

export function bashPart(args: BashFixtureArgs): AnalyzerInput {
  const input: Record<string, unknown> = { command: args.command }
  if (args.cwd !== undefined) input["cwd"] = args.cwd
  return {
    location: { messageIdx: 0, partIdx: nextIdx++ },
    view: makeView("bash", input, args.compacted ?? false, args.output ?? ""),
  }
}
