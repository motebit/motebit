/**
 * Tests-typechecked drift gate (#1000).
 *
 * Enforces: every test file of every workspace package that declares a
 * `typecheck` script is included by a tsconfig that the `typecheck` script
 * actually compiles.
 *
 * ## Why this gate exists
 *
 * The published packages built their declarations from a `tsconfig.json`
 * that excludes `src/__tests__` (tests must never ship in `dist/`), and their
 * `typecheck` script (`tsc --noEmit`) compiled that same tsconfig. So their
 * test files were type-checked nowhere: vitest strips types without checking
 * them, and the `tsconfig.eslint.json` that did include them is only read by
 * the linter's parser, which never reports type errors. The 2026-09-30 audit
 * found 90 latent errors in `packages/crypto` alone — including an import of a
 * type `@motebit/protocol` does not export. A test that type-checks wrong can
 * assert against a shape the code no longer has, and still pass.
 *
 * The fix keeps the build config excluding tests and adds a test-inclusive
 * tsconfig (`tsconfig.test.json`) that the `typecheck` script also compiles.
 * This gate holds that shape: it resolves the tsconfigs the `typecheck` script
 * compiles (following `pnpm run <script>` hops) and asks TypeScript itself
 * which files each one includes — `include` / `exclude` / `files` / `extends`
 * resolved exactly as `tsc` resolves them.
 *
 * Inclusion alone is not enough, so the gate holds two more properties:
 *
 * - **At least as strict as the build.** Every tsconfig the `typecheck`
 *   script compiles is compared, on its RESOLVED compiler options (the view
 *   `tsc --showConfig -p` prints: `extends` applied, strict-family flags
 *   implied from `strict`), against the package's build config(s)
 *   (`tsconfig.json` plus any `tsc` config the `build` script compiles). A
 *   test config that turns off `strict`, `noImplicitAny`,
 *   `noUncheckedIndexedAccess`, … (or turns on `skipLibCheck`) would compile
 *   the tests while hiding exactly the errors the build reports — it fails.
 * - **Unconditional.** The `typecheck` script (and every script it hops
 *   into) may chain commands only with `&&`. `||` (incl. `|| true`), `;`,
 *   `|` and a background `&` each let one `tsc` run only when another fails,
 *   or let a failing `tsc` exit green — they fail.
 *
 * ## What counts as a test file
 *
 * Any `.ts` / `.tsx` / `.mts` / `.cts` file (not `.d.ts`) whose name matches
 * `*.test.*` / `*.spec.*`, or that lives under a `__tests__/` directory
 * (helpers and fixtures a test imports are part of the test's contract).
 * `node_modules`, `dist`, and other build-output directories are skipped.
 *
 * ## Usage
 *
 *   tsx scripts/check-tests-typechecked.ts           # exit 1 on any uncovered test file
 *   tsx scripts/check-tests-typechecked.ts --table   # print the per-package coverage table
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { formatRepair } from "./lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** `CHECK_TESTS_TYPECHECKED_ROOT` points the gate at a fixture workspace (the bypass harness). */
const ROOT = process.env.CHECK_TESTS_TYPECHECKED_ROOT
  ? resolve(process.env.CHECK_TESTS_TYPECHECKED_ROOT)
  : resolve(__dirname, "..");

const WORKSPACE_GLOBS = ["packages", "apps", "services"];

/** Directories never walked for test files — build output and vendored code. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".expo",
  "src-tauri",
]);

const TS_SOURCE = /\.(?:ts|tsx|mts|cts)$/;
const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
const TEST_NAME = /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/;

/**
 * Test files deliberately outside a package's typecheck, keyed by repo-relative
 * package dir → package-relative path prefix → reason. Each entry is visible
 * debt: the gate fails when an entry goes stale (the prefix now matches no
 * uncovered file), so a fixed package forces its entry out.
 */
export const KNOWN_UNCOVERED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "apps/web": {
    "e2e/":
      "Playwright specs, run by the ci.yml e2e job (not vitest). apps/web/tsconfig.json has rootDir src and no e2e tsconfig exists; adding one is an apps/web config change outside the #1000 published-packages lane. Measured 2026-09-30: 1 error (golden.spec.ts uses `Buffer` without node types). Follow-up: give apps/web an e2e tsconfig compiled by its typecheck script, then delete this entry.",
  },
};

export function isTestFile(relPath: string): boolean {
  const posix = relPath.split("\\").join("/");
  if (!TS_SOURCE.test(posix) || DECLARATION.test(posix)) return false;
  return TEST_NAME.test(posix) || posix.split("/").includes("__tests__");
}

