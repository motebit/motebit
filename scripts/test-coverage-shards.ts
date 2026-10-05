#!/usr/bin/env tsx
/**
 * CI's `turbo run test:coverage`, split into N disjoint shards.
 *
 * The serial `check` job (build + every drift gate + typecheck + lint + every
 * suite with coverage on one 4-core runner) took 16–25 min against a 30-min
 * wall and timed out four times on 2026-10-04, each time ejecting a PR from
 * the merge queue. CI now runs the suites as the `test-coverage` matrix
 * (`.github/workflows/ci.yml`), one runner per shard, and `check` is the
 * fail-closed verdict over the static job and every shard.
 *
 * The assignment is COMPUTED, never a hand list:
 *   - the package set is every workspace package with a `test:coverage`
 *     script (exactly what an unfiltered `turbo run test:coverage` runs);
 *   - `services/relay` — the dominant suite — is shard 1, alone;
 *   - every other package is bin-packed (longest first, onto the lightest
 *     shard) over shards 2..N by its measured weight in SHARD_WEIGHTS;
 *   - a package with no weight, or a weight naming no such package, is a
 *     violation: every shard refuses to run, so a new package can never fall
 *     out of CI by being nobody's shard.
 * The partition (every package in exactly one shard) is re-proven three times:
 * by `check-prepush-subset` in `pnpm check` (the pre-push ⊆ CI gate — CI's
 * union must still be the full suite the hook's `turbo run test` subsets), by
 * every shard before it runs, and by the `check` verdict job from the
 * manifests the shards upload (`--verify-manifests`).
 *
 * Usage:
 *   tsx scripts/test-coverage-shards.ts --shard 2/3 --manifest coverage/test-coverage-shard.json
 *   tsx scripts/test-coverage-shards.ts --list 3
 *   tsx scripts/test-coverage-shards.ts --verify-manifests <dir>
 *
 * Re-measuring the weights: `pnpm exec turbo run test:coverage
 * --concurrency=4 --summarize` writes `.turbo/runs/<id>.json`; each task's
 * `execution.endTime - startTime` (ms) / 1000, rounded, is its weight.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { failWithRepair } from "./lib/gate-report.js";

/** The dominant suite: always shard 1, alone. */
export const SOLO = "services/relay";

/**
 * Measured wall seconds of each package's `test:coverage` (turbo
 * `--summarize`, `--concurrency=4`, 4-core machine, 2026-10-05; relay measured
 * alone — 928s here, 998s inside the contended serial CI run — and
 * cli/desktop/create-motebit together). Relative size is all the packer
 * compares. A rough guess is fine for a new package; re-measure when a
 * shard's runtime drifts.
 */
export const SHARD_WEIGHTS: Record<string, number> = {
  "apps/cli": 421,
  "apps/desktop": 106,
  "apps/identity": 3,
  "apps/inspector": 12,
  "apps/mobile": 50,
  "apps/operator": 8,
  "apps/spatial": 95,
  "apps/verify": 5,
  "apps/web": 105,
  "packages/ai-core": 17,
  "packages/behavior-engine": 3,
  "packages/browser-persistence": 7,
  "packages/circuit-breaker": 3,
  "packages/core-identity": 8,
  "packages/create-motebit": 21,
  "packages/crypto": 50,
  "packages/crypto-android-keystore": 5,
  "packages/crypto-appattest": 6,
  "packages/crypto-tpm": 7,
  "packages/crypto-webauthn": 6,
  "packages/deposit-detector": 3,
  "packages/encryption": 21,
  "packages/event-log": 4,
  "packages/evm-rpc": 7,
  "packages/gradient": 5,
  "packages/identity-file": 13,
  "packages/market": 9,
  "packages/mcp-client": 10,
  "packages/mcp-server": 34,
  "packages/memory-graph": 12,
  "packages/molecule-runner": 24,
  "packages/panels": 9,
  "packages/persistence": 15,
  "packages/planner": 12,
  "packages/policy": 11,
  "packages/policy-invariants": 5,
  "packages/privacy-layer": 6,
  "packages/protocol": 17,
  "packages/reflection": 8,
  "packages/relay-client": 5,
  "packages/render-engine": 21,
  "packages/runtime": 105,
  "packages/runtime-host": 8,
  "packages/sdk": 6,
  "packages/self-knowledge": 4,
  "packages/semiring": 10,
  "packages/settlement-rails": 7,
  "packages/skills": 9,
  "packages/sqlite-migrations": 4,
  "packages/state-export-client": 6,
  "packages/state-vector": 4,
  "packages/surface-kit": 123,
  "packages/sync-engine": 121,
  "packages/tools": 9,
  "packages/treasury-reconciliation": 3,
  "packages/verifier": 4,
  "packages/verify": 43,
  "packages/virtual-accounts": 4,
  "packages/voice": 5,
  "packages/wallet-solana": 10,
  "packages/wire-schemas": 10,
  "services/auditor": 4,
  "services/browser-sandbox": 7,
  "services/clerk": 2,
  "services/code-review": 16,
  "services/embed": 4,
  "services/proxy": 30,
  "services/read-url": 9,
  "services/relay": 928,
  "services/research": 11,
  "services/summarize": 13,
  "services/web-search": 12,
};

