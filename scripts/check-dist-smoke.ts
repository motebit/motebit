#!/usr/bin/env tsx
/**
 * check-dist-smoke — boots every published CLI-shaped binary and asserts
 * it exits 0 on a read-only invocation.
 *
 * Invariant #13 (added 2026-04-13 after the `@noble/hashes` ×
 * `@solana/web3.js` bundling regression slipped into `apps/cli/dist/`
 * and shipped unnoticed until a cold-install walkthrough hit it).
 * Defense: for every package with a `bin` entry in its package.json,
 * build the target, then run its primary entry with `--help` (or the
 * binary's conventional dry-invocation flag). Any non-zero exit —
 * whether from a module resolution error, a dynamic-require crash, a
 * missing runtime dependency, or a real bug — fails the gate.
 *
 * Scope today:
 *   - apps/cli → `motebit --help`
 *   - packages/create-motebit → `create-motebit --help`
 *
 * Scope excluded:
 *   - Vite-bundled browser targets (apps/web, apps/spatial, etc.) —
 *     those have their own build/smoke harness at dev server start.
 *   - Mobile Metro bundles — same, run under a separate test runner.
 *   - Service HTTP entrypoints (services/relay) — those are booted by
 *     the relay integration suite, not a CLI smoke.
 *
 * Rationale for `--help` as the trigger: universally implemented, no
 * side effects, fast (< 200ms on both targets), exercises the entire
 * module graph at load time. Anything that would blow up later
 * (missing transitive dep, wrong @noble version, dynamic-require-of-
 * buffer, ERR_PACKAGE_PATH_NOT_EXPORTED) fires at `--help` because
 * ESM loads everything at import time.
 *
 * Usage:
 *   tsx scripts/check-dist-smoke.ts         # exit 1 on any failure
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface Target {
  /** Package directory under the monorepo root. */
  pkgDir: string;
  /** Display name for the output. */
  name: string;
  /** Arguments passed to the built binary (default `--help`). */
  args: string[];
  /**
   * Acceptable exit codes. Default [0]. CLIs that use exit codes for
   * informational output (e.g. `--help` may exit 0 or 1 depending on
   * tooling) can widen this.
   */
  acceptExitCodes: number[];
}

const TARGETS: ReadonlyArray<Target> = [
  {
    pkgDir: "apps/cli",
    name: "motebit",
    args: ["--help"],
    acceptExitCodes: [0],
  },
  {
    pkgDir: "packages/create-motebit",
    name: "create-motebit",
    args: ["--help"],
    acceptExitCodes: [0],
  },
];

interface Result {
  target: Target;
  ok: boolean;
  exitCode: number | null;
  stderr: string;
  durationMs: number;
}

function resolveBinaryEntry(target: Target): string | null {
  const pkgJsonPath = resolve(ROOT, target.pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
    bin?: string | Record<string, string>;
    main?: string;
  };
  const bin = pkg.bin;
  const rel = typeof bin === "string" ? bin : bin ? Object.values(bin)[0] : pkg.main;
  if (!rel) return null;
  return resolve(ROOT, target.pkgDir, rel);
}

function runTarget(target: Target): Result {
  const started = Date.now();
  const entry = resolveBinaryEntry(target);
  if (!entry) {
    return {
      target,
      ok: false,
      exitCode: null,
      stderr: `no bin/main entry in ${target.pkgDir}/package.json`,
      durationMs: Date.now() - started,
    };
  }
  try {
    statSync(entry);
  } catch {
    return {
      target,
      ok: false,
      exitCode: null,
      stderr: `built entry not found at ${entry} — run \`pnpm --filter ${target.name} build\` first`,
      durationMs: Date.now() - started,
    };
  }
  // Run via node directly, not via the shell — catches shebang/env issues.
  const result = spawnSync("node", [entry, ...target.args], {
    cwd: resolve(ROOT, target.pkgDir),
    stdio: "pipe",
    encoding: "utf-8",
    // 10s is generous for a --help invocation; anything slower is a real
    // module-load problem, not a legitimate startup delay.
    timeout: 10_000,
  });
  const exitCode = result.status;
  const durationMs = Date.now() - started;
  const ok = exitCode !== null && target.acceptExitCodes.includes(exitCode);
  return {
    target,
    ok,
    exitCode,
    // Keep the tail of stderr so the gate's output contains the actual error.
    stderr: (result.stderr ?? "").slice(-1500),
    durationMs,
  };
}

function main(): void {
  const results = TARGETS.map(runTarget);

  console.log(`check-dist-smoke — ${results.length} binaries\n`);

  let anyFailed = false;
  for (const { target, ok, exitCode, stderr, durationMs } of results) {
    const status = ok ? "✓" : "✗";
    const exitStr = exitCode === null ? "no-exit" : `exit ${exitCode}`;
    console.log(`  ${status} ${target.name.padEnd(18)} ${exitStr.padEnd(10)} ${durationMs}ms`);
    if (!ok) {
      anyFailed = true;
      if (stderr.trim()) {
        console.log("    stderr (tail):");
        for (const line of stderr.trim().split("\n").slice(0, 20)) {
          console.log(`      ${line}`);
        }
      }
    }
  }

  if (anyFailed) {
    console.log(
      "\nOne or more published binaries failed to boot. This is the exact\n" +
        "class of regression shipped in the CLI's @noble/hashes × @solana/web3.js\n" +
        "bundling break (2026-04-13): a build that compiles clean but the\n" +
        "dist binary crashes on first load.\n\n" +
        "Fix: run `pnpm --filter <pkg> build` locally, then `node <bin-path> --help`\n" +
        "to reproduce. Most common cause is tsup `external` missing a CJS-era\n" +
        "dependency (bs58, safe-buffer, base-x) or a subpath export mismatch\n" +
        "(e.g. `@noble/hashes/utils.js` vs `@noble/hashes/utils`).",
    );
    process.exit(1);
  }

  console.log(`\nAll ${results.length} published binaries boot cleanly.`);
}

main();
