/**
 * Turbo stale-cache harness — reproduces, end to end, every way a CACHED test
 * result can be replayed after an input that changes its outcome has changed.
 *
 * Each case builds a miniature pnpm/turbo workspace in a temp dir that carries
 * the REAL repo's test-cache configuration (turbo.json, vitest.shared.ts and
 * every other file it names below — copied verbatim, so the harness always
 * measures the config as committed) plus one package whose test reads one
 * input through one shape. Then, through the repo's own `pnpm test` entry
 * point (the root `scripts.test` command):
 *
 *   1. run the test          — it must pass (or be refused by the input tracer)
 *   2. change the input      — a file, the lockfile, an env var, the runtime
 *   3. run it again          — `cache hit` or `cache miss`?
 *   4. on a hit, `--force`   — does the test actually still pass?
 *
 * Outcomes:
 *   STALE          hit on step 3, FAIL on step 4 — a replayed green over a test
 *                  that now fails. The defect this harness exists to catch.
 *   MISS           step 3 re-ran the test (the input is in the hash).
 *   HIT_VALID      hit on step 3 and the forced run still passes (the change
 *                  did not affect the outcome — never expected here).
 *   TRACER_FAIL    step 1 was refused by the runtime input tracer with a repair
 *                  line; the harness applies the named repair and re-runs the
 *                  case, reporting what the repaired config does (`repaired`).
 *   FIRST_FAIL     step 1 failed for any other reason (a harness bug).
 *   SKIPPED        the case's precondition is missing (e.g. no second Node).
 *
 * Usage:
 *   tsx scripts/turbo-stale-cache-harness.ts            # all cases, table
 *   tsx scripts/turbo-stale-cache-harness.ts c3-template c5-lockfile-closure
 *
 * The committed test (scripts/__tests__/turbo-stale-cache.test.ts) asserts no
 * case is STALE.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Repo files the fixture copies verbatim when they exist: the root test-cache
 * config and everything a package's test task loads from the root.
 */
const COPIED = [
  "turbo.json",
  "vitest.shared.ts",
  "tsconfig.base.json",
  ".node-version",
  "scripts/test-support",
  "scripts/turbo-run.mjs",
];

export type Outcome = "STALE" | "MISS" | "HIT_VALID" | "TRACER_FAIL" | "FIRST_FAIL" | "SKIPPED";

export interface CaseResult {
  name: string;
  claim: string;
  outcome: Outcome;
  detail: string;
  /** For TRACER_FAIL: the repair the tracer named, and the repaired run's outcome. */
  repair?: string;
  repaired?: Outcome;
  seconds: number;
}

interface RunOpts {
  /** Extra env for this run (merged over the base env). */
  env?: Record<string, string>;
  /** Directory prepended to PATH (an alternate `node`). */
  nodeDir?: string;
  /** Run `turbo run test` directly instead of the root `scripts.test`. */
  raw?: boolean;
  force?: boolean;
}

interface RunResult {
  status: number;
  out: string;
  hit: boolean;
  miss: boolean;
}

export interface Case {
  name: string;
  claim: string;
  /** The package (in `packages/`) whose test task is observed. */
  pkg: string;
  files: Record<string, string>;
  first?: RunOpts;
  /** Change the input. Returns the opts for the second run. */
  mutate: (root: string) => RunOpts | void;
  /** Precondition; a string is the skip reason. */
  pre?: () => string | null;
  setup?: (root: string) => void;
}

// ── Fixture workspace ───────────────────────────────────────────────────

export function testFile(body: string): string {
  return (
    `import { describe, expect, it } from "vitest";\n` +
    `import { existsSync, readFileSync } from "node:fs";\n` +
    `import { dirname, join, resolve } from "node:path";\n` +
    `import { fileURLToPath } from "node:url";\n` +
    `import { createRequire } from "node:module";\n` +
    `const __dir = dirname(fileURLToPath(import.meta.url));\n` +
    `void existsSync; void join; void resolve; void createRequire; void __dir;\n` +
    body
  );
}

export function pkgJson(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      name,
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        build: "node -e 0",
        test: "vitest run",
        "test:coverage": "vitest run",
      },
      ...extra,
    },
    null,
    2,
  );
}

export const VITEST_CONFIG =
  `import { defineMotebitTest } from "../../vitest.shared.js";\n` +
  `export default defineMotebitTest({\n` +
  `  thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 },\n` +
  `});\n`;

