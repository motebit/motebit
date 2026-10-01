/**
 * Report what vitest would load as test code for the package at
 * `process.cwd()`, resolved by vitest's own config loading and globbing
 * (never a hand-written walker). Used by scripts/check-tests-typechecked.ts;
 * run with the package dir as cwd. The gate runs `staticCollect` IN-PROCESS,
 * inside each vitest process its recorder observes (the cross-check against
 * the recording); the standalone entry is for diagnosis.
 *
 * Input (env): `MOTEBIT_VITEST_ARGV` — JSON array of the arguments a package
 * script passes after `vitest` (`["run", "-c", "vitest.unit.config.ts"]`),
 * parsed by vitest's own `parseCLI`, so `-c`/`--config`/`--dir`/`--root` and
 * every other flag resolve exactly as that script's vitest resolves them;
 * `MOTEBIT_VITEST_COLLECT_OUT` — where to write the JSON result (never
 * stdout: a reporter may print).
 *
 * Output: `{ files, fileValued }` — `files` = the test files vitest collects;
 * `fileValued` = every `{ key, file }` in the RESOLVED config (the root config
 * and every project's) whose value is a path to an existing JS/TS file inside
 * `MOTEBIT_REPO_ROOT` and outside node_modules, with `key` the dotted path
 * (array indices dropped). The gate — not this file — decides which keys are
 * test code (setupFiles, globalSetup, …) and fails on a key it does not know.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** vitest as the package resolves it; else (a package without the dep) the repo's. */
function resolveVitest() {
  try {
    return createRequire(`${process.cwd()}/package.json`).resolve("vitest/node");
  } catch (err) {
    const fallback = process.env.MOTEBIT_VITEST_RESOLVE_FALLBACK;
    if (!fallback) throw err;
    return createRequire(`${fallback}/package.json`).resolve("vitest/node");
  }
}

/**
 * Every string in `value` (plain objects and arrays, depth-bounded, cycle-safe)
 * that names an existing code file under `repoRoot`, outside node_modules, as
 * `{ key, file }`; `key` is the dotted path with array indices dropped.
 */
export function fileValuedEntries(value, base, repoRoot) {
  const out = [];
  const seen = new Set();
  const walk = (v, keys, depth) => {
    if (typeof v === "string") {
      if (!CODE_FILE.test(v)) return;
      const abs = resolve(isAbsolute(v) ? v : resolve(base, v));
      if (!abs.startsWith(repoRoot + sep) || abs.split(sep).includes("node_modules")) return;
      if (existsSync(abs) && statSync(abs).isFile()) out.push({ key: keys.join("."), file: abs });
      return;
    }
    if (v === null || typeof v !== "object" || depth > 10 || seen.has(v)) return;
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return;
    seen.add(v);
    if (Array.isArray(v)) for (const x of v) walk(x, keys, depth + 1);
    else for (const [k, x] of Object.entries(v)) walk(x, [...keys, k], depth + 1);
  };
  walk(value, [], 0);
  return out;
}

/**
 * The static prediction for a live Vitest instance: the test files its globs
 * match and every file-valued entry of its resolved configs. Called in-process
 * by scripts/lib/vitest-record-plugin.mjs (the gate's cross-check against what
 * the recorder saw load) and by the standalone entry below.
 */
export async function staticCollect(vitest, repoRoot) {
  const specs = await vitest.globTestSpecifications();
  const files = [...new Set(specs.map((s) => s.moduleId))].sort();
  const fileValued = [];
  for (const config of [vitest.config, ...vitest.projects.map((p) => p.config)]) {
    fileValued.push(...fileValuedEntries(config, config.root ?? process.cwd(), repoRoot));
  }
  const uniq = [...new Map(fileValued.map((e) => [`${e.key}\0${e.file}`, e])).values()];
  return { files, fileValued: uniq };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const node = await import(pathToFileURL(resolveVitest()).href);
  const args = JSON.parse(process.env.MOTEBIT_VITEST_ARGV || "[]");
  const { options } = node.parseCLI(["vitest", ...args]);
  const vitest = await node.createVitest(
    "test",
    { ...options, watch: false, run: true, passWithNoTests: true },
    { logLevel: "silent" },
  );
  try {
    const repoRoot = resolve(process.env.MOTEBIT_REPO_ROOT || process.cwd());
    writeFileSync(
      process.env.MOTEBIT_VITEST_COLLECT_OUT,
      JSON.stringify(await staticCollect(vitest, repoRoot)),
    );
  } finally {
    await vitest.close();
  }
}
