/**
 * Phase 2 (Layer B) unit tests.
 *
 * Covers only non-trivial logic: isErrorOutput pattern matching, and the four
 * new invalidation detectors. One focused test per detector.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { isErrorOutput } from "../src/extract-path.ts"
import { decideInvalidations } from "../src/invalidation.ts"
import { DEFAULT_OPTS, bashPart, readPart, resetIdx, writePart } from "./fixtures.ts"

// ---------------------------------------------------------------------------
// isErrorOutput
// ---------------------------------------------------------------------------

describe("isErrorOutput", () => {
  test("returns false for empty string", () => {
    expect(isErrorOutput("read", "")).toBe(false)
  })

  test("returns false for clean successful output", () => {
    expect(isErrorOutput("read", "export function foo() {}")).toBe(false)
  })

  test("matches 'Error:' line prefix", () => {
    expect(isErrorOutput("read", "Error: something went wrong")).toBe(true)
  })

  test("matches ENOENT token anywhere in output", () => {
    expect(isErrorOutput("read", "open /tmp/missing.ts: ENOENT: no such file")).toBe(true)
  })

  test("bash: matches non-zero exit code marker", () => {
    expect(isErrorOutput("bash", "some output\nexit code: 1")).toBe(true)
  })

  test("bash: does NOT match exit code 0", () => {
    expect(isErrorOutput("bash", "success\nexit code: 0")).toBe(false)
  })

  test("edit: matches oldString not found", () => {
    expect(isErrorOutput("edit", "oldString not found in file")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// write-supersedes-prior
// ---------------------------------------------------------------------------

describe("decideInvalidations — write-supersedes-prior", () => {
  beforeEach(() => resetIdx())

  test("Read → Write same path → Read invalidated with write-supersedes-prior", () => {
    const r1 = readPart({ path: "/a.ts" })
    const w1 = writePart({ path: "/a.ts" })

    const decisions = decideInvalidations([r1, w1], DEFAULT_OPTS)

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.location).toEqual(r1.location)
    expect(decisions[0]?.reason).toBe("write-supersedes-prior")
  })
})

// ---------------------------------------------------------------------------
// error-superseded-by-success (file tools)
// ---------------------------------------------------------------------------

describe("decideInvalidations — error-superseded-by-success", () => {
  beforeEach(() => resetIdx())

  test("errored Read → successful Read same path → errored invalidated", () => {
    const r1 = readPart({ path: "/a.ts" })
    // Manually build a view with errored output to avoid polluting readPart fixture API.
    const erroredInput = {
      location: { messageIdx: 0, partIdx: 1 },
      view: {
        tool: "read",
        input: { filePath: "/a.ts" },
        output: "Error: file locked",
        eligible: true,
        alreadyCompacted: false,
      },
    }
    // Use resetIdx to keep indices deterministic — but we're building manually here.
    // Rebuild r1 and erroredR so nextIdx is irrelevant for this test.
    const parts = [
      {
        location: { messageIdx: 0, partIdx: 0 },
        view: {
          tool: "read",
          input: { filePath: "/a.ts" },
          output: "Error: ENOENT: no such file",
          eligible: true,
          alreadyCompacted: false,
        },
      },
      {
        location: { messageIdx: 0, partIdx: 1 },
        view: {
          tool: "read",
          input: { filePath: "/a.ts" },
          output: "export const x = 1",
          eligible: true,
          alreadyCompacted: false,
        },
      },
    ]

    const decisions = decideInvalidations(parts, DEFAULT_OPTS)

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.location).toEqual({ messageIdx: 0, partIdx: 0 })
    expect(decisions[0]?.reason).toBe("error-superseded-by-success")
  })
})

// ---------------------------------------------------------------------------
// duplicate-bash
// ---------------------------------------------------------------------------

describe("decideInvalidations — duplicate-bash", () => {
  beforeEach(() => resetIdx())

  test("same bash command twice with identical clean output → first invalidated", () => {
    const b1 = bashPart({ command: "bun test", output: "40 pass" })
    const b2 = bashPart({ command: "bun test", output: "40 pass" })

    const decisions = decideInvalidations([b1, b2], DEFAULT_OPTS)

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.location).toEqual(b1.location)
    expect(decisions[0]?.reason).toBe("duplicate-bash")
  })
})

// ---------------------------------------------------------------------------
// bash-error-superseded-by-success
// ---------------------------------------------------------------------------

describe("decideInvalidations — bash-error-superseded-by-success", () => {
  beforeEach(() => resetIdx())

  test("errored bash → same bash success → errored entry invalidated", () => {
    const b1 = bashPart({ command: "npm run build", output: "Error: build failed\nexit code: 1" })
    const b2 = bashPart({ command: "npm run build", output: "build succeeded" })

    const decisions = decideInvalidations([b1, b2], DEFAULT_OPTS)

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.location).toEqual(b1.location)
    expect(decisions[0]?.reason).toBe("bash-error-superseded-by-success")
  })
})
