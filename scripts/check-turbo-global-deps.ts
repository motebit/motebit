#!/usr/bin/env tsx
/**
 * Drift defense: every repo-root file a package's turbo task reads is a turbo
 * input.
 *
 * Turbo hashes a task from the files INSIDE its package (plus the lockfile's
 * view of its deps and the root package.json). A file at the repo root that a
 * package reads through a `../` path — `tsconfig.base.json` every tsconfig
 * extends, the root `.eslintrc.js` every package's eslint cascades to,
 * `vitest.shared.ts` every vitest config imports — is invisible to that hash
 * unless `turbo.json` names it in `globalDependencies`. Then an edit to it
 * replays the cached `typecheck`/`lint`/`build` verdict from BEFORE the edit:
 * measured 2026-10-01, appending to `tsconfig.base.json` left every
 * `@motebit/protocol` task hash unchanged. The pre-push hook leans on those
 * caches (typecheck+lint over changed + dependents, "untouched dependents are
 * cache hits"), so a stale hit there is a green push of a broken tree.
 *
 * The set is DISCOVERED, never listed by hand:
 *   1. every git-tracked file at the top level of every workspace package
 *      (`package.json` scripts, `tsconfig*.json`, `*.config.*`,
 *      `api-extractor.json`, eslintrc …) is scanned for `../` path literals;
 *      one that resolves outside every workspace package to a FILE is a root
 *      input (`.js` specifiers also resolve to the `.ts` source, as TS does);
 *   2. the ESLint cascade: a package whose `lint` script runs eslint reads
 *      every `.eslintrc.*` from its dir up to the first `root: true`;
 *   3. transitively: a root input's own relative imports and `extends`, the
 *      repo-root files its string literals name, and — for a root script that
 *      reads files at runtime — the files it reads, from SCRIPT_DATA_READS
 *      (a root script with an fs read and no entry there is a violation: an
 *      unmodelled read is an unknown input, so it fails closed). A read of a
 *      directory LISTING (the llms generator counts spec/*.md) is modelled as
 *      the turbo glob the script exports — the one place a glob is allowed.
 *
 * `turbo.json` `globalDependencies` must equal that set exactly: a missing
 * entry is a stale-cache hole, an extra one invalidates every cache for a
 * file no task reads. That the listed entries really move task hashes is
 * proven by execution in scripts/__tests__/check-turbo-global-deps.test.ts
 * (each entry perturbed, `turbo --dry=json` hashes must change).
 *
 * Aperture: config files only. A package's SOURCE reading a root file at
 * test time is not discovered — harmless today because `test` and
 * `test:coverage` are `cache: false` in turbo.json (asserted below for the
 * root file; per package, as RESOLVED by `turbo --dry=json`, by
 * check-prepush-subset — a package-level turbo.json can override the root).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { failWithRepair } from "./lib/gate-report.js";
import { parseDoctrineChain, SPEC_COUNT_INPUTS } from "./generate-llms-txt.js";

const ROOT = process.cwd();

/**
 * Root scripts that READ files at runtime, and what they read. The gate asks
 * the script itself where it can (the llms.txt generator's own chain parser
 * and spec-count globs), so the list cannot drift from the code. An entry is a
 * repo-relative file, or a turbo glob (`!` = exclusion) for a directory
 * listing; a glob must appear verbatim in turbo.json globalDependencies.
 */
export const SCRIPT_DATA_READS: Record<string, (root: string) => string[]> = {
  "scripts/generate-llms-txt.ts": () => [
    "DOCTRINE.md",
    ...parseDoctrineChain().map((e) => e.filename),
    // The spec count in the llms.txt footer: spec/'s *.md listing.
    ...SPEC_COUNT_INPUTS,
    // apps/docs/content/** is inside @motebit/docs — already hashed by turbo.
  ],
};

export interface Discovery {
  /** root input → the files that made it one (for the failure text). */
  inputs: Map<string, Set<string>>;
  /** turbo glob (a directory-listing read) → the scripts that read it. */
  globs: Map<string, Set<string>>;
  packages: string[];
  configFiles: number;
  violations: string[];
}

