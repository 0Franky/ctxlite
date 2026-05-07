/**
 * Persistent compaction registry.
 *
 * The opencode HTTP API does not (today) expose a way to mutate
 * `state.time.compacted` on a single message Part. On desktop opencode the
 * `_client.patch()` we previously used was either a no-op or hit a phantom
 * endpoint that returned 200 without applying the change. To make
 * `ctxlite_compact` actually persist on every platform — desktop, web,
 * future versions — we keep our own registry and replay it from the
 * transform hook on every turn. The mutation itself still flows through
 * the same primitive used by Layer A/B (`state.time.compacted = now`),
 * so the rendered "[Old tool result content cleared]" behaviour is
 * identical.
 *
 * Properties:
 *   - Independent of opencode's HTTP API. Works on desktop and web.
 *   - Idempotent: replaying the same registry on the same payload is a no-op.
 *   - Atomic write: tmp + rename so a crash mid-write can't leave a half-
 *     truncated JSON that bricks the plugin.
 *   - Fail-open on every error: any I/O or parse failure returns an empty
 *     registry, so a corrupt file degrades to "no pending compactions"
 *     instead of crashing opencode.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

export interface CompactionEntry {
  partIds: string[]
  compactedAt: number
}

export interface RegistryV1 {
  version: 1
  sessions: Record<string, CompactionEntry>
}

const EMPTY: RegistryV1 = { version: 1, sessions: {} }

/** Default location: per-user, outside any project tree. */
export function defaultRegistryPath(): string {
  return path.join(os.homedir(), ".ctxlite", "compactions.json")
}

function emptyRegistry(): RegistryV1 {
  return { version: 1, sessions: {} }
}

/**
 * Read the registry from disk. Any I/O or parse error returns an empty
 * registry so the caller can keep going.
 *
 * Defensive: validates the on-disk shape before returning. Unknown fields
 * survive a round-trip only for entries we don't touch; corrupted entries
 * are silently dropped.
 */
export async function loadRegistry(filePath: string): Promise<RegistryV1> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch {
    return emptyRegistry()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyRegistry()
  }
  if (typeof parsed !== "object" || parsed === null) return emptyRegistry()
  const obj = parsed as Record<string, unknown>
  if (obj["version"] !== 1) return emptyRegistry()
  const sessions = obj["sessions"]
  if (typeof sessions !== "object" || sessions === null) return emptyRegistry()

  const out: RegistryV1 = { version: 1, sessions: {} }
  for (const [sid, value] of Object.entries(sessions as Record<string, unknown>)) {
    if (typeof sid !== "string" || sid.length === 0) continue
    if (typeof value !== "object" || value === null) continue
    const v = value as Record<string, unknown>
    const partIdsRaw = v["partIds"]
    if (!Array.isArray(partIdsRaw)) continue
    const partIds: string[] = []
    for (const id of partIdsRaw) {
      if (typeof id === "string" && id.length > 0) partIds.push(id)
    }
    const compactedAtRaw = v["compactedAt"]
    const compactedAt =
      typeof compactedAtRaw === "number" && Number.isFinite(compactedAtRaw) && compactedAtRaw > 0
        ? compactedAtRaw
        : Date.now()
    out.sessions[sid] = { partIds, compactedAt }
  }
  return out
}

/**
 * Persist the registry atomically: write to a sibling tmp file, then
 * rename(2). Last writer wins; we don't take a lock because in practice
 * a single opencode instance is the sole writer per session.
 */
export async function saveRegistry(filePath: string, reg: RegistryV1): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = filePath + ".tmp"
  await writeFile(tmp, JSON.stringify(reg, null, 2), "utf8")
  await rename(tmp, filePath)
}

/**
 * Add the given partIds to the registry under sessionID. Returns how many
 * were genuinely new (not already present) and the total after the merge.
 * Mutates `reg` in place; caller is responsible for `saveRegistry`.
 */
export function addToRegistry(
  reg: RegistryV1,
  sessionID: string,
  newPartIds: readonly string[],
): { added: number; total: number } {
  const existing = reg.sessions[sessionID]?.partIds ?? []
  const set = new Set(existing)
  let added = 0
  for (const id of newPartIds) {
    if (typeof id !== "string" || id.length === 0) continue
    if (set.has(id)) continue
    set.add(id)
    added++
  }
  reg.sessions[sessionID] = {
    partIds: [...set],
    compactedAt: Date.now(),
  }
  return { added, total: set.size }
}

/**
 * Set of partIds the registry says are compacted for this session.
 * Empty Set if the session is unknown.
 */
export function getCompactedForSession(reg: RegistryV1, sessionID: string): Set<string> {
  const entry = reg.sessions[sessionID]
  if (!entry) return new Set()
  return new Set(entry.partIds)
}

/**
 * Drop sessions whose `compactedAt` is older than `maxAgeMs`. Returns how
 * many sessions were removed. Mutates `reg` in place.
 */
export function cleanupOldEntries(
  reg: RegistryV1,
  maxAgeMs: number,
  now: number = Date.now(),
): { removed: number } {
  let removed = 0
  for (const [sid, entry] of Object.entries(reg.sessions)) {
    if (now - entry.compactedAt > maxAgeMs) {
      delete reg.sessions[sid]
      removed++
    }
  }
  return { removed }
}