/** Every test file under `pkgDir`, as package-relative posix paths, sorted. */
export function findTestFiles(pkgDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        const rel = relative(pkgDir, abs).split("\\").join("/");
        if (isTestFile(rel)) out.push(rel);
      }
    }
  };
  walk(pkgDir);
  return out.sort();
}

/** Shell-ish tokenizer: whitespace split, honoring simple single/double quotes. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  for (const m of segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

export interface TypecheckResolution {
  /** Package-relative tsconfig paths the `typecheck` script compiles. */
  configs: string[];
  /** Commands in the chain the resolver could not interpret (reported, never guessed). */
  unresolved: string[];
  /**
   * Control operators other than `&&` in the chain — each one lets a `tsc`
   * run conditionally on another's failure, or a failing `tsc` exit green.
   */
  conditional: string[];
}

/**
 * Shell control operators in `cmd` other than `&&`, outside quotes: `||`,
 * `;`, `|`, a background `&`, or a newline. `&` inside a redirection
 * (`2>&1`, `&>`) is not a control operator.
 */
export function nonAndOperators(cmd: string): string[] {
  const found: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    const next = cmd[i + 1];
    if (c === "&" && next === "&") {
      i++;
    } else if (c === "|" && next === "|") {
      found.push("||");
      i++;
    } else if (c === "|") {
      found.push("|");
    } else if (c === ";") {
      found.push(";");
    } else if (c === "\n") {
      found.push("newline");
    } else if (c === "&" && cmd[i - 1] !== ">" && next !== ">") {
      found.push("&");
    }
  }
  return found;
}

/**
 * Resolve the tsconfig(s) a package's `typecheck` script compiles. Follows
 * `pnpm run <x>` / `pnpm <x>` / `npm run <x>` hops into sibling scripts;
 * each `tsc` invocation contributes its `-p` / `--project` / `-b` target, or
 * `tsconfig.json` when it names none.
 */
export function resolveTypecheckConfigs(
  scripts: Record<string, string>,
  entry = "typecheck",
): TypecheckResolution {
  const configs: string[] = [];
  const unresolved: string[] = [];
  const conditional: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const cmd = scripts[name];
    if (cmd === undefined) {
      unresolved.push(`script "${name}" is referenced but not defined`);
      return;
    }
    for (const op of new Set(nonAndOperators(cmd))) {
      conditional.push(
        `script "${name}" ("${cmd}") uses \`${op}\` — every tsc in the typecheck chain must run unconditionally; chain with \`&&\` only`,
      );
    }
    for (const segment of cmd.split(/&&|\|\||;|\||&|\n/)) {
      const tokens = tokenize(segment.trim());
      if (tokens.length === 0) continue;
      let i = 0;
      if (tokens[0] === "npx") i = 1;
      else if (tokens[0] === "pnpm" && tokens[1] === "exec") i = 2;
      const bin = tokens[i];
      if (bin === "tsc") {
        let project = "tsconfig.json";
        for (let j = i + 1; j < tokens.length; j++) {
          const t = tokens[j];
          if (
            (t === "-p" || t === "--project" || t === "-b" || t === "--build") &&
            tokens[j + 1] &&
            !tokens[j + 1]!.startsWith("-")
          ) {
            project = tokens[j + 1]!;
          }
        }
        configs.push(project.endsWith(".json") ? project : join(project, "tsconfig.json"));
        continue;
      }
      if ((tokens[0] === "pnpm" || tokens[0] === "npm" || tokens[0] === "yarn") && i === 0) {
        const target = tokens[1] === "run" ? tokens[2] : tokens[1];
        if (target !== undefined && scripts[target] !== undefined) {
          visit(target);
          continue;
        }
      }
      // Anything else (fumadocs-mdx, echo, …) compiles no TypeScript; it is
      // neither a config nor an error.
    }
  };
  visit(entry);
  return { configs: [...new Set(configs)], unresolved, conditional };
}

/**
 * Compiler flags a test config must not weaken relative to the build config.
 * `true` is the strict value for each, except the `LOOSE_WHEN_TRUE` ones.
 */
export const STRICTNESS_FLAGS = [
  "strict",
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "noImplicitThis",
  "alwaysStrict",
  "useUnknownInCatchVariables",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noPropertyAccessFromIndexSignature",
  "noUnusedLocals",
  "noUnusedParameters",
  "skipLibCheck",
] as const;

const LOOSE_WHEN_TRUE = new Set<string>(["skipLibCheck"]);

/** Flags that default to the value of `strict` when not set explicitly (as tsc resolves them). */
const STRICT_FAMILY = new Set<string>([
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "noImplicitThis",
  "alwaysStrict",
  "useUnknownInCatchVariables",
]);

/**
 * A tsconfig's resolved compiler options — `extends` applied, exactly the
 * options `tsc --showConfig -p <config>` prints. Throws if it cannot be parsed.
 */
