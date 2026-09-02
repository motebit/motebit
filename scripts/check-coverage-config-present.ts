#!/usr/bin/env tsx
/**
 * check-coverage-config-present — coverage-floor governance, fail-closed.
 *
 * Two invariants, one gate:
 *
 *  (Amendment 1 — universal presence) Every package under `packages/` OR
 *  `services/` that has a `src/__tests__/` directory MUST declare a
 *  `vitest.config.ts` with explicit `coverage.thresholds`. This closes the fail-open that `coverage-graduation`
 *  (opt-in) cannot: a package that never declares a config is invisible to every
 *  threshold check. A package with tests but no floor can silently regress to 0%.
 *
 *    NOTE on the predicate: the obvious "publishable" framing (`private !== true`)
 *    is WRONG for this monorepo — packages use the `0.0.0-private` sentinel and
 *    most stay `private: true` until promoted, so `private !== true` would catch
 *    `state-export-client` but MISS `panels` and `skills` (both `private: true`,
 *    both test-bearing, both config-less). The invariant we want is "test-bearing
 *    → floored," which is orthogonal to publish status. The predicate is therefore
 *    locked HERE explicitly as: under `packages/` or `services/`,
 *    `src/__tests__/` exists.
 *
 *    `services/` was out of scope in v1, on the rationale that "every
 *    money/identity registry member lives under `packages/`". That is true of
 *    the REGISTRY and had stopped being true of the RISK (#546): `services/clerk`
 *    is the money-EXECUTION pole and had no floor of any kind. `apps/` remains
 *    out of scope — surfaces carry their own conventions and execute no money.
 *
 *    Tier FLOORS still apply to registry members only. Extending membership to
 *    services is a separate decision with real consequences — the relay would owe
 *    money-tier 90/85/90/90 against a measured 61 branches — and belongs in the
 *    graduation manifest with a raise-by date, not in this gate.
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

  // (Amendment 1) presence: every test-bearing package OR SERVICE has a config.
  //
  // `services/` was out of scope in v1 on the rationale that "every
  // money/identity registry member lives under packages/". That is true of the
  // REGISTRY, and it stopped being true of the RISK (#546): `services/clerk` is
  // the money-EXECUTION pole — it spends under a self-issued grant — and both it
  // and `services/auditor` carried tests with no `vitest.config.ts` at all, so
  // no coverage floor of any kind.
  //
  // Worse than "no floor": without a config, vitest measures only the files the
  // tests happen to import, so an un-imported module is not 0% — it is absent
  // from the denominator. `clerk` reported 100% branches while its real figure
  // was 34%, because `helpers.ts` (which holds the fail-safe `DRY_RUN` default)
  // was never counted. A missing config does not read as a low number; it reads
  // as a good one.
  //
  // Presence only. Tier FLOORS still apply to registry members alone — extending
  // membership to services is a separate decision with real consequences (the
  // relay would owe money-tier 90/85/90/90 against a measured 61 branches), and
  // belongs in the graduation manifest with a raise-by date, not here.
  const serviceRoots = ["packages", "services"] as const;
  let scanned = 0;
  for (const root of serviceRoots)
    for (const entry of readdirSync(join(REPO_ROOT, root))) {
      const dir = join(REPO_ROOT, root, entry);
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
            : "has src/__tests__/ but no vitest.config.ts declaring coverage.thresholds " +
              "(without one, vitest measures only the files the tests import — an " +
              "un-imported module is absent from the denominator, not counted as 0%)",
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
    `check-coverage-config-present — ${scanned} test-bearing packages/ + services/ checked for presence; ${MONEY_IDENTITY_PATH.size} registry members checked against tier floors (${graduating.size} graduating)\n`,
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
