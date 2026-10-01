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
 * Companion gate: check-changeset-discipline.ts requires every `major`
 * changeset to ship with a `## Migration` section. Together they enforce:
 * breaking → major changeset → migration guide → baseline updated. The
 * protocol behaves like a protocol.
 */

import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Packages whose API surface is tracked by this gate. */
interface TrackedPackage {
  /** Filesystem path relative to ROOT. */
  path: string;
  /** npm package name (matches the `name` field in its package.json). */
  name: string;
  /** Filename of the committed baseline — typically `etc/<unscoped>.api.md`. */
  baseline: string;
}

const TRACKED: ReadonlyArray<TrackedPackage> = [
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
 * Parse pending changesets and collect which tracked packages have a `major`
 * bump already declared. If the API surface diff is covered by a declared
 * major, the gate passes (the break is intentional and in the record).
 */
function majorBumpsFromPendingChangesets(): Set<string> {
  const dir = resolve(ROOT, ".changeset");
  if (!existsSync(dir)) return new Set();
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "README.md" && f !== "CHANGELOG.md",
  );
  const majors = new Set<string>();
  for (const file of files) {
    const content = readFileSync(resolve(dir, file), "utf-8");
    // Frontmatter between --- markers; one `"@pkg/name": major` per line.
    const frontMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontMatch) continue;
    const front = frontMatch[1];
    if (!front) continue;
    for (const line of front.split("\n")) {
      const entry = line.match(/^"([^"]+)":\s*(patch|minor|major)/);
      if (entry && entry[2] === "major") {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        majors.add(entry[1]!);
      }
    }
  }
  return majors;
}

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
function runExtractorAndDiff(
  pkgPath: string,
  baselineRel: string,
): { ok: boolean; output: string; error?: string } {
  const entryRel = `${pkgPath}/dist/index.d.ts`;
  if (!existsSync(resolve(ROOT, entryRel))) {
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
  const tempPath = resolve(ROOT, pkgPath, dir, "temp", file);
  const baselinePath = resolve(ROOT, pkgPath, baselineRel);

  // A temp file left by an earlier run must not stand in for this run's result.
  rmSync(tempPath, { force: true });

  const result = spawnSync("pnpm", ["--silent", "exec", "api-extractor", "run", "--verbose"], {
    cwd: resolve(ROOT, pkgPath),
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

  return { ok: false, output: extractorOutput };
}

function main(): void {
  const declaredMajors = majorBumpsFromPendingChangesets();
  const failures: Array<{ pkg: TrackedPackage; output: string }> = [];
  const extractionErrors: Array<{ pkg: TrackedPackage; output: string; error: string }> = [];

  for (const pkg of TRACKED) {
    // Confirm the baseline exists. Absence is a config bug, not a drift.
    const baselinePath = resolve(ROOT, pkg.path, pkg.baseline);
    if (!existsSync(baselinePath)) {
      process.stderr.write(
        `error: ${pkg.name} baseline missing at ${pkg.baseline}. Run \`pnpm --filter ${pkg.name} run api:extract\` and commit the result.\n`,
      );
      process.exit(2);
    }

    const { ok, output, error } = runExtractorAndDiff(pkg.path, pkg.baseline);
    if (error !== undefined) {
      // Not a drift verdict at all — the surface was never extracted. A
      // pending `major` changeset does not cover this: there is nothing to
      // compare, so the gate fails closed.
      process.stderr.write(`  ✗ ${pkg.name.padEnd(24)} API surface NOT extracted\n`);
      extractionErrors.push({ pkg, output, error });
      continue;
    }
    if (ok) {
      process.stderr.write(`  ✓ ${pkg.name.padEnd(24)} API surface matches baseline\n`);
      continue;
    }

    if (declaredMajors.has(pkg.name)) {
      // The author already declared this as a breaking change. Accept the
      // diff — but the baseline still needs to be regenerated and committed
      // so reviewers see exactly what changed.
      //
      // When api-extractor runs non-local and finds a diff, it writes the
      // updated surface to etc/temp/ rather than overwriting the baseline.
      // That asymmetry is deliberate: it forces the author to run the
      // extractor locally (`pnpm -r run api:extract`) and commit the result,
      // which puts the diff in the PR for review.
      process.stderr.write(
        `  ⚠ ${pkg.name.padEnd(24)} API changed — covered by pending \`major\` changeset\n`,
      );
      process.stderr.write(
        `    Remember to run \`pnpm --filter ${pkg.name} run api:extract\` and commit the updated baseline.\n`,
      );
      continue;
    }

    failures.push({ pkg, output });
  }

  if (extractionErrors.length > 0) {
    process.stderr.write(
      `\nerror: could not extract the API surface for ${extractionErrors.length} of ${TRACKED.length} package(s) — the gate fails closed rather than treat an unchecked surface as matching:\n\n`,
    );
    for (const { pkg, output, error } of extractionErrors) {
      process.stderr.write(`─── ${pkg.name} ───\n  ${error}\n`);
      if (output) process.stderr.write(output);
      process.stderr.write(
        `  Fix: run \`pnpm --filter ${pkg.name} build\` so ${pkg.path}/dist/index.d.ts exists (or fix the api-extractor error shown above), then re-run \`pnpm check-api-surface\`.\n\n`,
      );
    }
    process.exit(1);
  }

  if (failures.length === 0) {
    process.stderr.write(
      `\nAPI surface check passed — ${TRACKED.length} packages match their baselines.\n`,
    );
    return;
  }

  process.stderr.write(
    `\nerror: API surface diverged for ${failures.length} package(s) without a corresponding \`major\` changeset:\n\n`,
  );
  for (const { pkg, output } of failures) {
    process.stderr.write(`─── ${pkg.name} ───\n`);
    // api-extractor's own output includes the diff location and guidance.
    process.stderr.write(output);
    process.stderr.write("\n");
  }
  process.stderr.write(
    "Resolution paths:\n" +
      "  1. If the change is intentional and breaking → add a changeset marking the package `major`\n" +
      "     with a \\`## Migration\\` section, then run \\`pnpm --filter <pkg> run api:extract\\`\n" +
      "     and commit the updated baseline.\n" +
      "  2. If the change was accidental → revert the API change.\n",
  );
  process.exit(1);
}

main();
