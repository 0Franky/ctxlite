# ctxlite

> opencode plugin that invalidates stale `Read`/`Edit` tool_results to reduce token waste and context rot.

## Why

When an opencode session repeatedly reads and edits the same file, the message history accumulates multiple stale snapshots of that file's content. Two problems follow:

1. **Token waste** — every full re-read pays the file size again.
2. **Context rot** — the model sees several versions of the same file and may cite the older one, producing bugs.

opencode's built-in compaction (`session/compaction.ts:295-340`) only triggers near the context-window limit (~180k tokens) and works in bulk. ctxlite intervenes earlier and per-file: at every turn it walks the message history, identifies tool_results made obsolete by later operations on the same path, and marks them with `state.time.compacted = Date.now()`. opencode's renderer (`session/message-v2.ts:858-891`) then automatically substitutes their content with `[Old tool result content cleared]` when sending to the LLM.

No extra LLM calls, no extra round trips, no changes to opencode source.

## How it works

ctxlite hooks `experimental.chat.messages.transform`, which opencode triggers at `session/prompt.ts:1440` immediately before converting the history to provider-format messages.

For every `path` it tracks, ctxlite maintains an "active set" of live (non-compacted) tool_results and applies a small, deterministic policy:

| Event | Effect |
|-------|--------|
| `Edit` / `apply_patch` on path P | Every prior live view for P is invalidated (file changed). |
| `Read(P, range R)` covering a prior `Read(P, range R')` (R ⊇ R') | Prior read invalidated as redundant. |
| Identical `Read(P, R)` | Earlier identical read invalidated. |
| Most recent live view for any path | **Always preserved** — opencode's invariant "every tool_use has a tool_result" is upheld. |

Re-running on already-processed history is a no-op (idempotent).

## Install & configure

### 1. Clone or place ctxlite somewhere stable

```bash
git clone <this-repo> /absolute/path/to/ctxlite
cd /absolute/path/to/ctxlite
bun install
```

### 2. Add to your opencode config

In `~/.config/opencode/opencode.json` (global) or `<project>/.opencode/opencode.json` (per project):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/to/ctxlite/src/index.ts",
      {
        "tools": ["read", "edit"],
        "logLevel": "info",
        "preserveRecentMessages": 0
      }
    ]
  ]
}
```

On Windows use a `file://` URL with forward slashes:

```json
"file:///C:/ctxlite/src/index.ts"
```

A working sample is in `example-config/opencode.json`.

### 3. (Alternative) Auto-discovery

opencode also auto-loads any `{plugin,plugins}/*.{ts,js}` placed in the project directory (`packages/opencode/src/config/plugin.ts:30-42`). You can symlink `ctxlite/src/index.ts` into your project's `plugins/` directory if you prefer.

## Configuration reference

All options are optional; defaults are applied when omitted.

| Option | Type | Default | Meaning |
|--------|------|---------|---------|
| `tools` | `string[]` | `["read", "edit"]` | Tool names whose tool_results ctxlite analyzes. Empty array falls back to defaults. |
| `logLevel` | `"silent" \| "info" \| "debug"` | `"info"` | Verbosity. `info` logs one line per turn when invalidations occur. `debug` also logs no-op turns. |
| `preserveRecentMessages` | `number` | `0` | Number of most-recent messages whose ToolParts ctxlite skips entirely. Defensive option for users who fear race conditions; the default is fine. |
| `preserveOldestMessages` | `number` | `0` | Number of OLDEST messages whose ToolParts ctxlite never touches. **Cache-friendly knob** — see "Prompt cache trade-off" below. |
| `minMessagesForActivation` | `number` | `0` | Don't run the transform hook until the session has at least N messages. Lets the prompt cache warm up before ctxlite starts taking bites out of it. |
| `registryPath` | `string` | `~/.ctxlite/compactions.json` | Where to persist the on-disk compaction registry used by `ctxlite_compact`. See **"How `ctxlite_compact` persists"** below. |

## How `ctxlite_compact` persists

opencode does not (today) expose an HTTP endpoint or SDK method to mutate `state.time.compacted` on a single message Part. The earlier ctxlite tried `_client.patch("/session/.../message/.../part/...")` against a phantom endpoint that doesn't exist — silently failing on **opencode desktop** (and likely on web too) while reporting `persisted: N` to the caller.

