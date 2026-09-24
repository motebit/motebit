/**
 * The slack report's two pieces of judgement.
 *
 * Most of `measure-coverage-slack.ts` is arithmetic over vitest's own numbers,
 * which needs no test. Two parts do:
 *
 *  1. `readMeasured` must return `null` — not zeros — when a package has no
 *     coverage summary. Zeros would read as "0% coverage, enormous slack" and
 *     invert the report's meaning for every un-run package.
 *  2. `alreadyGraduatable` must SKIP entries whose rationale records a closed
 *     graduation. The manifest deliberately retains graduated entries as
 *     auditable records, so without that skip the report would nag forever
 *     about commitments already met — becoming exactly the stale noise it
 *     exists to remove.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMeasured } from "../measure-coverage-slack.js";

function withPkg<T>(summary: unknown | null, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "slack-"));
  if (summary !== null) {
    mkdirSync(join(dir, "coverage"), { recursive: true });
    writeFileSync(join(dir, "coverage", "coverage-summary.json"), JSON.stringify(summary));
  }
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FULL = {
  total: {
    statements: { pct: 88.48 },
    branches: { pct: 83.98 },
    functions: { pct: 89.13 },
    lines: { pct: 89.77 },
  },
};

describe("readMeasured", () => {
  it("reads vitest's own totals", () => {
    expect(withPkg(FULL, readMeasured)).toEqual({
      statements: 88.48,
      branches: 83.98,
      functions: 89.13,
      lines: 89.77,
    });
  });

  it("returns null — never zeros — when coverage has not been run", () => {
    // The load-bearing case. Zeros here would report as "0% measured", i.e.
    // maximum slack, and every un-run package would top the work queue.
    expect(withPkg(null, readMeasured)).toBeNull();
  });

  it("returns null on a summary missing an axis rather than defaulting it", () => {
    const partial = {
      total: { statements: { pct: 90 }, branches: { pct: 80 }, functions: { pct: 90 } },
    };
    expect(withPkg(partial, readMeasured)).toBeNull();
  });

  it("returns null on malformed JSON instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "slack-"));
    mkdirSync(join(dir, "coverage"), { recursive: true });
    writeFileSync(join(dir, "coverage", "coverage-summary.json"), "{ not json");
    try {
      expect(readMeasured(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when `total` is absent", () => {
    expect(withPkg({ "/some/file.ts": {} }, readMeasured)).toBeNull();
  });
});
