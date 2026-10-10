/**
 * check-identity-authority-inventory — the census-freshness gate (Inc 0 of
 * docs/design/identity-authority-writers.md). The stale verdict and its
 * failure block are pure; the live run proves the committed census is fresh
 * and that a passing run states its aperture.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { censusDrift, staleReport } from "../check-identity-authority-inventory.js";
import { formatRepair, hasApertureDisclosure, hasRepairInstruction } from "../lib/gate-report.js";

const ROOT = resolve(__dirname, "..", "..");

describe("censusDrift", () => {
  it("is empty for an identical census", () => {
    expect(censusDrift("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("names the changed line on both sides", () => {
    const drift = censusDrift("| writers | 307 |\n", "| writers | 308 |\n");
    expect(drift).toEqual([
      "line 1 committed: | writers | 307 |",
      "line 1 fresh:     | writers | 308 |",
    ]);
  });

  it("reports an added trailing row and caps the list", () => {
    const fresh = Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n");
    const drift = censusDrift("", fresh);
    expect(drift.length).toBe(12);
    expect(drift[0]).toBe("line 1 committed: ");
  });

  it("is non-empty for a whitespace-only difference", () => {
    expect(censusDrift("a\n", "a\n\n").length).toBeGreaterThan(0);
  });
});

describe("staleReport", () => {
  it("satisfies the repair-instruction contract", () => {
    const out = formatRepair(staleReport("docs/x.generated.md", ["line 1 …"], "3 files scanned"));
    expect(hasRepairInstruction(out)).toEqual({ ok: true });
    expect(out).toContain("npx tsx scripts/inventory-identity-authority.ts");
    expect(out).toContain("line 1 …");
  });
});

describe("live run", () => {
  it("passes on the committed census and discloses its aperture", () => {
    const r = spawnSync(
      resolve(ROOT, "node_modules", ".bin", "tsx"),
      ["scripts/check-identity-authority-inventory.ts"],
      { cwd: ROOT, encoding: "utf-8" },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(hasApertureDisclosure(r.stdout)).toEqual({ ok: true });
    expect(r.stdout).toMatch(/\d+ files scanned/);
  }, 60_000);
});