export interface Assignment {
  /** shards[i] = the package dirs shard i+1 runs, sorted. */
  shards: string[][];
  /** Estimated seconds per shard (sum of weights). */
  load: number[];
  violations: string[];
}

/** Every package dir whose package.json declares `test:coverage`, sorted. */
export function coveragePackages(packageScripts: Record<string, Record<string, string>>): string[] {
  return Object.entries(packageScripts)
    .filter(([, s]) => typeof s["test:coverage"] === "string")
    .map(([dir]) => dir)
    .sort();
}

export function assignShards(
  packages: readonly string[],
  n: number,
  weights: Record<string, number> = SHARD_WEIGHTS,
): Assignment {
  const violations: string[] = [];
  const shards: string[][] = Array.from({ length: Math.max(n, 0) }, () => []);
  const load: number[] = shards.map(() => 0);
  if (!Number.isInteger(n) || n < 2) {
    violations.push(`shard count must be an integer ≥ 2 (relay alone + the rest); got ${n}`);
    return { shards, load, violations };
  }
  const set = new Set(packages);
  if (!set.has(SOLO))
    violations.push(`${SOLO} has no test:coverage script — the solo shard would run nothing`);
  for (const p of packages)
    if (p !== SOLO && !(typeof weights[p] === "number" && weights[p] >= 0))
      violations.push(
        `${p} has a test:coverage script but no weight in SHARD_WEIGHTS — it would be in no shard`,
      );
  for (const p of Object.keys(weights))
    if (!set.has(p))
      violations.push(`SHARD_WEIGHTS names ${p}, which has no test:coverage script (stale entry)`);
  if (violations.length > 0) return { shards, load, violations };

  shards[0]!.push(SOLO);
  load[0] = weights[SOLO] ?? 0;
  const rest = packages
    .filter((p) => p !== SOLO)
    .sort((a, b) => weights[b]! - weights[a]! || (a < b ? -1 : 1));
  for (const p of rest) {
    let best = 1;
    for (let i = 2; i < n; i++) if (load[i]! < load[best]!) best = i;
    shards[best]!.push(p);
    load[best]! += weights[p]!;
  }
  for (const s of shards) s.sort();
  return { shards, load, violations };
}

/** Every package in exactly one shard, and nothing else in any shard. */
export function verifyPartition(
  packages: readonly string[],
  shards: readonly string[][],
): string[] {
  const v: string[] = [];
  const seen = new Map<string, number>();
  shards.forEach((s, i) => {
    if (s.length === 0) v.push(`shard ${i + 1}/${shards.length} runs no package`);
    for (const p of s) {
      if (seen.has(p))
        v.push(`${p} is in shard ${seen.get(p)! + 1} AND shard ${i + 1} (runs twice)`);
      else seen.set(p, i);
    }
  });
  const want = new Set(packages);
  for (const p of want)
    if (!seen.has(p)) v.push(`${p} has a test:coverage script but is in no shard (never tested)`);
  for (const p of seen.keys())
    if (!want.has(p)) v.push(`a shard runs ${p}, which has no test:coverage script`);
  return v;
}

/** The exact turbo invocation a shard runs — CI's former unfiltered form, filtered to the shard. */
export function turboArgs(dirs: readonly string[]): string[] {
  return ["run", "test:coverage", "--concurrency=4", ...dirs.map((d) => `--filter=./${d}`)];
}