export const isGlob = (g: string): boolean => g.startsWith("!") || /[*?[{]/.test(g);

/** Whether a declared glob set (turbo semantics: `!` excludes) selects `file`. */
export function globSelects(globs: readonly string[], file: string): boolean {
  const pos = globs.filter((g) => !g.startsWith("!"));
  const neg = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  return pos.some((g) => matchesGlob(file, g)) && !neg.some((g) => matchesGlob(file, g));
}

/**
 * A string literal that is only an operand of `===` / `!==` is a comparison
 * (`f !== "README.md"` filters a listing), not a path a file is read from.
 */
function isComparisonOperand(src: string, start: number, end: number): boolean {
  return (
    /[!=]==\s*$/.test(src.slice(Math.max(0, start - 8), start)) ||
    /^\s*[!=]==/.test(src.slice(end, end + 8))
  );
}

function gitFiles(root: string, ...paths: string[]): string[] {
  return execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

export function workspacePackages(root: string): string[] {
  const ws = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [...ws.matchAll(/^\s*-\s*["']?([A-Za-z0-9_.-]+)\/\*["']?\s*$/gm)].map((m) => m[1]!);
  const out: string[] = [];
  for (const g of globs) {
    for (const f of gitFiles(root, `${g}/*/package.json`)) {
      if (f.split("/").length === 3) out.push(dirname(f));
    }
  }
  return out.sort();
}

const CONFIG_SHAPED =
  /\/(tsconfig[^/]*\.json|[^/]*\.config\.[cm]?[jt]s|\.eslintrc[^/]*|api-extractor\.json|package\.json)$/;

const FILE_EXT_SWAP: [RegExp, string][] = [
  [/\.js$/, ".ts"],
  [/\.mjs$/, ".mts"],
  [/\.cjs$/, ".cts"],
];

function asFile(root: string, rel: string): string | null {
  const cands = [rel];
  for (const [re, to] of FILE_EXT_SWAP) if (re.test(rel)) cands.push(rel.replace(re, to));
  if (!/\.[A-Za-z]+$/.test(rel)) cands.push(`${rel}.ts`, `${rel}.js`, `${rel}.json`);
  for (const c of cands) {
    const abs = join(root, c);
    if (existsSync(abs) && statSync(abs).isFile()) return c;
  }
  return null;
}

const insideAny = (rel: string, pkgs: string[]) =>
  rel.startsWith(`node_modules${sep}`) ||
  rel === "node_modules" ||
  pkgs.some((p) => rel === p || rel.startsWith(`${p}/`));

/** `../`-relative path literals in a file, resolved against the file's dir. */
function upwardRefs(root: string, file: string): string[] {
  const src = readFileSync(join(root, file), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|[\s"'`=(:,])((?:\.\.\/)+[A-Za-z0-9_.@/-]*)/g)) {
    out.push(relative(root, resolve(root, dirname(file), m[1]!)));
  }
  return out;
}

function eslintCascade(root: string, pkg: string): string[] {
  const out: string[] = [];
  let dir = pkg;
  for (;;) {
    for (const name of [".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc"]) {
      const rel = dir === "" ? name : `${dir}/${name}`;
      if (!existsSync(join(root, rel))) continue;
      out.push(rel);
      if (/\broot\s*:\s*true\b|"root"\s*:\s*true/.test(readFileSync(join(root, rel), "utf8")))
        return out;
    }
    if (dir === "") return out;
    dir = dir.includes("/") ? dirname(dir) : "";
  }
}

export function discover(root: string): Discovery {
  const packages = workspacePackages(root);
  const inputs = new Map<string, Set<string>>();
  const globs = new Map<string, Set<string>>();
  const violations: string[] = [];
  const queue: string[] = [];
  const add = (input: string, why: string) => {
    if (!inputs.has(input)) {
      inputs.set(input, new Set());
      queue.push(input);
    }
    inputs.get(input)!.add(why);
  };

  let configFiles = 0;
  for (const pkg of packages) {
    // Every top-level file, plus a config-shaped file at any depth (a nested
    // tsconfig / *.config.* / eslintrc / manifest is read the same way).
    const top = gitFiles(root, pkg).filter(
      (f) =>
        (f.split("/").length === 3 && !/\.(md|mdx|png|svg|ico|txt)$/i.test(f)) ||
        CONFIG_SHAPED.test(f),
    );
    for (const f of top) {
      configFiles++;
      for (const ref of upwardRefs(root, f)) {
        if (insideAny(ref, packages)) continue;
        const file = asFile(root, ref);
        if (file) add(file, f);
        // A bare directory (`../..` as metro's watch root, `$PWD/../..` as a
        // docker mount) names no single file — not a hashable input.
      }
    }
    const manifest = JSON.parse(readFileSync(join(root, pkg, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (/\beslint\b/.test(manifest.scripts?.lint ?? "")) {
      for (const rc of eslintCascade(root, pkg))
        if (!rc.startsWith(`${pkg}/`)) add(rc, `${pkg} (eslint cascade)`);
    }
  }

  // Transitive closure over the root inputs themselves.
  const rootLevel = new Set(gitFiles(root).filter((f) => !f.includes("/")));
  while (queue.length > 0) {
    const input = queue.shift()!;
    const src = readFileSync(join(root, input), "utf8");
    if (/\.(c|m)?[jt]s$/.test(input)) {
      for (const m of src.matchAll(
        /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g,
      )) {
        const ref = relative(root, resolve(root, dirname(input), m[1]!));
        if (insideAny(ref, packages)) continue;
        const file = asFile(root, ref);
        if (file) add(file, `${input} (import)`);
      }
      for (const m of src.matchAll(/["'`]([A-Za-z0-9_.-]+\.[A-Za-z]+)["'`]/g)) {
        if (isComparisonOperand(src, m.index, m.index + m[0].length)) continue;
        if (rootLevel.has(m[1]!) && m[1] !== input) add(m[1]!, `${input} (names it)`);
      }
      if (/\b(readFileSync|readdirSync|readFile|createReadStream)\b/.test(src)) {
        const reads = SCRIPT_DATA_READS[input];
        if (!reads) {
          violations.push(
            `${input} reads files at runtime and is a turbo input, but SCRIPT_DATA_READS has no entry for it — its data inputs are unknown`,
          );
        } else {
          const tracked = gitFiles(root);
          for (const r of reads(root)) {
            if (isGlob(r)) {
              if (!globs.has(r)) globs.set(r, new Set());
              globs.get(r)!.add(`${input} (reads it)`);
              if (!r.startsWith("!") && !tracked.some((f) => matchesGlob(f, r)))
                violations.push(`${input}: SCRIPT_DATA_READS names ${r}, which matches no file`);
              continue;
            }
            const file = asFile(root, r);
            if (file && !insideAny(file, packages)) add(file, `${input} (reads it)`);
            else if (!file)
              violations.push(`${input}: SCRIPT_DATA_READS names ${r}, which does not exist`);
          }
        }
      }
    } else if (/\.json$/.test(input)) {
      for (const m of src.matchAll(/"extends"\s*:\s*"(\.{1,2}\/[^"]+)"/g)) {
        const file = asFile(root, relative(root, resolve(root, dirname(input), m[1]!)));
        if (file && !insideAny(file, packages)) add(file, `${input} (extends)`);
      }
    }
  }
  // The ESLint cascade from a root .eslintrc is itself a root input (covered
  // above); `.md` inputs are data, never followed.
  return { inputs, globs, packages, configFiles, violations };
}

interface TurboJson {
  globalDependencies?: string[];
  tasks?: Record<string, { cache?: boolean }>;
}

const brief = (xs: string[]) =>
  xs.length <= 3 ? xs.join(", ") : `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more`;

export function evaluate(root: string): { violations: string[]; d: Discovery; declared: string[] } {
  const d = discover(root);
  const turbo = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8")) as TurboJson;
  const declared = turbo.globalDependencies ?? [];
  const violations = [...d.violations];
  const declaredGlobs = declared.filter(isGlob);
  for (const [input, why] of [...d.inputs].sort(([a], [b]) => a.localeCompare(b))) {
    if (!declared.includes(input) && !globSelects(declaredGlobs, input)) {
      violations.push(
        `${input} is read by ${brief([...why].sort())} but is not in turbo.json globalDependencies — an edit to it replays stale cached build/typecheck/lint results`,
      );
    }
  }
  for (const [g, why] of [...d.globs].sort(([a], [b]) => a.localeCompare(b))) {
    if (!declared.includes(g)) {
      violations.push(
        `${g} is read by ${brief([...why].sort())} (a directory listing) but is not in turbo.json globalDependencies — adding or removing a matching file replays stale cached results`,
      );
    }
  }
  for (const g of declared) {
    if (isGlob(g)) {
      if (!d.globs.has(g))
        violations.push(
          `turbo.json globalDependencies entry "${g}" is a glob — list discovered files exactly (a glob only as a SCRIPT_DATA_READS directory-listing read declares it)`,
        );
    } else if (!d.inputs.has(g)) {
      violations.push(
        `turbo.json globalDependencies lists "${g}", which no package config reads (discovery found no path to it) — it invalidates every cache for nothing; remove it, or teach discovery the read`,
      );
    }
  }
  for (const t of ["test", "test:coverage"]) {
    if (turbo.tasks?.[t]?.cache !== false) {
      violations.push(
        `turbo.json task "${t}" is cacheable — this gate does not discover root files read by package SOURCE at test time, which is only safe while tests are never cached`,
      );
    }
  }
  return { violations, d, declared };
}

function main(): void {
  const { violations, d, declared } = evaluate(ROOT);
  if (violations.length > 0) {
    failWithRepair({
      invariant:
        "every repo-root file a workspace package's turbo task reads (through a `../` path in its config, the ESLint cascade, or transitively) is listed in turbo.json `globalDependencies` — otherwise an edit to it replays a stale cached verdict",
      sites: violations,
      canonical:
        "turbo.json `globalDependencies` (the declaration) ← discovered from every workspace package's top-level config files by scripts/check-turbo-global-deps.ts",
      fix: 'Add each missing path to turbo.json "globalDependencies" (exact path; a glob only verbatim as SCRIPT_DATA_READS declares it) and remove any entry nothing reads; for a root script that reads files, add its reads to SCRIPT_DATA_READS in scripts/check-turbo-global-deps.ts.',
      doctrine: "docs/drift-defenses.md",
    });
  }
  console.log(
    `✓ check-turbo-global-deps: ${d.inputs.size} root input(s) + ${d.globs.size} directory-listing glob(s) discovered from ${d.configFiles} config file(s) across ${d.packages.length} workspace package(s); all ${declared.length} turbo.json globalDependencies match.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
