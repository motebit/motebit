#!/usr/bin/env tsx
/**
 * check-coverage-config-present — coverage-floor governance, fail-closed.
 *
 * Two invariants, one gate:
 *
 *  (Amendment 1 — universal presence) Every package under `packages/` OR
 *  `services/`, and every in-scope app under `apps/`, that has a
 *  `src/__tests__/` directory MUST declare a `vitest.config.ts` with explicit
 *  `coverage.thresholds`. This closes the fail-open that `coverage-graduation`
 *  (opt-in) cannot: a package that never declares a config is invisible to every
 *  threshold check. A package with tests but no floor can silently regress to 0%.
 *
 *    NOTE on the predicate: the obvious "publishable" framing (`private !== true`)
 *    is WRONG for this monorepo's packages — they use the `0.0.0-private` sentinel
 *    and most stay `private: true` until promoted, so `private !== true` would
 *    catch `state-export-client` but MISS `panels` and `skills` (both
 *    `private: true`, both test-bearing, both config-less). The invariant we want
 *    is "test-bearing → floored," which is orthogonal to publish status. The
 *    predicate is therefore locked HERE explicitly as: under `packages/` or
 *    `services/` (or an in-scope app under `apps/`, below), `src/__tests__/`
 *    exists.
 *
 *    `services/` was out of scope in v1, on the rationale that "every
 *    money/identity registry member lives under `packages/`". That is true of
 *    the REGISTRY and had stopped being true of the RISK (#546): `services/clerk`
 *    is the money-EXECUTION pole and had no floor of any kind.
 *
 *    `apps/` was out of scope on the premise that "surfaces carry their own
 *    conventions and execute no money" — false for the CLI, which is published
 *    to npm as `motebit` and signs money transactions (`wallet swap`,
 *    `withdraw`, `delegate --sovereign`, `grant create`, the daemon's R4 path)
 *    yet declared no floor. The same premise failure as #546, one root over. An
 *    app is now in scope by RULE (`appScopeReasons`), never by a list: a
 *    test-bearing app is held to the presence invariant when it is
 *      - published (`private !== true` — it ships to users outside the repo;
 *        apps, unlike packages, do not use the private-until-promoted
 *        sentinel, so here the flag means what it says), or
 *      - money/identity-executing: any of its `dependencies`,
 *        `peerDependencies` or `devDependencies` is a MEMBERSHIP_TRIGGER
 *        (`scripts/money-identity-path.ts`). devDependencies count for apps,
 *        unlike the registry's packages rule: an app BUNDLES its workspace
 *        deps (the CLI lists every `@motebit/*` as a devDependency and tsup
 *        inlines them), so a devDependency is shipped code.
 *    At landing that puts cli (published; wallet-solana), desktop, mobile,
 *    spatial and web (wallet-solana) in scope. The gate prints the in-scope apps
 *    with their reasons and the out-of-scope apps on every run, so the set is
 *    never implicit, and a private app that gains a trigger dependency enters
 *    scope by itself.
 *
 *    Tier FLOORS still apply to registry members only. Extending membership to
 *    services or apps is a separate decision with real consequences — the relay
 *    would owe money-tier 90/85/90/90 against a measured 61 branches — and
 *    belongs in the registry and graduation manifest with a raise-by date, not
 *    in this gate.
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
 * Tests: scripts/__tests__/check-coverage-config-present.test.ts.
 * Tampers: scripts/tampers/coverage-config-present.ts.
 *
 * Usage: tsx scripts/check-coverage-config-present.ts   # exit 1 on violation
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readPackageThresholds } from "./lib/vitest-thresholds.js";
import {
  MEMBERSHIP_TRIGGERS,
  MONEY_IDENTITY_PATH,
  TIER_FLOOR,
  type CoverageFloor,
  type PathTier,
} from "./money-identity-path.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const AXES = ["statements", "branches", "functions", "lines"] as const;

/**
 * Package-level thresholds, via the shared brace-aware reader.
 *
 * The previous local regex (`/thresholds:\s*\{([^}]+)\}/`) stopped at the first
 * closing brace, so once per-glob floors existed the parse became
 * order-dependent — a config whose glob entry came first reported the GLOB's
 * numbers as the package's. See scripts/lib/vitest-thresholds.ts.
 */
