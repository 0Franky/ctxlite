# Context Optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three-layer context optimization toolkit defined in `docs/superpowers/specs/2026-05-03-context-optimization-design.md`: ag-mcp-server hardening (Layer A), ctxlite v2 detectors (Layer B), ctxlite_dump and ctxlite_compact (Layer C).

**Architecture:** Three orthogonal layers with shared utilities where appropriate. Layer A is a Node.js MCP server in `../ag-mcp-server/`. Layers B and C extend the existing TypeScript/Bun plugin in `./` (ctxlite). Pure logic separated from adapters; TDD throughout.

**Tech Stack:** Node.js (ag-mcp-server, JS/ESM), TypeScript + Bun (ctxlite), `@modelcontextprotocol/sdk`, `@opencode-ai/plugin`, `@opencode-ai/sdk`, Anthropic SDK (optional summarizer), `node:test` (ag-mcp-server), `bun:test` (ctxlite).

**Working directories:**
- Phase 1 operates on `../ag-mcp-server/` (sibling repo).
- Phase 2 and Phase 3 operate on `./` (this ctxlite repo).

**Phases:**
- **Phase 1** (Tasks 1.1–1.18) — Layer A in ag-mcp-server.
- **Phase 2** (Tasks 2.1–2.10) — Layer B in ctxlite.
- **Phase 3** (Tasks 3.1–3.14) — Layer C in ctxlite.

Each phase is independently shippable. Commit after every task. Run `bun test` (ctxlite) or `node --test` (ag-mcp-server) after every implementation step.

---

# PHASE 1 — Layer A (ag-mcp-server)

## Task 1.1: Project setup

**Files:** Modify `../ag-mcp-server/package.json`; create directory tree under `src/` and `test/`.

- [ ] **Step 1**: Update package.json — bump version to 2.0.0, set `main: "src/server.js"`, add `"test": "node --test test/"` script, add `@anthropic-ai/sdk` to dependencies.
- [ ] **Step 2**: Create directories: `src/{logs,truncation,shell,summarizer,tools}` and matching `test/` subdirs.
- [ ] **Step 3**: `npm install`.
- [ ] **Step 4**: Commit `chore(ag-mcp-server): scaffold v2 directory structure and test framework`.

## Task 1.2: LOGS_DIR resolution

**Files:** Create `src/logs/logs-dir.js` + `test/logs/logs-dir.test.js`.

Resolves LOGS_DIR from env override `AG_LOGS_DIR` or default `os.tmpdir()/ag-mcp-logs/{pid}/`. Uses `path.join`, never string concatenation.

- [ ] Test (3 cases): default under tmpdir, env override, pid in path.
- [ ] Implement `resolveLogsDir({ env, pid })` exporting from `logs-dir.js`.
- [ ] Run `node --test test/logs/logs-dir.test.js` → 3 of 3 pass.
- [ ] Commit `feat(logs): resolve LOGS_DIR via os.tmpdir + env override`.

## Task 1.3: Logs cleanup (TTL + startup)

**Files:** Create `src/logs/logs-cleanup.js` + tests.

Functions: `cleanupOldLogs(dir, { ttlHours })` and `ensureLogsDir(dir)`. Cleanup walks dir, stats each file, removes those with mtime less than cutoff. Fail-open on missing dir.

- [ ] Test (3 cases): removes old, keeps fresh, returns empty on missing dir.
- [ ] Implement using `fs/promises` readdir/stat/unlink.
- [ ] Commit `feat(logs): TTL-based cleanup of old log files`.

## Task 1.4: Marker regex catalog

**Files:** Create `src/truncation/marker-regex.js` + tests.

Single compiled regex unioned across categories (shell errors, compiled langs, interpreted langs, build tools, test runners, linters, git, docker/k8s, http, db, stack frames, user markers like TODO/FIXME). Negative lookbehind on generic `error|fail|warning` to avoid "no errors found" false positives.

