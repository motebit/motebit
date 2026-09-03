#!/usr/bin/env tsx
/**
 * measure-coverage-slack — which coverage floors are no longer floors?
 *
 * A declared threshold sitting far below measured coverage is not protection,
 * it is slack: the code could regress by that whole margin and nothing would
 * fail. Worse, the gap is invisible — the gate is green either way, so nobody
 * looks until a deadline forces it.
 *
 * That is not a hypothetical failure mode here, it is the documented one. The
 * coverage-graduation post-mortem found **five stale entries out of six**: the
 * named levers were never built, the branches got covered incidentally by later
 * work, and nobody re-measured — so the manifest spent months tracking gaps that
 * had already closed and would have produced a CI-red fire drill over a
 * commitment satisfied months earlier. Its own recommendation was to build this:
 *
 *   > the gate already reads live thresholds; it could equally warn when a live
 *   > threshold is far BELOW measured coverage — "this entry may already be
 *   > graduatable". That would turn a deadline scramble into a routine ratchet.
 *
 * Three more were found by hand in one day (`summarize` at `branches: 15`
 * against a real 50; the relay at 61 against 67; `verify` measuring almost
 * nothing). Hand-finding does not scale, hence this.
 *
 * A REPORT, not a gate. Slack is not a defect — a fresh floor is deliberately
 * set just under measured, and a package mid-arc may hold a low floor on
 * purpose. The output is a work queue for a routine ratchet, and turning it red
 * would punish exactly the conservative floor-setting it is meant to encourage.
 *
 * Reads `coverage/coverage-summary.json`, written by the `json-summary`
 * reporter in `vitest.shared.ts`. Those are vitest's OWN totals — the same
 * figures the thresholds are checked against — so this can never disagree with
 * the gate that enforces them.
 *
 * Usage:
 *   pnpm test:coverage                          # produce the summaries first
 *   npx tsx scripts/measure-coverage-slack.ts
 *   … --min-slack 10     # only report gaps of ≥10 points (default 5)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COVERAGE_AXES,
  readPackageThresholds,
  type CoverageAxis,
  type CoverageThresholds,
} from "./lib/vitest-thresholds.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const ROOTS = ["packages", "services"] as const;

const MIN_SLACK = (() => {
  const i = process.argv.indexOf("--min-slack");
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 5;
})();

interface Measured {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

/** vitest's own totals for a package, or null when coverage has not been run. */
function readMeasured(pkgDir: string): Measured | null {
  const file = join(pkgDir, "coverage", "coverage-summary.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
      total?: Record<string, { pct?: number }>;
    };
    const total = parsed.total;
    if (!total) return null;
    const out = {} as Measured;
    for (const axis of COVERAGE_AXES) {
      const pct = total[axis]?.pct;
      if (typeof pct !== "number") return null;
      out[axis] = pct;
    }
    return out;
  } catch {
    return null;
  }
}

interface Row {
  name: string;
  declared: CoverageThresholds;
  measured: Measured;
  /** Smallest per-axis slack — the axis that would fail first on a regression. */
  minSlack: number;
  slack: Record<CoverageAxis, number>;
}

function pkgName(dir: string): string | null {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return null;
  try {
    return (JSON.parse(readFileSync(manifest, "utf-8")) as { name?: string }).name ?? null;
  } catch {
    return null;
  }
}

/** Non-graduated graduation entries whose measured coverage already meets target. */
function alreadyGraduatable(measuredByName: Map<string, Measured>): string[] {
  const file = join(REPO_ROOT, "coverage-graduation.json");
  if (!existsSync(file)) return [];
  const manifest = JSON.parse(readFileSync(file, "utf-8")) as {
    packages?: Array<{
      package?: string;
      target?: Partial<CoverageThresholds>;
      rationale?: string;
    }>;
  };
  const out: string[] = [];
  for (const entry of manifest.packages ?? []) {
    if (!entry.package || !entry.target) continue;
    // A rationale beginning GRADUATED is a closed record kept for auditability.
    if ((entry.rationale ?? "").trimStart().toUpperCase().startsWith("GRADUATED")) continue;
    const measured = measuredByName.get(entry.package);
    if (!measured) continue;
    const meets = COVERAGE_AXES.every((a) => {
      const t = entry.target?.[a];
      return typeof t !== "number" || measured[a] >= t;
    });
    if (meets) out.push(entry.package);
  }
  return out;
}

