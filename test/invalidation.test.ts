import { beforeEach, describe, expect, test } from "bun:test"
import { decideInvalidations } from "../src/invalidation.ts"
import {
  DEFAULT_OPTS,
  applyPatchPart,
  editPart,
  readPart,
  resetIdx,
} from "./fixtures.ts"

describe("decideInvalidations — primary scenarios", () => {
  beforeEach(() => resetIdx())

  test("Read → Edit → Read on same path → first Read invalidated", () => {
    const r1 = readPart({ path: "/a.ts" })
    const e1 = editPart({ path: "/a.ts" })
    const r2 = readPart({ path: "/a.ts" })

    const decisions = decideInvalidations([r1, e1, r2], DEFAULT_OPTS)

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.location).toEqual(r1.location)
    expect(decisions[0]?.reason).toBe("edit-supersedes-prior-read")
  })

  test("Read(1-50) → Read(1-100) on same path → first Read invalidated as superset", () => {
    const r1 = readPart({ path: "/a.ts", offset: 1, limit: 50 })
    const r2 = readPart({ path: "/a.ts", offset: 1, limit: 100 })

    const decisions = decideInvalidations([r1, r2], DEFAULT_OPTS)

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.location).toEqual(r1.location)
    expect(decisions[0]?.reason).toBe("read-superset-supersedes-prior-read")
  })

  test("Read(1-100) → Read(1-50) → narrower range does NOT invalidate broader prior", () => {
    const r1 = readPart({ path: "/a.ts", offset: 1, limit: 100 })
    const r2 = readPart({ path: "/a.ts", offset: 1, limit: 50 })

    const decisions = decideInvalidations([r1, r2], DEFAULT_OPTS)

    expect(decisions).toHaveLength(0)
  })

  test("Read(a) → Read(b) → Read(a) → only Read(a) #1 invalidated; Read(b) untouched", () => {
    const ra1 = readPart({ path: "/a.ts" })
    const rb1 = readPart({ path: "/b.ts" })
    const ra2 = readPart({ path: "/a.ts" })

    const decisions = decideInvalidations([ra1, rb1, ra2], DEFAULT_OPTS)

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.location).toEqual(ra1.location)
    expect(decisions[0]?.reason).toBe("duplicate-read")
  })

  test("identical full-file Reads → earlier marked as duplicate-read", () => {
    const r1 = readPart({ path: "/a.ts" })
    const r2 = readPart({ path: "/a.ts" })

    const decisions = decideInvalidations([r1, r2], DEFAULT_OPTS)

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.reason).toBe("duplicate-read")
  })
})

describe("decideInvalidations — Edit chains", () => {
  beforeEach(() => resetIdx())

  test("Edit → Edit on same path → first Edit invalidated", () => {
    const e1 = editPart({ path: "/a.ts" })
    const e2 = editPart({ path: "/a.ts" })

    const decisions = decideInvalidations([e1, e2], DEFAULT_OPTS)

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.reason).toBe("edit-supersedes-prior-edit")
  })

  test("Read → Edit → Edit → Read → 1st Read + 1st Edit invalidated", () => {
    const r1 = readPart({ path: "/a.ts" })
    const e1 = editPart({ path: "/a.ts" })
    const e2 = editPart({ path: "/a.ts" })
    const r2 = readPart({ path: "/a.ts" })

    const decisions = decideInvalidations([r1, e1, e2, r2], DEFAULT_OPTS)

    const targets = decisions.map((d) => d.location)
    expect(targets).toContainEqual(r1.location)
    expect(targets).toContainEqual(e1.location)
    expect(decisions).toHaveLength(2)
  })
})

