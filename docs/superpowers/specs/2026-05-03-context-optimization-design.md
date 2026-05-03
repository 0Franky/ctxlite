# Context Optimization — Three-Layer Design

**Date**: 2026-05-03
**Status**: Draft (awaiting user review)
**Authors**: Giuseppe + Claude (brainstorming session)

## Goal

Build a complete, efficient pipeline for managing the LLM context window in opencode sessions. Save tokens, prevent dirty context from degrading agent reasoning, and avoid the "uncontrolled `/compact`" problem.

## Problem statement

Four concrete problems drive this design:

1. **Bash output bloat** — A command like `find /` or a verbose build can generate 10K+ lines, blowing up the context window in a single tool call.
2. **Large-file reads** — Reading a 5MB JSON file costs thousands of tokens, most of which are irrelevant.
3. **Stale tool_results** — Repeated reads/edits of the same file accumulate obsolete snapshots; ctxlite v0.1 partially addresses this.
4. **No control over context cleanup** — The user has no visibility into what's currently in the context, no way to remove specific noise (off-topic content, dead reasoning, errors) without resorting to opencode's blunt `/compact` global summarization.

## Architecture overview — three orthogonal layers

Each layer addresses a different point in the context lifecycle:

| Layer | Role | Component | Mechanism |
|-------|------|-----------|-----------|
| A | Prevention at source | `ag-mcp-server` (MCP) | Truncate output before it enters context |
| B | Always-on cleanup | `ctxlite` (plugin) | Transform-time deterministic invalidation |
| C | On-demand inspection + surgical removal | `ctxlite` (plugin) | Dump + selector-based compact |

Each layer is independently usable, but they're designed to compose:
- A handles what enters the context (problems 1, 2)
- B handles deterministic cleanup of what's already in (problem 3)
- C handles content that needs human/agent judgment (problem 4)

---

## Layer A — Prevention at source (`ag-mcp-server`)

### Tools exposed

| Tool | Purpose |
|------|---------|
| `bash_capped` (rename of `sandboxed_bash`) | Run shell command with adaptive truncation. Backward-compat alias to old name for transition. |
| `execute_js_analyzer` | Run a Node.js script (think-in-code pattern). |
| `execute_python_analyzer` | Run a Python script (think-in-code pattern). |
| `peek_file` (NEW) | Read a file applying the same adaptive truncation as `bash_capped`. |

### Mandatory file-first persistence

Every command execution writes its FULL output to a temp file BEFORE any post-processing. The truncated output returned to the LLM always includes the path to the full log.

**Lifecycle (two-mechanism cleanup, simplified from original three)**:
- **TTL 24h** on every file (safety net).
- **Startup cleanup**: when the MCP server starts, deletes all expired files in `LOGS_DIR`.

Plugin-driven cleanup (third mechanism) was dropped as over-engineered: TTL + startup cover the realistic cases.

**LOGS_DIR resolution**: `os.tmpdir()/ag-mcp-logs/{session_marker}/` by default. Override via `AG_LOGS_DIR` env. Path resolution uses `path.join` and `import.meta.url`, never string concatenation.

### Three-path post-processing decision tree

```
Capture full output → write to temp file → read stats (bytes, newlines, command class)

tokens_estimated = ceil(bytes / 3.5)

PATH A: tokens_estimated <= target[class]
  → return full output + log_path
  
PATH B: target[class] < tokens_estimated <= huge_threshold[class]
  → apply deterministic head+tail+marker truncation
  → return processed + log_path + footer
  
PATH C: tokens_estimated > huge_threshold[class]  AND  AG_SUMMARIZER_MODEL is set
  → call cheap LLM to summarize the full output
  → return structured summary + log_path + footer
  
PATH C fallback: AG_SUMMARIZER_MODEL not set OR call fails
  → degrade to PATH B with hard cap
  → return truncated + log_path + warning footer
```

`huge_threshold[class] = hard[class] × 5` (per-class, not global, to avoid discontinuity).

### Per-command-class budgets (absolute, not percentage of context window)

% of context window was rejected: 1% on a 1M model = 10K tokens for a single tool_result, far too generous. Budgets are absolute, calibrated to the typical information density per class.