export function readPackageScripts(root: string): Record<string, Record<string, string>> {
  const globs = (
    parseYaml(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")) as { packages: string[] }
  ).packages;
  const out: Record<string, Record<string, string>> = {};
  for (const g of globs) {
    const base = g.replace(/\/\*$/, "");
    for (const d of readdirSync(join(root, base))) {
      const pj = join(root, base, d, "package.json");
      if (!existsSync(pj)) continue;
      out[`${base}/${d}`] =
        (JSON.parse(readFileSync(pj, "utf8")) as { scripts?: Record<string, string> }).scripts ??
        {};
    }
  }
  return out;
}

export interface Manifest {
  shard: string;
  packages: string[];
}

/** The `check` verdict job's proof: the uploaded manifests cover every package exactly once. */
export function verifyManifests(packages: readonly string[], manifests: Manifest[]): string[] {
  const v: string[] = [];
  const n = manifests.length;
  if (n === 0) return ["no shard manifest found — no shard proved what it ran"];
  const byIndex: string[][] = Array.from({ length: n }, () => []);
  const seen = new Set<number>();
  for (const m of manifests) {
    const hit = /^(\d+)\/(\d+)$/.exec(m.shard);
    const i = hit ? Number(hit[1]) : NaN;
    if (!hit || Number(hit[2]) !== n || i < 1 || i > n) {
      v.push(`manifest shard "${m.shard}" does not fit ${n} manifest(s)`);
      continue;
    }
    if (seen.has(i)) v.push(`shard ${m.shard} reported twice`);
    seen.add(i);
    byIndex[i - 1] = m.packages;
  }
  if (v.length > 0) return v;
  return verifyPartition(packages, byIndex);
}

function parseShard(s: string | undefined): { i: number; n: number } | null {
  const m = /^(\d+)\/(\d+)$/.exec(s ?? "");
  if (!m) return null;
  const i = Number(m[1]);
  const n = Number(m[2]);
  return i >= 1 && i <= n ? { i, n } : null;
}

function fail(sites: string[]): never {
  failWithRepair({
    invariant:
      "CI's test:coverage shards partition every workspace package with a test:coverage script — relay alone in shard 1, the rest bin-packed by SHARD_WEIGHTS, each package in exactly one shard",
    sites,
    canonical:
      "SHARD_WEIGHTS / assignShards in scripts/test-coverage-shards.ts; the test-coverage matrix in .github/workflows/ci.yml",
    fix: "Add a measured weight for each new package to SHARD_WEIGHTS in scripts/test-coverage-shards.ts (a rough guess in seconds is fine; see the header for re-measuring), and remove entries for packages that no longer have a test:coverage script.",
    doctrine: "docs/drift-defenses.md",
  });
}

function main(argv: string[]): void {
  const root = process.cwd();
  const packages = coveragePackages(readPackageScripts(root));
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const verifyDir = arg("--verify-manifests");
  if (verifyDir != null) {
    const files: string[] = [];
    const walkDir = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walkDir(p);
        else if (/^test-coverage-shard.*\.json$/.test(e.name)) files.push(p);
      }
    };
    if (existsSync(verifyDir)) walkDir(verifyDir);
    const manifests = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as Manifest);
    const v = verifyManifests(packages, manifests);
    if (v.length > 0) fail(v);
    console.log(
      `✓ test-coverage-shards: ${manifests.length} shard manifest(s) cover all ${packages.length} package(s) with a test:coverage script, each exactly once.`,
    );
    return;
  }

  const listN = arg("--list");
  if (listN != null) {
    const a = assignShards(packages, Number(listN));
    if (a.violations.length > 0) fail(a.violations);
    a.shards.forEach((s, i) =>
      console.log(`shard ${i + 1}/${a.shards.length} (~${a.load[i]}s): ${s.join(" ")}`),
    );
    return;
  }

  const shard = parseShard(arg("--shard"));
  if (shard == null) {
    console.error(
      "usage: test-coverage-shards.ts --shard i/N [--manifest <file>] | --list N | --verify-manifests <dir>",
    );
    process.exit(2);
  }
  const a = assignShards(packages, shard.n);
  const v = [...a.violations, ...(a.violations.length ? [] : verifyPartition(packages, a.shards))];
  if (v.length > 0) fail(v);
  const mine = a.shards[shard.i - 1]!;
  const manifest = arg("--manifest");
  if (manifest != null) {
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(
      manifest,
      `${JSON.stringify({ shard: `${shard.i}/${shard.n}`, packages: mine } satisfies Manifest)}\n`,
    );
  }
  console.log(
    `test-coverage shard ${shard.i}/${shard.n}: ${mine.length} of ${packages.length} package(s), ~${a.load[shard.i - 1]}s measured — ${mine.join(" ")}`,
  );
  const r = spawnSync(join(root, "node_modules", ".bin", "turbo"), turboArgs(mine), {
    cwd: root,
    stdio: "inherit",
  });
  if (r.error) throw r.error;
  process.exit(r.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
