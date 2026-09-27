/**
 * differential-vs-main — run ONE probe against the working tree and against a
 * base ref (default `origin/main`), and diff what each observed.
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/identity-keys.probe.ts \
 *     [--pkg services/relay]            # the package the probe runs in; default: the
 *                                       #   workspace package the probe file lives in, or
 *                                       #   services/relay for a probe outside the workspace
 *     [--from-main diff | host | <dir>,<dir>,…]
 *                                       # which workspace packages come from the base ref;
 *                                       #   default `diff` (see Aperture)
 *     [--base origin/main] [--base-repo <path>] [--root-from-head] [--out report.json]
 *
 *   --base-repo    read the base ref from another repository (default: this one).
 *   --root-from-head
 *                  when paths outside the workspace packages differ from the base
 *                  ref, hold the working tree's copy of each on BOTH sides and list
 *                  them as NOT differentialled, instead of refusing.
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
 * What it does: refuses (exit 1, naming the cause and the repair) when it
 * cannot state its aperture truthfully — when a working-tree build the probe
 * can reach is stale against any of its build inputs or its dependencies'
 * emitted output, or when a path outside the workspace packages differs from
 * the base ref; otherwise builds a base tree in a temp dir
 * (scripts/lib/differential-tree.ts has the mechanics and the #818/#833/#835
 * history); drops the probe into the host package on both trees
 * as `src/__tests__/zz-differential.test.ts`; runs the host's `pretest` script
 * if it has one (generated inputs, e.g. apps/mobile's creature bundle, which
 * inlines render-engine's browser bundle); runs the probe with the host's own
 * vitest config in each; always removes it from the working tree; and prints
 * per-observation SAME / DIFF. Exit 0 when both runs produced observations;
 * exit 1 when either did not or the run was refused — "unknown" is not a
 * result. A DIFF is information, not failure: the reviewer decides whether
 * each is intended.
 *
 * Aperture — exactly what the base side swaps, printed on every run:
 *   - Paths OUTSIDE the workspace packages (root `package.json`,
 *     `tsconfig.base.json`, `pnpm-lock.yaml`, `vitest.shared.ts`, `spec/`, …)
 *     are identical on both sides: the run refuses if any differs from the
 *     base ref, unless `--root-from-head` holds the working tree's copy on both
 *     sides — then every such path is listed as NOT differentialled.
 *   - The workspace packages in `--from-main` are the base ref's source. `diff`
 *     (default) = every package with any file whose content differs between
 *     the base ref and the working tree (uncommitted and untracked-not-ignored
 *     files included); `host` = only the probe's package. The host package is
 *     always from the base ref.
 *   - Every working-tree package that can REACH a from-main package — through
 *     its declared workspace deps, or through the root package.json's
 *     workspace deps, which node resolves from any package — is copied into
 *     the base tree as SOURCE and rebuilt there, so whatever its build bundles
 *     or inlines is the base tree's version. A working-tree `dist` is never
 *     copied into the base tree.
 *   - Every from-main or copied package the probe can reach is built inside
 *     the base tree, dependencies first (`tsc -b` runs as `tsc -p
 *     tsconfig.json`, so a stale reference is never rebuilt into the working
 *     tree; tsup, esbuild and `build:browser` steps run as written).
 *   - Every other working-tree package cannot reach a from-main package: it is
 *     linked, and read from its working-tree build on both sides — which is why
 *     a stale build refuses the run.
 *   - Packages only on the base ref that were not requested stay the base
 *     ref's source, unbuilt; the aperture lists them.
 *   - Third-party dependencies are the working tree's install on both sides
 *     (one lockfile). A change that moved a third-party version is not
 *     differentialled by this script, and a third-party package that imports
 *     an `@motebit/*` package would resolve it to the working tree.
 *
 * Safety: every child process (git, builds, vitest) runs with EVERY `GIT_*`
 * variable removed and an explicit `cwd`, and only read-only git subcommands
 * (rev-parse, archive, ls-files) are allowed — a git hook's GIT_DIR can never
 * point this script at a repository it did not mean (#835).
 *
 * Tests: `pnpm test:gates` runs the unit half and a behavioural fixture (a
 * mini-workspace in a temp dir, whose git runs are scrubbed and guarded; see
 * the test file for the cases and timing). The real-repo smoke is opt-in:
 *   MOTEBIT_DIFFERENTIAL_SMOKE=1 npx vitest run --dir scripts/__tests__ differential-vs-main
 * (a planted protocol change observed through mobile's creature bundle and
 * through semiring from surface-kit).
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
  cleanEnv,
  dependencyClosure,
  DifferentialRefusal,
  headFiles,
  packageDirOf,
  readGit,
  readPackage,
  repairCommand,
  rootWorkspaceDeps,
  runPretest,
  staleBuilds,
  workspaceGraph,
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

const root = realpathSync(readGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim());
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
const baseRepo = arg("base-repo") != null ? realpathSync(resolve(arg("base-repo")!)) : root;
const rootFromHead = process.argv.includes("--root-from-head");
/** The package a probe outside the workspace runs in (the script's first and commonest subject). */
const DEFAULT_HOST = "services/relay";
const probeHome = packageDirOf(relative(root, realpathSync(probe)), roots);
const host = arg("pkg") ?? probeHome ?? DEFAULT_HOST;
const hostWhy =
  arg("pkg") != null
    ? "--pkg"
    : probeHome != null
      ? "the probe's package"
      : "default: the probe is outside every workspace package";