Starting from `0.2.0` ctxlite uses an **on-disk registry**:

```
ctxlite_compact (called by the agent)
   ↓ writes
~/.ctxlite/compactions.json   ← Map<sessionID, { partIds[], compactedAt }>
   ↓ reads
transform hook (called by opencode every turn, BEFORE the LLM call)
   ↓ mutates state.time.compacted in-place on the outgoing payload
opencode renders "[Old tool result content cleared]"
```

This works on **both opencode desktop and opencode web**, because it doesn't depend on opencode's HTTP API at all — only on the `experimental.chat.messages.transform` hook, which is part of the universal plugin contract.

Properties:

- **Persistent across restarts.** The registry is on disk; closing and reopening opencode preserves the compactions.
- **Idempotent.** Replaying the same registry on already-compacted parts is a no-op (`state.time.compacted > 0` short-circuits).
- **Atomic.** `saveRegistry` writes to `<path>.tmp` and renames; a crash mid-write can't leave a half-truncated JSON.
- **Fail-open.** A corrupt or missing registry file degrades to "no pending compactions" — opencode keeps running without ctxlite getting in the way.
- **Per-session isolation.** Sessions are keyed by `sessionID`; mutations from session A never leak into session B.
- **TTL.** At plugin boot, sessions whose `compactedAt` is older than 30 days are pruned automatically.
- **Override-friendly.** Set `registryPath` in the plugin config if you want a project-local file or a shared registry across multiple opencode installs.

The registry is **append-only by design**: `ctxlite_compact` adds partIds; nothing in the plugin removes them except the 30-day TTL. The agent can revoke a compaction by deleting the file, editing the JSON manually, or just letting the TTL expire.

## Prompt cache trade-off

ctxlite mutates `state.time.compacted` on **past** tool_results — meaning the byte-prefix of the messages payload changes between turns. Anthropic's prompt cache is byte-identical-prefix: any mutation past a cache breakpoint invalidates everything after it.

Concretely: every Edit/Write that supersedes a prior Read forces a cache miss from the position of that Read in the history. In a session with ~10 Edits over 50 turns, this can amount to **hundreds of thousands of input-equivalent tokens** of extra cost (cache-write at 1.25× instead of cache-read at 0.1×).

ctxlite still wins overall when:
- the same large file is read+edited multiple times (prefix shrinks more than the miss costs),
- the session is long enough to amortize the misses,
- token-window pressure matters more than per-turn latency.

ctxlite loses when:
- the session is short (< 20 turns), few files, sparse edits — you pay misses without recouping,
- you're in a tight edit/test loop (cache invalidated every 1–2 turns).

### Cache-friendly configuration

The two knobs `preserveOldestMessages` and `minMessagesForActivation` let you carve out a stable prefix that ctxlite never mutates, so the cache stays hot for the bulk of the conversation.

A reasonable starting point for cache-sensitive sessions:

```json
{
  "preserveOldestMessages": 6,
  "minMessagesForActivation": 8
}
```

Translation: ctxlite stays silent for the first 8 messages, then starts pruning — but only on messages 7 and later. The first 6 messages (typically: bootstrap, initial reads, plan) remain a stable cached prefix.

If you don't care about the prompt cache (e.g. local model, no cache pricing), leave both at `0`.

## Verifying it works

After enabling the plugin, run a session that reads the same file multiple times across edits. With `logLevel: "info"` you should see lines like:

```
[ctxlite] loaded — tools=[read,edit] preserveRecent=0
[ctxlite] invalidated 2 stale tool_result(s) across 7 eligible — reasons: edit-supersedes-prior-read=1, duplicate-read=1
```

To confirm at the API level, intercept the request payload (opencode debug mode or a network proxy): obsolete tool_results should arrive with the body `[Old tool result content cleared]` instead of the original file content.

## Failure modes

ctxlite is **fail-open**: any unexpected exception is caught, logged at `info`, and the message history is forwarded unchanged. opencode never breaks because of a ctxlite bug.

If you suspect ctxlite is invalidating something it shouldn't, set `logLevel: "debug"` and inspect the per-decision reasons. If the issue is reproducible, the analyzer is a pure function — file an issue with the message history snapshot.

## Limitations & roadmap (Tier 2)

