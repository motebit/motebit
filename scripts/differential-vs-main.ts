/**
 * differential-vs-main — run ONE probe against the working tree and against a
 * base ref (default `origin/main`), and diff what each observed.
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/differential/identity-keys.probe.ts \
 *     [--pkg services/relay]            # the package the probe runs in; default:
 *                                       #   the workspace package the probe file lives in
 *     [--from-main diff | host | <dir>,<dir>,…]
 *                                       # which workspace packages come from the base ref;
 *                                       #   default `diff` (see Aperture)
 *     [--base origin/main] [--out report.json]
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
 * observations to `process.env.PROBE_OUT`. Replace concrete keys, ids and
 * paths with role names before recording, or every observation differs
 * trivially. `process.env.DIFFERENTIAL_SIDE` is `head` or `base`.
 *
 * What it does: builds a base tree in a temp dir (scripts/lib/differential-tree.ts
 * has the mechanics and the #818 history), drops the probe into the host
 * package on both trees as `src/__tests__/zz-differential.test.ts`, runs the
 * host's `pretest` script if it has one (generated inputs, e.g. apps/mobile's
 * creature bundle), runs the probe with the host's own vitest config in each,
 * always removes it from the working tree, and prints per-observation SAME /
 * DIFF. Exit 0 when both runs produced observations; exit 1 when either did
 * not — "unknown" is not a result. A DIFF is information, not failure: the
 * reviewer decides whether each is intended.
 *
 * Aperture — exactly what the base side swaps, printed on every run:
 *   - Every path OUTSIDE the workspace packages (root `package.json`,
 *     `tsconfig.base.json`, `vitest.shared.ts`, `spec/`, `config/`, …) is the
 *     base ref's.
 *   - The workspace packages in `--from-main` are the base ref's sources. Any
 *     of them the host can import is REBUILT from base sources in the temp
 *     tree (`tsc -b` runs as `tsc -p tsconfig.json`, so a stale reference is
 *     never rebuilt into the working tree). `diff` (default) = every package
 *     whose files differ between the base ref and the working tree, including
 *     uncommitted and untracked files; `host` = only the probe's package.
 *     The host package is always from the base ref.
 *   - Every other workspace package is this checkout's, as BUILT (its `dist`):
 *     build the host's dependencies first (`pnpm --filter <host>... build`)
 *     or both sides read stale output.
 *   - Third-party dependencies are the working tree's install on both sides
 *     (one lockfile). A change that moved a third-party version is not
 *     differentialled by this script.
 *
 * Smoke test (opt-in; ~25 s once the working tree is built):
 *   MOTEBIT_DIFFERENTIAL_SMOKE=1 npx vitest run --dir scripts/__tests__ differential-vs-main
 * It probes services/relay, packages/surface-kit with packages/sdk also from
 * main, and apps/web, and asserts observations on both sides and where each
 * side's imports resolve. `pnpm test:gates` runs only its unit half.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
  buildBaseTree,
  packageDirOf,
  packagesTouchedSince,
  readPackage,
  runPretest,
  workspaceRoots,
} from "./lib/differential-tree.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ?? fallback;
}

function fail(lines: string[]): never {
  for (const l of lines) console.error(l);
  process.exit(1);
}

const root = realpathSync(
  execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim(),
);
const probeArg = arg("probe");
if (probeArg == null) {
  fail([
    "differential-vs-main: --probe is required.",
    "Fix: pass --probe <path to a *.probe.ts that writes JSON observations to process.env.PROBE_OUT>; see the header of scripts/differential-vs-main.ts.",
  ]);
}
const probe = resolve(root, probeArg);
if (!existsSync(probe)) fail([`differential-vs-main: probe not found: ${probe}`]);

const roots = workspaceRoots(root);
const base = arg("base", "origin/main")!;
const host = arg("pkg") ?? packageDirOf(relative(root, realpathSync(probe)), roots) ?? undefined;
if (host == null || !existsSync(join(root, host, "package.json"))) {
  fail([
    `differential-vs-main: cannot tell which workspace package the probe runs in (got ${host ?? "none"}).`,
    "Fix: put the probe inside the package (e.g. services/relay/src/__tests__/…) or pass --pkg <workspace dir>.",
  ]);
}
const fromMainArg = arg("from-main", "diff")!;
const fromMain =
  fromMainArg === "diff"
    ? packagesTouchedSince(root, base, roots)
    : fromMainArg === "host"
      ? [host]
      : fromMainArg
          .split(",")
          .map((s) => s.trim().replace(/\/+$/, ""))
          .filter(Boolean);
for (const d of fromMain) {
  if (packageDirOf(d, roots) !== d) {
    fail([
      `differential-vs-main: --from-main entry "${d}" is not a workspace package directory.`,
      `Fix: name package directories (${roots.map((r) => `${r}/<name>`).join(", ")}); paths outside the workspace packages always come from the base ref.`,
    ]);
  }
}
const out = arg("out", join(tmpdir(), `differential-${Date.now()}.json`))!;

const work = realpathSync(mkdtempSync(join(tmpdir(), "motebit-differential-")));
const tree = join(work, "tree");
const PROBE_NAME = "src/__tests__/zz-differential.test.ts";

function runProbe(treeDir: string, label: "head" | "base"): Record<string, unknown> | null {
  const pkgDir = join(treeDir, host!);
  const target = join(pkgDir, PROBE_NAME);
  const obsFile = join(work, `obs-${label}.json`);
  try {
    runPretest(treeDir, readPackage(treeDir, host!));
  } catch (err) {
    console.error(
      `▸ pretest FAILED on ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  copyFileSync(probe, target);
  try {
    execFileSync("npx", ["vitest", "run", PROBE_NAME], {
      cwd: pkgDir,
      env: { ...process.env, PROBE_OUT: obsFile, DIFFERENTIAL_SIDE: label },
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

let exitCode = 0;
try {
  const baseSha = execFileSync("git", ["rev-parse", "--short", base], {
    cwd: root,
    encoding: "utf-8",
  }).trim();
  const headSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf-8",
  }).trim();
  console.log(
    `▸ differential-vs-main — probe ${basename(probe)} in ${host}: working tree (${headSha}+) vs ${base} (${baseSha})`,
  );

  const started = Date.now();
  const aperture = buildBaseTree({
    root,
    base,
    treeDir: tree,
    host: host!,
    fromMain,
    log: (l) => console.log(l),
  });
  console.log(`  base tree assembled in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const head = runProbe(root, "head");
  const baseObs = runProbe(tree, "base");

  const apertureLines = [
    `  Aperture (base side): from ${base}: ${aperture.fromMain.join(", ") || "(none)"}` +
      ` + every path outside the workspace packages.`,
    aperture.rebuilt.length > 0
      ? `  Rebuilt from ${base} sources: ${aperture.rebuilt.join(", ")}.`
      : `  Rebuilt from ${base} sources: none (nothing the host imports is from ${base}).`,
    aperture.materialized.length > 0
      ? `  Working-tree builds rewired to import the ${base} versions: ${aperture.materialized.join(", ")}.`
      : "",
    aperture.absentOnBase.length > 0
      ? `  Requested but absent on ${base} (new on this branch): ${aperture.absentOnBase.join(", ")}.`
      : "",
    `  Every other workspace package (${aperture.linkedFromHead}) and every third-party dependency is this checkout's build on both sides.`,
  ].filter(Boolean);

  if (head == null || baseObs == null) {
    for (const l of apertureLines) console.error(l);
    console.error(
      `differential-vs-main: ${head == null ? "the working tree" : base} produced no observations — no comparison is possible.`,
    );
    console.error(
      "Fix: the probe must write a JSON object to process.env.PROBE_OUT in afterAll, and must use only surfaces that exist on both trees (the run output above names the failure).",
    );
    exitCode = 1;
  } else {
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
      JSON.stringify(
        { base, baseSha, headSha, pkg: host, probe, aperture, baseTree: tree, head, baseObs },
        null,
        2,
      ),
    );
    console.log(
      `\n✓ differential-vs-main: ${keys.length} observation(s), ${diffs} DIFF. Every DIFF must be an intended, stated change — the reviewer decides. Report: ${out}`,
    );
    for (const l of apertureLines) console.log(l);
  }
} catch (err) {
  console.error(
    `differential-vs-main: could not assemble the base tree: ${err instanceof Error ? err.message : String(err)}`,
  );
  exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
