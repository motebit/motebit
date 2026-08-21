#!/usr/bin/env tsx
/**
 * Drift defense: a package that declares coverage thresholds must actually
 * MEASURE something.
 *
 * Every `vitest.config.ts` in this repo declares thresholds, and the
 * never-lower-thresholds policy treats those numbers as a ratchet. That
 * reasoning silently collapses if the coverage run reports zero files: the
 * thresholds are then enforced against an empty set, so they always pass, and a
 * green gate proves nothing at all.
 *
 * It is not hypothetical. A sweep on 2026-08-20 found EIGHT packages in this
 * state — including `@motebit/treasury-reconciliation` (money path),
 * `@motebit/verify` (identity path; the canonical `motebit-verify` aggregator),
 * `services/research` (the flagship archetype), and `@motebit/circuit-breaker`,
 * whose config reads "Lock at 100% across all dimensions; any regression
 * blocks" while measuring no files whatsoever.
 *
 * This is worse than a low threshold. A low number is visible and argues for
 * itself; a vacuous 100 looks like the strongest guarantee in the repo.
 *
 * ## Why the allowlist, and why it may only shrink
 *
 * The eight known instances are recorded in `KNOWN_VACUOUS` so this gate can
 * ship green rather than blocking every push while they are investigated —
 * the same acknowledged-debt shape as `WAIVED_EXPORTS` in
 * `check-readme-public-exports`. Two rules keep it honest:
 *
 *   1. A package NOT on the list that measures nothing fails immediately.
 *   2. A package ON the list that now measures something ALSO fails, with an
 *      instruction to delete its entry. The list cannot silently outlive the
 *      problem it records.
 *
 * ## Cost, and why this is not in `pnpm check`
 *
 * Establishing that a package measures something requires actually running its
 * coverage — there is no static answer. That is ~10-30s per package, far too
 * slow for the static pass, so this registers in `EXCLUDED_CHECKS` and runs as
 * its own CI job, the same shape as `check-gates-effective` and
 * `check-activation-effective`.
 *
 * Pass `--only <name>` to check a single package while iterating.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { failWithRepair } from "./lib/gate-report.js";

const ROOT = process.cwd();

/**
 * Packages known to report zero coverage files as of 2026-08-20.
 *
 * KEEP THIS SHRINKING. Every entry is a coverage threshold that currently
 * proves nothing. Root cause is unresolved — ruled out so far: test-import
 * extension (`../x` vs `../x.js`), `coverageExclude` over-matching, stray
 * compiled artifacts shadowing `src/`, glob depth (`src/**​/*.ts` vs
 * `src/*.ts`), the shared config's `coverage.include`, and vitest's own stock
 * defaults. In every case the tests run and pass while v8 reports no files.
 * Tracked in the follow-up issue linked from the drift-defenses entry.
 */
const KNOWN_VACUOUS: Record<string, string> = {
  "packages/circuit-breaker": "declares 100/100/100/100; 22 tests pass, zero files measured",
  "packages/event-log": "Layer 1 primitive; thresholds enforced against nothing",
  "packages/sqlite-migrations": "Layer 1 primitive; thresholds enforced against nothing",
  "packages/treasury-reconciliation": "MONEY PATH — operator-treasury reconciliation algebra",
  "packages/verify": "IDENTITY PATH — canonical motebit-verify aggregator (see #568)",
  "packages/wire-schemas": "BSL zod sources that generate the committed JSON Schemas",
  "services/read-url": "second hop in the multi-hop delegation chain",
  "services/research": "flagship archetype service",
};

/** Every directory holding a `vitest.config.ts`, repo-relative. */
function packagesWithCoverage(): string[] {
  const out: string[] = [];
  for (const group of ["packages", "services"]) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const rel = `${group}/${entry}`;
      if (existsSync(join(ROOT, rel, "vitest.config.ts"))) out.push(rel);
    }
  }
  return out;
}

/**
 * True when the package's coverage run reports at least one measured file.
 *
 * Detected via the `All files` summary row, which the text reporter emits only
 * when the table has content — an empty table prints its rules and nothing
 * between them.
 */
function measuresSomething(pkgDir: string): boolean {
  try {
    const out = execFileSync("npx", ["vitest", "run", "--coverage"], {
      cwd: join(ROOT, pkgDir),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return /^All files/m.test(out);
  } catch (err) {
    // A failing suite still prints its coverage table; read the captured output
    // rather than treating a red suite as "vacuous" (that is a different gate's
    // job, and conflating them would produce a misleading repair instruction).
    const e = err as { stdout?: string; stderr?: string };
    return /^All files/m.test(`${e.stdout ?? ""}\n${e.stderr ?? ""}`);
  }
}

function main(): void {
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;

  const targets = packagesWithCoverage().filter((p) => only == null || p.endsWith(only));
  const newlyVacuous: string[] = [];
  const staleWaivers: string[] = [];
  let measured = 0;
  let waivedSeen = 0;

  for (const pkg of targets) {
    const ok = measuresSomething(pkg);
    const waived = pkg in KNOWN_VACUOUS;
    if (ok) measured++;
    if (waived) waivedSeen++;
    if (!ok && !waived) newlyVacuous.push(pkg);
    if (ok && waived) staleWaivers.push(pkg);
  }

  if (newlyVacuous.length > 0) {
    failWithRepair({
      invariant:
        "a package declaring coverage thresholds must MEASURE at least one file — thresholds enforced against an empty set always pass, so the gate is green and proves nothing",
      sites: newlyVacuous.map((p) => `${p}/vitest.config.ts — coverage run reported no files`),
      canonical: "the package's own vitest.config.ts + vitest.shared.ts",
      fix: "Run `npx vitest run --coverage` in that package and look at the table. If it is empty, the thresholds are vacuous: check that coverageExclude has not removed every measurable file, and that the tests import the source under `src/` rather than a built artifact. If the cause is the open instrumentation bug rather than the package's own config, add it to KNOWN_VACUOUS in scripts/check-coverage-measures-something.ts with a one-line reason.",
      doctrine: "docs/doctrine/coverage-graduation.md",
    });
  }

  if (staleWaivers.length > 0) {
    failWithRepair({
      invariant: "KNOWN_VACUOUS carries an entry for a package that now measures files",
      sites: staleWaivers.map((p) => `${p} — measures coverage now; the waiver is obsolete`),
      canonical: "scripts/check-coverage-measures-something.ts (KNOWN_VACUOUS)",
      fix: "Delete that package's entry from KNOWN_VACUOUS so the list keeps shrinking.",
    });
  }

  console.log(
    `✓ ${measured}/${targets.length} package(s) measure real coverage; ` +
      `${waivedSeen} of the ${Object.keys(KNOWN_VACUOUS).length} acknowledged-debt ` +
      `entries in scope (the list must only shrink).`,
  );
}

main();
