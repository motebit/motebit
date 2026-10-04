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
 *     [--base origin/main] [--base-repo <path>] [--root-from-head]
 *     [--head-from-working-tree] [--out report.json]
 *
 *   --base-repo    read the base ref from another repository (default: this one).
 *   --root-from-head
 *                  when INSTALL-LEVEL root files differ from the base ref, hold the
 *                  working tree's copy of each on BOTH sides and list them as NOT
 *                  differentialled, instead of refusing.
 *   --head-from-working-tree
 *                  fast path: run the head side in the working tree on its OWN
 *                  builds instead of a fresh-from-source head tree. Those builds are
 *                  NOT freshness-checked — the aperture says so. Default off.
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
 * What it does (scripts/lib/differential-tree.ts has the mechanics and the
 * #818/#833/#835/#837 history): builds TWO trees in a temp dir, each FRESH
 * FROM SOURCE — a head tree (the working tree's tracked + untracked-not-ignored
 * files) and a base tree (the base ref, with every package not taken from it
 * replaced by the working tree's source) — and builds every package the probe
 * can reach in each, dependencies first, with the same build logic. The
 * working tree's own `dist` is read by neither side. It then drops the probe
 * into the probe's package in each tree as
 * `src/__tests__/zz-differential.test.ts`, runs that package's `pretest` if it
 * has one (e.g. apps/mobile's creature bundle, generated from render-engine's
 * browser bundle), runs the probe with the package's own vitest config, and
 * prints per-observation SAME / DIFF. Each tree runs its tools through its OWN
 * `node_modules/.bin` shims and NODE_PATH (the tree's `.pnpm/node_modules`),
 * so CommonJS `require` never falls back to the working tree (#840). A
 * default run writes nothing to the working tree; --head-from-working-tree
 * writes the probe file there (always removed), the package's `pretest`
 * output and vitest's `node_modules/.vite` cache. Exit 0 when both runs produced observations; exit 1
 * when either did not, or when the run was REFUSED — "unknown" is not a
 * result. A DIFF is information, not failure: the reviewer decides.
 *
 * Refusals (exit 1, naming the cause and the fix):
 *   - the probe's package is new on this branch: nothing on the base to compare;
 *   - an INSTALL-LEVEL root file differs from the base ref: a dependency field
 *     of the root package.json (dependencies, devDependencies,
 *     optionalDependencies, peerDependencies, pnpm.overrides, resolutions —
 *     compared structurally), pnpm-lock.yaml, pnpm-workspace.yaml, patches/**,
 *     .npmrc or .pnpmfile.cjs. node_modules is mirrored from the working
 *     tree's single install into both trees, so such a change cannot be
 *     assigned to one side. Every other root path (tsconfig.base.json,
 *     vitest.shared.ts, scripts/**, docs, .changeset, a scripts-only
 *     package.json change, …) never refuses: each tree builds from its own copy.
 *
 * Aperture — printed on every run:
 *   - the packages taken from the base ref: `diff` (default) = every package
 *     with any file whose content differs; `host` = only the probe's package.
 *     The probe's package is always from the base ref.
 *   - what was built in each tree (the probe's reach, including the root
 *     package.json's workspace deps, which node resolves from any package);
 *   - root files: each side reads its own copy (the differing ones are
 *     listed); install-level files are shared and identical, or held at the
 *     working tree's copy (--root-from-head);
 *   - third-party dependencies: the working tree's install on both sides (one
 *     lockfile), so a third-party version change is not differentialled.
 *
 * Safety: every child process (git, builds, vitest) runs with EVERY `GIT_*`
 * variable removed and an explicit `cwd`, and only read-only git subcommands
 * (rev-parse, archive, ls-files) are allowed — a git hook's GIT_DIR can never
 * point this script at a repository it did not mean (#835).
 *
 * Tests: `pnpm test:gates` runs the units, the decoy-repository safety test
 * (which also asserts the bundle + root-hoisted DIFF); `pnpm test:differential`
 * runs every fixture case. The real-repo smoke is opt-in:
 *   MOTEBIT_DIFFERENTIAL_SMOKE=1 npx vitest run --dir scripts/__tests__ differential-vs-main
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
  buildTrees,
  binPath,
  DifferentialRefusal,
  packageDirOf,
  readGit,
  readPackage,
  runPretest,
  cleanEnv,
  treeEnv,
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
const headFromWorkingTree = process.argv.includes("--head-from-working-tree");
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
    // The tree's OWN vitest shim (its NODE_PATH re-homed into the tree), with
    // NODE_PATH set to the tree's own .pnpm/node_modules — never the working tree's.
    const shim = [
      join(pkgDir, "node_modules", ".bin", "vitest"),
      join(treeDir, "node_modules", ".bin", "vitest"),
    ].find((f) => existsSync(f));
    if (shim == null) throw new Error(`no vitest in ${host}'s or the root node_modules/.bin`);
    execFileSync(shim, ["run", PROBE_NAME], {
      cwd: pkgDir,
      // treeEnv is already scrubbed; the outer cleanEnv states it at the spawn
      // (check-fixture-git-env reads one file at a time).
      env: cleanEnv(
        treeEnv(treeDir, binPath(treeDir, host), {
          PROBE_OUT: obsFile,
          DIFFERENTIAL_SIDE: label,
        }),
      ),
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

  const started = Date.now();
  const { baseTree, headTree, aperture } = await buildTrees({
    root,
    baseRepo,
    base,
    workDir: work,
    host,
    fromMain,
    rootFromHead,
    headFromWorkingTree,
    log: (l) => console.log(l),
  });
  console.log(`  trees built from source in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const head = await runProbe(headTree, "head");
  const baseObs = await runProbe(baseTree, "base");

  const list = (xs: string[]) => (xs.length > 0 ? xs.join(", ") : "none");
  const apertureLines = [
    `  Aperture, probe in ${host} (${hostWhy}):`,
    `    from ${base}: ${list(aperture.fromMain)}; every other workspace package is the working tree's SOURCE on both sides.`,
    `    built from source in the base tree: ${list(aperture.builtBase)}.`,
    aperture.fromMainUnbuilt.length > 0
      ? `    from ${base}, NOT built (outside the probe's declared reach — a require of it will fail on both sides): ${list(aperture.fromMainUnbuilt)}.`
      : "",
    aperture.headFromWorkingTree
      ? "    head side: the WORKING TREE's own builds (--head-from-working-tree) — NOT freshness-checked."
      : `    built from source in the head tree: ${list(aperture.builtHead)}.`,
    aperture.absentOnBase.length > 0
      ? `    requested but absent on ${base} (new on this branch): ${list(aperture.absentOnBase)}.`
      : "",
    aperture.baseOnly.length > 0
      ? `    on ${base} only, not requested (its source, unbuilt): ${list(aperture.baseOnly)}.`
      : "",
    `    root files: each side reads its own copy (${aperture.rootPerSide.length} differ${aperture.rootPerSide.length > 0 ? `: ${aperture.rootPerSide.slice(0, 10).join(", ")}${aperture.rootPerSide.length > 10 ? ", …" : ""}` : ""}); install-level files are shared and ${aperture.rootHeldAtHead.length > 0 ? `HELD at the working tree's copy on both sides (--root-from-head), so NOT differentialled: ${list(aperture.rootHeldAtHead)}` : "identical"}.`,
    `    root package.json workspace deps, treated as reachable from every package: ${list(aperture.rootWorkspaceDeps)}.`,
    "    Third-party dependencies: the working tree's install on both sides.",
  ].filter(Boolean);

  if (head == null || baseObs == null) {
    for (const l of apertureLines) console.error(l);
    console.error(
      `differential-vs-main: ${head == null ? "the head side" : base} produced no observations — no comparison is possible.`,
    );
    console.error(
      "Fix: the probe must write a JSON object to process.env.PROBE_OUT in afterAll, and must use only surfaces that exist on both trees (the run output above names the failure).",
    );
    exitCode = 1;
    return;
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
        baseTree,
        headTree,
        treesDeleted: true,
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

main()
  .catch((err: unknown) => {
    exitCode = 1;
    if (err instanceof DifferentialRefusal) {
      for (const l of err.lines) console.error(l);
      return;
    }
    console.error(
      `differential-vs-main: could not build the trees: ${err instanceof Error ? err.message : String(err)}`,
    );
  })
  .finally(() => {
    rmSync(work, { recursive: true, force: true });
    process.exit(exitCode);
  });