export function resolvedCompilerOptions(configAbs: string): Record<string, unknown> {
  let diagnostic: string | undefined;
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      diagnostic = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configAbs, undefined, host);
  if (!parsed) throw new Error(diagnostic ?? `could not parse ${configAbs}`);
  return parsed.options as Record<string, unknown>;
}

/** The value tsc acts on: explicit flag, else `strict` for the strict family, else off. */
function effectiveFlag(options: Record<string, unknown>, flag: string): boolean {
  const explicit = options[flag];
  if (typeof explicit === "boolean") return explicit;
  if (STRICT_FAMILY.has(flag)) return options.strict === true;
  return false;
}

/** Each flag on which `test` is looser than `build`, as "flag (build X, test Y)". */
export function strictnessWeakenings(
  build: Record<string, unknown>,
  test: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const flag of STRICTNESS_FLAGS) {
    const b = effectiveFlag(build, flag);
    const t = effectiveFlag(test, flag);
    const weaker = LOOSE_WHEN_TRUE.has(flag) ? !b && t : b && !t;
    if (weaker) out.push(`${flag} (build ${String(b)}, test ${String(t)})`);
  }
  return out;
}

/** Absolute paths of every file a tsconfig includes, as `tsc -p` resolves it. */
export function filesIncludedBy(configAbs: string): { files: Set<string>; error?: string } {
  if (!existsSync(configAbs)) return { files: new Set(), error: `${configAbs} does not exist` };
  let diagnostic: string | undefined;
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      diagnostic = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configAbs, undefined, host);
  if (!parsed) return { files: new Set(), error: diagnostic ?? `could not parse ${configAbs}` };
  return { files: new Set(parsed.fileNames.map((f) => resolve(f))) };
}

export interface PackageCoverage {
  /** Repo-relative package dir. */
  dir: string;
  name: string;
  configs: string[];
  testFiles: string[];
  /** Package-relative test files no typecheck config includes (allowlisted ones removed). */
  uncovered: string[];
  /** Package-relative test files uncovered but named by a KNOWN_UNCOVERED entry. */
  allowlisted: string[];
  /** Typecheck configs (other than a build config) compared for strictness. */
  strictnessCompared: number;
  problems: string[];
}

export function scanPackage(
  pkgDirAbs: string,
  root = ROOT,
  known: Readonly<Record<string, Readonly<Record<string, string>>>> = KNOWN_UNCOVERED,
): PackageCoverage | null {
  const manifestPath = join(pkgDirAbs, "package.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  const scripts = manifest.scripts ?? {};
  if (scripts.typecheck === undefined) return null;
  const { configs, unresolved, conditional } = resolveTypecheckConfigs(scripts);
  const problems = [...unresolved, ...conditional];
  const covered = new Set<string>();
  for (const cfg of configs) {
    const { files, error } = filesIncludedBy(resolve(pkgDirAbs, cfg));
    if (error) problems.push(error);
    for (const f of files) covered.add(f);
  }
  if (configs.length === 0)
    problems.push(`the typecheck script ("${scripts.typecheck}") runs no tsc`);
  // Build configs: tsconfig.json plus whatever the build script compiles.
  const buildConfigs = new Set<string>();
  if (existsSync(join(pkgDirAbs, "tsconfig.json"))) buildConfigs.add("tsconfig.json");
  if (scripts.build !== undefined) {
    for (const c of resolveTypecheckConfigs(scripts, "build").configs) {
      if (existsSync(resolve(pkgDirAbs, c))) buildConfigs.add(c);
    }
  }
  const buildPaths = new Set([...buildConfigs].map((c) => resolve(pkgDirAbs, c)));
  let strictnessCompared = 0;
  for (const cfg of configs) {
    const cfgAbs = resolve(pkgDirAbs, cfg);
    if (buildPaths.has(cfgAbs) || !existsSync(cfgAbs)) continue;
    if (buildConfigs.size > 0) strictnessCompared++;
    for (const b of buildConfigs) {
      let weakened: string[];
      try {
        weakened = strictnessWeakenings(
          resolvedCompilerOptions(resolve(pkgDirAbs, b)),
          resolvedCompilerOptions(cfgAbs),
        );
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      if (weakened.length > 0) {
        problems.push(
          `${cfg} is less strict than the build config ${b}: ${weakened.join(", ")} — a test config must never loosen what the build checks; remove the override`,
        );
      }
    }
  }
  const testFiles = findTestFiles(pkgDirAbs);
  const dir = relative(root, pkgDirAbs).split("\\").join("/");
  const prefixes = Object.keys(known[dir] ?? {});
  const notCompiled = testFiles.filter((f) => !covered.has(resolve(pkgDirAbs, f)));
  const allowlisted = notCompiled.filter((f) => prefixes.some((p) => f.startsWith(p)));
  const uncovered = notCompiled.filter((f) => !allowlisted.includes(f));
  for (const p of prefixes) {
    if (!allowlisted.some((f) => f.startsWith(p))) {
      problems.push(
        `stale KNOWN_UNCOVERED entry "${p}" — no uncovered test file matches it any more; delete it from scripts/check-tests-typechecked.ts`,
      );
    }
  }
  return {
    dir,
    name: manifest.name ?? relative(root, pkgDirAbs),
    configs,
    testFiles,
    uncovered,
    allowlisted,
    strictnessCompared,
    problems,
  };
}

export function workspacePackageDirs(root = ROOT): string[] {
  const dirs: string[] = [];
  for (const group of WORKSPACE_GLOBS) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base).sort()) {
      const abs = join(base, entry);
      if (statSync(abs).isDirectory() && existsSync(join(abs, "package.json"))) dirs.push(abs);
    }
  }
  return dirs;
}

