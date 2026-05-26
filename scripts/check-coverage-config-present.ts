#!/usr/bin/env tsx
/**
 * check-coverage-config-present — coverage-floor governance, fail-closed.
 *
 * Two invariants, one gate:
 *
 *  (Amendment 1 — universal presence) Every package under `packages/` that has a
 *  `src/__tests__/` directory MUST declare a `vitest.config.ts` with explicit
 *  `coverage.thresholds`. This closes the fail-open that `coverage-graduation`
 *  (opt-in) cannot: a package that never declares a config is invisible to every
 *  threshold check. A package with tests but no floor can silently regress to 0%.
 *
 *    NOTE on the predicate: the obvious "publishable" framing (`private !== true`)
 *    is WRONG for this monorepo — packages use the `0.0.0-private` sentinel and
 *    most stay `private: true` until promoted, so `private !== true` would catch
 *    `state-export-client` but MISS `panels` and `skills` (both `private: true`,
 *    both test-bearing, both config-less). The invariant we want is "test-bearing
 *    → floored," which is orthogonal to publish status. The predicate is therefore
 *    locked HERE explicitly as: under `packages/`, `src/__tests__/` exists. (apps/
 *    and services/ carry their own test conventions and are out of scope for v1;
 *    every money/identity registry member lives under `packages/`.)
 *
 *  (Floor) Every member of the money/identity-path registry
 *  (`scripts/money-identity-path.ts`) MUST declare thresholds at or above its
 *  tier floor (money 90/85/90/90, identity 85/80/85/85) — UNLESS it is carried in
 *  `coverage-graduation.json` (the graduation manifest owns the upward ratchet for
 *  named laggards with raise-by dates). `coverage-graduation` keeps ratcheting;
 *  this gate enforces the floor it assumes.
 *
 * Threshold extraction reuses the regex shape from `coverage-graduation.ts` so the
 * two tools read configs identically.
 *
 * Usage: tsx scripts/check-coverage-config-present.ts   # exit 1 on violation
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MONEY_IDENTITY_PATH,
  TIER_FLOOR,
  type CoverageFloor,
  type PathTier,
} from "./money-identity-path.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const AXES = ["statements", "branches", "functions", "lines"] as const;

/** Read live thresholds from a vitest.config.ts (same method as coverage-graduation.ts). */
function readThresholds(configPath: string): CoverageFloor | null {
  if (!existsSync(configPath)) return null;
  const src = readFileSync(configPath, "utf-8");
  const block = src.match(/thresholds:\s*\{([^}]+)\}/);
  if (!block) return null;
  const body = block[1]!;
  const out = {} as Record<(typeof AXES)[number], number>;
  for (const axis of AXES) {
    const m = body.match(new RegExp(`${axis}:\\s*(\\d+(?:\\.\\d+)?)`));
    if (!m) return null;
    out[axis] = Number(m[1]);
  }
  return out;
}

/** Package names currently carried in the graduation manifest (floor-exempt). */
function graduatingPackages(): Set<string> {
  const manifestPath = join(REPO_ROOT, "coverage-graduation.json");
  if (!existsSync(manifestPath)) return new Set();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    packages?: Array<{ package?: string }>;
  };
  return new Set((manifest.packages ?? []).map((p) => p.package).filter((p): p is string => !!p));
}

interface Violation {
  package: string;
  kind: "missing-config" | "below-floor";
  detail: string;
}

function pkgName(dir: string): string | null {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return null;
  const pkg = JSON.parse(readFileSync(pj, "utf-8")) as { name?: string };
  return pkg.name ?? null;
}

function main(): void {
  const packagesRoot = join(REPO_ROOT, "packages");
  const violations: Violation[] = [];
  const graduating = graduatingPackages();

  // Map package name → dir, for the floor pass.
  const nameToDir = new Map<string, string>();

  // (Amendment 1) presence: every packages/* with src/__tests__/ has a config.
  let scanned = 0;
  for (const entry of readdirSync(packagesRoot)) {
    const dir = join(packagesRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    const name = pkgName(dir);
    if (!name) continue;
    nameToDir.set(name, dir);

    const hasTests = existsSync(join(dir, "src", "__tests__"));
    if (!hasTests) continue;
    scanned++;

    const config = join(dir, "vitest.config.ts");
    if (readThresholds(config) === null) {
      violations.push({
        package: name,
        kind: "missing-config",
        detail: existsSync(config)
          ? "vitest.config.ts present but no parseable coverage.thresholds"
          : "has src/__tests__/ but no vitest.config.ts declaring coverage.thresholds",
      });
    }
  }

  // (Floor) registry members meet their tier floor unless graduating.
  for (const [name, tier] of MONEY_IDENTITY_PATH) {
    const dir = nameToDir.get(name);
    if (!dir) {
      violations.push({
        package: name,
        kind: "missing-config",
        detail: "registry member not found under packages/ (stale registry entry?)",
      });
      continue;
    }
    if (graduating.has(name)) continue; // graduation manifest owns the ratchet
    const live = readThresholds(join(dir, "vitest.config.ts"));
    if (live === null) continue; // already reported by the presence pass
    const floor = TIER_FLOOR[tier as PathTier];
    const short = AXES.filter((a) => live[a] < floor[a]);
    if (short.length > 0) {
      violations.push({
        package: name,
        kind: "below-floor",
        detail: `${tier} floor ${floor.statements}/${floor.branches}/${floor.functions}/${floor.lines}; declares ${live.statements}/${live.branches}/${live.functions}/${live.lines} (short on ${short.join(", ")}) — raise tests to floor or enter in coverage-graduation.json with a raise-by date`,
      });
    }
  }

  console.log(
    `check-coverage-config-present — ${scanned} test-bearing packages/ checked for presence; ${MONEY_IDENTITY_PATH.size} registry members checked against tier floors (${graduating.size} graduating)\n`,
  );

  if (violations.length === 0) {
    console.log(
      "✓ Every test-bearing package declares a coverage floor; every registry member meets its tier floor.",
    );
    return;
  }

  for (const v of violations) {
    console.log(`  ✗ ${v.package} [${v.kind}]`);
    console.log(`      ${v.detail}`);
  }
  process.exit(1);
}

main();