function readThresholds(configPath: string): CoverageFloor | null {
  return readPackageThresholds(configPath);
}

/** Package names currently carried in the graduation manifest (floor-exempt). */
function graduatingPackages(root: string): Set<string> {
  const manifestPath = join(root, "coverage-graduation.json");
  if (!existsSync(manifestPath)) return new Set();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    packages?: Array<{ package?: string }>;
  };
  return new Set((manifest.packages ?? []).map((p) => p.package).filter((p): p is string => !!p));
}

export interface Violation {
  package: string;
  kind: "missing-config" | "below-floor";
  detail: string;
}

export interface PkgJson {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPkg(dir: string): PkgJson | null {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return null;
  return JSON.parse(readFileSync(pj, "utf-8")) as PkgJson;
}

/**
 * Why an app is held to the presence invariant — empty when it is not.
 *
 * The rule (see the header): published, or money/identity-executing (a
 * MEMBERSHIP_TRIGGER in any dependency kind, devDependencies included — apps
 * bundle their workspace deps, so a devDependency is shipped code).
 */
export function appScopeReasons(pkg: PkgJson, triggers: ReadonlySet<string>): string[] {
  const reasons: string[] = [];
  if (pkg.private !== true) reasons.push("published");
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const hits = [...triggers].filter((t) => deps.has(t)).sort();
  if (hits.length > 0) reasons.push(`money/identity path via ${hits.join(", ")}`);
  return reasons;
}

export interface AppScope {
  name: string;
  dir: string;
  /** Empty ⇒ out of scope. */
  reasons: string[];
  hasTests: boolean;
}

export interface CoverageConfigReport {
  violations: Violation[];
  /** Test-bearing packages/ + services/ checked for presence. */
  scannedPackages: number;
  /** Every app under apps/ with its scope verdict. */
  apps: AppScope[];
  registrySize: number;
  graduating: number;
}

export interface CheckOptions {
  /** Defaults to MONEY_IDENTITY_PATH; tests pass a fixture registry. */
  registry?: ReadonlyMap<string, PathTier>;
  /** Defaults to MEMBERSHIP_TRIGGERS. */
  triggers?: ReadonlySet<string>;
}

function presenceViolation(name: string, config: string): Violation | null {
  if (readThresholds(config) !== null) return null;
  return {
    package: name,
    kind: "missing-config",
    detail: existsSync(config)
      ? "vitest.config.ts present but no parseable coverage.thresholds"
      : "has src/__tests__/ but no vitest.config.ts declaring coverage.thresholds " +
        "(without one, vitest measures only the files the tests import — an " +
        "un-imported module is absent from the denominator, not counted as 0%)",
  };
}

export function checkCoverageConfigPresent(
  root: string,
  opts: CheckOptions = {},
): CoverageConfigReport {
  const registry = opts.registry ?? MONEY_IDENTITY_PATH;
  const triggers = opts.triggers ?? MEMBERSHIP_TRIGGERS;
  const violations: Violation[] = [];
  const graduating = graduatingPackages(root);

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
  let scannedPackages = 0;
  for (const base of ["packages", "services"] as const) {
    const absBase = join(root, base);
    if (!existsSync(absBase)) continue;
    for (const entry of readdirSync(absBase)) {
      const dir = join(absBase, entry);
      if (!statSync(dir).isDirectory()) continue;
      const name = readPkg(dir)?.name;
      if (!name) continue;
      nameToDir.set(name, dir);

      if (!existsSync(join(dir, "src", "__tests__"))) continue;
      scannedPackages++;
      const v = presenceViolation(name, join(dir, "vitest.config.ts"));
      if (v) violations.push(v);
    }
  }

  // (Amendment 1, apps) presence for every in-scope, test-bearing app. The
  // scope rule is `appScopeReasons`; the header says why `apps/` was excluded
  // and why that premise was false.
  const apps: AppScope[] = [];
  const appsBase = join(root, "apps");
  if (existsSync(appsBase)) {
    for (const entry of readdirSync(appsBase).sort()) {
      const dir = join(appsBase, entry);
      if (!statSync(dir).isDirectory()) continue;
      const pkg = readPkg(dir);
      if (!pkg?.name) continue;
      const scope: AppScope = {
        name: pkg.name,
        dir,
        reasons: appScopeReasons(pkg, triggers),
        hasTests: existsSync(join(dir, "src", "__tests__")),
      };
      apps.push(scope);
      if (scope.reasons.length === 0 || !scope.hasTests) continue;
      const v = presenceViolation(pkg.name, join(dir, "vitest.config.ts"));
      if (v) violations.push(v);
    }
  }

  // (Floor) registry members meet their tier floor unless graduating.
  for (const [name, tier] of registry) {
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
    const floor = TIER_FLOOR[tier];
    const short = AXES.filter((a) => live[a] < floor[a]);
    if (short.length > 0) {
      violations.push({
        package: name,
        kind: "below-floor",
        detail: `${tier} floor ${floor.statements}/${floor.branches}/${floor.functions}/${floor.lines}; declares ${live.statements}/${live.branches}/${live.functions}/${live.lines} (short on ${short.join(", ")}) — raise tests to floor or enter in coverage-graduation.json with a raise-by date`,
      });
    }
  }

  return {
    violations,
    scannedPackages,
    apps,
    registrySize: registry.size,
    graduating: graduating.size,
  };
}

/** The gate's printed report: the aperture always, the violations when any. */
export function formatReport(report: CoverageConfigReport, root: string): string {
  const inScope = report.apps.filter((a) => a.reasons.length > 0);
  const outScope = report.apps.filter((a) => a.reasons.length === 0);
  const checkedApps = inScope.filter((a) => a.hasTests);
  const lines: string[] = [
    `check-coverage-config-present — ${report.scannedPackages} test-bearing packages/ + services/ and ${checkedApps.length} in-scope test-bearing apps checked for presence; ${report.registrySize} registry members checked against tier floors (${report.graduating} graduating)`,
    `  apps in scope (${inScope.length} of ${report.apps.length} apps — published, or a money/identity trigger in any dependency kind):`,
    ...inScope.map(
      (a) =>
        `    ${relative(root, a.dir)} (${a.name}): ${a.reasons.join("; ")}${a.hasTests ? "" : " — no src/__tests__/, nothing to floor"}`,
    ),
    `  apps out of scope (${outScope.length} apps — private, no trigger dependency): ${outScope.map((a) => relative(root, a.dir)).join(", ") || "none"}`,
    "",
  ];
  if (report.violations.length === 0) {
    lines.push(
      "✓ Every test-bearing package and in-scope app declares a coverage floor; every registry member meets its tier floor.",
    );
    return lines.join("\n");
  }
  for (const v of report.violations) {
    lines.push(`  ✗ ${v.package} [${v.kind}]`);
    lines.push(`      ${v.detail}`);
  }
  lines.push(
    "",
    "Fix: add coverage.thresholds to each missing-config entry's vitest.config.ts at its measured level, rounded down " +
      "(`pnpm --filter <pkg> test:coverage` measures it, with coverage.include set so untested files count), or raise a below-floor " +
      "member's tests to its tier floor. The scope rule lives in scripts/check-coverage-config-present.ts; the registry and tier " +
      "floors in scripts/money-identity-path.ts.",
  );
  return lines.join("\n");
}

function main(): void {
  const report = checkCoverageConfigPresent(REPO_ROOT);
  console.log(formatReport(report, REPO_ROOT));
  if (report.violations.length > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
