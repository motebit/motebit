/**
 * Public-API-surface drift gate for the permissive-floor packages.
 *
 * Motebit publishes `@motebit/protocol`, `@motebit/crypto`, `@motebit/sdk`, and
 * `@motebit/verifier` to npm as Apache-2.0 types + primitives that third
 * parties will build against. Once
 * external developers depend on those packages, any silent breaking change —
 * a renamed export, a tightened signature, a removed type — burns them
 * without warning. Semver is the social contract; enforcement turns it from
 * promise into guarantee.
 *
 * This gate runs `api-extractor` in CI mode for each tracked package, which
 * extracts the public API surface from the built `.d.ts` and compares it to
 * the committed baseline at `packages/<pkg>/etc/<unscoped>.api.md`. If the
 * extracted surface diverges from the baseline, this gate fails the build —
 * with one escape hatch: if a pending `.changeset/*.md` already marks the
 * affected package as `major`, the diff is accepted as an intentional
 * breaking change that the author explicitly declared.
 *
 * The author still has to update the baseline (via `pnpm -r run api:extract`)
 * and commit it, so a reviewer sees the diff in the PR.
 *
 * That comparison alone is blind to its own instruction: once an author
 * regenerates and commits the baseline, surface and baseline agree again and
 * a break would pass with no changeset at all. So the gate runs a second,
 * history check (scripts/lib/api-baseline-history.ts): each tracked baseline
 * as checked out is compared with the same file at `git merge-base HEAD
 * origin/main`. A removed or changed declaration line is BREAKING and needs a
 * pending `major` changeset for that package; only added lines are ADDITIVE
 * and need at least a `minor`. When the merge-base cannot be resolved
 * (origin/main not fetched, shallow clone) the gate fails closed with a
 * repair instruction — CI checks out with `fetch-depth: 0` for this.
 *
 * Companion gate: check-changeset-discipline.ts requires every `major`
 * changeset to ship with a `## Migration` section. Together they enforce:
 * breaking → major changeset → migration guide → baseline updated. The
 * protocol behaves like a protocol.
 */

import { readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  checkBaselineHistory,
  classifyBaselineChange,
  pendingBumps,
  type HistoryVerdict,
} from "./lib/api-baseline-history.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Packages whose API surface is tracked by this gate. */
export interface TrackedPackage {
  /** Filesystem path relative to ROOT. */
  path: string;
  /** npm package name (matches the `name` field in its package.json). */
  name: string;
  /** Filename of the committed baseline — typically `etc/<unscoped>.api.md`. */
  baseline: string;
}

export const TRACKED: ReadonlyArray<TrackedPackage> = [
  { path: "packages/protocol", name: "@motebit/protocol", baseline: "etc/protocol.api.md" },
  { path: "packages/crypto", name: "@motebit/crypto", baseline: "etc/crypto.api.md" },
  { path: "packages/sdk", name: "@motebit/sdk", baseline: "etc/sdk.api.md" },
  // The pinned surface an external consumer (agency.computer) codes against —
  // docs/doctrine/agency-proof-integration.md §2 promises it is held stable
  // by this gate. Its api-extractor config BUNDLES @motebit/crypto and
  // @motebit/protocol (`bundledPackages` + `includeForgottenExports`), so the
  // baseline carries the full declaration of every re-exported symbol and of
  // every type they transitively reach — not just the name. A breaking change
  // to a re-exported crypto/protocol type therefore turns THIS row red, and a
  // crypto-only `major` changeset cannot cover it: the verifier needs its own
  // `major` (otherwise changesets would cascade it as a patch).
  { path: "packages/verifier", name: "@motebit/verifier", baseline: "etc/verifier.api.md" },
];

/**
 * api-extractor prints exactly one of these lines when it finished analysing
 * the package. Its exit status cannot be the success signal on its own: a
 * clean run that only emitted warnings exits 1, while an aborted run (missing
 * entry point, config error, crash) also exits nonzero but never prints a
 * completion line.
 */