- [ ] Test (9 cases): catches generic errors, NOT "no errors found" / "0 errors", catches Rust/Python/JS/HTTP/TODO; user extra patterns added; MARKER_PATTERNS array exported.
- [ ] Implement: `MARKER_PATTERNS` array of regex source strings, `buildMarkerRegex({ extra })` joining with `|`, returns case-insensitive multi-line `RegExp`.
- [ ] Commit `feat(truncation): categorized marker regex with negative lookbehind`.

## Task 1.5: Command-class detection

**Files:** Create `src/truncation/command-class.js` + tests.

Strips wrappers (time/sudo/nice/nohup/env VAR=), takes last segment of `&&|;|||\\|`-chain, matches first token via dictionary (with subcommand support for cargo/npm/yarn/pnpm/git/go/dotnet/mvn/gradle/docker/kubectl). Falls back to `default`. Exports `BUDGETS` table with target/hard/huge for 11 classes (huge = hard times 5).

- [ ] Test (8 cases): enumerative, build via wrapper, test, git history vs status, strip wrappers, last-segment chain, fallback default, BUDGETS shape.
- [ ] Implement.
- [ ] Commit `feat(truncation): per-command-class detection with absolute budgets`.

## Task 1.6: Mode select (line vs char)

**Files:** Create `src/truncation/mode-select.js` + tests.

`countNewlines(s)` matches `/\r\n|\r|\n/g`. `selectMode(output)` returns `"line"` only if `newlines >= 20 AND avg_line_length <= 500`, else `"char"`.

- [ ] Test (4 cases): newline counting, line mode requires both conditions, char mode for huge single line, char for empty.
- [ ] Implement.
- [ ] Commit `feat(truncation): mode selection (line vs char-chunked)`.

## Task 1.7: Binary detection

**Files:** Create `src/truncation/binary-detect.js` + tests.

`isBinaryOutput(s)` samples first 4KB, returns true if non-printable ratio greater than 0.30. Considers tab/CR/LF + ASCII printable + UTF-8 (>=128) as printable.

- [ ] Test (5 cases): plain ASCII, UTF-8 with accents, high non-printable, empty, only-first-4KB-checked.
- [ ] Implement.
- [ ] Commit `feat(truncation): binary output detection`.

## Task 1.8: Line-mode head+tail+marker truncation

**Files:** Create `src/truncation/line-truncate.js` + tests.

`truncateLineMode(input, opts)` with opts headLines, tailLines, contextLines, maxSegments, markerRegex. If lines under head+tail, returns intact. Otherwise: head + `[N lines truncated]` + marker segments (line + plus/minus 2 context) + tail. Caps at maxSegments.

- [ ] Test (4 cases): pass intact, head+tail when exceeded, marker preservation with context, maxSegments cap.
- [ ] Implement using `split(/\r\n|\r|\n/)`.
- [ ] Commit `feat(truncation): line-mode head+tail+marker preservation`.

## Task 1.9: Char-chunked truncation

**Files:** Create `src/truncation/char-truncate.js` + tests.

`truncateCharMode(input, opts)` with opts headChars, tailChars, chunkSize, maxSegments, markerRegex. Same shape as line-mode but operates on char ranges; marker matches expand to a 256-char chunk centered on the match.

- [ ] Test (3 cases): pass intact below threshold, head+tail char ranges, marker chunk preservation.
- [ ] Implement.
- [ ] Commit `feat(truncation): char-chunked mode for dense output`.

## Task 1.10: Token estimation

**Files:** Create `src/truncation/token-estimate.js` + tests.

`estimateTokens(s) = Math.ceil(s.length / 3.5)`. Plus `estimateBytes(s)` using `Buffer.byteLength`.

- [ ] Test (4 cases): empty, ratio, rounds up, unicode.
- [ ] Implement.
- [ ] Commit `feat(truncation): token estimation via chars/3.5 heuristic`.

## Task 1.11: Summarizer (PATH C, optional)

**Files:** Create `src/summarizer/summarize.js` + tests.

`isSummarizerEnabled(env)` returns true only if both `AG_SUMMARIZER_MODEL` AND `AG_SUMMARIZER_API_KEY` are set. `buildSummaryPrompt({...})` returns the structured prompt. `summarizeOutput(...)` calls Anthropic SDK with the model from env, returns summary text + latencyMs + model + usage, or null on failure (fail-open). Logs to stderr.