if (!existsSync(join(root, host, "package.json"))) {
  fail([
    `differential-vs-main: ${host} (${hostWhy}) is not a workspace package in this checkout.`,
    "Fix: put the probe inside the package (e.g. services/relay/src/__tests__/…) or pass --pkg <workspace dir>.",
  ]);
}
const fromMainArg = arg("from-main", "diff")!;
const fromMain: string[] | "diff" =
  fromMainArg === "diff"
    ? "diff"
    : fromMainArg === "host"
      ? [host]
      : fromMainArg
          .split(",")
          .map((s) => s.trim().replace(/\/+$/, ""))
          .filter(Boolean);
for (const d of fromMain === "diff" ? [] : fromMain) {
  if (packageDirOf(d, roots) !== d) {
    fail([
      `differential-vs-main: --from-main entry "${d}" is not a workspace package directory.`,
      `Fix: name package directories (${roots.map((r) => `${r}/<name>`).join(", ")}); paths outside the workspace packages are never swapped (see --root-from-head).`,
    ]);
  }
}
const out = arg("out", join(tmpdir(), `differential-${Date.now()}.json`))!;

const work = realpathSync(mkdtempSync(join(tmpdir(), "motebit-differential-")));
const tree = join(work, "tree");
const PROBE_NAME = "src/__tests__/zz-differential.test.ts";