const EXTRACTOR_COMPLETED = /API Extractor completed (?:successfully|with warnings)/;

/**
 * Run api-extractor in non-local mode for a single package, then compare the
 * generated temp file against the committed baseline.
 *
 * Divergence: api-extractor treats signature changes as warnings, not errors.
 * When it runs in non-local mode and the extracted surface differs, it writes
 * the new surface to `etc/temp/<pkg>.api.md` for the developer to copy over.
 * That temp file is what we diff against the committed baseline.
 *
 * Fail closed: "no temp file" means "matches" ONLY when the extractor actually
 * ran to completion. A missing `dist/index.d.ts`, a spawn failure, or a run
 * that aborted before completing is an `error`, never a match — otherwise an
 * unbuilt package would silently pass.
 */
export interface ExtractResult {
  ok: boolean;
  output: string;
  error?: string;
  /** The extracted surface when it diverges from the committed baseline. */
  extracted?: string;
}

function runExtractorAndDiff(root: string, pkgPath: string, baselineRel: string): ExtractResult {
  const entryRel = `${pkgPath}/dist/index.d.ts`;
  if (!existsSync(resolve(root, entryRel))) {
    return {
      ok: false,
      output: "",
      error: `${entryRel} is missing — api-extractor has no surface to extract`,
    };
  }

  // The temp file lives at etc/temp/<unscoped>.api.md — same filename as the
  // committed baseline, just under the temp/ directory.
  // baselineRel is like "etc/protocol.api.md"; the temp sibling is
  // "etc/temp/protocol.api.md".
  const lastSlash = baselineRel.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : baselineRel.slice(0, lastSlash);
  const file = lastSlash === -1 ? baselineRel : baselineRel.slice(lastSlash + 1);
  const tempPath = resolve(root, pkgPath, dir, "temp", file);
  const baselinePath = resolve(root, pkgPath, baselineRel);

  // A temp file left by an earlier run must not stand in for this run's result.
  rmSync(tempPath, { force: true });

  const result = spawnSync("pnpm", ["--silent", "exec", "api-extractor", "run", "--verbose"], {
    cwd: resolve(root, pkgPath),
    encoding: "utf-8",
  });
  const extractorOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (result.error || !EXTRACTOR_COMPLETED.test(extractorOutput)) {
    const why = result.error
      ? `could not spawn api-extractor (${result.error.message})`
      : `api-extractor did not complete (exit status ${String(result.status)})`;
    return { ok: false, output: extractorOutput, error: why };
  }

  // The extractor completed and wrote no temp file: it considered the
  // baseline current — no divergence.
  if (!existsSync(tempPath)) {
    return { ok: true, output: extractorOutput };
  }

  const tempContent = readFileSync(tempPath, "utf-8");
  const baselineContent = existsSync(baselinePath) ? readFileSync(baselinePath, "utf-8") : "";

  if (tempContent === baselineContent) {
    return { ok: true, output: extractorOutput };
  }

  return { ok: false, output: extractorOutput, extracted: tempContent };
}

export interface GateOptions {
  root: string;
  tracked: ReadonlyArray<TrackedPackage>;
  /** The base branch the history check diffs against (merge-base with HEAD). */
  baseRef: string;
  /** Injected in tests; defaults to running api-extractor in `root`. */
  extract?: (pkg: TrackedPackage) => ExtractResult;
  write?: (text: string) => void;
}

const MAX_LISTED_LINES = 20;

function listLines(write: (text: string) => void, label: string, lines: string[]): void {
  if (lines.length === 0) return;
  write(`    ${label}:\n`);
  for (const line of lines.slice(0, MAX_LISTED_LINES)) write(`      ${line}\n`);
  if (lines.length > MAX_LISTED_LINES) {
    write(`      … and ${lines.length - MAX_LISTED_LINES} more\n`);
  }
}