- [ ] Test (4 cases): disabled when model unset, disabled when key unset, enabled when both, prompt content includes command/class/size/output.
- [ ] Implement using `@anthropic-ai/sdk`.
- [ ] Commit `feat(summarizer): config-only LLM summarizer for PATH C`.

## Task 1.12: Truncation orchestrator (decision tree)

**Files:** Create `src/truncation/truncate.js` + tests.

`truncateOutput({ output, command, logPath, env, anthropicClient })`:
1. If binary, bypass with marker text + log path.
2. Detect class, estimate tokens.
3. PATH A: tokens at most target[class] → return intact.
4. PATH C: tokens above huge[class] AND summarizer enabled → call summarizer; on success return summary text + footer.
5. PATH B (default and PATH C fallback): mode select → line or char truncate with marker regex; append footer with stats and log path.

- [ ] Test (5 cases): PATH A small, PATH B medium with marker, PATH C fallback when disabled, PATH C with mocked client returns summary, binary bypass.
- [ ] Implement.
- [ ] Commit `feat(truncation): three-path orchestrator`.

## Task 1.13: Shell detection (OS-aware)

**Files:** Create `src/shell/shell-detect.js` + tests.

`resolveShell({ env, platform, existsCheck })`. Honors `AG_BASH_SHELL`. Windows chain: Git Bash → PowerShell 7 (`pwsh.exe`) → Windows PowerShell → cmd.exe. Unix chain: `/bin/bash` → `/bin/sh`.

- [ ] Test (3 cases): env override, linux preference, windows chain (Git Bash > pwsh > cmd).
- [ ] Implement using `fs.existsSync` for default check, with mock-friendly `existsCheck` injection.
- [ ] Commit `feat(shell): OS-aware shell detection`.

## Task 1.14: Python detection (OS-aware)

**Files:** Create `src/shell/python-detect.js` + tests.

`resolvePython({ platform, existsCheck })` returns `{ cmd, args }` or null. Windows chain: `py -3` → `python` → `python3`. Unix chain: `python3` → `python`.

- [ ] Test (3 cases): Windows prefers py -3, Unix prefers python3, returns null when none.
- [ ] Implement using `spawnSync(cmd, ['--version'])` for default check (status 0 indicates presence).
- [ ] Commit `feat(shell): OS-aware Python detection`.

## Task 1.15: bash_capped tool

**Files:** Create `src/tools/bash-capped.js` + integration tests.

`runBashCapped({ command, cwd, logsDir, timeoutMs, env, anthropicClient })`:
1. ensureLogsDir, generate `cmd_{ts}_{rnd}.log` path.
2. resolveShell, build args (PowerShell uses `-NoLogo -NonInteractive -NoProfile -Command`; cmd.exe uses `/d /c`; bash/sh uses `-c`).
3. Spawn child via `node:child_process` `spawn` (no shell-injection surface). Capture stdout/stderr. Apply timeout via setTimeout + kill SIGTERM/SIGKILL.
4. Write FULL output to log file (COMMAND + STDOUT + STDERR + EXIT_CODE + DURATION + timeout note).
5. Build visible string with `[Exit Code: N TIMED OUT]` annotation.
6. Pass through `truncateOutput`.
7. Return `{ text, logPath, code, timedOut, durationMs, pathTaken, class }`.

- [ ] Test (2 cases): saves full log + truncated visible for `echo hello`, respects timeout for `sleep 10` with 500ms cap.
- [ ] Implement.
- [ ] Commit `feat(tools): bash_capped — orchestrates shell + log + truncation`.

## Task 1.16: peek_file tool

**Files:** Create `src/tools/peek-file.js` + tests.

`runPeekFile({ path, logsDir, env, anthropicClient })`:
1. Read file via `fs/promises`.
2. Save full content to `peek_{ts}_{rnd}.log`.
3. Pass through `truncateOutput`.
4. Return `{ text, logPath, pathTaken }`.

- [ ] Test (3 cases): small file intact, large file truncated with marker preservation, missing file returns error message.
- [ ] Implement.
- [ ] Commit `feat(tools): peek_file — content-aware truncation for huge files`.