| Class | Examples | Target | Hard | Huge |
|-------|----------|--------|------|------|
| enumerative | ls, find, tree, du, locate, fd | 800 | 1500 | 7500 |
| concise | git status, git diff --stat, git log --oneline | 600 | 1200 | 6000 |
| history | git log, git blame, git show | 1500 | 3000 | 15000 |
| build | cargo build, npm run build, make, gradle, mvn, gcc, tsc | 3000 | 6000 | 30000 |
| test | jest, pytest, cargo test, go test, mocha | 3000 | 6000 | 30000 |
| install | npm/pip/yarn/apt/cargo install | 1000 | 2000 | 10000 |
| read-file | cat, head, tail, less | 2000 | 4000 | 20000 |
| network | curl, wget, http, dig | 1500 | 3000 | 15000 |
| db-query | psql, mysql, sqlite3, redis-cli | 2000 | 4000 | 20000 |
| log-view | docker logs, journalctl, kubectl logs | 2500 | 5000 | 25000 |
| default | (anything else) | 2000 | 4000 | 20000 |

Override entire table via env `AG_COMMAND_BUDGETS` (path to JSON file).

### Command-class detection

Deterministic pseudo-algorithm:
1. Strip noise prefixes: `time`, `sudo`, `nice`, `nohup`, `env VAR=...`, PowerShell call operator `&`.
2. If chained (`&&`, `||`, `;`, `|`): take the LAST segment (its exit code is what reaches the caller).
3. Match first token against the dictionary; for known wrappers (cargo, npm, yarn, pnpm, git, dotnet, go, mvn, gradle, docker, kubectl), match `${first}_${second}` (e.g., `cargo_build`).
4. No match → `default`.

### Truncation algorithm — head+tail+marker preservation

**Mode selection**: `line_mode = (newline_count >= 20) AND (total_bytes / newline_count <= 500)`. Both conditions must hold; otherwise char-chunked mode is used. This protects against the "21 lines × 5KB each" edge case.

**Newline counting**: `output.match(/\r\n|\r|\n/g)?.length ?? 0` (handles all three line-ending conventions).

**Line-mode**:
- Head: first `head_lines` (default 50)
- Tail: last `tail_lines` (default 100)
- Marker scan: regex match in truncated zone, preserve matched line + ±2 lines context as "segments"
- Concatenation: `head + "[N lines truncated]" + segments + "[...]" + tail`
- Hard byte cap enforced even if it means dropping marker segments

**Char-chunked mode** (when line_mode = false):
- Head: first `head_chars` (default 1500, ≈ 430 tokens)
- Tail: last `tail_chars` (default 1500)
- Marker scan: regex match on the whole string, preserve a 256-char chunk centered on each match
- 256-char chunks chosen as a balance: small enough to be granular, large enough to retain semantic context (≈ 75 tokens)

**Binary output bypass**: if first 4KB contains > 30% non-printable characters → skip post-processing entirely, return `[Binary output, {N} bytes, full content: {PATH}]`.

### Marker regex catalog (categorized)

A single compiled regex unioned across categories. False positives mitigated by a negative lookbehind on generic patterns: `(?<!\b(no|zero|0|without|all\s+\w+\s+passed.*?)\s+)(error|fail|warning)`.

**Shell/system errors**:
```
\b(error|errore|fail(?:ed|ure)?|fatal|critical)\b
\bexit code\s*[:=]?\s*[1-9]\d*\b
\b(?:errno|EACCES|EPERM|ENOENT|EEXIST|EISDIR|ENOTDIR|EBUSY|ETIMEDOUT|ECONNREFUSED|ENOSPC|EMFILE)\b
(?:permission denied|operation not permitted|no such file|cannot access|connection refused|timeout|killed|aborted|core dumped|segmentation fault)
```