export function lockfile(importers: Record<string, Record<string, string>>): string {
  const lines = [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
  ];
  const pkgs = new Set<string>();
  for (const [dir, deps] of Object.entries(importers)) {
    lines.push(`  ${dir}:`);
    if (Object.keys(deps).length === 0) {
      lines.push("    {}");
    } else {
      lines.push("    dependencies:");
      for (const [n, v] of Object.entries(deps)) {
        lines.push(`      ${n}:`, `        specifier: ${v}`, `        version: ${v}`);
        pkgs.add(`${n}@${v}`);
      }
    }
    lines.push("");
  }
  lines.push("packages:", "");
  for (const p of pkgs) {
    lines.push(
      `  ${p}:`,
      `    resolution: {integrity: sha512-${Buffer.from(p).toString("base64")}}`,
      "",
    );
  }
  lines.push("snapshots:", "");
  for (const p of pkgs) lines.push(`  ${p}: {}`, "");
  return lines.join("\n");
}

/** A fake external package laid out the way pnpm lays it out. */
export function fakeDep(root: string, name: string, version: string, value: number): string {
  const dir = join(root, "node_modules", ".pnpm", `${name}@${version}`, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, main: "index.cjs" }));
  writeFileSync(join(dir, "index.cjs"), `module.exports = { value: ${value} };\n`);
  return dir;
}

export function linkDep(root: string, importerDir: string, name: string, target: string): void {
  const nm = join(root, importerDir, "node_modules");
  mkdirSync(nm, { recursive: true });
  rmSync(join(nm, name), { force: true, recursive: true });
  symlinkSync(target, join(nm, name), "dir");
}

export function buildFixture(c: Case): string {
  const root = mkdtempSync(join(tmpdir(), `turbo-stale-${c.name}-`));
  for (const rel of COPIED) {
    const src = join(REPO, rel);
    if (existsSync(src)) cpSync(src, join(root, rel), { recursive: true });
  }
  const realRoot = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8")) as {
    scripts: Record<string, string>;
    packageManager: string;
  };
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "fx-root",
        private: true,
        packageManager: realRoot.packageManager,
        scripts: {
          test: realRoot.scripts.test,
          "test:coverage": realRoot.scripts["test:coverage"],
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n  - "apps/*"\n');
  writeFileSync(join(root, ".gitignore"), "node_modules\n.turbo\ncoverage\ndist\n");
  // Tooling (vitest, turbo, typescript) resolves through the real install.
  const nm = join(root, "node_modules");
  mkdirSync(join(nm, ".pnpm"), { recursive: true });
  for (const e of readdirSync(join(REPO, "node_modules"))) {
    if (e === ".pnpm" || e === ".modules.yaml") continue;
    symlinkSync(join(REPO, "node_modules", e), join(nm, e));
  }
  for (const [p, content] of Object.entries({
    [`packages/${c.pkg}/package.json`]: pkgJson(`@fx/${c.pkg}`),
    [`packages/${c.pkg}/vitest.config.ts`]: VITEST_CONFIG,
    [`packages/${c.pkg}/tsconfig.json`]: JSON.stringify({ extends: "../../tsconfig.base.json" }),
    "pnpm-lock.yaml": lockfile({ ".": {}, [`packages/${c.pkg}`]: {} }),
    ...c.files,
  })) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  c.setup?.(root);
  const git = (...a: string[]) =>
    spawnSync("git", a, { cwd: root, encoding: "utf-8", env: baseEnv() });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=h", "-c", "user.email=h@h", "commit", "-qm", "fixture");
  return root;
}

// ── Running turbo ───────────────────────────────────────────────────────

function nodeDirOf(bin: string): string {
  return dirname(bin);
}