## Task 1.17: js_analyzer and py_analyzer (refresh)

**Files:** Create `src/tools/js-analyzer.js`, `src/tools/py-analyzer.js` + tests.

Both follow same pattern: write `tmp_{ts}_{rnd}.{js|py}` script, spawn (`node script` for js; resolved Python interpreter for py), capture with timeout, unlink temp script in finally, save log of output, pass through `truncateOutput`. Returns `{ text, logPath, timedOut, code }`.

- [ ] Test (3 cases): trivial JS returns stdout, temp file cleanup, timeout respected.
- [ ] Implement js-analyzer.
- [ ] Implement py-analyzer using `resolvePython()`.
- [ ] Commit `feat(tools): refresh js/py analyzers — timeout, OS-aware, truncation pipeline`.

## Task 1.18: server.js — wire tools to MCP server

**Files:** Create `src/server.js`; replace `index.js` with shim re-export.

Server constructs `McpServer({ name, version: '2.0.0' })`. At startup: resolve LOGS_DIR, ensure exists, run cleanup, log result to stderr. Register four tools (`bash_capped`, `peek_file`, `execute_js_analyzer`, `execute_python_analyzer`) plus deprecated alias `sandboxed_bash` → `bash_capped` for backward compat. Each tool: zod schema for args, calls the matching `run*` function, returns `{ content: [{ type: 'text', text }], isError: bool }`.

- [ ] Implement `src/server.js` with stdio transport.
- [ ] Replace `index.js` content with `import './src/server.js'`.
- [ ] Smoke run, verify "ag-mcp v2.0.0 ready" line on stderr.
- [ ] Commit `feat(server): wire all tools + startup cleanup`.

---

# PHASE 2 — Layer B (ctxlite v2 detectors)

## Task 2.1: types.ts extensions

**Files:** Modify `src/types.ts`.

Extend `FileToolKind = "read" | "edit" | "write" | "apply_patch" | "bash"`. Add `BashCommandRef { binary, fullHash }`. Extend `ToolPartView` with `output: string` and `isError: boolean`. Extend `InvalidationReason` union with `"write-supersedes-prior" | "error-superseded-by-success" | "bash-error-superseded-by-success" | "duplicate-bash"`. Extend `CtxliteOptions` and `ResolvedOptions` with `enableDuplicateBash` and `bashCommandIdentity`.

- [ ] Update types.
- [ ] Run `bun run typecheck` (callers will surface errors fixed in subsequent tasks).
- [ ] Commit `feat(types): extend for v2 — write/bash tools, isError, new reasons`.

## Task 2.2: error-detection.ts

**Files:** Create `src/error-detection.ts` + `test/error-detection.test.ts`.

Per-tool regex patterns: read (ENOENT/EACCES/file not found/permission denied), edit (oldString not found / string is not unique / cannot read / patch failed), write (EACCES/EISDIR/EROFS/permission denied/cannot write/read-only), bash (`[COMMAND FAILED]` / `Exit Code: [1-9]` / `^Error:`).

`isErrorOutput(toolName, output)`: returns false on non-string/empty/unknown-tool/regex-throw. Otherwise tests pattern.

- [ ] Test (6 describe blocks, multiple cases each): each tool, unknown tool, garbled input fail-safe.
- [ ] Implement.
- [ ] Commit `feat(error-detection): per-tool isErrorOutput pattern matching`.

## Task 2.3: extract-path.ts — add write and bash

**Files:** Modify `src/extract-path.ts` + extend tests.

Add `case "write"` (returns FULL_RANGE on filePath like edit). Add `case "bash"` (returns null in extractFileRef — bash uses extractCommandIdentity instead). Add new export `extractCommandIdentity(rawCommand)`: strips wrappers (time/sudo/nice/nohup/env), takes last `&&|;|||\\|` segment, recognizes wrappers (cargo/npm/yarn/pnpm/git/go/dotnet/mvn/gradle/docker/kubectl) → `binary_subcommand`. Computes `fullHash` via djb2 of normalized whitespace command.