function main(): void {
  const table = process.argv.includes("--table");
  const results = workspacePackageDirs()
    .map((d) => scanPackage(d))
    .filter((r): r is PackageCoverage => r !== null);

  if (table) {
    process.stdout.write(
      "| package | typecheck config(s) | test files | covered |\n|---|---|---|---|\n",
    );
    for (const r of results) {
      const covered =
        r.testFiles.length === 0
          ? "n/a"
          : r.uncovered.length > 0
            ? `NO (${r.uncovered.length} uncovered)`
            : r.allowlisted.length > 0
              ? `yes, except ${r.allowlisted.length} allowlisted (KNOWN_UNCOVERED)`
              : "yes";
      process.stdout.write(
        `| ${r.dir} | ${r.configs.join(", ")} | ${r.testFiles.length} | ${covered} |\n`,
      );
    }
  }

  const totalTests = results.reduce((n, r) => n + r.testFiles.length, 0);
  const failing = results.filter((r) => r.uncovered.length > 0 || r.problems.length > 0);
  const totalAllowlisted = results.reduce((n, r) => n + r.allowlisted.length, 0);
  const strictChecked = results.reduce((n, r) => n + r.strictnessCompared, 0);
  if (failing.length === 0) {
    process.stdout.write(
      `✓ check-tests-typechecked: ${totalTests - totalAllowlisted} of ${totalTests} test file(s) across ${results.length} package(s) with a typecheck script are compiled by their typecheck tsconfig(s); ${totalAllowlisted} test file(s) allowlisted in KNOWN_UNCOVERED. ${strictChecked} non-build typecheck config(s) compared against their build config on ${STRICTNESS_FLAGS.length} resolved strictness flags; every typecheck script chains with \`&&\` only.\n`,
    );
    return;
  }

  const sites: string[] = [];
  for (const r of failing) {
    for (const p of r.problems) sites.push(`${r.dir}: ${p}`);
    if (r.uncovered.length > 0) {
      const sample = r.uncovered
        .slice(0, 5)
        .map((f) => `${r.dir}/${f}`)
        .join(", ");
      const more = r.uncovered.length > 5 ? `, … +${r.uncovered.length - 5} more` : "";
      sites.push(
        `${r.dir} (${r.name}): ${r.uncovered.length} of ${r.testFiles.length} test file(s) not compiled by [${r.configs.join(", ")}] — ${sample}${more}`,
      );
    }
  }
  process.stderr.write(
    formatRepair({
      invariant: `${failing.length} package(s) have test files their \`typecheck\` script never type-checks, checks less strictly than the build, or checks only conditionally (${totalTests} test file(s) across ${results.length} package(s) scanned)`,
      sites,
      canonical:
        "the package's tsconfig.json (build) + tsconfig.test.json (tests), compiled by its package.json `typecheck` script",
      fix: 'keep the build tsconfig excluding tests; add `tsconfig.test.json` (copy packages/crypto/tsconfig.test.json: `extends: ./tsconfig.json`, `rootDir: \".\"`, `noEmit: true`, emitDeclarationOnly/composite/incremental off, `include` covering src and every test dir, `exclude: []`) and make `typecheck` run `tsc --noEmit && tsc -p tsconfig.test.json` (chained with `&&` only — never `||`, `;`, `|` or `&`). The test config must not override any strictness flag weaker than the build config (compare `tsc --showConfig -p` of each). Then fix the surfaced errors in the tests — never loosen the config. Verify with `pnpm check-tests-typechecked --table`.',
      doctrine: "docs/drift-defenses.md (check-tests-typechecked), issue #1000",
    }),
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
