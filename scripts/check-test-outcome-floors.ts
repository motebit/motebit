#!/usr/bin/env tsx
/**
 * check-test-outcome-floors — the committed per-package test floors
 * (scripts/test-outcome-floors.json) are a RATCHET.
 *
 * The `check` verdict (scripts/verify-test-outcomes.ts) refuses a package
 * that passed fewer tests than its floor: that is what catches a suite whose
 * DECLARATION was narrowed (a test:coverage script naming one file,
 * `--shard=k/N`, `--changed`, a narrowed include/exclude, deleted test files)
 * while every other rule — tests > 0, none failed, run-share, coverage — still
 * passes. The floor only holds if the same change cannot quietly lower it, so
 * this gate compares the working tree's floors with the copy at the merge-base:
 *
 *   - a floor BELOW its merge-base value is RED unless the file's
 *     `allowedDecreases` carries `{ from: <merge-base floor>, to: <new floor>,
 *     reason }` for that package — written by `--write-floors --allow-lower
 *     "<reason>"`, so a lowering is always a reviewed line in the diff;
 *   - every workspace package with a `test:coverage` script has a positive
 *     integer floor (a new package fails closed here, before any shard runs),
 *     and no floor names a package that no longer runs coverage;
 *   - an allowance whose `to` is not the current floor, or one this change
 *     adds for no decrease, is stale and RED.
 *
 * Raising a floor or adding one is always GREEN. The baseline is the
 * merge-base copy (the file the change set started from); when the file is
 * new since the merge-base, HEAD's committed copy (so an uncommitted lowering
 * is still caught); an unresolvable merge-base fails closed.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBaseRef } from "./check-cli-surface.js";
import { cleanEnv } from "./lib/differential-tree.js";
import { failWithRepair } from "./lib/gate-report.js";
import {
  FLOORS_FILE,
  parseFloors,
  readFloors,
  workspaceCoveragePackages,
  type FloorsFile,
} from "./verify-test-outcomes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every ratchet violation of `current` against `base` (null = no baseline). */
export function ratchetViolations(
  base: FloorsFile | null,
  current: FloorsFile,
  packages: readonly string[],
): string[] {
  const v: string[] = [];
  const want = new Set(packages);
  for (const pkg of packages)
    if (current.floors[pkg] === undefined)
      v.push(
        `${pkg}: has a test:coverage script but no floor in ${FLOORS_FILE} — a new package must add one`,
      );
  for (const pkg of Object.keys(current.floors))
    if (!want.has(pkg))
      v.push(
        `${FLOORS_FILE}: floor for ${pkg}, which is not a workspace package with a test:coverage script — remove the stale entry`,
      );
  const matched = new Set<string>();
  if (base)
    for (const [pkg, was] of Object.entries(base.floors)) {
      const now = current.floors[pkg];
      if (now === undefined || now >= was) continue;
      const a = current.allowedDecreases[pkg];
      if (a && a.from === was && a.to === now) matched.add(pkg);
      else
        v.push(
          `${pkg}: floor lowered ${was} → ${now} with no allowedDecreases entry { from: ${was}, to: ${now}, reason } — a floor only goes down as a reviewed decision`,
        );
    }
  for (const [pkg, a] of Object.entries(current.allowedDecreases)) {
    if (current.floors[pkg] !== a.to) {
      v.push(
        `${FLOORS_FILE}: allowedDecreases[${pkg}] says to=${a.to} but the floor is ${String(current.floors[pkg])} — a stale allowance; remove it`,
      );
      continue;
    }
    const inherited =
      base !== null && JSON.stringify(base.allowedDecreases[pkg]) === JSON.stringify(a);
    if (!inherited && !matched.has(pkg))
      v.push(
        `${FLOORS_FILE}: allowedDecreases[${pkg}] is added by this change but ${pkg}'s floor was not lowered from ${a.from} vs the baseline — remove it`,
      );
  }
  return v;
}

function git(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", env: cleanEnv() });
  return { status: r.status, stdout: r.stdout ?? "" };
}

/** The baseline floors and where they came from; a string when it fails closed. */
function baseline(argv: readonly string[]): { floors: FloorsFile | null; label: string } | string {
  const ref = resolveBaseRef(argv, process.env);
  if (!ref.ok) return `cannot resolve the change set's base (${ref.why})`;
  const verify = git(["rev-parse", "--verify", "--quiet", `${ref.ref}^{commit}`]);
  if (verify.status !== 0) return `\`${ref.ref}\` (${ref.source}) does not resolve to a commit`;
  const mb = git(["merge-base", ref.ref, "HEAD"]);
  const sha = mb.stdout.trim();
  if (mb.status !== 0 || !/^[0-9a-f]{40}$/.test(sha))
    return `no merge-base between \`${ref.ref}\` and HEAD (a shallow checkout, or unrelated history)`;
  for (const [rev, label] of [
    [sha, `the merge-base ${sha.slice(0, 10)} (${ref.ref})`],
    ["HEAD", `HEAD (${FLOORS_FILE} is new since the merge-base ${sha.slice(0, 10)})`],
  ] as const) {
    const show = git(["show", `${rev}:${FLOORS_FILE}`]);
    if (show.status !== 0) continue;
    const f = parseFloors(show.stdout);
    if (typeof f === "string") return `${label}: ${f}`;
    return { floors: f, label };
  }
  return { floors: null, label: `nothing (${FLOORS_FILE} is committed nowhere yet)` };
}

function main(argv: string[]): void {
  const packages = workspaceCoveragePackages(ROOT);
  const current = readFloors(ROOT);
  const base = baseline(argv);
  const violations: string[] = [];
  if (typeof current === "string") violations.push(`${current} — fail closed`);
  if (typeof base === "string") violations.push(`${base} — fail closed`);
  if (typeof current !== "string" && typeof base !== "string")
    violations.push(...ratchetViolations(base.floors, current, packages));
  if (violations.length > 0)
    failWithRepair({
      invariant:
        "the committed per-package test floors cover every package with a test:coverage script and only ever go down through a reviewed allowedDecreases entry",
      sites: violations,
      canonical: `${FLOORS_FILE}, written by \`pnpm test:outcomes:verify --artifacts <dir> --write-floors\` from a real full run of every shard`,
      fix: 'Add a missing floor by running every shard locally (scripts/test-coverage-shards.ts --shard i/N, each into its own artifact dir) and `pnpm test:outcomes:verify --artifacts <dir> --write-floors`. Restore a lowered floor, or — when tests were legitimately deleted — re-measure with `--write-floors --allow-lower "<reason>"`, which records { from, to, reason } in allowedDecreases for review. Remove a stale floor or allowance.',
      doctrine: "docs/doctrine/composition-preserves-enforcement.md",
    });
  const b = (base as { label: string }).label;
  const cur = current as FloorsFile;
  console.log(
    `✓ check-test-outcome-floors: examined ${packages.length} workspace package(s) with a test:coverage script — each has a floor in ${FLOORS_FILE} (${Object.values(cur.floors).reduce((a, n) => a + n, 0)} tests in all); ${Object.keys(cur.floors).length} floor(s) compared against ${b}: none lowered without an allowedDecreases entry (${Object.keys(cur.allowedDecreases).length} allowance(s)).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