- [ ] Test write cases (2): full-range ref; missing filePath returns null.
- [ ] Test extractCommandIdentity (6 cases): simple binary, wrapper strip, known wrappers expand, last-segment chain, hash differs for different commands but normalizes whitespace, empty returns null.
- [ ] Implement.
- [ ] Commit `feat(extract-path): add write tool + extractCommandIdentity for bash`.

## Task 2.4: invalidation.ts — write, error-retry, bash detectors

**Files:** Replace `src/invalidation.ts` + new test file.

Walk now maintains: `activeByPath`, `errorByPath`, `errorByBinary`, `lastBashByBinary`. For each part:
- bash + isError → push to `errorByBinary[binary]`.
- bash + success → flush `errorByBinary[binary]` emitting `bash-error-superseded-by-success`; if `enableDuplicateBash` and `lastBashByBinary[binary].fullHash` matches current → emit `duplicate-bash` for prior. Update `lastBashByBinary[binary]`.
- read/edit/write + isError → push to `errorByPath[path]`.
- read/edit/write + success → flush `errorByPath[path]` emitting `error-superseded-by-success`; then existing logic (read superset, edit/write supersedes prior).

Keep idempotency filter (drop decisions on already-compacted parts).

- [ ] Test 8 new cases (B1–B4): write supersedes read, read error+success, isolated error preserved, bash error+success same binary, different binary preserved, duplicate-bash, intervening edit on different file (still invalidates per v1 choice), disable via option.
- [ ] Implement.
- [ ] Commit `feat(invalidation): add stale-write, error-retry, bash-error-retry, duplicate-bash`.

## Task 2.5: index.ts — wire isError into ToolPartView

**Files:** Modify `src/index.ts`.

Update `resolveOptions` to read new options. Update `toView`: read `output` from `state.output`, compute `isError = isErrorOutput(part.tool, output)`. Pass updated options into `decideInvalidations`.

- [ ] Update `index.ts`.
- [ ] Run `bun test` (full suite, all existing 35 + new tests).
- [ ] Commit `feat(index): pass isError flag and new options to invalidation`.

## Tasks 2.6 – 2.9: Smoke integration tests via real SDK types

Following the pattern of `test/smoke-integration.test.ts`, add four new smoke tests using real `@opencode-ai/sdk` ToolPart shapes:

- **2.6**: write supersedes read on real ToolPart tree.
- **2.7**: read error + read success — first marked compacted on live tree.
- **2.8**: bash error + bash success same binary — first marked compacted.
- **2.9**: duplicate-bash with intervening different-binary error — older marked compacted.

Each task: write test → run → verify mutation on live tree → commit `test(smoke): <scenario>`.

## Task 2.10: README update for Layer B

**Files:** Modify `README.md`.

Add section "v2 detectors" documenting new tools tracked, new reasons, new options. Update "How it works" table with new rows. Update Installation/configure example to show `tools: ["read","edit","write","bash"]`.

- [ ] Edit README.
- [ ] Commit `docs(readme): document v2 detectors`.

---

# PHASE 3 — Layer C (dump + compact)

## Task 3.1: token-estimate.ts (shared TS helper)

**Files:** Create `src/dump/token-estimate.ts` + tests.

Pure functions: `estimateTokens(s)` (chars/3.5 ceil), `estimateTokensForPart(part)` (switch on part.type — text uses .text, tool sums JSON.stringify(input) + output length, reasoning uses .text, fallback 0).

- [ ] Test (6 cases): empty, ratio, rounds up, text part, tool part, unknown type returns 0.
- [ ] Implement.
- [ ] Commit `feat(dump): token estimation helpers`.

## Task 3.2: flag-heuristics.ts

**Files:** Create `src/dump/flag-heuristics.ts` + tests.

Six pure functions, each `(messages, ctx?) → CleanupCandidate[]`:
- `flagDeadReasoning`: reasoning part with no edit/write/successful tool call in next 10 messages → confidence high.
- `flagSupersededToolResults`: precompute Layer B decisions, surface as flags → confidence high.
- `flagLargeErrors`: tool_result with isError && tokens above 800 → medium.
- `flagOversizedBash`: bash tool_result above 2000 tokens, NOT the most recent for that binary → medium.
- `flagDuplicateText`: n-gram (size 5) Jaccard similarity above 0.7 between text parts → low.
- `flagUnusedMcp`: MCP with 0 calls in counters → medium.

