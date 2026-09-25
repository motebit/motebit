/**
 * differential-vs-main — run ONE probe against the working tree and against a
 * base ref (default `origin/main`), and diff what each observed.
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/differential/identity-keys.probe.ts \
 *     [--pkg services/relay] [--base origin/main] [--out report.json]
 *
 * Why this exists: a behaviour-preserving change (a refactor, a new authority
 * model, a migration) is proven by showing where it DIFFERS from main and that
 * every difference is intended — not by its own tests, which were written by
 * the same hand as the change. #703's build 3 was built and reviewed on exactly
 * this evidence (docs/proposals/identity-key-state-v1.md §5g–§5i), run by hand
 * from a scratch copy; this makes it one command any reviewer can repeat.
 *
 * The probe contract: a vitest file (named `*.probe.ts`, so the normal suite
 * never collects it) that talks to the package only through surfaces that
 * exist on BOTH trees, and in `afterAll` writes a JSON object of named
 * observations to `process.env.PROBE_OUT`. Replace concrete keys and ids with
 * role names before recording, or every observation differs trivially.
 *
 * What it does: `git archive <base> <pkg>` into a temp dir, links the root
 * `node_modules` + the package's (so workspace packages resolve to THIS
 * checkout's builds — the base tree differs only in the package under test),
 * copies the root tsconfig / vitest config the package extends, drops the
 * probe into both trees as `src/__tests__/zz-differential.test.ts`, runs it in
 * each, always removes it from the working tree, and prints per-observation
 * SAME / DIFF. Exit 0 when both runs produced observations; exit 1 when either
 * did not — "unknown" is not a result. A DIFF is information, not failure: the
 * reviewer decides whether each is intended.
 *
 * Aperture: only the package under test comes from the base ref. A change that
 * also moved a workspace package is compared against the CURRENT build of that
 * package on both sides — say so in the review.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v != null) return v;
  if (fallback != null) return fallback;
  console.error(`differential-vs-main: --${name} is required.`);
  console.error(
    "Fix: pass --probe <path to a *.probe.ts that writes JSON observations to process.env.PROBE_OUT>; see the header of scripts/differential-vs-main.ts.",
  );
  process.exit(1);
}

const root = resolve(
  execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim(),
);
const probe = resolve(root, arg("probe"));
const pkg = arg("pkg", "services/relay");
const base = arg("base", "origin/main");
const out = arg("out", join(tmpdir(), `differential-${Date.now()}.json`));

if (!existsSync(probe)) {
  console.error(`differential-vs-main: probe not found: ${probe}`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "motebit-differential-"));
const PROBE_NAME = "src/__tests__/zz-differential.test.ts";

function runProbe(pkgDir: string, label: string): Record<string, unknown> | null {
  const target = join(pkgDir, PROBE_NAME);
  const obsFile = join(work, `obs-${label}.json`);
  copyFileSync(probe, target);
  try {
    execFileSync("npx", ["vitest", "run", PROBE_NAME], {
      cwd: pkgDir,
      env: { ...process.env, PROBE_OUT: obsFile },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    console.error(`▸ probe run FAILED on ${label}:`);
    console.error(
      String(e.stdout ?? "")
        .split("\n")
        .slice(-25)
        .join("\n"),
    );
    console.error(
      String(e.stderr ?? "")
        .split("\n")
        .slice(-10)
        .join("\n"),
    );
  } finally {
    rmSync(target, { force: true });
  }
  return existsSync(obsFile)
    ? (JSON.parse(readFileSync(obsFile, "utf-8")) as Record<string, unknown>)
    : null;
}

try {
  // The base tree: only the package under test, from the base ref.
  // --output, not a captured buffer: a package archive outgrows execFileSync's 1 MB default.
  execFileSync("git", ["archive", `--output=${join(work, "base.tar")}`, base, pkg], { cwd: root });
  execFileSync("tar", ["-xf", join(work, "base.tar"), "-C", work]);
  symlinkSync(join(root, "node_modules"), join(work, "node_modules"));
  if (existsSync(join(root, pkg, "node_modules"))) {
    symlinkSync(join(root, pkg, "node_modules"), join(work, pkg, "node_modules"));
  }
  for (const f of readdirSync(root)) {
    if (/^tsconfig.*\.json$/.test(f) || /^vitest\.shared\./.test(f))
      copyFileSync(join(root, f), join(work, f));
  }

  const baseSha = execFileSync("git", ["rev-parse", "--short", base], {
    cwd: root,
    encoding: "utf-8",
  }).trim();
  const headSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf-8",
  }).trim();
  console.log(
    `▸ differential-vs-main — probe ${basename(probe)} on ${pkg}: working tree (${headSha}+) vs ${base} (${baseSha})`,
  );

  const head = runProbe(join(root, pkg), "head");
  const baseObs = runProbe(join(work, pkg), "base");
  if (head == null || baseObs == null) {
    console.error(
      `differential-vs-main: ${head == null ? "the working tree" : base} produced no observations — no comparison is possible.`,
    );
    console.error(
      "Fix: the probe must write a JSON object to process.env.PROBE_OUT in afterAll, and must use only surfaces that exist on both trees (the run output above names the failure).",
    );
    process.exit(1);
  }

  const keys = [...new Set([...Object.keys(baseObs), ...Object.keys(head)])].sort();
  let diffs = 0;
  for (const k of keys) {
    const same = JSON.stringify(baseObs[k]) === JSON.stringify(head[k]);
    if (!same) diffs++;
    console.log(`\n== ${k} [${same ? "SAME" : "DIFF"}]`);
    console.log(`  ${base}: ${JSON.stringify(baseObs[k])}`);
    console.log(`  head: ${JSON.stringify(head[k])}`);
  }
  writeFileSync(
    out,
    JSON.stringify({ base, baseSha, headSha, pkg, probe, head, baseObs }, null, 2),
  );
  console.log(
    `\n✓ differential-vs-main: ${keys.length} observation(s), ${diffs} DIFF. Every DIFF must be an intended, stated change — the reviewer decides. Report: ${out}`,
  );
  console.log(
    `  Aperture: only ${pkg} is taken from ${base}; every other workspace package is this checkout's build on both sides.`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