- **`apply_patch` is not handled in v1.** The patch-text format would require reproducing opencode's patch parser; deferred until needed.
- **No explicit `forget(path)` mechanism.** Files read once and never touched again stay in history until the broader compaction kicks in. A future MCP server (`file-session`) with an explicit `forget` tool is sketched in the [plan](../.claude/plans/woolly-puzzling-gem.md) but only if real usage shows the need.
- **MCP tools that read files (e.g. Serena `find_symbol`)** are currently outside the scope. Adding them requires per-tool path-extraction logic in `extract-path.ts`.

## Architecture summary

```
src/
├── index.ts           # default export: { id, server }; registers the hook
├── invalidation.ts    # pure: decideInvalidations(parts, options) → decisions[]
├── extract-path.ts    # pure: extractFileRef(toolName, input) → FileRef | null
└── types.ts           # internal types — no opencode dependency
```

`index.ts` is the only file that imports opencode types (`@opencode-ai/plugin`, `@opencode-ai/sdk`). Everything else is pure logic with no runtime dependencies — drop-in testable.

## Tests

```bash
bun install        # install dev deps (first time only)
bun test           # run the full suite
bun run typecheck  # typecheck only
```

**118 tests across 10 files.** One pre-existing failure on `duplicate-bash` (fixture shares `messageIdx`, unrelated to recent changes); the remaining 117 pass.

| File | Coverage |
|------|----------|
| `extract-path.test.ts` | path normalization (Unix + Windows drives), range arithmetic, isErrorOutput precision |
| `invalidation.test.ts` | the four primary invalidation reasons (`edit-supersedes-prior-read`, `read-superset-supersedes-prior-read`, `duplicate-read`, `write-supersedes-prior`), idempotency, untracked-tool isolation |
| `layer-b.test.ts` | bash-side detectors (`bash-error-superseded-by-success`, `duplicate-bash`, `error-superseded-by-success` for read) |
| `selector.test.ts` | `matchSelector` filters: type, tool, olderThanMessages, largerThanTokens, flaggedAs, partIds intersection |
| `compact-on-demand.test.ts` | `planCompaction` safety set, massive-op confirmation guard, tokens-recovered estimate |
| `flag-heuristics.test.ts` | dead-reasoning, superseded-tool-result, large-error, oversized-bash-output, duplicate-text |
| `smoke-integration.test.ts` | end-to-end against real `@opencode-ai/sdk` types: read→edit→read mutation, idempotency, fail-open on malformed input, running-tool isolation, **`preserveOldestMessages`**, **`minMessagesForActivation`** |
| `cache-friendly.test.ts` | exhaustive matrix for the cache-friendly knobs: protected-prefix invariant, warm-up gate, knob interaction grid (8 combinations), invalid-input coercion, byte-stable re-runs |
| `registry.test.ts` | **registry persistence**: defensive load (missing file, empty file, invalid JSON, wrong version, malformed entries), atomic save (tmp+rename), idempotent merge, per-session isolation, TTL cleanup with boundary case, default path under `$HOME/.ctxlite/` |
| `compact-persistence.test.ts` | **end-to-end registry replay** against real SDK types: registry entry → transform mutates the matching part; replay unaffected by `minMessagesForActivation` and `preserveOldestMessages` (explicit user decisions take precedence); cross-session isolation; idempotent re-runs; missing/corrupt registry are no-ops; **simulated restart** (new plugin instance reads the same on-disk file and applies pending compactions) |

### What the tests verify

- **Pure logic** (no SDK dep): every invalidation rule, every flag heuristic, every selector branch.
- **SDK contract**: smoke tests use the real `@opencode-ai/sdk` types and run the plugin's `server()` factory exactly as opencode would. If the SDK shape drifts, tests break.
- **Cache invariants**: `cache-friendly.test.ts` asserts that `preserveOldestMessages=N` keeps the prefix byte-identical across re-runs, and that `minMessagesForActivation=K` produces zero mutations until the threshold.
- **Idempotency**: multiple test files re-invoke the hook on already-processed history and assert no further mutations.

### Adding a test

Tests use `bun:test` (Jest-compatible API). Pure-logic tests use the fixtures in `test/fixtures.ts`; integration tests build SDK-shaped values inline (see `smoke-integration.test.ts`). Keep new tests under `test/` — `bun test` discovers `**/*.test.ts` automatically.

## License

MIT