CleanupCandidate shape: `{ partId, reason, rationale, tokensSavedIfCompacted, confidence: "high"|"medium"|"low" }`.

- [ ] Test 5 cases per flag (positive, negative, edge × variants) → 30 total.
- [ ] Implement each flag as standalone pure function.
- [ ] Commit per flag (6 commits): `feat(flags): <flag-name>`.

## Task 3.3: format-markdown.ts

**Files:** Create `src/dump/format-markdown.ts` + tests.

Pure function `formatMarkdown(dumpData) → string`. Sections per spec: Overview, Startup overhead table, Conversation (per message+part), Top 10 offenders table, Cleanup candidates table, How to apply.

- [ ] Test: produces expected sections, top offenders sorted desc, candidates link to part IDs.
- [ ] Implement.
- [ ] Commit `feat(dump): markdown serializer`.

## Task 3.4: format-json.ts

**Files:** Create `src/dump/format-json.ts` + tests.

Pure function `formatJson(dumpData) → string`. Strict schema per spec (version 1.0).

- [ ] Test: parses back, structure matches schema, top_offenders sorted desc.
- [ ] Implement.
- [ ] Commit `feat(dump): JSON sidecar serializer`.

## Task 3.5: dump.ts (orchestrator)

**Files:** Create `src/dump/dump.ts` + tests.

Pure function `buildDump({ messages, mcpCounts, contextWindow, opts }) → { dumpData, markdown, json, summary }`. Combines flag-heuristics + formatters + token estimator.

- [ ] Test: full pipeline on a 5-message fixture.
- [ ] Implement.
- [ ] Commit `feat(dump): dump orchestrator`.

## Task 3.6: selector.ts

**Files:** Create `src/compact/selector.ts` + tests.

Pure function `matchSelector({ parts, selector }) → PartLocation[]`. Implements partIds + filter (type, tool, olderThanMessages, largerThanTokens, flaggedAs). All criteria intersected.

- [ ] Test 6 cases: explicit IDs, type filter, tool filter, olderThanMessages, largerThanTokens, intersection of multiple.
- [ ] Implement.
- [ ] Commit `feat(compact): selector matching`.

## Task 3.7: compact-on-demand.ts

**Files:** Create `src/compact/compact-on-demand.ts` + tests.

Pure function `decideCompaction({ parts, selector, opts }) → { decisions, preservedForInvariant, totalTokensSaved, forceDryRun }`. Applies safety invariant (most recent live tool_result per path/binary protected) + massive-operation guardrail (more than 20 parts OR more than 10K tokens forces dryRun unless `confirmLargeOperation`).

- [ ] Test 6 cases: explicit IDs, filter-based, safety invariant fires, massive forces dryRun, confirmLargeOperation override, idempotency.
- [ ] Implement.
- [ ] Commit `feat(compact): on-demand compaction decisions`.

## Task 3.8: index.ts — register `ctxlite_dump` tool

**Files:** Modify `src/index.ts`.

Add tool registration in plugin server function. Args: `{ output_dir?, include_startup?, verbosity? }`. Calls `buildDump` with current `output.messages`. Writes md+json files. Returns compact summary (≤200 tokens).

- [ ] Smoke test: invoke hook flow, call dump, verify files exist + parse.
- [ ] Implement.
- [ ] Commit `feat(plugin): register ctxlite_dump tool`.

## Task 3.9: index.ts — register `ctxlite_compact` tool

**Files:** Modify `src/index.ts`.

Args: `{ selector, dryRun?, confirmLargeOperation? }`. Calls `decideCompaction`. If `!dryRun && !forceDryRun`, applies decisions to live tree (mark `state.time.compacted`). Returns preview summary either way.

- [ ] Smoke test: dry-run returns preview no mutation; apply mutates state; safety invariant verified.
- [ ] Implement.
- [ ] Commit `feat(plugin): register ctxlite_compact tool`.