**Compiled languages** (C/C++, Rust, Go, Java, C#, Swift):
```
^.*?:(\d+):(\d+):\s+(error|warning|note)\b
\bundefined reference\b
\bld returned \d+ exit status\b
^error(\[E\d+\])?:                   # Rust
^.*?\.go:\d+:\d+:\s+
\bpanic:\s
\bgoroutine\s+\d+\b
\bException\s+in\s+thread\b           # Java
^\s*at\s+[\w.$]+\(.*\)\s*$
\bCaused by:\s
\b(error|warning)\s+CS\d{4}:          # C#
^.*?\.swift:\d+:\d+:\s+(error|warning):
```

**Interpreted languages** (Python, Ruby, JS/TS, PHP, Lua):
```
^Traceback \(most recent call last\):
^\s*File\s+"[^"]+",\s+line\s+\d+
^\w*Error:\s
^\w+Warning:\s
\bSyntaxError:\s
^\s*at\s+(?:async\s+)?[\w.<>\[\] ]+\(.*?\)
^TypeError:\s
^ReferenceError:\s
^.*?\.rb:\d+:in\s+\`
\b(?:Fatal|Parse|Warning|Notice)\s+error:
^lua:.*?:\d+:
```

**Build tools** (npm, cargo, make, gradle, maven, cmake):
```
^npm ERR!
^npm WARN
\bBUILD FAILED\b
\bExecution failed for task\b
^\[ERROR\]
\bBUILD FAILURE\b
\bCMake Error\b
\bmake\[\d+\]:\s+\*\*\*\s
```

**Test runners** (jest, pytest, mocha, cargo test):
```
\bFAIL(?:ED)?\b
\b(\d+) (?:tests? failed|failures?)
^(FAIL|PASS)\s+
^\s+✕\s
^FAILED\s
^E\s+
^test result:\s+(?:FAILED|ok)
```

**Linters/typecheckers** (tsc, eslint, mypy, ruff, pylint, black):
```
\berror TS\d+:
^✖ \d+ problems
^.*?\.py:\d+:\s+(?:error|note):
^.*?:\d+:\d+:\s+[A-Z]\d+\s
\bwould reformat\b
```

**Git, Docker, K8s, HTTP, DB**:
```
^CONFLICT\b
\bAuto-merging\b
^fatal:\s
\bnon-fast-forward\b
^Error response from daemon:
\bExited \(\d+\)\b
\b(CrashLoopBackOff|ImagePullBackOff|OOMKilled)\b
\bHTTP/\d(?:\.\d)?\s+(4\d\d|5\d\d)\b
\b(SQL|PG|MY|SQLite)\s*ERROR\b
\bduplicate key value\b
\bdeadlock detected\b
```

**Stack frames (generic)**:
```
^\s+at\s+[\w$./<>\[\]\-]+\s*\(.*?\)\s*$
^\s+File\s+"[^"]+",\s+line\s+\d+
^\s+#\d+\s+0x[0-9a-f]+\s
^\s+from\s+.*?:\d+:
```

**User-visible markers (always preserve)**:
```
\b(TODO|FIXME|XXX|HACK|BUG|DEPRECATED)\b
^[\W_]*?(WARNING|NOTICE|ATTENTION|CAUTION)[\W_]*?:
```

User can extend via env `AG_MARKER_PATTERNS` (file with one pattern per line, OR-unioned with built-in).

### LLM summarizer (PATH C)

**Activation**: only if `AG_SUMMARIZER_MODEL` env is set. No default — explicit user opt-in is required. If unset, PATH C falls back silently to PATH B with a warning footer.

**Auth**: `AG_SUMMARIZER_API_KEY` env. Never inherits from `ANTHROPIC_API_KEY` — explicit only.

**Prompt structure**:
```
System: You analyze command output and produce a concise structured summary
for an AI coding agent. Output max 1500 tokens.

User:
  Command: {command}
  Class: {command_class}
  Original size: {bytes} bytes / {lines} lines
  Output (full):
  {output}
  
  Produce a summary with sections:
  - Result: SUCCESS | FAILURE | MIXED
  - Key info: 3-5 bullet points
  - Errors found: list with file:line if present
  - Sample: first 200 char + last 200 char verbatim
```

**Output**: `summary_text + "[Original output: {PATH}, summarized by {model} in {ms}ms — full content available]"`.

**No per-session cap by default**. The user explicitly opted in by setting the env var; arbitrary caps create surprising behavior. Optional cap via `AG_SUMMARIZER_MAX_PER_SESSION` (unset = unlimited). Verbose stderr logging on every call: `[ag-mcp] summarized cmd_{ts} — input ~{tokens}, model {model}, est. cost ~${cost}, latency {ms}ms`.

**Failure mode**: API key missing / call fails / quota → silent fallback to PATH B + warning footer. Summarizer NEVER blocks command execution.

### `bash_capped` — additional design

**Working directory**: argument `cwd` (optional). Default = project root, resolved from `OPENCODE_PROJECT_ROOT` env, fallback to MCP server's `directory` parameter passed at startup.

**Timeout**: `AG_BASH_TIMEOUT_MS` env (default 60000). Cross-platform kill via the standard Node child-process API with `timeout` option. `windowsHide: true` to suppress console flash on Windows.

**Encoding**: forced `utf-8` for all subprocess and filesystem calls. Avoids cp1252/utf-16le corruption on Windows for accented characters.

**Empty output**: returns `[Command completed with no output]` (preserved from v0.1).

**Implementation note**: prefer the `execFile`-style API over the shell-string API where feasible to avoid shell-injection surface. Where shell features are required (pipes, redirection, `&&`), the `command` argument is documented as user-trusted input — the MCP runs whatever the agent provides; sanitization is the agent's job, not ours.

### Shell selection (OS-aware)

**Linux/macOS**: `/bin/bash` → `/bin/sh` fallback. Override via `AG_BASH_SHELL`.

**Windows**: detection chain to maximize bash-compatible syntax success:
1. Git Bash if installed (`C:\Program Files\Git\bin\bash.exe` or `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`)
2. PowerShell 7+ (`pwsh.exe`)
3. Windows PowerShell (`powershell.exe`)
4. cmd.exe as last resort

Override via `AG_BASH_SHELL`. Documented limitation: `&&`/`||` may behave differently in cmd.exe; recommend Git Bash or PowerShell 7+.

### Python detection (OS-aware)

**Linux/macOS**: `python3` → `python` fallback.

**Windows**: `py -3` → `python` → `python3` fallback.

Probed at startup, cached. Explicit error message if none found.

### `peek_file` — design

Args:
```typescript
{
  path: string                  // file to peek
  head_lines?: number
  tail_lines?: number
  byte_cap?: number
  cwd?: string
}
```

Behavior: same head+tail+marker algorithm as `bash_capped`, applied to file content. Mode selection (line vs char-chunked) identical. Saves the FULL content to a temp file, returns truncated view + log_path.

Differs from opencode's built-in `read`: `read` takes an explicit offset/limit chosen blindly by the caller. `peek_file` applies content-aware truncation when the caller doesn't know what to look for (e.g., understanding the structure of an unknown 5MB JSON).

### Configuration reference (Layer A)

| Env | Default | Purpose |
|-----|---------|---------|
| `AG_LOGS_DIR` | `os.tmpdir()/ag-mcp-logs/{session}/` | Where to store full-output logs |
| `AG_BASH_TIMEOUT_MS` | 60000 | Timeout for `bash_capped` |
| `AG_BASH_SHELL` | (auto-detected) | Shell binary override |
| `AG_BASH_HEAD_LINES` | 50 | Line-mode head |
| `AG_BASH_TAIL_LINES` | 100 | Line-mode tail |
| `AG_BASH_HEAD_CHARS` | 1500 | Char-mode head |
| `AG_BASH_TAIL_CHARS` | 1500 | Char-mode tail |
| `AG_BASH_MIN_LINES_FOR_LINE_MODE` | 20 | Threshold to switch to line-mode (also requires avg line length ≤ 500) |
| `AG_COMMAND_BUDGETS` | (built-in table) | Path to JSON overriding the budget table |
| `AG_MARKER_PATTERNS` | (built-in regex) | Path to file with extra regex patterns |
| `AG_SUMMARIZER_MODEL` | (unset) | If set, enables PATH C with this model |
| `AG_SUMMARIZER_API_KEY` | (unset) | Required if summarizer enabled |
| `AG_SUMMARIZER_MAX_PER_SESSION` | (unlimited) | Optional cost cap |
| `AG_LOG_TTL_HOURS` | 24 | TTL for full-output logs |

### Bug fixes from current ag-mcp-server v1.0

1. `sandboxed_bash` had no timeout → fixed by `AG_BASH_TIMEOUT_MS`.
2. `LOGS_DIR` used `process.cwd()` (fragile) → fixed by `os.tmpdir()` + `AG_LOGS_DIR`.
3. Truncation only by tail-50-lines → replaced with full algorithm above.
4. Truncation only by lines, not bytes → byte cap enforced.
5. No log cleanup → TTL + startup cleanup.
6. Temp file names timestamp-only → `${ts}_${randomBytes(4).toString('hex')}.{js,py}`.
7. Python assumed `python` on PATH → OS-aware detection chain.
8. `error.stdout`/`error.stderr` could be undefined → fallback to `""`.
9. Misleading "sandboxed" name → renamed to `bash_capped` (alias preserved).

---

## Layer B — Always-on cleanup (`ctxlite` v2)

### Philosophy

Identical to ctxlite v0.1: hook `experimental.chat.messages.transform`, pure mutation in-process, zero LLM calls, idempotent, fail-open. The only thing that changes is the catalog of detectors.

### Four new detectors

**(B1) Stale Write**

Symmetric to existing edit logic: write supersedes all prior live views (read/edit/write) on the same path.

Reason: `write-supersedes-prior`.

**(B2) Error + retry success on same path**

Helper `isErrorOutput(tool, output) → boolean` (pure, per-tool pattern matching). Per path P, maintain an "error set" alongside the active view set. When a non-errored op on P arrives, all prior errors on P are invalidated.

Reason: `error-superseded-by-success`.

Tools covered: read, edit, write, bash.

**(B3) Bash error + retry success on same binary**

Bash command identity = `${binary}` (or `${binary}_${subcommand}` for known wrappers: cargo, npm, yarn, pnpm, git, dotnet, go, mvn, gradle, docker, kubectl), after stripping wrapper prefixes (`time`, `sudo`, `nice`, `env VAR=...`) and taking the LAST segment of `&&|;|||\\|`-chained commands.

Per binary B, maintain "errored on B". On non-errored bash with same B → invalidate prior errored.

Reason: `bash-error-superseded-by-success`.

Known limitation (acceptable for v1): typo-fix retries (`gti status` → `git status`) are NOT caught — different binaries.

**(B4) Duplicate bash output**

Hash of normalized command string (trim + collapse whitespace, no path/quoting normalization to stay deterministic). When a bash with same hash as a previous one arrives AND both are non-errored AND no intervening write/edit/error/different-binary-bash exists → invalidate the OLDER one (preserve most recent, mirroring `duplicate-read` from v0.1).

The "no intervening modification" guard avoids false positives where the agent legitimately re-runs `git status` to check progress after edits.

Reason: `duplicate-bash`.

Configurable via `enableDuplicateBash` option (default true).

### Helper `isErrorOutput`

New module `error-detection.ts`. Per-tool patterns:

```javascript
read:  /(?:^|\b)(?:Error|ENOENT|EACCES|EISDIR|cannot access|no such file|file not found|permission denied)\b/i
edit:  /\b(?:oldString.*?not found|string is not unique|file not found|cannot read|patch.*?failed)\b/i
write: /\b(?:EACCES|EISDIR|EROFS|permission denied|cannot write|read-only file system)\b/i
bash:  /(?:^\[(?:COMMAND FAILED|FAILED)\]|\bExit Code:\s*[1-9]|^Error:\s)/m
```

Patterns shared with Layer A's marker regex where applicable (DRY).

**Future-proofing**: if a future opencode SDK exposes a structured `state.metadata.isError` field, prefer it over pattern matching. Pattern matching is fallback. Plugin checks SDK version at boot to decide.

Fallback for undefined/null/empty output → returns `false` (skip).

### Architecture (codebase extension)

```
src/
├── index.ts             (existing — adapter only)
├── invalidation.ts      (extended: walk maintains active+error sets per path AND per binary)
├── extract-path.ts      (adds case "write" and "bash"; adds extractCommandIdentity for bash)
├── error-detection.ts   (NEW: isErrorOutput per tool)
└── types.ts             (FileToolKind adds "write"|"bash"; reason union extended)
```

`index.ts` remains a thin adapter — same as v0.1.

### Walk algorithm in `invalidation.ts`

For each completed tool part, in chronological order:

1. **If errored** (per its tool): add to `errorSet[target]` (path or binary). Emit no decision yet.
2. **If non-errored**:
   - **Read**: compare with prior live reads on path P (existing logic) + flush `errorSet[P]` emitting `error-superseded-by-success`.
   - **Edit/Write on P**: invalidate all prior live views on P (existing edit logic, applied to write too) + flush `errorSet[P]`.
   - **Bash with binary B**: compute command hash; check for prior identical bash with no intervening modification → emit `duplicate-bash`. Always flush `errorSet[B]` (`bash-error-superseded-by-success`).
3. **Idempotency filter** (existing): drop decisions targeting already-compacted parts.

The order guarantees that an isolated error (never retried) survives untouched.

### Test plan extension

In addition to existing 35 tests:

- write-supersedes-read, write-supersedes-edit (symmetric to existing)
- read-error → read-success → first invalidated
- edit-error → edit-success → first invalidated
- bash-error → bash-success same binary → first invalidated
- bash-error → bash-success different binary → no invalidation
- duplicate-bash with same hash, no intervening mods → first invalidated
- duplicate-bash with same hash, intervening edit on different file → still invalidated (file is unrelated to the bash check) — this is an explicit choice for v1, may need refinement
- duplicate-bash with same hash, intervening bash error → first NOT invalidated
- isErrorOutput with garbled input (numbers, objects, null) → returns false safe

### Configuration extension

| Option | Type | Default | Meaning |
|--------|------|---------|---------|
| `tools` | string[] | `["read","edit","write","bash"]` | Tools tracked (was `["read","edit"]`) |
| `logLevel` | enum | `"info"` | Unchanged |
| `preserveRecentMessages` | number | 0 | Unchanged |
| `enableDuplicateBash` | bool | true | Disable detector B4 if user only wants error-retry |
| `bashCommandIdentity` | enum | `"binary"` | `"binary"` (cargo_build) or `"full"` (full hash); future `"normalized"` |

### Out of scope for Layer B

- `apply_patch` (deferred — same reason as v0.1, patch parser not reproduced).
- MCP-external tools (Serena, codegraph, context7) — per-tool path/identity extraction not scalable; deferred.
- "Load-bearing" errors without retry (Category B from earlier discussion) — too high false-positive risk.
- Long traceback compression (Category C) — requires judgment, lives in Layer C.

---

## Layer C — On-demand inspection + surgical removal (`ctxlite`)

### Philosophy

Layer C exists because some context noise (dead reasoning, long tracebacks, unused MCP overhead) requires judgment that Layer B's deterministic rules can't safely apply automatically. Layer C surfaces information; the user (or agent) decides what to remove.

### Two operations exposed

Both as opencode plugin custom tools AND as slash commands (markdown wrappers in `.opencode/commands/`).

**`ctxlite_dump`** — produces a structured snapshot of the current session context.
**`ctxlite_compact`** — applies surgical removal based on a selector.

### Tool 1 — `ctxlite_dump`

**Args**:
```typescript
{
  output_dir?: string         // default: os.tmpdir()/ctxlite-dumps/
  include_startup?: boolean   // default: true
  verbosity?: "minimal" | "normal" | "verbose"  // default: "normal"
}
```

**Output to caller** (compact, always ≤ 200 tokens):
```typescript
{
  markdown_path: string
  json_path: string
  summary: {
    total_tokens: number
    used_pct: number
    n_messages: number
    n_parts: number
    n_already_compacted: number
    top_offenders: Array<{ part_id: string, tokens: number, type: string }>
    cleanup_candidates_count: number
  }
}
```

The agent sees only the summary; it opens the file only if it needs detail. Avoids return-value bloat.

### Markdown format (human-readable)

Key sections:
- Overview (context window, used %, recovered tokens)
- Startup overhead (broken down by source: system prompt, built-in tools, each MCP, agents, skills)
- Conversation history (per-message, per-part, with tokens, content previews, and flags)
- Top 10 offenders (sorted by token cost)
- Cleanup candidates (heuristic-flagged parts with rationale)
- "How to apply" examples

Example shape:

```markdown
# ctxlite context dump
Session: {sid} | Generated: {iso} | Tool by ctxlite v2

## Overview
- Context window: 200000 tokens
- Used: 45120 tokens (22.6%)
- Already compacted: 8 parts (12340 tokens recovered)
- Cleanup candidates: 14 parts (~9800 tokens recoverable)

## Startup overhead — 8400 tokens (4.2%)
| Source | Tokens | Detail |
|--------|--------|--------|
| System prompt | 1200 | opencode default |
| Built-in tools | 3400 | read, edit, write, bash, ... |
| MCP ag-mcp-server | 800 | bash_capped, peek_file, ... |
| MCP codegraph | 1500 | 6 tools [used: 12 calls] |

## Conversation — 36720 tokens
### msg_aaa [user] (320 tokens)
- p0 [text] (id: aaa_p0, 320 tokens)

### msg_bbb [assistant] (8240 tokens)
- p0 [reasoning] (id: bbb_p0, 3201 tokens) ⚠️ dead-reasoning
- p1 [tool_use] read (id: bbb_p1, 45 tokens) → /src/auth.ts
- p2 [tool_result] (id: bbb_p2, 4994 tokens) ✓ already-compacted

## Top 10 offenders
1. ddd_p2 — tool_result bash, 4523 tokens
2. bbb_p0 — reasoning, 3201 tokens [⚠️ dead-reasoning]

## Cleanup candidates (heuristics)
| Part ID | Reason | Tokens | Confidence |
|---------|--------|--------|-----------|
| bbb_p0 | dead-reasoning | 3201 | high |

## How to apply
ctxlite_compact { selector: { partIds: ["bbb_p0", "ccc_p1"] } }
ctxlite_compact { selector: { filter: { type: "reasoning", olderThanMessages: 5 } } }
```

### JSON sidecar format (script-friendly)

Strict structure with all stats and addressing info, suitable for parsing by external tools:

```json
{
  "version": "1.0",
  "session_id": "...",
  "generated_at": "2026-05-03T...",
  "context": { "window_tokens": 200000, "used_tokens": 45120, "used_pct": 22.6 },
  "startup_overhead": {
    "system_prompt": { "tokens": 1200, "preview": "..." },
    "tool_descriptions": [
      { "source": "opencode-builtin", "tokens": 3400, "tools": ["read","edit","write","bash"] },
      { "source": "mcp:ag-mcp-server", "tokens": 800, "tools": [], "calls_in_session": 0 }
    ]
  },
  "messages": [
    { "idx": 0, "id": "msg_aaa", "role": "user", "tokens": 320,
      "parts": [{ "idx": 0, "id": "aaa_p0", "type": "text", "tokens": 320,
                   "preview_head": "...", "preview_tail": "...",
                   "flags": [], "already_compacted": false }] }
  ],
  "top_offenders": [],
  "cleanup_candidates": [
    { "part_id": "bbb_p0", "reason": "dead-reasoning",
      "rationale": "...", "tokens_saved_if_compacted": 3201,
      "confidence": "high" }
  ]
}
```

### Tool 2 — `ctxlite_compact`

**Args**:
```typescript
{
  selector: {
    partIds?: string[]
    filter?: {
      type?: "text" | "reasoning" | "tool_use" | "tool_result"
      tool?: string
      olderThanMessages?: number
      largerThanTokens?: number
      flaggedAs?: string[]    // references heuristic flag names from dump
    }
  }
  dryRun?: boolean              // DEFAULT true
  confirmLargeOperation?: boolean  // required if affected > 20 parts OR > 10K tokens
}
```

**Behavior**:
1. Compute affected parts (intersection of selector criteria).
2. Apply safety invariant: the most recent live tool_result for any tracked path/binary is NEVER compactable (carries v0.1 invariant forward).
3. Apply massive-operation guardrail: if affected > 20 parts OR > 10000 tokens AND `confirmLargeOperation !== true` → force `dryRun = true` regardless of user setting; return preview with explicit message asking for `confirmLargeOperation: true` to apply.
4. If `dryRun === true`: return preview (no mutation).
5. If `dryRun === false`: mark each affected part with `state.time.compacted = Date.now()`; return summary of applied changes.

`dryRun` defaults to `true`. The user/agent must explicitly opt into mutation. Two-step process is deliberate.

### Heuristic flags for cleanup candidates

Pure functions in `flag-heuristics.ts`. Each is independently togglable.

| Flag | Logic | Confidence |
|------|-------|------------|
| `dead-reasoning` | reasoning part with no edit/write/successful tool call in next 10 messages | high |
| `superseded-tool-result` | tool_result that Layer B's transformer would mark stale (precomputed inline) | high |
| `large-error` | tool_result with `isErrorOutput=true` AND tokens > 800 | medium |
| `oversized-bash-output` | tool_result of bash > 2000 tokens, not the most recent for that binary | medium |
| `duplicate-text` | text part with n-gram-hash Jaccard similarity > 0.7 with another text part | low |
| `unused-mcp-description` | MCP whose tool descriptions are loaded but 0 tool calls in this session | medium |

These are SUGGESTIONS in the dump; `ctxlite_compact` applies them only via explicit `flaggedAs` selector.

### Tracking unused MCPs

Plugin subscribes to `tool.execute.before` event at boot, maintains a per-MCP call counter for the session lifetime. At dump time: counter == 0 AND MCP description tokens > threshold → emit `unused-mcp-description` flag with estimated tokens-saved-if-disabled.

### Startup overhead inspection (best effort)

Plugin SDK may not directly expose tool descriptions of external MCPs. Best-effort approach:
1. Try plugin client SDK for richest data.
2. Fallback: read `opencode.json` to enumerate active MCPs; estimate description size at a per-MCP fixed value (e.g., 800 tokens) calibrated empirically.
3. Document limitation: "estimated, real tokenization may differ ±15%".

### Slash commands

Two markdown files in `.opencode/commands/`:
- `ctxlite-dump.md` — wrapper that asks the agent to call `ctxlite_dump` with provided args
- `ctxlite-compact.md` — wrapper that asks the agent to call `ctxlite_compact` with provided args

These are UX shortcuts, not separate logic. Same pipeline beneath.

### Lifecycle of dump files

- Default location: `os.tmpdir()/ctxlite-dumps/dump_{ts}_{rnd}.{md,json}`.
- TTL: 7 days.
- Startup cleanup: idempotent, fail-open.
- User can override `output_dir` for persistent dumps (e.g., `.opencode/thoughts/`).

### Architecture

```
src/
├── index.ts                    (extended: registers ctxlite_dump, ctxlite_compact tools + event subscription)
├── invalidation.ts             (Layer B)
├── extract-path.ts             (Layer B)
├── error-detection.ts          (Layer B)
├── types.ts                    (extended)
├── dump/
│   ├── dump.ts                 NEW: pure: builds dump from message tree + metadata
│   ├── token-estimate.ts       NEW: chars/3.5 + utilities
│   ├── flag-heuristics.ts      NEW: pure: candidate flagging
│   ├── format-markdown.ts      NEW: pure: markdown serializer
│   └── format-json.ts          NEW: pure: JSON serializer
└── compact/
    ├── compact-on-demand.ts    NEW: pure: selector → InvalidationDecision[]
    └── selector.ts             NEW: pure: filter schema + matcher
```

All new modules pure — adapter-style integration in `index.ts`.

### Test plan (Layer C)

- `ctxlite_dump`: produces both md and json files, JSON parses successfully, top_offenders sorted descending, summary numbers match the file content.
- `ctxlite_compact` dryRun: returns preview, does NOT mutate state.
- `ctxlite_compact` apply: mutates `state.time.compacted` on selected parts.
- Safety invariant: the most recent live tool_result for any path is NOT compactable even if explicitly listed in `partIds`.
- Massive-operation guardrail: selector that would affect > 20 parts forces dryRun; second call with `confirmLargeOperation: true` actually mutates.
- Filter combinations: `{type: "reasoning", olderThanMessages: 5}` correctly intersects.
- `unused-mcp-description` flag: 0 calls produces flag; ≥ 1 call suppresses flag.
- `dead-reasoning` flag: only emits with high confidence (10+ messages without follow-up).

### Out of scope for Layer C v1

- LLM-as-judge for borderline cases (e.g., "is this off-topic relative to current task?") — possible future iteration.
- Cross-session dumps / persistent context history — single-session only.
- Real-time UI / browser companion — text-based UX only for v1.
- Auto-apply heuristic flags without user confirmation — explicit opt-in is required by design.

---

## Cross-layer integration

### Shared utilities

- **Marker regex** (Layer A) and **`isErrorOutput` patterns** (Layer B) share their core bash/error pattern set. Single source of truth, exported from a common module to avoid drift.
- **Token estimation** (Layer A's chars/3.5 heuristic and Layer C's per-part estimation) use the same function from `token-estimate.ts`.

### Component boundaries

- Layer A (`ag-mcp-server`) and Layer B/C (`ctxlite` plugin) communicate ONLY through opencode's session state (`state.time.compacted` mechanism). No direct IPC, no shared in-process state.
- Layer A's log files and Layer C's dumps live in separate subdirectories under `os.tmpdir()`. Each layer cleans only its own files.

### Configuration coexistence

ag-mcp-server uses `AG_*` env vars. ctxlite uses opencode plugin options (passed via `opencode.json`). No env collisions.

---

## Risks and open questions

### Acknowledged risks (carrying forward into implementation)

1. **`isErrorOutput` pattern matching is fragile** vs unknown tool error formats. Mitigation: prefer SDK-provided structured `isError` if available; pattern matching as fallback.
2. **Token estimation accuracy** (chars/3.5) is approximate. Documented in dump footer.
3. **Startup overhead inspection** depends on plugin SDK exposing MCP tool descriptions; falls back to static estimates if not.
4. **PATH C latency** (1-3s) not directly reported by tool description; mitigated by stderr logging and inclusion of latency in output footer.
5. **`unused-mcp-description` requires session-lifetime event tracking**; new state surface.

### Out-of-scope items (deferred, may revisit)

- True sandboxing for `bash_capped` (security boundary).
- Streaming output for long-running commands.
- LLM-as-judge for off-topic detection in Layer C.
- Cross-tool path extraction for non-built-in tools (Serena, codegraph, etc.).

---

## Implementation order

1. **Layer A bug fixes + truncation upgrade + summarizer** (depends on no other work).
2. **Layer B detectors** (extends ctxlite v0.1; independent of A; introduces `error-detection.ts` and write/bash support).
3. **Layer C dump tool** (introduces dump/ subtree; can be developed in parallel with B).
4. **Layer C compact tool** (depends on B's `error-detection.ts` for some flags).
5. **Slash commands + final wiring**.
6. **Documentation update** (ctxlite README, ag-mcp-server README, examples).

Each layer is shippable independently. A user could install only Layer A or only Layer B and get partial benefit.

---

## Open decisions captured (for record)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| % context window vs absolute budgets | Absolute per-class | % too generous on 1M models |
| Single global huge_threshold vs per-class | Per-class (hard × 5) | Avoids discontinuity |
| Default summarizer model | None (config-only) | User must explicitly opt into LLM cost |
| Per-session summarizer cap | None by default | Arbitrary caps surprise; user knowingly opts in |
| Line-mode threshold | newlines ≥ 20 AND avg line length ≤ 500 | Protects from "21 lines × 5KB" edge case |
| Windows shell default | Git Bash → PowerShell 7 → cmd | Maximizes bash-syntax compatibility |
| Layer C trigger | Custom tool + slash command | UX flexibility, single underlying logic |
| `dryRun` default for compact | true | Safety: explicit opt-in to mutation |
| Detector 4 (duplicate-bash) | Default ON, with intervening-modification guard | Captures real noise, preserves "check after edit" pattern |

## Next step

Per superpowers:brainstorming flow: user reviews this spec, provides feedback or approval. On approval, transition to `superpowers:writing-plans` skill to produce a detailed implementation plan.