function main(): void {
  console.log(`measure-coverage-slack — reporting gaps of ≥${MIN_SLACK} points\n`);

  const rows: Row[] = [];
  const unmeasured: string[] = [];
  const measuredByName = new Map<string, Measured>();

  for (const root of ROOTS) {
    const rootDir = join(REPO_ROOT, root);
    if (!existsSync(rootDir)) continue;
    for (const entry of readdirSync(rootDir)) {
      const dir = join(rootDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      const name = pkgName(dir);
      if (!name) continue;

      const declared = readPackageThresholds(join(dir, "vitest.config.ts"));
      if (!declared) continue; // no floor declared — check-coverage-config-present owns that

      const measured = readMeasured(dir);
      if (!measured) {
        unmeasured.push(name);
        continue;
      }
      measuredByName.set(name, measured);

      const slack = {} as Record<CoverageAxis, number>;
      for (const axis of COVERAGE_AXES) {
        slack[axis] = Math.round((measured[axis] - declared[axis]) * 100) / 100;
      }
      rows.push({
        name,
        declared,
        measured,
        slack,
        minSlack: Math.min(...COVERAGE_AXES.map((a) => slack[a])),
      });
    }
  }

  // Measured nothing? Say so and stop, rather than printing an encouraging
  // "no slack found" over an empty set — an absent denominator reading as a
  // clean result is the failure this repo keeps rediscovering.
  if (rows.length === 0) {
    console.log(
      `MEASURED NOTHING — no package has a coverage/coverage-summary.json, so no\n` +
        `conclusion about slack follows from this run.\n\n` +
        `  Run \`pnpm test:coverage\` first (turbo caches it), then re-run.`,
    );
    process.exit(0);
  }

  const loose = rows.filter((r) => r.minSlack >= MIN_SLACK).sort((a, b) => b.minSlack - a.minSlack);

  // Negative slack should be impossible — the threshold gate would have failed
  // the run that produced this summary — so surface it as an anomaly, not a row.
  const impossible = rows.filter((r) => r.minSlack < 0);

  console.log(`${rows.length} package(s) with both a declared floor and measured coverage\n`);

  if (loose.length > 0) {
    console.log(`${loose.length} carrying ≥${MIN_SLACK} points of slack on every axis:\n`);
    for (const r of loose) {
      const detail = COVERAGE_AXES.map(
        (a) => `${a.slice(0, 4)} ${r.declared[a]}→${r.measured[a]} (+${r.slack[a]})`,
      ).join("  ");
      console.log(`  ${r.name.padEnd(32)} min +${r.minSlack}`);
      console.log(`  ${" ".repeat(32)} ${detail}`);
    }
    console.log(
      `\n  → Each is a FREE ratchet: raise the floor to just under measured, no new\n` +
        `    tests. Slack is not a defect, but a floor N points below reality only\n` +
        `    catches a regression bigger than N.`,
    );
  } else {
    console.log(`No package carries ≥${MIN_SLACK} points of slack on every axis.`);
  }

  const graduatable = alreadyGraduatable(measuredByName);
  if (graduatable.length > 0) {
    console.log(
      `\n${graduatable.length} graduation commitment(s) ALREADY satisfied by measurement:`,
    );
    for (const name of graduatable) console.log(`    ${name}`);
    console.log(
      `\n  → Close these by ratcheting the floor to the target, not by writing the\n` +
        `    tests the rationale names. Five of six entries were stale this way once\n` +
        `    already; the levers were never built and the branches got covered by\n` +
        `    other work. Re-measure before planning any coverage push.`,
    );
  }

  if (impossible.length > 0) {
    console.log(`\n⚠ ${impossible.length} package(s) measure BELOW their declared floor:`);
    for (const r of impossible) console.log(`    ${r.name} (min ${r.minSlack})`);
    console.log(
      `  This should be impossible — the threshold check would have failed the run\n` +
        `  that wrote this summary. Suspect a stale coverage/ directory before\n` +
        `  suspecting the numbers.`,
    );
  }

  if (unmeasured.length > 0) {
    console.log(
      `\n${unmeasured.length} package(s) declare a floor but have no coverage summary — ` +
        `not assessed:\n    ${unmeasured.join(", ")}`,
    );
  }
}

// Entrypoint guard: importing this module must stay inert.
const invokedDirectly =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

export { readMeasured, alreadyGraduatable };