## Task 3.10: Event subscription for unused-mcp tracking

**Files:** Modify `src/index.ts`.

Subscribe to `tool.execute.before` event in plugin server. Maintain per-MCP counter Map for session lifetime. Pass into `buildDump` for `flagUnusedMcp`. MCP namespace extraction: tool name prefix split by `_` first segment, or use tool name verbatim if no MCP namespace.

- [ ] Test: simulate event sequence, counters update, unused MCP flagged on 0 calls, suppressed on at least 1.
- [ ] Implement.
- [ ] Commit `feat(plugin): track tool calls per MCP for unused-mcp flag`.

## Task 3.11: Dump file lifecycle

**Files:** Modify `src/index.ts`.

Add startup cleanup of old dump files (TTL 7 days) at plugin boot. Reuse pattern from Layer A logs-cleanup. Default dump dir `os.tmpdir()/ctxlite-dumps/`.

- [ ] Test: write old files, run cleanup, verify removed.
- [ ] Implement.
- [ ] Commit `feat(plugin): startup cleanup of stale dump files`.

## Task 3.12: Slash command markdown wrappers

**Files:** Create `.opencode/commands/ctxlite-dump.md` and `.opencode/commands/ctxlite-compact.md`.

Each is a frontmatter+body markdown file telling the agent to call the corresponding tool with passed args. Default to `dryRun: true` for compact. No code logic, pure prompt wrappers.

- [ ] Create both files.
- [ ] Commit `feat(slash): add /ctxlite-dump and /ctxlite-compact wrappers`.

## Task 3.13: README update

**Files:** Modify `README.md`.

Document Layer C (new tools, slash commands, selector schema with examples, heuristic flag reference table, lifecycle of dump files).

- [ ] Edit README.
- [ ] Commit `docs(readme): document Layer C`.

## Task 3.14: End-to-end integration test

**Files:** Create `test/integration-e2e.test.ts`.

Full smoke: assemble realistic message tree via SDK builders, invoke dump → assert md+json valid, parse summary; call compact with selector → assert mutation; call dump again → assert decreased totals.

- [ ] Test.
- [ ] Commit `test(integration): end-to-end dump+compact pipeline`.

---

# Self-Review Checklist

- [ ] **Spec coverage**:
  - Layer A bug fixes (9): Tasks 1.2–1.18.
  - Layer A truncation algorithm: Tasks 1.4–1.12.
  - Layer A summarizer config-only: Task 1.11.
  - Layer A OS-awareness: Tasks 1.13, 1.14, 1.15, 1.17.
  - Layer A peek_file: Task 1.16.
  - Layer B 4 detectors: Task 2.4 (with helpers 2.2–2.3, integration 2.5–2.9).
  - Layer C dump (md+json): Tasks 3.1–3.5, 3.8.
  - Layer C compact (selector + safety): Tasks 3.6–3.7, 3.9.
  - Layer C heuristic flags: Task 3.2 (six flags).
  - Layer C unused-mcp tracking: Task 3.10.
  - Layer C lifecycle: Task 3.11.
  - Slash commands: Task 3.12.

- [ ] **Placeholder scan**: Phase 1 has bite-sized steps with concrete code in detailed tasks. Phases 2 and 3 use a tighter format (one paragraph + checklist) since the patterns are established in Phase 1; expand to bite-sized steps when executing each task. No `TODO` / `TBD` / `implement later` placeholders. Heuristic flag implementations described by their precise logic.

- [ ] **Type consistency**: `FileToolKind` extended in 2.1 → used in 2.3 → used in 2.4 → used in 2.5. `BashCommandRef` defined in 2.1 → used in 2.3 → used in 2.4. `InvalidationReason` union extended in 2.1 → produced in 2.4 → consumed in tests. `CleanupCandidate` shape defined in 3.2 → consumed in 3.3 (markdown), 3.4 (JSON), 3.5 (dump), 3.7 (compact via flaggedAs).

---

# Execution Choice

**Plan complete and saved to `docs/superpowers/plans/2026-05-03-context-optimization.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Best when you want parallel review and the tasks are well-scoped.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Best when you want to follow along step-by-step.

**Which approach?**