async function runProbe(
  treeDir: string,
  label: "head" | "base",
): Promise<Record<string, unknown> | null> {
  const pkgDir = join(treeDir, host);
  const target = join(pkgDir, PROBE_NAME);
  const obsFile = join(work, `obs-${label}.json`);
  try {
    await runPretest(treeDir, readPackage(treeDir, host));
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
      env: cleanEnv(process.env, { PROBE_OUT: obsFile, DIFFERENTIAL_SIDE: label }),
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
async function main(): Promise<void> {
  const baseSha = readGit(baseRepo, ["rev-parse", "--short", base]).trim();
  const headSha = readGit(root, ["rev-parse", "--short", "HEAD"]).trim();
  console.log(
    `▸ differential-vs-main — probe ${basename(probe)} in ${host} (${hostWhy}): working tree (${headSha}+) vs ${base} (${baseSha})`,
  );

  // The head side reads the working tree's builds of everything the probe can
  // reach; a stale one would hide a real change.
  const headGraph = workspaceGraph(root, roots);
  const headReach = [...dependencyClosure(host, headGraph, rootWorkspaceDeps(root))].filter(
    (d) => d !== host,
  );
  const stale = staleBuilds(root, headReach, headGraph, headFiles(root));
  if (stale.length > 0) {
    throw new DifferentialRefusal([
      `differential-vs-main: refused — working-tree builds the probe reads are stale (built before a change to one of their build inputs, or before a dependency last emitted output): ${stale.join(", ")}.`,
      "A stale build is read on the head side (and on the base side wherever it is linked), so a real change would report SAME.",
      `Fix: ${repairCommand(stale, headReach, headGraph)}`,
    ]);
  }

  const started = Date.now();
  const aperture = await buildBaseTree({
    root,
    baseRepo,
    base,
    treeDir: tree,
    host,
    fromMain,
    rootFromHead,
    log: (l) => console.log(l),
  });
  console.log(`  base tree assembled in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const head = await runProbe(root, "head");
  const baseObs = await runProbe(tree, "base");

  const list = (xs: string[]) => (xs.length > 0 ? xs.join(", ") : "none");
  const apertureLines = [
    `  Aperture (base side), probe in ${host} (${hostWhy}):`,
    `    from ${base}: ${list(aperture.fromMain)}.`,
    aperture.rootHeldAtHead.length > 0
      ? `    NOT differentialled (--root-from-head: the working tree's copy on BOTH sides): ${list(aperture.rootHeldAtHead)}.`
      : `    paths outside the workspace packages: identical to ${base} (checked by content).`,
    `    built inside the base tree from ${base} source: ${list(aperture.rebuiltFromMain)}.`,
    `    built inside the base tree from working-tree SOURCE (they reach a package taken from ${base}; bundles included): ${list(aperture.rebuiltFromHead)}.`,
    aperture.copiedUnbuilt.length > 0
      ? `    working-tree source copied but unbuilt (they reach a package taken from ${base}; the probe cannot reach them, so loading one fails loudly): ${list(aperture.copiedUnbuilt)}.`
      : "",
    aperture.absentOnBase.length > 0
      ? `    requested but absent on ${base} (new on this branch): ${list(aperture.absentOnBase)}.`
      : "",
    aperture.baseOnly.length > 0
      ? `    on ${base} only, not requested (its source, unbuilt): ${list(aperture.baseOnly)}.`
      : "",
    `    linked from the working tree, read from its build on both sides (they cannot reach a package taken from ${base}): ${aperture.linkedFromHead} package(s).`,
    `    root package.json workspace deps, treated as reachable from every package: ${list(aperture.rootWorkspaceDeps)}.`,
    "    Third-party dependencies: the working tree's install on both sides.",
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
        {
          base,
          baseRepo,
          baseSha,
          headSha,
          pkg: host,
          pkgReason: hostWhy,
          probe,
          aperture,
          // Deleted when the run ends; kept so paths recorded in observations can be read.
          baseTree: tree,
          baseTreeDeleted: true,
          head,
          baseObs,
        },
        null,
        2,
      ),
    );
    console.log(
      `\n✓ differential-vs-main: ${keys.length} observation(s), ${diffs} DIFF. Every DIFF must be an intended, stated change — the reviewer decides. Report: ${out}`,
    );
    for (const l of apertureLines) console.log(l);
  }
}

main()
  .catch((err: unknown) => {
    exitCode = 1;
    if (err instanceof DifferentialRefusal) {
      for (const l of err.lines) console.error(l);
      return;
    }
    console.error(
      `differential-vs-main: could not assemble the base tree: ${err instanceof Error ? err.message : String(err)}`,
    );
    exitCode = 1;
  })
  .finally(() => {
    rmSync(work, { recursive: true, force: true });
    process.exit(exitCode);
  });
