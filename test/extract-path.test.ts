import { describe, expect, test } from "bun:test"
import { extractFileRef, normalizePath, rangeContains, FULL_RANGE } from "../src/extract-path.ts"

describe("normalizePath", () => {
  test("converts backslashes to forward slashes", () => {
    expect(normalizePath("C:\\foo\\bar.ts")).toBe("c:/foo/bar.ts")
  })

  test("collapses duplicate separators", () => {
    expect(normalizePath("C:\\\\foo//bar")).toBe("c:/foo/bar")
  })

  test("strips trailing slash on non-root paths", () => {
    expect(normalizePath("/foo/bar/")).toBe("/foo/bar")
  })

  test("preserves root '/' and 'C:/'", () => {
    expect(normalizePath("/")).toBe("/")
    expect(normalizePath("C:/")).toBe("c:/")
  })

  test("lowercases Windows drive letter for stable comparison", () => {
    expect(normalizePath("D:/Code/file.ts")).toBe(normalizePath("d:/Code/file.ts"))
  })

  test("returns empty string for empty/non-string input", () => {
    expect(normalizePath("")).toBe("")
    // @ts-expect-error testing defensive behavior
    expect(normalizePath(undefined)).toBe("")
  })
})

describe("extractFileRef", () => {
  test("read: full-file when offset/limit absent", () => {
    expect(extractFileRef("read", { filePath: "/a.ts" })).toEqual({
      path: "/a.ts",
      range: FULL_RANGE,
    })
  })

  test("read: closed range when offset+limit present", () => {
    expect(extractFileRef("read", { filePath: "/a.ts", offset: 10, limit: 50 })).toEqual({
      path: "/a.ts",
      range: { start: 10, end: 59 },
    })
  })

  test("read: open-ended when only offset present", () => {
    expect(extractFileRef("read", { filePath: "/a.ts", offset: 100 })).toEqual({
      path: "/a.ts",
      range: { start: 100, end: undefined },
    })
  })

  test("read: invalid offset/limit fall back to defaults", () => {
    expect(extractFileRef("read", { filePath: "/a.ts", offset: -1, limit: "x" })).toEqual({
      path: "/a.ts",
      range: { start: 1, end: undefined },
    })
  })

  test("read: missing filePath returns null", () => {
    expect(extractFileRef("read", {})).toBeNull()
    expect(extractFileRef("read", { filePath: "" })).toBeNull()
  })

  test("edit: returns full-range regardless of strings", () => {
    expect(extractFileRef("edit", { filePath: "/a.ts", oldString: "x", newString: "y" })).toEqual({
      path: "/a.ts",
      range: FULL_RANGE,
    })
  })

  test("apply_patch: returns null in v1 (path extraction not implemented)", () => {
    expect(extractFileRef("apply_patch", { patchText: "*** Begin Patch\n*** End Patch" })).toBeNull()
  })

  test("unknown tool returns null", () => {
    expect(extractFileRef("bash", { command: "ls" })).toBeNull()
  })

  test("malformed input (null/non-object) returns null", () => {
    expect(extractFileRef("read", null)).toBeNull()
    expect(extractFileRef("read", undefined)).toBeNull()
  })
})

describe("rangeContains", () => {
  test("open-ended outer covers any closed inner with start ≥ outer.start", () => {
    expect(rangeContains({ start: 1, end: undefined }, { start: 5, end: 100 })).toBe(true)
    expect(rangeContains({ start: 10, end: undefined }, { start: 5, end: 100 })).toBe(false)
  })

  test("closed outer fully covers closed inner", () => {
    expect(rangeContains({ start: 1, end: 100 }, { start: 10, end: 50 })).toBe(true)
    expect(rangeContains({ start: 1, end: 100 }, { start: 10, end: 200 })).toBe(false)
  })

  test("closed outer never covers open-ended inner", () => {
    expect(rangeContains({ start: 1, end: 100 }, { start: 5, end: undefined })).toBe(false)
  })

  test("identical ranges contain each other", () => {
    expect(rangeContains({ start: 1, end: 100 }, { start: 1, end: 100 })).toBe(true)
  })
})