/** Run both halves of the gate; returns the process exit code. */
export function runApiSurfaceGate(opts: GateOptions): number {
  const { root, tracked } = opts;
  const write = opts.write ?? ((text: string) => void process.stderr.write(text));
  const extract =
    opts.extract ?? ((pkg: TrackedPackage) => runExtractorAndDiff(root, pkg.path, pkg.baseline));
  const bumps = pendingBumps(resolve(root, ".changeset"));
  const failures: Array<{ pkg: TrackedPackage; result: ExtractResult }> = [];
  const extractionErrors: Array<{ pkg: TrackedPackage; output: string; error: string }> = [];

  write("Extracted surface vs committed baseline:\n");
  for (const pkg of tracked) {
    // Confirm the baseline exists. Absence is a config bug, not a drift.
    const baselinePath = resolve(root, pkg.path, pkg.baseline);
    if (!existsSync(baselinePath)) {
      write(
        `error: ${pkg.name} baseline missing at ${pkg.baseline}. Run \`pnpm --filter ${pkg.name} run api:extract\` and commit the result.\n`,
      );
      return 2;
    }

    const result = extract(pkg);
    if (result.error !== undefined) {
      // Not a drift verdict at all — the surface was never extracted. A
      // pending `major` changeset does not cover this: there is nothing to
      // compare, so the gate fails closed.
      write(`  ✗ ${pkg.name.padEnd(24)} API surface NOT extracted\n`);
      extractionErrors.push({ pkg, output: result.output, error: result.error });
      continue;
    }
    if (result.ok) {
      write(`  ✓ ${pkg.name.padEnd(24)} API surface matches baseline\n`);
      continue;
    }

    if (bumps.get(pkg.name) === "major") {
      // The author already declared this as a breaking change. Accept the
      // diff — but the baseline still needs to be regenerated and committed
      // so reviewers see exactly what changed.
      //
      // When api-extractor runs non-local and finds a diff, it writes the
      // updated surface to etc/temp/ rather than overwriting the baseline.
      // That asymmetry is deliberate: it forces the author to run the
      // extractor locally (`pnpm -r run api:extract`) and commit the result,
      // which puts the diff in the PR for review.
      write(`  ⚠ ${pkg.name.padEnd(24)} API changed — covered by pending \`major\` changeset\n`);
      write(
        `    Remember to run \`pnpm --filter ${pkg.name} run api:extract\` and commit the updated baseline.\n`,
      );
      continue;
    }

    write(`  ✗ ${pkg.name.padEnd(24)} API surface diverges from the committed baseline\n`);
    failures.push({ pkg, result });
  }

  // History half: what this branch changed in each committed baseline.
  // Without it, regenerating the baseline (the instruction above) would make
  // any break invisible to the extractor half.
  write(`\nCommitted baseline vs merge-base with ${opts.baseRef}:\n`);
  const history = checkBaselineHistory({
    root,
    baseRef: opts.baseRef,
    packages: tracked.map((pkg) => ({
      name: pkg.name,
      baselinePath: `${pkg.path}/${pkg.baseline}`,
    })),
  });
  const historyFailures: HistoryVerdict[] = [];
  if (history.ok) {
    for (const v of history.verdicts) {
      const name = v.pkg.name.padEnd(24);
      const declared = v.declared === undefined ? "none" : `\`${v.declared}\``;
      if (v.change.kind === "new") {
        write(`  ✓ ${name} newly tracked (no baseline at the merge-base)\n`);
      } else if (v.change.kind === "unchanged") {
        write(`  ✓ ${name} no declaration changed since the merge-base\n`);
      } else if (v.ok) {
        write(`  ✓ ${name} ${v.change.kind} change covered by pending ${declared} changeset\n`);
      } else {
        write(
          `  ✗ ${name} ${v.change.kind.toUpperCase()} change needs a pending \`${v.required ?? "major"}\` changeset (declared: ${declared})\n`,
        );
        historyFailures.push(v);
      }
    }
  } else {
    write(`  ✗ history NOT checked — ${history.error}\n`);
  }

  if (extractionErrors.length > 0) {
    write(
      `\nerror: could not extract the API surface for ${extractionErrors.length} of ${tracked.length} package(s) — the gate fails closed rather than treat an unchecked surface as matching:\n\n`,
    );
    for (const { pkg, output, error } of extractionErrors) {
      write(`─── ${pkg.name} ───\n  ${error}\n`);
      if (output) write(output);
      write(
        `  Fix: run \`pnpm --filter ${pkg.name} build\` so ${pkg.path}/dist/index.d.ts exists (or fix the api-extractor error shown above), then re-run \`pnpm check-api-surface\`.\n\n`,
      );
    }
  }

  if (!history.ok) {
    write(
      `\nerror: could not compare the committed baselines with the merge-base — the gate fails closed rather than assume this branch changed no baseline (scripts/lib/api-baseline-history.ts):\n  ${history.error}\n  Fix: ${history.repair}\n`,
    );
  }

  if (failures.length > 0) {
    write(
      `\nerror: the extracted API surface diverges from the committed baseline for ${failures.length} package(s):\n\n`,
    );
    for (const { pkg, result } of failures) {
      write(`─── ${pkg.name} ───\n`);
      // api-extractor's own output includes the diff location and guidance.
      write(result.output);
      const baseline = readFileSync(resolve(root, pkg.path, pkg.baseline), "utf-8");
      const change =
        result.extracted === undefined
          ? undefined
          : classifyBaselineChange(baseline, result.extracted);
      if (change?.kind === "additive") {
        write(
          `\n  The change is ADDITIVE (declarations only added). Resolution:\n` +
            `    run \`pnpm --filter ${pkg.name} run api:extract\`, commit the updated baseline,\n` +
            `    and add a changeset declaring "${pkg.name}": minor (or higher).\n`,
        );
        listLines(write, "added", change.added);
      } else {
        write(
          `\n  The change is BREAKING (a declaration was removed or changed). Resolution:\n` +
            `    1. Intentional → add a changeset declaring "${pkg.name}": major with a \`## Migration\`\n` +
            `       section, run \`pnpm --filter ${pkg.name} run api:extract\`, and commit the updated baseline.\n` +
            `    2. Accidental → revert the API change.\n`,
        );
        if (change) {
          listLines(write, "removed or changed", change.removed);
          listLines(write, "added", change.added);
        }
      }
      write("\n");
    }
  }

  if (historyFailures.length > 0) {
    write(
      `\nerror: the committed API baseline changed since the merge-base without a covering changeset for ${historyFailures.length} package(s):\n\n`,
    );
    for (const v of historyFailures) {
      write(`─── ${v.pkg.name} (${v.pkg.baselinePath}) ───\n`);
      if (v.change.kind === "additive") {
        write(
          `  ADDITIVE (declarations only added). Resolution: add a changeset declaring\n` +
            `  "${v.pkg.name}": minor (or higher) and commit it.\n`,
        );
        listLines(write, "added", v.change.added);
      } else {
        write(
          `  BREAKING (a declaration was removed or changed). Resolution:\n` +
            `    1. Intentional → add a changeset declaring "${v.pkg.name}": major with a \`## Migration\` section.\n` +
            `    2. Accidental → revert the API change and re-run \`pnpm --filter ${v.pkg.name} run api:extract\`.\n`,
        );
        listLines(write, "removed or changed", v.change.removed);
        listLines(write, "added", v.change.added);
      }
      write("\n");
    }
  }

  if (
    extractionErrors.length > 0 ||
    !history.ok ||
    failures.length > 0 ||
    historyFailures.length > 0
  ) {
    return 1;
  }
  write(
    `\nAPI surface check passed — ${tracked.length} packages match their baselines, and every baseline change since the merge-base is covered by a pending changeset.\n`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(runApiSurfaceGate({ root: ROOT, tracked: TRACKED, baseRef: "origin/main" }));
}
