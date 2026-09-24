/**
 * Reading a package's declared coverage thresholds — order must not matter.
 *
 * Two tools (`check-coverage-config-present`, `coverage-graduation`) each kept
 * their own copy of `/thresholds:\s*\{([^}]+)\}/`. `[^}]+` stops at the FIRST
 * closing brace, which was harmless until per-glob floors arrived (#568) and
 * made the parse **order-dependent**:
 *
 *   - `packages/verify` declares its bare axes first, so it parsed correctly —
 *     by luck, not by design.
 *   - Adding per-file money floors to the relay (#619) put a glob entry first,
 *     and both tools began reading `42/30/35/44` (the key-rotation file's floor)
 *     as the relay's package thresholds instead of `77/66/80/78`.
 *
 * Latent, because the relay is not a money/identity registry member and only the
 * presence check ran against it. But a tool that reports the wrong number
 * confidently is worse than one that fails, and this is the tooling that decides
 * whether a coverage COMMITMENT has been met.
 *
 * These tests pin the property the old behaviour merely happened to satisfy:
 * declaration order is irrelevant.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPackageThresholds,
  readGlobThresholds,
  extractThresholdBlock,
  stripNestedObjects,
} from "../lib/vitest-thresholds.js";

function withConfig<T>(source: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "vt-"));
  const path = join(dir, "vitest.config.ts");
  writeFileSync(path, source);
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GLOB_FIRST = `
export default defineMotebitTest({
  thresholds: {
    "**/key-rotation.ts": { statements: 42, branches: 30, functions: 35, lines: 44 },
    statements: 77,
    branches: 66,
    functions: 80,
    lines: 78,
  },
});
`;

const GLOB_LAST = `
export default defineMotebitTest({
  thresholds: {
    statements: 77,
    branches: 66,
    functions: 80,
    lines: 78,
    "**/key-rotation.ts": { statements: 42, branches: 30, functions: 35, lines: 44 },
  },
});
`;

describe("readPackageThresholds", () => {
  it("reads the PACKAGE axes when a per-glob floor is declared FIRST", () => {
    // The exact shape that broke it. Before the fix this returned the glob's
    // 42/30/35/44.
    const got = withConfig(GLOB_FIRST, readPackageThresholds);
    expect(got).toEqual({ statements: 77, branches: 66, functions: 80, lines: 78 });
  });

  it("reads the same values when the per-glob floor is declared LAST", () => {
    const got = withConfig(GLOB_LAST, readPackageThresholds);
    expect(got).toEqual({ statements: 77, branches: 66, functions: 80, lines: 78 });
  });

  it("is order-independent — the property, not the two cases", () => {
    expect(withConfig(GLOB_FIRST, readPackageThresholds)).toEqual(
      withConfig(GLOB_LAST, readPackageThresholds),
    );
  });

  it("handles multiple per-glob floors interleaved with the axes", () => {
    const src = `thresholds: {
      "**/a.ts": { statements: 1, branches: 2, functions: 3, lines: 4 },
      statements: 90,
      "**/b.ts": { statements: 5, branches: 6, functions: 7, lines: 8 },
      branches: 85,
      functions: 91,
      lines: 92,
    },`;
    expect(withConfig(src, readPackageThresholds)).toEqual({
      statements: 90,
      branches: 85,
      functions: 91,
      lines: 92,
    });
  });

  it("returns null for a config with no thresholds block", () => {
    expect(withConfig("export default {}", readPackageThresholds)).toBeNull();
  });

  it("returns null when an axis is missing rather than guessing one", () => {
    const src = `thresholds: { statements: 90, branches: 85, functions: 91 },`;
    expect(withConfig(src, readPackageThresholds)).toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(readPackageThresholds("/nonexistent/vitest.config.ts")).toBeNull();
  });

  it("accepts fractional floors", () => {
    const src = `thresholds: { statements: 90.5, branches: 85.25, functions: 91, lines: 92 },`;
    expect(withConfig(src, readPackageThresholds)?.statements).toBe(90.5);
  });
});

describe("readGlobThresholds", () => {
  it("returns the per-file floors keyed by glob, regardless of position", () => {
    for (const src of [GLOB_FIRST, GLOB_LAST]) {
      expect(withConfig(src, readGlobThresholds)).toEqual({
        "**/key-rotation.ts": { statements: 42, branches: 30, functions: 35, lines: 44 },
      });
    }
  });

  it("is empty when only package axes are declared", () => {
    const src = `thresholds: { statements: 90, branches: 85, functions: 91, lines: 92 },`;
    expect(withConfig(src, readGlobThresholds)).toEqual({});
  });
});

describe("block extraction", () => {
  it("walks to the BALANCED closing brace, not the first one", () => {
    const block = extractThresholdBlock(GLOB_FIRST);
    // The old regex truncated here; the balanced walk must reach `lines: 78`.
    expect(block).toContain("lines: 78");
    expect(block).toContain("key-rotation");
  });

  it("returns null on an unbalanced block rather than guessing", () => {
    expect(extractThresholdBlock("thresholds: { statements: 1,")).toBeNull();
  });

  it("strips nested objects at any depth", () => {
    expect(stripNestedObjects("a: 1, x: { b: { c: 2 } }, d: 3").replace(/\s+/g, "")).toBe(
      "a:1,x:,d:3",
    );
  });
});
