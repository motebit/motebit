/**
 * Shared harness for the tamper-runner self-tests (tamper-runner*.test.ts).
 *
 * Builds a throwaway git repo from `tamper-runner-fixture/` — a two-package
 * pnpm workspace (`fx`, `@fx/lib`) with vitest tests (`*.fx.mjs`), a build
 * that writes a `dist/` and a non-`dist` ignored output (`out/`), a pnpm-shaped
 * store whose hoisted link points back into the workspace, and a few
 * non-vitest checks — and drives the REAL runner over it in a child `node`, as
 * a tamper file would.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";

import type { RunTampersSummary, TamperEntry } from "../lib/tamper-runner";

export const RUNNER = resolve(__dirname, "../lib/tamper-runner.ts");
const FIXTURE = resolve(__dirname, "tamper-runner-fixture");
const MONOREPO = resolve(__dirname, "../..");

export interface Fx {
  base: string;
  repo: string;
  /** The driver's TMPDIR: where the runner puts its motebit-tamper-* copies. */
  tmp: string;
  /** The driver's HOME (never the real one: a leak test writes there). */
  home: string;
  /** A path outside every slot and the repo (FX_LEAK): state no reset can clear. */
  leak: string;
  /** A path prefix outside every slot (FX_STATE) for fixture tests that count runs. */
  state: string;
  /** A free port for port.fx.mjs (handed to it as FX_PORT). */
  port: number;
}

export interface Driven {
  code: number | null;
  out: string;
  summary: RunTampersSummary;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr != null ? addr.port : 0;
      s.close(() => res(port));
    });
  });
}

export function git(fx: Fx, args: string[]): string {
  return execFileSync("git", args, { cwd: fx.repo, encoding: "utf8" });
}

