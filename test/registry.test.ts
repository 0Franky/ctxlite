/**
 * Exhaustive tests for the persistent compaction registry.
 *
 * The registry is the load-bearing piece that makes ctxlite_compact actually
 * persist on opencode desktop (where the HTTP "PATCH part" we previously
 * tried doesn't exist). Tests cover: round-trip, atomic write, defensive
 * parse of corrupted files, idempotent merge, multi-session isolation, TTL
 * cleanup, default path resolution.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
  addToRegistry,
  cleanupOldEntries,
  defaultRegistryPath,
  getCompactedForSession,
  loadRegistry,
  saveRegistry,
  type RegistryV1,
} from "../src/registry.ts"

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "ctxlite-registry-test-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function regPath(name = "registry.json"): string {
  return path.join(tmpDir, name)
}

describe("loadRegistry — defensive read", () => {
  test("missing file → empty registry", async () => {
    const reg = await loadRegistry(regPath("does-not-exist.json"))
    expect(reg).toEqual({ version: 1, sessions: {} })
  })

  test("empty file → empty registry", async () => {
    const p = regPath()
    await writeFile(p, "", "utf8")
    const reg = await loadRegistry(p)
    expect(reg.sessions).toEqual({})
  })

  test("invalid JSON → empty registry (fail-open)", async () => {
    const p = regPath()
    await writeFile(p, "{ not valid json,,, ", "utf8")
    const reg = await loadRegistry(p)
    expect(reg).toEqual({ version: 1, sessions: {} })
  })

  test("wrong version → empty registry", async () => {
    const p = regPath()
    await writeFile(p, JSON.stringify({ version: 99, sessions: { s1: { partIds: ["a"], compactedAt: 1 } } }), "utf8")
    const reg = await loadRegistry(p)
    expect(reg.sessions).toEqual({})
  })

  test("missing sessions field → empty registry", async () => {
    const p = regPath()
    await writeFile(p, JSON.stringify({ version: 1 }), "utf8")
    const reg = await loadRegistry(p)
    expect(reg.sessions).toEqual({})
  })

  test("sessions with malformed entries are silently dropped", async () => {
    const p = regPath()
    const onDisk = {
      version: 1,
      sessions: {
        good: { partIds: ["x", "y"], compactedAt: 1700000000000 },
        wrong_partIds: { partIds: "nope", compactedAt: 1700000000000 },
        wrong_partIds_items: { partIds: [123, null, "valid"], compactedAt: 1700000000000 },
        no_partIds: { compactedAt: 1700000000000 },
        null_value: null,
      },
    }
    await writeFile(p, JSON.stringify(onDisk), "utf8")
    const reg = await loadRegistry(p)
    expect(reg.sessions["good"]).toEqual({ partIds: ["x", "y"], compactedAt: 1700000000000 })
    // Item 123 and null filtered out, "valid" kept.
    expect(reg.sessions["wrong_partIds_items"]?.partIds).toEqual(["valid"])
    expect(reg.sessions["wrong_partIds"]).toBeUndefined()
    expect(reg.sessions["no_partIds"]).toBeUndefined()
    expect(reg.sessions["null_value"]).toBeUndefined()
  })

  test("compactedAt absent or invalid is replaced with now()", async () => {
    const p = regPath()
    const onDisk = {
      version: 1,
      sessions: {
        s1: { partIds: ["x"] },
        s2: { partIds: ["y"], compactedAt: "not a number" },
        s3: { partIds: ["z"], compactedAt: -5 },
      },
    }
    const before = Date.now()
    await writeFile(p, JSON.stringify(onDisk), "utf8")
    const reg = await loadRegistry(p)
    const after = Date.now()
    for (const sid of ["s1", "s2", "s3"]) {
      const ts = reg.sessions[sid]?.compactedAt ?? 0
      expect(ts).toBeGreaterThanOrEqual(before)
      expect(ts).toBeLessThanOrEqual(after)
    }
  })
})

describe("saveRegistry — atomic write", () => {
  test("creates parent directory if missing", async () => {
    const p = path.join(tmpDir, "deep", "nested", "registry.json")
    const reg: RegistryV1 = { version: 1, sessions: { s1: { partIds: ["a"], compactedAt: 1 } } }
    await saveRegistry(p, reg)
    const onDisk = JSON.parse(await readFile(p, "utf8"))
    expect(onDisk).toEqual(reg)
  })

  test("round-trip: save → load returns the same data", async () => {
    const p = regPath()
    const reg: RegistryV1 = {
      version: 1,
      sessions: {
        s1: { partIds: ["p1", "p2", "p3"], compactedAt: 1700000000000 },
        s2: { partIds: ["pX"], compactedAt: 1700000001000 },
      },
    }
    await saveRegistry(p, reg)
    const loaded = await loadRegistry(p)
    expect(loaded).toEqual(reg)
  })

  test("save uses tmp+rename pattern (no .tmp file remains after success)", async () => {
    const p = regPath()
    await saveRegistry(p, { version: 1, sessions: {} })
    // The tmp file should not exist anymore.
    let tmpStillExists = false
    try {
      await readFile(p + ".tmp", "utf8")
      tmpStillExists = true
    } catch {
      tmpStillExists = false
    }
    expect(tmpStillExists).toBe(false)
  })

  test("save overwrites previous content (last writer wins)", async () => {
    const p = regPath()
    await saveRegistry(p, { version: 1, sessions: { a: { partIds: ["1"], compactedAt: 1 } } })
    await saveRegistry(p, { version: 1, sessions: { b: { partIds: ["2"], compactedAt: 2 } } })
    const reg = await loadRegistry(p)
    expect(reg.sessions["a"]).toBeUndefined()
    expect(reg.sessions["b"]).toEqual({ partIds: ["2"], compactedAt: 2 })
  })
})

describe("addToRegistry — idempotent merge", () => {
  test("first add: returns added=N, total=N", async () => {
    const reg: RegistryV1 = { version: 1, sessions: {} }
    const r = addToRegistry(reg, "sess1", ["a", "b", "c"])
    expect(r.added).toBe(3)
    expect(r.total).toBe(3)
    expect(reg.sessions["sess1"]?.partIds.sort()).toEqual(["a", "b", "c"])
  })

  test("re-adding same ids: added=0, total unchanged (idempotent)", async () => {
    const reg: RegistryV1 = {
      version: 1,
      sessions: { sess1: { partIds: ["a", "b"], compactedAt: 1 } },
    }
    const r = addToRegistry(reg, "sess1", ["a", "b"])
    expect(r.added).toBe(0)
    expect(r.total).toBe(2)
  })

  test("partial overlap: only new ids counted", async () => {
    const reg: RegistryV1 = {
      version: 1,
      sessions: { sess1: { partIds: ["a", "b"], compactedAt: 1 } },
    }
    const r = addToRegistry(reg, "sess1", ["b", "c", "d"])
    expect(r.added).toBe(2)
    expect(r.total).toBe(4)
    expect(new Set(reg.sessions["sess1"]?.partIds)).toEqual(new Set(["a", "b", "c", "d"]))
  })

  test("invalid ids (non-string, empty) are skipped", async () => {
    const reg: RegistryV1 = { version: 1, sessions: {} }
    // Pass-through cast for type-deliberate junk.
    const ids = ["valid", "", null, undefined, 42] as unknown as string[]
    const r = addToRegistry(reg, "sess1", ids)
    expect(r.added).toBe(1)
    expect(reg.sessions["sess1"]?.partIds).toEqual(["valid"])
  })

  test("compactedAt is bumped on every merge", async () => {
    const reg: RegistryV1 = {
      version: 1,
      sessions: { sess1: { partIds: ["a"], compactedAt: 1 } },
    }
    addToRegistry(reg, "sess1", ["b"])
    expect(reg.sessions["sess1"]?.compactedAt).toBeGreaterThan(1)
  })

  test("multiple sessions are isolated", async () => {
    const reg: RegistryV1 = { version: 1, sessions: {} }
    addToRegistry(reg, "sess1", ["a", "b"])
    addToRegistry(reg, "sess2", ["c"])
    expect(reg.sessions["sess1"]?.partIds.sort()).toEqual(["a", "b"])
    expect(reg.sessions["sess2"]?.partIds).toEqual(["c"])
  })
})

describe("getCompactedForSession", () => {
  test("returns empty Set for unknown session", () => {
    const reg: RegistryV1 = { version: 1, sessions: {} }
    expect(getCompactedForSession(reg, "missing").size).toBe(0)
  })

  test("returns Set with the right ids for a known session", () => {
    const reg: RegistryV1 = {
      version: 1,
      sessions: { s1: { partIds: ["a", "b", "c"], compactedAt: 1 } },
    }
    const set = getCompactedForSession(reg, "s1")
    expect(set.size).toBe(3)
    expect(set.has("a")).toBe(true)
    expect(set.has("b")).toBe(true)
    expect(set.has("c")).toBe(true)
  })

  test("returned Set is a copy (mutating it does not affect the registry)", () => {
    const reg: RegistryV1 = {
      version: 1,
      sessions: { s1: { partIds: ["a"], compactedAt: 1 } },
    }
    const set = getCompactedForSession(reg, "s1")
    set.add("injected")
    expect(reg.sessions["s1"]?.partIds).toEqual(["a"])
  })
})

describe("cleanupOldEntries — TTL", () => {
  test("does not touch fresh entries", () => {
    const now = 1_700_000_000_000
    const reg: RegistryV1 = {
      version: 1,
      sessions: { fresh: { partIds: ["a"], compactedAt: now - 1000 } },
    }
    const r = cleanupOldEntries(reg, 60_000, now)
    expect(r.removed).toBe(0)
    expect(reg.sessions["fresh"]).toBeDefined()
  })

  test("removes entries older than maxAgeMs", () => {
    const now = 1_700_000_000_000
    const reg: RegistryV1 = {
      version: 1,
      sessions: {
        fresh: { partIds: ["a"], compactedAt: now - 1000 },
        ancient: { partIds: ["b"], compactedAt: now - 365 * 24 * 60 * 60 * 1000 },
      },
    }
    const r = cleanupOldEntries(reg, 60_000, now)
    expect(r.removed).toBe(1)
    expect(reg.sessions["ancient"]).toBeUndefined()
    expect(reg.sessions["fresh"]).toBeDefined()
  })

  test("boundary: entry exactly at maxAgeMs is kept (not strictly older)", () => {
    const now = 1_700_000_000_000
    const reg: RegistryV1 = {
      version: 1,
      sessions: { boundary: { partIds: ["a"], compactedAt: now - 60_000 } },
    }
    const r = cleanupOldEntries(reg, 60_000, now)
    expect(r.removed).toBe(0) // 60_000 - 60_000 = 0, NOT > 60_000
  })

  test("empty registry: no-op, removed=0", () => {
    const reg: RegistryV1 = { version: 1, sessions: {} }
    expect(cleanupOldEntries(reg, 60_000, Date.now()).removed).toBe(0)
  })
})

describe("defaultRegistryPath", () => {
  test("returns an absolute path inside the user home", () => {
    const p = defaultRegistryPath()
    expect(path.isAbsolute(p)).toBe(true)
    expect(p.endsWith(path.join(".ctxlite", "compactions.json"))).toBe(true)
  })
})