function baseEnv(): Record<string, string> {
  // A deterministic env built from scratch: nothing from the caller's shell
  // (CI, NODE_OPTIONS, TURBO_TOKEN, …) leaks into a case unless it sets it.
  return {
    PATH: `${nodeDirOf(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: tmpdir(),
    TURBO_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    TURBO_NO_UPDATE_NOTIFIER: "1",
    TURBO_PRINT_VERSION_DISABLED: "1",
  };
}

function runTurbo(root: string, pkg: string, o: RunOpts = {}): Promise<RunResult> {
  const scripts = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const base = o.raw ? "turbo run test" : scripts.test;
  const args = [`--filter=@fx/${pkg}`, "--ui=stream", "--output-logs=full"];
  if (o.force) args.push("--force");
  const env = baseEnv();
  // pnpm's `node_modules/.bin` shims, as `pnpm run` would put on PATH.
  env.PATH = `${join(root, "node_modules", ".bin")}:${env.PATH}`;
  if (o.nodeDir) env.PATH = `${o.nodeDir}:${env.PATH}`;
  Object.assign(env, o.env ?? {});
  return new Promise((res) => {
    const child = spawn("sh", ["-c", `${base} ${args.join(" ")}`], { cwd: root, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const task = `@fx/${pkg}:test:`;
      const lines = out.split("\n").filter((l) => l.includes(task));
      res({
        status: code ?? 1,
        out,
        hit: lines.some((l) => /cache hit/.test(l)),
        miss: lines.some((l) => /cache (miss|bypass)/.test(l)),
      });
    });
  });
}

const REPAIR = /REPAIR-JSON (\{.*\})/;

interface Repair {
  file: string;
  tasks: string[];
  key: "inputs" | "env";
  add: string;
}

function applyRepair(root: string, r: Repair): void {
  const file = join(root, r.file);
  const cfg: { extends?: string[]; tasks?: Record<string, Record<string, string[]>> } = existsSync(
    file,
  )
    ? (JSON.parse(readFileSync(file, "utf-8")) as {
        tasks?: Record<string, Record<string, string[]>>;
      })
    : { extends: ["//"], tasks: {} };
  cfg.tasks ??= {};
  for (const t of r.tasks) {
    const task = (cfg.tasks[t] ??= {});
    const list = (task[r.key] ??= r.key === "inputs" ? ["$TURBO_DEFAULT$"] : []);
    if (!list.includes(r.add)) list.push(r.add);
  }
  writeFileSync(file, JSON.stringify(cfg, null, 2));
}

async function runCase(c: Case): Promise<CaseResult> {
  const t0 = Date.now();
  const done = (outcome: Outcome, detail: string, extra: Partial<CaseResult> = {}): CaseResult => ({
    name: c.name,
    claim: c.claim,
    outcome,
    detail,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    ...extra,
  });
  const skip = c.pre?.();
  if (skip) return done("SKIPPED", skip);
  const root = buildFixture(c);
  try {
    const flow = async (): Promise<[Outcome, string]> => {
      const first = await runTurbo(root, c.pkg, c.first);
      if (first.status !== 0) {
        return [REPAIR.test(first.out) ? "TRACER_FAIL" : "FIRST_FAIL", tail(first.out)];
      }
      const next = c.mutate(root) ?? {};
      const second = await runTurbo(root, c.pkg, next);
      if (second.miss || !second.hit) {
        return [
          "MISS",
          `re-ran (exit ${second.status})${second.status ? ": " + tracerLine(second.out) : ""}`,
        ];
      }
      const forced = await runTurbo(root, c.pkg, { ...next, force: true });
      return forced.status !== 0
        ? ["STALE", `cache hit replayed PASS; --force FAILED: ${failLine(forced.out)}`]
        : ["HIT_VALID", "cache hit and the forced run passes"];
    };
    const [outcome, detail] = await flow();
    if (outcome !== "TRACER_FAIL") return done(outcome, detail);
    // Apply the repair the tracer named, reset the input, and re-run the case.
    const m = REPAIR.exec(detail);
    const repairs = [
      ...new Set([...detail.matchAll(new RegExp(REPAIR.source, "g"))].map((x) => x[1])),
    ].map((x) => JSON.parse(x) as Repair);
    if (!m || repairs.length === 0) return done(outcome, detail);
    for (const r of repairs) applyRepair(root, r);
    spawnSync("git", ["add", "-A"], { cwd: root });
    const [again, againDetail] = await flow();
    return done(outcome, tracerLine(detail), {
      repair: repairs.map((r) => `${r.file} ${r.key} += ${r.add}`).join("; "),
      repaired: again,
      detail: `${tracerLine(detail)} || after repair: ${again} — ${againDetail}`,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

function tail(out: string): string {
  return out.split("\n").slice(-60).join("\n");
}
function tracerLine(out: string): string {
  out = out.replace(ANSI, "");
  const l = out.split("\n").find((x) => x.includes("[input-tracer]"));
  return (l ?? out.split("\n").filter(Boolean).slice(-1)[0] ?? "").trim().slice(0, 400);
}
function failLine(out: string): string {
  const l = out
    .replace(ANSI, "")
    .split("\n")
    .find((x) => /AssertionError|Error:|FAIL/.test(x));
  return (l ?? "").trim().slice(0, 200);
}

// ── The cases ───────────────────────────────────────────────────────────

/** A Node binary of a different major than the one running the harness. */
export function altNode(): string | null {
  const want = process.env.MOTEBIT_HARNESS_ALT_NODE;
  if (want) return existsSync(want) ? want : null;
  const major = process.versions.node.split(".")[0];
  for (const cand of ["/opt/node20/bin/node", "/opt/node22/bin/node", "/opt/node24/bin/node"]) {
    if (!existsSync(cand)) continue;
    const v = spawnSync(cand, ["-p", "process.versions.node"], { encoding: "utf-8" }).stdout.trim();
    if (v && v.split(".")[0] !== major) return cand;
  }
  return null;
}

function altNodeShimDir(): string {
  const bin = altNode()!;
  const dir = mkdtempSync(join(tmpdir(), "alt-node-"));
  symlinkSync(bin, join(dir, "node"));
  return dir;
}

const SPEC_READ = (file: string, expr: string) =>
  testFile(
    `describe("spec", () => {\n  it("reads ${file}", () => {\n    expect(${expr}.trim()).toBe("v1");\n  });\n});\n`,
  );

const specCase = (name: string, claim: string, expr: (f: string) => string, pre = ""): Case => {
  const file = `spec/${name}.md`;
  return {
    name,
    claim,
    pkg: "p",
    files: {
      [file]: "v1\n",
      "packages/p/src/__tests__/read.test.ts": SPEC_READ(
        file,
        `(() => { ${pre} return ${expr(file)}; })()`,
      ),
    },
    mutate: (root) => {
      writeFileSync(join(root, file), "v2\n");
    },
  };
};

export const CASES: Case[] = [
  {
    name: "c1-node-version",
    claim: "C1: a result cached under one Node major replays under another",
    pkg: "p",
    pre: () => (altNode() ? null : "no second Node major found (set MOTEBIT_HARNESS_ALT_NODE)"),
    files: {
      "packages/p/src/__tests__/runtime.test.ts": testFile(
        `describe("runtime", () => {\n  it("needs Node >= ${process.versions.node.split(".")[0]}", () => {\n` +
          `    expect(Number(process.versions.node.split(".")[0])).toBe(${process.versions.node.split(".")[0]});\n  });\n});\n`,
      ),
    },
    mutate: () => ({ nodeDir: altNodeShimDir() }),
  },
  {
    name: "c1-raw-turbo",
    claim: "C1: a run that bypasses the entry point replays a result for another runtime",
    pkg: "p",
    pre: () => (altNode() ? null : "no second Node major found (set MOTEBIT_HARNESS_ALT_NODE)"),
    files: {
      "packages/p/src/__tests__/runtime.test.ts": testFile(
        `describe("runtime", () => {\n  it("runs on the cached major", () => {\n` +
          `    expect(Number(process.versions.node.split(".")[0])).toBe(${process.versions.node.split(".")[0]});\n  });\n});\n`,
      ),
    },
    mutate: () => ({ nodeDir: altNodeShimDir(), raw: true }),
  },
  specCase(
    "c3-template-root",
    "C3: template literal with a path-valued span (`${ROOT}/spec/x.md`)",
    (f) => `readFileSync(\`\${ROOT}/${f}\`, "utf-8")`,
    `const ROOT = resolve(__dir, "../../../..");`,
  ),
  specCase(
    "c3-template-dirname",
    "C3: `${__dirname}/../../../../spec/x.md`",
    (f) => `readFileSync(\`\${__dir}/../../../../${f}\`, "utf-8")`,
  ),
  specCase(
    "c4-cwd-relative",
    "C4: cwd-relative read (vitest cwd is the package dir)",
    (f) => `readFileSync("../../${f}", "utf-8")`,
  ),
  specCase(
    "c4-join-literal",
    "C4: join() with a literal first argument",
    (f) => `readFileSync(join("..", "..", ${JSON.stringify(f)}), "utf-8")`,
  ),
  specCase(
    "c4-join-spread",
    "C4: join(process.cwd(), ...up, …) spread arguments",
    (f) => `readFileSync(join(process.cwd(), ...up, ${JSON.stringify(f)}), "utf-8")`,
    `const up = ["..", ".."];`,
  ),
  specCase(
    "c4-literal-collapse",
    "C4: an open read collapsing onto an unrelated globally-hashed literal",
    () => `readFileSync(join(ROOT, name), "utf-8")`,
    `const ROOT = resolve(__dir, "../../../.."); const SHARED = "vitest.shared.ts"; ` +
      `void existsSync(join(ROOT, SHARED)); const name = ["spec", "c4-literal-collapse.md"].join("/");`,
  ),
  {
    name: "c5-lockfile-closure",
    claim: "C5: a module resolved through ANOTHER package's lockfile closure",
    pkg: "se",
    files: {
      "apps/mob/package.json": pkgJson("@fx/mob", { dependencies: { "fx-fetch": "1.0.0" } }),
      "packages/se/package.json": pkgJson("@fx/se"),
      "packages/se/vitest.config.ts": VITEST_CONFIG,
      "packages/se/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json" }),
      "packages/se/turbo.json": JSON.stringify({
        extends: ["//"],
        tasks: {
          test: { inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/apps/mob/package.json"] },
          "test:coverage": { inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/apps/mob/package.json"] },
        },
      }),
      "packages/se/src/__tests__/closure.test.ts": testFile(
        `describe("closure", () => {\n  it("loads fx-fetch through apps/mob", () => {\n` +
          `    const req = createRequire(resolve(__dir, "../../../../apps/mob/package.json"));\n` +
          `    expect(req("fx-fetch").value).toBe(1);\n  });\n});\n`,
      ),
    },
    setup: (root) => {
      writeFileSync(
        join(root, "pnpm-lock.yaml"),
        lockfile({ ".": {}, "apps/mob": { "fx-fetch": "1.0.0" }, "packages/se": {} }),
      );
      linkDep(root, "apps/mob", "fx-fetch", fakeDep(root, "fx-fetch", "1.0.0", 1));
    },
    mutate: (root) => {
      // A lockfile-only bump: exactly what `pnpm update fx-fetch` would do.
      writeFileSync(
        join(root, "pnpm-lock.yaml"),
        lockfile({ ".": {}, "apps/mob": { "fx-fetch": "1.0.1" }, "packages/se": {} }),
      );
      linkDep(root, "apps/mob", "fx-fetch", fakeDep(root, "fx-fetch", "1.0.1", 2));
    },
  },
  {
    name: "c6-passthrough-env",
    claim: "C6: an unhashed pass-through env var (XDG_RUNTIME_DIR)",
    pkg: "p",
    files: {
      "packages/p/src/__tests__/env.test.ts": testFile(
        `describe("env", () => {\n  it("reads XDG_RUNTIME_DIR", () => {\n` +
          `    expect(process.env.XDG_RUNTIME_DIR).toBe("/run/user/a");\n  });\n});\n`,
      ),
    },
    first: { env: { XDG_RUNTIME_DIR: "/run/user/a" } },
    mutate: () => ({ env: { XDG_RUNTIME_DIR: "/run/user/b" } }),
  },
  {
    name: "node-options",
    claim: "NODE_OPTIONS reaches the test unhashed (--disable-proto=throw)",
    pkg: "p",
    files: {
      "packages/p/src/__tests__/proto.test.ts": testFile(
        `describe("proto", () => {\n  it("__proto__ is readable", () => {\n` +
          `    expect(() => (({}) as { __proto__?: unknown }).__proto__).not.toThrow();\n  });\n});\n`,
      ),
    },
    mutate: () => ({ env: { NODE_OPTIONS: "--disable-proto=throw" } }),
  },
];

export async function runCases(names: string[] = []): Promise<CaseResult[]> {
  const selected = names.length ? CASES.filter((c) => names.includes(c.name)) : CASES;
  return Promise.all(selected.map((c) => runCase(c)));
}

async function main(): Promise<void> {
  const results = await runCases(process.argv.slice(2));
  for (const r of results) {
    const rep = r.repair ? `  [repair: ${r.repair} → ${r.repaired}]` : "";
    console.log(
      `${r.outcome.padEnd(11)} ${r.name.padEnd(22)} ${String(r.seconds).padStart(5)}s  ${r.claim}${rep}`,
    );
    console.log(`            ${r.detail.split("\n")[0].slice(0, 300)}`);
  }
  const stale = results.filter((r) => r.outcome === "STALE" || r.repaired === "STALE").length;
  console.log(`\n${stale}/${results.length} case(s) replayed a stale cached PASS.`);
  process.exitCode = stale > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