export async function setupFixture(): Promise<Fx> {
  const base = mkdtempSync(join(tmpdir(), "tamper-runner-test-"));
  const repo = join(base, "repo");
  const tmp = join(base, "tmp");
  mkdirSync(tmp);
  cpSync(FIXTURE, repo, { recursive: true });
  const json = (rel: string, v: unknown): void =>
    writeFileSync(join(repo, rel), `${JSON.stringify(v, null, 2)}\n`);
  json("package.json", { name: "fxroot", private: true });
  json("packages/fx/package.json", {
    name: "fx",
    private: true,
    type: "module",
    scripts: { build: "node build.mjs" },
  });
  json("packages/lib/package.json", { name: "@fx/lib", private: true });
  json("packages/bail/package.json", { name: "bail", private: true, type: "module" });
  json("packages/exit7/package.json", { name: "exit7", private: true, type: "module" });
  writeFileSync(join(repo, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\nout/\n");
  const home = join(base, "home");
  mkdirSync(home);
  const fx: Fx = {
    base,
    repo,
    tmp,
    home,
    leak: join(base, "leak"),
    state: join(base, "state"),
    port: await freePort(),
  };
  execFileSync("git", ["init", "-q"], { cwd: repo });
  git(fx, ["add", "-A"]);
  git(fx, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);

  // Ignored install state, pnpm-shaped: vitest (from the monorepo), and a
  // store whose hoisted link points back into the workspace.
  const nm = join(repo, "node_modules");
  mkdirSync(join(nm, ".bin"), { recursive: true });
  symlinkSync(realpathSync(join(MONOREPO, "node_modules/vitest")), join(nm, "vitest"));
  symlinkSync(join(MONOREPO, "node_modules/.bin/vitest"), join(nm, ".bin/vitest"));
  // The compiler the runner type-checks an edit with (fold.ts, tsconfig.json).
  symlinkSync(realpathSync(join(MONOREPO, "node_modules/typescript")), join(nm, "typescript"));
  mkdirSync(join(nm, ".pnpm/node_modules/@fx"), { recursive: true });
  symlinkSync("../../../../packages/lib", join(nm, ".pnpm/node_modules/@fx/lib"));
  mkdirSync(join(nm, ".pnpm/ext@1.0.0/node_modules/ext"), { recursive: true });
  writeFileSync(join(nm, ".pnpm/ext@1.0.0/node_modules/ext/index.js"), "module.exports = 1;\n");
  writeFileSync(join(nm, ".pnpm/lock.yaml"), "lockfileVersion: '9.0'\n");
  // A store ENTRY (not the hoisted dir) whose dependency links back into the
  // workspace, as pnpm writes for an external package depending on one.
  mkdirSync(join(nm, ".pnpm/dep@1.0.0/node_modules/@fx"), { recursive: true });
  symlinkSync("../../../../../packages/lib", join(nm, ".pnpm/dep@1.0.0/node_modules/@fx/lib"));
  // A pnpm-style `.bin` shim that bakes the tree's ABSOLUTE path in.
  const shim = join(nm, ".bin/fxlib");
  writeFileSync(shim, `#!/bin/sh\nexec cat "${realpathSync(repo)}/packages/lib/value.txt"\n`);
  chmodSync(shim, 0o755);

  // Built outputs, as the caller would have them.
  execFileSync("node", ["build.mjs"], { cwd: join(repo, "packages/fx") });
  return fx;
}

export function teardownFixture(fx: Fx | undefined): void {
  if (fx != null) rmSync(fx.base, { recursive: true, force: true });
}

/** Every observable of the caller's tree: HEAD, status, worktrees, and file bytes. */
export function snapshot(fx: Fx): string {
  const files = git(fx, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n");
  return [
    git(fx, ["rev-parse", "HEAD"]),
    git(fx, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(fx, ["worktree", "list", "--porcelain"]),
    ...files
      .filter(Boolean)
      .map(
        (f) =>
          `${f}\n${existsSync(join(fx.repo, f)) ? readFileSync(join(fx.repo, f), "utf8") : "<deleted>"}`,
      ),
  ].join("\0");
}

/** Worktrees still registered besides the repo itself, and copies left in the driver's TMPDIR. */
export function leftovers(fx: Fx): string[] {
  const wts = git(fx, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => realpathSync(p) !== realpathSync(fx.repo));
  const dirs = readdirSync(fx.tmp)
    .filter((d) => d.startsWith("motebit-tamper-"))
    .map((d) => join(fx.tmp, d));
  return [...wts, ...dirs];
}

function writeDriver(fx: Fx, concurrency: number): string {
  const driver = join(fx.base, "drive.mjs");
  writeFileSync(
    driver,
    `import { runTampers } from ${JSON.stringify(RUNNER)};\n` +
      `const s = await runTampers(JSON.parse(process.argv[2]), { root: process.cwd(), concurrency: ${concurrency}, exit: false, argv: [] });\n` +
      `console.log("SUMMARY " + JSON.stringify(s));\n` +
      `process.exit(s.exitCode);\n`,
  );
  return driver;
}

function driverEnv(fx: Fx, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    TMPDIR: fx.tmp,
    HOME: fx.home,
    FX_PORT: String(fx.port),
    FX_LEAK: fx.leak,
    FX_STATE: fx.state,
  };
  delete env.TAMPER_CONCURRENCY;
  for (const k of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    delete env[k];
  }
  return env;
}

/**
 * Run the entries through the real runner (`env`: extra variables for it and
 * the tests it runs). Unless `allowLeftovers`, also requires that the run
 * left no copy and no worktree registration behind.
 */
export function drive(
  fx: Fx,
  entries: TamperEntry[],
  concurrency: number,
  opts: { allowLeftovers?: boolean; env?: Record<string, string> } = {},
): Driven {
  const driver = writeDriver(fx, concurrency);
  const r = spawnSync("node", ["--no-warnings", driver, JSON.stringify(entries)], {
    cwd: fx.repo,
    encoding: "utf8",
    env: driverEnv(fx, opts.env),
  });
  const out = `${r.stdout}${r.stderr}`;
  const line = out.split("\n").find((l) => l.startsWith("SUMMARY "));
  if (line == null) throw new Error(`driver printed no summary:\n${out}`);
  if (opts.allowLeftovers !== true) expect(leftovers(fx), out).toEqual([]);
  return { code: r.status, out, summary: JSON.parse(line.slice("SUMMARY ".length)) };
}

/** Start the runner without waiting (for the signal tests). */
export function startDriver(fx: Fx, entries: TamperEntry[], concurrency: number): ChildProcess {
  const driver = writeDriver(fx, concurrency);
  return spawn("node", ["--no-warnings", driver, JSON.stringify(entries)], {
    cwd: fx.repo,
    env: driverEnv(fx),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function verdicts(d: Driven): string[] {
  return d.summary.results.map((r) => r.verdict);
}

// Entry shorthands over the fixture.
export const FX = "fx";
export const SUM_FILE = "packages/fx/sum.mjs";
export const SUM_TEST = { pkg: FX, test: "sum.fx.mjs" };
export const BREAK_SUM = { file: SUM_FILE, from: "a + b", to: "a - b" };
export const BREAK_SUB = { file: SUM_FILE, from: "a - b", to: "a + b" };
export const SYNTAX_ERROR = { file: SUM_FILE, from: "return a + b;", to: "return a + ;" };
export const UNDEFINED_NAME = { file: SUM_FILE, from: "return a + b;", to: "return a + bb;" };
/** A comment-only edit carrying a token a fixture check or test looks for. */
export const tokenEdit = (token: string) => ({
  file: SUM_FILE,
  from: "// marker: a comment",
  to: `// ${token}: a comment`,
});
export const COMMENT_ONLY = {
  file: SUM_FILE,
  from: "// marker: a comment",
  to: "// changed: a comment",
};
