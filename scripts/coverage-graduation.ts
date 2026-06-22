/**
 * Coverage graduation report + deadline gate.
 *
 * The "never lower thresholds" policy (vitest.shared.ts, feedback memory) is
 * the floor: a regression in coverage breaks CI. Graduation is the ceiling
 * commitment: money + identity path packages whose floor sits below the
 * project's 80% target carry an explicit raise-by date in
 * `coverage-graduation.json`. This script reads the manifest, compares
 * against each package's live vitest threshold, and prints a timeline.
 *
 * Soft BEFORE the date, HARD on/after it (issue #111). Before an entry's
 * `target_date` the report is a quarterly conversation (exit 0). On or after
 * the date, an entry whose live thresholds still do not meet its `target`
 * fails CI (exit 1) — a graduation commitment past its date that nobody
 * honored is the opt-in fail-open this primitive exists to close, recurring
 * one layer up inside graduation itself. Doctrine: `docs/doctrine/coverage-graduation.md`.
 *
 * What it checks:
 *   1. Every manifest entry's `vitest_config` exists and parses.
 *   2. Manifest `current` matches the live threshold (drift = stale manifest).
 *   3. Days remaining until `target_date`; flagged WARN if past due.
 *   4. The package qualifies for graduation (current < target on any axis).
 *   5. HARD FAIL: past `target_date` AND live thresholds still below `target`.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface Thresholds {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

interface ManifestEntry {
  package: string;
  vitest_config: string;
  current: Thresholds;
  target: Thresholds;
  target_date: string;
  rationale: string;
}

interface Manifest {
  policy: string;
  scope: string;
  doctrine: string;
  packages: ManifestEntry[];
}

const AXES: Array<keyof Thresholds> = ["statements", "branches", "functions", "lines"];

function readLiveThresholds(configPath: string): Thresholds | null {
  const abs = resolve(ROOT, configPath);
  if (!existsSync(abs)) return null;
  const src = readFileSync(abs, "utf-8");
  // Match the `thresholds: { ... }` literal inside the defineMotebitTest call.
  // The shape is uniform across the monorepo; if a package starts using a
  // computed threshold we'll switch to ts-morph.
  const match = src.match(/thresholds:\s*\{([^}]+)\}/);
  if (!match) return null;
  const body = match[1];
  const get = (axis: string): number | null => {
    const m = body.match(new RegExp(`${axis}:\\s*(\\d+(?:\\.\\d+)?)`));
    return m ? Number(m[1]) : null;
  };
  const out: Partial<Thresholds> = {};
  for (const axis of AXES) {
    const v = get(axis);
    if (v === null) return null;
    out[axis] = v;
  }
  return out as Thresholds;
}

function daysUntil(isoDate: string, today: Date): number {
  const target = new Date(`${isoDate}T00:00:00Z`).getTime();
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - now) / 86400000);
}

function formatGap(current: Thresholds, target: Thresholds): string {
  const parts: string[] = [];
  for (const axis of AXES) {
    if (current[axis] < target[axis]) {
      parts.push(`${axis} ${current[axis]} → ${target[axis]} (+${target[axis] - current[axis]})`);
    }
  }
  return parts.length === 0 ? "(targets met)" : parts.join(", ");
}

function thresholdsMatch(a: Thresholds, b: Thresholds): boolean {
  return AXES.every((axis) => a[axis] === b[axis]);
}

/** Live thresholds meet the graduation target when no axis sits below it. */
function meetsTarget(live: Thresholds, target: Thresholds): boolean {
  return AXES.every((axis) => live[axis] >= target[axis]);
}

function main(): void {
  const manifestPath = resolve(ROOT, "coverage-graduation.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
  const today = new Date();

  process.stdout.write(`Coverage graduation — ${manifest.policy}\n`);
  process.stdout.write(`Scope: ${manifest.scope}\n`);
  process.stdout.write(`Doctrine: ${manifest.doctrine}\n`);
  process.stdout.write(`Today: ${today.toISOString().slice(0, 10)}\n\n`);

  if (manifest.packages.length === 0) {
    process.stdout.write("No packages currently under graduation. ✓\n");
    return;
  }

  const overdue: string[] = [];
  for (const entry of manifest.packages) {
    const live = readLiveThresholds(entry.vitest_config);
    process.stdout.write(`▸ ${entry.package}\n`);
    process.stdout.write(`  config:    ${entry.vitest_config}\n`);

    if (!live) {
      process.stdout.write(`  [DRIFT]    cannot read live thresholds from vitest.config\n\n`);
      continue;
    }

    if (!thresholdsMatch(live, entry.current)) {
      process.stdout.write(
        `  [DRIFT]    manifest snapshot ${JSON.stringify(entry.current)} ` +
          `does not match live ${JSON.stringify(live)} — update the manifest\n`,
      );
    }

    const gap = formatGap(live, entry.target);
    const days = daysUntil(entry.target_date, today);
    const dateLabel =
      days < 0 ? `[OVERDUE by ${-days}d]` : days === 0 ? "[DUE TODAY]" : `${days}d remaining`;

    process.stdout.write(`  gap:       ${gap}\n`);
    process.stdout.write(`  target:    ${entry.target_date} (${dateLabel})\n`);
    process.stdout.write(`  rationale: ${entry.rationale}\n\n`);

    // HARD FAIL condition (#111): the raise-by date has passed and the live
    // thresholds still do not meet the target. Soft before the date.
    if (days < 0 && !meetsTarget(live, entry.target)) {
      overdue.push(`${entry.package} — ${-days}d overdue, still ${gap}`);
    }
  }

  if (overdue.length > 0) {
    process.stdout.write(
      `✗ ${overdue.length} graduation commitment(s) PAST target_date with the target still unmet:\n`,
    );
    for (const o of overdue) process.stdout.write(`    ${o}\n`);
    process.stdout.write(
      `\nFix: raise the package's vitest coverage thresholds to its graduation target and update the\n` +
        `     'current' snapshot in coverage-graduation.json (the honest path — close the gap). A commitment\n` +
        `     past its date that nobody honored is a broken promise; do NOT silently extend the date. If the\n` +
        `     target genuinely no longer applies, change it with a doctrine-grade rationale.\n` +
        `     Doctrine: docs/doctrine/coverage-graduation.md.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `${manifest.packages.length} package(s) tracked. No overdue graduation commitment — exit 0.\n`,
  );
}

main();