describe("decideInvalidations — idempotency & alreadyCompacted", () => {
  beforeEach(() => resetIdx())

  test("re-running on already-marked history yields no new decisions", () => {
    const r1 = readPart({ path: "/a.ts", compacted: true }) // already done by prior run
    const e1 = editPart({ path: "/a.ts" })
    const r2 = readPart({ path: "/a.ts" })

    const decisions = decideInvalidations([r1, e1, r2], DEFAULT_OPTS)

    // r1 is alreadyCompacted → filtered out of decisions
    expect(decisions).toHaveLength(0)
  })

  test("compacted Edit still invalidates prior live Reads (file changed marker)", () => {
    const r1 = readPart({ path: "/a.ts" })
    const e1 = editPart({ path: "/a.ts", compacted: true })
    const r2 = readPart({ path: "/a.ts" })

    const decisions = decideInvalidations([r1, e1, r2], DEFAULT_OPTS)

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.location).toEqual(r1.location)
    expect(decisions[0]?.reason).toBe("edit-supersedes-prior-read")
  })

  test("compacted Read does not contribute to active set (cannot supersede later)", () => {
    // Without the compacted Read in the active set, the second live Read has nothing
    // to supersede; only one read survives, and it's the live one — no decisions.
    const r1 = readPart({ path: "/a.ts", compacted: true, offset: 1, limit: 100 })
    const r2 = readPart({ path: "/a.ts", offset: 1, limit: 50 })

    const decisions = decideInvalidations([r1, r2], DEFAULT_OPTS)

    expect(decisions).toHaveLength(0)
  })
})

describe("decideInvalidations — boundary safety", () => {
  beforeEach(() => resetIdx())

  test("never invalidates the most recent live tool_result for a path", () => {
    const r1 = readPart({ path: "/a.ts" })
    const r2 = readPart({ path: "/a.ts" })
    const r3 = readPart({ path: "/a.ts" })

    const decisions = decideInvalidations([r1, r2, r3], DEFAULT_OPTS)

    // r3 must never be in decisions.
    for (const d of decisions) {
      expect(d.location).not.toEqual(r3.location)
    }
  })

  test("untracked tools are ignored entirely", () => {
    const opts = { ...DEFAULT_OPTS, tools: new Set(["read"]) } // edit not tracked
    const r1 = readPart({ path: "/a.ts" })
    const e1 = editPart({ path: "/a.ts" })
    const r2 = readPart({ path: "/a.ts" })

    const decisions = decideInvalidations([r1, e1, r2], opts)

    // With edit untracked, the algorithm sees: Read → Read (full+full) → r1 is duplicate.
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.location).toEqual(r1.location)
    expect(decisions[0]?.reason).toBe("duplicate-read")
  })

  test("apply_patch is ignored in v1 (extractFileRef returns null)", () => {
    const r1 = readPart({ path: "/a.ts" })
    const ap = applyPatchPart()
    const r2 = readPart({ path: "/a.ts" })

    const decisions = decideInvalidations([r1, ap, r2], DEFAULT_OPTS)

    // apply_patch produces no FileRef → r1 invalidated as duplicate of r2 (no edit signal).
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.reason).toBe("duplicate-read")
  })

  test("empty input → empty decisions", () => {
    expect(decideInvalidations([], DEFAULT_OPTS)).toHaveLength(0)
  })

  test("non-eligible (not completed) parts skipped", () => {
    const r1 = readPart({ path: "/a.ts" })
    // Manually flip eligible to false to simulate a still-running tool call.
    const inflight = {
      ...readPart({ path: "/a.ts" }),
      view: { ...readPart({ path: "/a.ts" }).view, eligible: false },
    }
    const r2 = readPart({ path: "/a.ts" })

    const decisions = decideInvalidations([r1, inflight, r2], DEFAULT_OPTS)

    // r1 → r2 with full ranges → r1 is duplicate-read; the in-flight one is invisible.
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.location).toEqual(r1.location)
  })
})

describe("decideInvalidations — independence between paths", () => {
  beforeEach(() => resetIdx())

  test("Edit on path A does not affect Read on path B", () => {
    const ra = readPart({ path: "/a.ts" })
    const rb = readPart({ path: "/b.ts" })
    const ea = editPart({ path: "/a.ts" })
    const ra2 = readPart({ path: "/a.ts" })

    const decisions = decideInvalidations([ra, rb, ea, ra2], DEFAULT_OPTS)

    const targets = decisions.map((d) => d.location)
    expect(targets).toContainEqual(ra.location)
    expect(targets).not.toContainEqual(rb.location)
  })
})
