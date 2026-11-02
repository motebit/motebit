/**
 * prepush-script-readers — the derivation `.husky/pre-push` uses to narrow a
 * changed `scripts/` path to the packages that read it (2026-10-28).
 *
 * Two halves. On the REAL repo: the readers of the root scripts packages
 * actually import today come out exactly, an unreferenced script reads as no
 * package, and a turbo globalDependency's closure fails closed. On FIXTURE
 * repos: each rule of the derivation (closure, dependents, every fail-closed
 * branch) in isolation. The hook side (fail closed on a helper error, union
 * with changed packages) is pinned in pre-push-hook.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "../lib/differential-tree.js";
import { scriptReaders } from "../lib/prepush-script-readers.js";
import { evaluateHook } from "../check-prepush-subset.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = "scripts/lib/prepush-script-readers.ts";

describe("prepush-script-readers — the real repo", () => {
  it("scripts/lib/tamper-runner.ts is read by exactly its five reader packages", () => {
    expect(scriptReaders(ROOT, ["scripts/lib/tamper-runner.ts"])).toEqual({
      all: false,
      dirs: [
        "packages/mcp-server",
        "packages/planner",
        "packages/runtime",
        "packages/verify",
        "services/relay",
      ],
    });
  });

  it("scripts/lib/federation-live-v2.mjs is read by services/relay only", () => {
    expect(scriptReaders(ROOT, ["scripts/lib/federation-live-v2.mjs"])).toEqual({
      all: false,
      dirs: ["services/relay"],
    });
  });

  it("an unreferenced script (a gate, a new file) is read by no package", () => {
    expect(scriptReaders(ROOT, ["scripts/check-prepush-subset.ts"])).toEqual({
      all: false,
      dirs: [],
    });
    expect(scriptReaders(ROOT, ["scripts/check-a-brand-new-gate.ts"])).toEqual({
      all: false,
      dirs: [],
    });
  });

  it("every turbo globalDependency under scripts/ fails closed to every package", () => {
    const turbo = JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8")) as {
      globalDependencies: string[];
    };
    const scripts = turbo.globalDependencies.filter((g) => g.startsWith("scripts/"));
    expect(scripts.length).toBeGreaterThan(0);
    for (const g of scripts) expect(scriptReaders(ROOT, [g]), g).toMatchObject({ all: true });
  });
});

// ---------------------------------------------------------------------------
// Fixture repos

let base: string;
let n = 0;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A git repo (files tracked) with two packages: `a`, and `b` depending on `a`. */
function fixture(
  files: Record<string, string>,
  turbo: unknown = { globalDependencies: [] },
  untracked: Record<string, string> = {},
): string {
  const dir = join(base, `fx-${n++}`);
  const all: Record<string, string> = {
    "package.json": '{ "name": "root", "scripts": { "check": "tsx scripts/check.ts" } }\n',
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "turbo.json": JSON.stringify(turbo),
    "packages/a/package.json": '{ "name": "a" }\n',
    "packages/a/src/index.ts": "export const a = 1;\n",
    "packages/b/package.json": '{ "name": "b", "dependencies": { "a": "workspace:*" } }\n',
    "packages/b/src/index.ts": "export const b = 1;\n",
    "packages/c/package.json": '{ "name": "c" }\n',
    "scripts/check.ts": "export {};\n",
    "scripts/lib/core.ts": "export const core = 1;\n",
    "scripts/lib/runner.ts": 'import { core } from "./core.js";\nexport const run = core;\n',
    // The CLI runs as `node --import tsx …` from the repo: borrow the real
    // node_modules, ignored like the real one.
    ".gitignore": "node_modules\n",
    ...files,
  };
  const put = (rel: string, content: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  for (const [rel, content] of Object.entries(all)) put(rel, content);
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  for (const [rel, content] of Object.entries(untracked)) put(rel, content);
  return dir;
}

/** The helper's CLI, run as the hook runs it, in `repo`. */
function cli(repo: string, input: string) {
  return spawnSync(process.execPath, ["--import", "tsx", join(ROOT, HELPER)], {
    cwd: repo,
    input,
    encoding: "utf8",
    env: cleanEnv(),
  });
}

const C_TEST = "packages/c/src/__tests__/x.test.ts";

const TAMPER_READS_RUNNER = {
  "packages/a/tamper/t.mjs": 'import { run } from "../../../scripts/lib/runner.ts";\nrun;\n',
};

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "script-readers-")));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("prepush-script-readers — references and closure", () => {
  it("a test-only reference makes exactly that package a reader", () => {
    const repo = fixture(TAMPER_READS_RUNNER);
    expect(scriptReaders(repo, ["scripts/lib/runner.ts"])).toEqual({
      all: false,
      dirs: ["packages/a"],
    });
  });

  it("a change to a script the referenced one imports (transitively) reaches its readers", () => {
    const repo = fixture({
      ...TAMPER_READS_RUNNER,
      "scripts/lib/core.ts": 'export { leaf as core } from "./deep/leaf.ts";\n',
      "scripts/lib/deep/leaf.ts": "export const leaf = 1;\n",
    });
    expect(scriptReaders(repo, ["scripts/lib/core.ts"])).toEqual({
      all: false,
      dirs: ["packages/a"],
    });
    expect(scriptReaders(repo, ["scripts/lib/deep/leaf.ts"])).toEqual({
      all: false,
      dirs: ["packages/a"],
    });
  });

  it("a DELETED module the referenced one imports still reaches its readers", () => {
    // The import edge is followed by specifier, not by an existing file: a
    // deletion can break the reader as surely as an edit.
    const repo = fixture({
      ...TAMPER_READS_RUNNER,
      "scripts/lib/runner.ts": 'import { gone } from "./gone.js";\nexport const run = gone;\n',
    });
    expect(scriptReaders(repo, ["scripts/lib/gone.ts"])).toEqual({
      all: false,
      dirs: ["packages/a"],
    });
  });

  it("a script nothing references adds no package", () => {
    const repo = fixture(TAMPER_READS_RUNNER);
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual({ all: false, dirs: [] });
  });

  it("a reference from non-test source also widens to the package's dependents", () => {
    const repo = fixture({
      "packages/a/src/gen.ts": 'export const p = "../../scripts/lib/runner.ts";\n',
    });
    expect(scriptReaders(repo, ["scripts/lib/core.ts"])).toEqual({
      all: false,
      dirs: ["packages/a", "packages/b"],
    });
  });

  it("a package.json script run from the package dir is a reference", () => {
    const repo = fixture({
      "packages/c/package.json":
        '{ "name": "c", "scripts": { "build": "tsx ../../scripts/check.ts" } }\n',
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual({ all: false, dirs: ["packages/c"] });
  });

  it("a bare `scripts/x` the package has itself is the package's own, not the root's", () => {
    const repo = fixture({
      "packages/c/package.json":
        '{ "name": "c", "scripts": { "build": "tsx scripts/check.ts" } }\n',
      "packages/c/scripts/check.ts": "export {};\n",
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual({ all: false, dirs: [] });
  });

  it("a bare root `scripts/x` (run from the repo root) is a reference", () => {
    const repo = fixture({
      "packages/c/src/__tests__/x.test.ts":
        'spawnSync("tsx", ["scripts/check.ts"], { cwd: ROOT });\n',
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual({ all: false, dirs: ["packages/c"] });
  });

  it("a full-line comment is not a reference", () => {
    const repo = fixture({
      "packages/c/src/x.ts":
        "// enforced by scripts/check.ts\n/*\n * see scripts/check.ts\n */\nexport {};\n",
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual({ all: false, dirs: [] });
  });

  it("a data-file mention reads that exact path, not its closure", () => {
    const repo = fixture({ "packages/c/notes.txt": "regenerate with scripts/lib/runner.ts\n" });
    expect(scriptReaders(repo, ["scripts/lib/runner.ts"])).toEqual({
      all: false,
      dirs: ["packages/c"],
    });
    expect(scriptReaders(repo, ["scripts/lib/core.ts"])).toEqual({ all: false, dirs: [] });
  });

  it('a path built from a bare "scripts" segment: that package reads every script', () => {
    const repo = fixture({
      "packages/c/src/__tests__/x.test.ts": 'const p = join(REPO, "scripts", name);\n',
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual({ all: false, dirs: ["packages/c"] });
  });

  it("an unfollowable closure (non-literal import): its reader reads every script", () => {
    const repo = fixture({
      ...TAMPER_READS_RUNNER,
      "scripts/lib/runner.ts": "export const run = await import(process.env.X!);\n",
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual({ all: false, dirs: ["packages/a"] });
  });

  it("a closure that leaves scripts/ by a relative import: its reader reads every script", () => {
    const repo = fixture({
      ...TAMPER_READS_RUNNER,
      "scripts/lib/runner.ts": 'export { a as run } from "../../packages/a/src/index.ts";\n',
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual({ all: false, dirs: ["packages/a"] });
  });
});

describe("prepush-script-readers — fail closed to every package", () => {
  it("a path listed in turbo.json globalDependencies", () => {
    const repo = fixture({}, { globalDependencies: ["scripts/check.ts"] });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toMatchObject({ all: true });
  });

  it("a path matched by a globalDependencies glob (one naming no scripts/ prefix)", () => {
    const repo = fixture({ "scripts/gen/x.txt": "x\n" }, { globalDependencies: ["**/*.txt"] });
    expect(scriptReaders(repo, ["scripts/gen/x.txt"])).toMatchObject({ all: true });
  });

  it("a path in a globalDependency's import closure", () => {
    const repo = fixture({}, { globalDependencies: ["scripts/lib/runner.ts"] });
    expect(scriptReaders(repo, ["scripts/lib/core.ts"])).toMatchObject({ all: true });
  });

  it("a globalDependency whose closure cannot be followed (any scripts/ change)", () => {
    const repo = fixture(
      { "scripts/lib/runner.ts": "export const run = require(name);\n" },
      { globalDependencies: ["scripts/lib/runner.ts"] },
    );
    expect(scriptReaders(repo, ["scripts/check.ts"])).toMatchObject({ all: true });
  });

  it("a path a root config reads (vitest.shared.ts importing a scripts/ module)", () => {
    const repo = fixture({ "vitest.shared.ts": 'import "./scripts/lib/runner.ts";\nexport {};\n' });
    expect(scriptReaders(repo, ["scripts/lib/core.ts"])).toMatchObject({ all: true });
  });

  it("a root package.json lifecycle script (runs on every install)", () => {
    const repo = fixture({
      "package.json": '{ "name": "root", "scripts": { "postinstall": "tsx scripts/check.ts" } }\n',
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toMatchObject({ all: true });
  });

  it("a package invoking a root package.json script by name", () => {
    const repo = fixture({
      "packages/c/package.json": '{ "name": "c", "scripts": { "lint": "pnpm -w check" } }\n',
    });
    expect(scriptReaders(repo, ["scripts/lib/core.ts"])).toMatchObject({ all: true });
  });

  it("a helper error (unreadable turbo.json): the CLI prints __ALL__ and __END__", () => {
    const repo = fixture({ "turbo.json": "{ not json" });
    const r = cli(repo, "scripts/check.ts\n");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^__ALL__ helper error: .*\n__END__\n$/);
  });

  it("the CLI prints the reader dirs then __END__", () => {
    const repo = fixture(TAMPER_READS_RUNNER);
    const r = cli(repo, "scripts/lib/core.ts\n");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("packages/a\n__END__\n");
  });
});

const C_ONLY = { all: false, dirs: ["packages/c"] };

describe("prepush-script-readers — review round 2 (F1–F5)", () => {
  it("F1: a path cut short by an interpolation is a prefix of every script it can name", () => {
    const repo = fixture({ [C_TEST]: "const p = `../../../../scripts/lib/co${name}.ts`;\n" });
    expect(scriptReaders(repo, ["scripts/lib/core.ts"])).toEqual(C_ONLY);
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual({ all: false, dirs: [] });
  });

  it("F1: a glob path is a prefix of every script it can name", () => {
    const repo = fixture({ [C_TEST]: 'const g = "../../../../scripts/che*.ts";\n' });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual(C_ONLY);
  });

  it('F2: a "scripts" segment in a multi-line join reads the whole root scripts/ dir', () => {
    const repo = fixture({
      [C_TEST]: 'const p = join(\n  ROOT,\n  "scripts",\n  "check.ts",\n);\n',
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual(C_ONLY);
  });

  it('F2: a "scripts" segment in an array joined into a path', () => {
    const repo = fixture({ [C_TEST]: 'const p = [here, "scripts", "check.ts"].join("/");\n' });
    expect(scriptReaders(repo, ["scripts/lib/core.ts"])).toEqual(C_ONLY);
  });

  it('F2 control: a provably package-local "scripts" (own scripts/ dir, no root) is not the root\'s', () => {
    const repo = fixture({
      "packages/c/scripts/build.ts": "export {};\n",
      "packages/c/src/skills.ts": 'const AUX_DIRS = ["scripts", "assets"] as const;\n',
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual({ all: false, dirs: [] });
  });

  it("T1: a relative string literal a closure file reads (an fs read) is in the closure", () => {
    const repo = fixture({
      ...TAMPER_READS_RUNNER,
      "scripts/lib/runner.ts":
        'import { core } from "./core.js";\nexport const data = readFileSync(new URL("./data.json", import.meta.url));\nexport const run = core;\n',
      "scripts/lib/data.json": "{}\n",
    });
    expect(scriptReaders(repo, ["scripts/lib/data.json"])).toEqual({
      all: false,
      dirs: ["packages/a"],
    });
  });

  it("T2: a scripts/ path a closure file runs (`tsx scripts/x`) is in the closure", () => {
    const repo = fixture({
      ...TAMPER_READS_RUNNER,
      "scripts/lib/runner.ts": 'spawnSync("tsx", ["scripts/check.ts"]);\nexport const run = 1;\n',
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual({
      all: false,
      dirs: ["packages/a"],
    });
  });

  it("T3: a referenced directory reads the closure of every file under it", () => {
    const repo = fixture({
      [C_TEST]: 'const dir = "../../../../scripts/lib";\n',
      "scripts/lib/core.ts": 'export { x as core } from "../check.ts";\n',
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual(C_ONLY);
  });

  it("T4: `$TURBO_ROOT$/scripts/…` is the root's even when the package has that path", () => {
    const repo = fixture({
      "packages/c/scripts/check.ts": "export {};\n",
      "packages/c/turbo.json": JSON.stringify({
        extends: ["//"],
        tasks: { build: { inputs: ["$TURBO_ROOT$/scripts/check.ts"] } },
      }),
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual(C_ONLY);
  });

  it("T5: a package running pnpm from the repo root (`--dir ../..`) is ALL", () => {
    const repo = fixture({
      "packages/c/package.json":
        '{ "name": "c", "scripts": { "lint": "pnpm --dir ../.. check" } }\n',
    });
    expect(scriptReaders(repo, ["scripts/lib/core.ts"])).toMatchObject({ all: true });
  });

  it("T6: an UNTRACKED package file's reference counts", () => {
    const repo = fixture({}, undefined, {
      [C_TEST]: 'const p = "../../../../scripts/check.ts";\n',
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual(C_ONLY);
  });

  it("F3: a package file reaching an executable non-package file reads what that file runs", () => {
    const repo = fixture({
      [C_TEST]: 'execFileSync("node", ["../../../../examples/run.mjs"]);\n',
      "examples/run.mjs": 'execFileSync("sh", ["examples/lib/go.sh"]);\n',
      "examples/lib/go.sh": "npx tsx scripts/check.ts\n",
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual(C_ONLY);
  });

  it("rule 5: a package with a test script and no vite/vitest config of its own is ALL", () => {
    const repo = fixture({
      "packages/c/package.json": '{ "name": "c", "scripts": { "test": "vitest run" } }\n',
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toMatchObject({ all: true });
  });

  it("rule 5 control: with its own vitest config, it is not", () => {
    const repo = fixture({
      "packages/c/package.json": '{ "name": "c", "scripts": { "test": "vitest run" } }\n',
      "packages/c/vitest.config.ts": "export default {};\n",
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual({ all: false, dirs: [] });
  });

  it("F4: code after a closing block comment on the same line is a reference", () => {
    const repo = fixture({
      [C_TEST]: '/* the gate */ const p = "../../../../scripts/check.ts";\n',
    });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual(C_ONLY);
  });

  it("F4: `cd ../.. && …` in a package script is ALL", () => {
    const repo = fixture({
      "packages/c/package.json":
        '{ "name": "c", "scripts": { "lint": "cd ../.. && pnpm check" } }\n',
    });
    expect(scriptReaders(repo, ["scripts/lib/core.ts"])).toMatchObject({ all: true });
  });

  it("F4: `turbo run //#…` (a root task) in a package script is ALL", () => {
    const repo = fixture({
      "packages/c/package.json": '{ "name": "c", "scripts": { "lint": "turbo run //#check" } }\n',
    });
    expect(scriptReaders(repo, ["scripts/lib/core.ts"])).toMatchObject({ all: true });
  });

  it("F4: script paths match case-insensitively (a case-insensitive filesystem)", () => {
    const repo = fixture({ [C_TEST]: 'const p = "../../../../scripts/Check.ts";\n' });
    expect(scriptReaders(repo, ["scripts/check.ts"])).toEqual(C_ONLY);
  });
});

describe("prepush-script-readers — the hook calls it", () => {
  const hook = readFileSync(join(ROOT, ".husky/pre-push"), "utf8");

  it(".husky/pre-push runs this helper from the repo root", () => {
    expect(hook).toContain(`node --import tsx ${HELPER}`);
  });

  it("check-prepush-subset accepts the call, and refuses it with arguments", () => {
    expect(evaluateHook(hook).violations).toEqual([]);
    const withArgs = hook.replace(
      /\n(\s*)scope_script_readers\n/,
      "\n$1scope_script_readers packages/x\n",
    );
    expect(withArgs).not.toBe(hook);
    expect(evaluateHook(withArgs).violations.join("\n")).toMatch(
      /scope_script_readers takes no arguments/,
    );
  });
});
