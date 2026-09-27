/**
 * differential-vs-main — the base side must run the same probe the head side
 * runs, every package the aperture says came from the base ref must be what
 * the probe observes, the run must refuse whenever it cannot say that, and
 * nothing here may touch a repository it did not create (#818, #833, #835).
 *
 * SAFETY (#835): this file's fixture once ran `git init`/`config`/`commit`
 * with the caller's environment. Under `pnpm test:gates` from a pre-push hook
 * in a linked worktree, GIT_DIR pointed at the real repository, so those
 * commands rewrote the real repository (core.bare=true, user=fixture, and a
 * commit deleting every tracked file, which was then pushed). Rules now:
 *   - every child process gets `cleanEnv()` (EVERY `GIT_*` removed) and an
 *     explicit `cwd` inside this test's temp dir;
 *   - every git command runs through `fxGit`, which sets
 *     GIT_CEILING_DIRECTORIES to the temp dir and, before any command that
 *     writes, asserts `git rev-parse --absolute-git-dir` resolves inside the
 *     temp dir (and throws otherwise);
 *   - the "decoy" test runs the whole fixture and the script with GIT_DIR /
 *     GIT_WORK_TREE / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY / GIT_COMMON_DIR
 *     aimed at a DECOY repository in another temp dir, and asserts the decoy's
 *     config, HEAD, refs and index are byte-identical afterwards.
 *
 * Layers:
 *   - Unit (always on, milliseconds).
 *   - Behavioural fixture (always on, in `pnpm test:gates`; ~40 s): a
 *     five-package mini-workspace in a temp dir with its own git history. The
 *     change between its "main" commit and its head commit is one string in
 *     `@fx/proto`; the probe (in `apps/mobile`) sees it only (a) through
 *     `@fx/bundler`, whose build INLINES proto's value, via a `pretest` that
 *     generates a file from the bundle — apps/mobile ← render-engine's
 *     browser.iife.js ← protocol — and (b) through `@fx/hoisted`, declared only
 *     by the root package.json — surface-kit ← semiring. proto and hoisted
 *     build with the real `tsc -b`, so the staleness repair is exercised
 *     against tsc's real skip behaviour.
 *   - Real-repo smoke (opt-in, `MOTEBIT_DIFFERENTIAL_SMOKE=1`, 2-3 min once the
 *     working tree is built): a planted protocol change observed through
 *     mobile's creature bundle and through semiring from surface-kit. The
 *     planted base commit lives in a temp bare repository whose object store
 *     borrows the real one READ-ONLY through `objects/info/alternates`; the
 *     script reads it with `--base-repo`. Nothing is written to the real
 *     repository.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  READ_ONLY_GIT,
  baseBuildCommand,
  cleanEnv,
  dependencyClosure,
  isBuildInput,
  mirrorNodeModules,
  packageDirOf,
  readGit,
  topoOrder,
  type WorkspacePackage,
} from "../lib/differential-tree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = realpathSync(resolve(__dirname, "..", ".."));
const SCRIPT = resolve(ROOT, "scripts", "differential-vs-main.ts");
const TSX = resolve(ROOT, "node_modules", ".bin", "tsx");
const ROOTS = ["packages", "apps", "services"];

/** A child's output as a failure message: its tail, printable characters only. */
function show(r: { stdout: string | null; stderr: string | null }): string {
  // Stack frames are dropped: vitest tries to source-map any it finds in a message.
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`
    .split("\n")
    .filter((l) => !/^\s+at /.test(l))
    .join("\n")
    .slice(-4000)
    .replace(/[^\t\n\x20-\x7e]/g, "?");
}

// ── Guarded process helpers ────────────────────────────────────────────

const inside = (dir: string, p: string) => {
  const d = realpathSync(dir);
  const r = realpathSync(p);
  return r === d || r.startsWith(d + sep);
};

/** git subcommands that never write a repository. */
const GIT_READS = new Set(["rev-parse", "show", "ls-files", "cat-file", "log", "rev-list"]);

/**
 * Run git in `cwd` (which must be inside `jail`) with every GIT_* from
 * `baseEnv` removed, discovery fenced at `jail`, and — for anything that
 * writes — a check that the repository it would write resolves inside `jail`.
 */
function fxGit(
  jail: string,
  cwd: string,
  args: string[],
  opts: { baseEnv?: NodeJS.ProcessEnv; extraEnv?: Record<string, string>; input?: string } = {},
): string {
  if (!inside(jail, cwd)) throw new Error(`fxGit: cwd ${cwd} is outside ${jail}`);
  const env = cleanEnv(opts.baseEnv ?? process.env, {
    GIT_CEILING_DIRECTORIES: realpathSync(jail),
    ...opts.extraEnv,
  });
  const run = (a: string[], input?: string) => {
    const r = spawnSync("git", a, { cwd, env, encoding: "utf8", input });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed in ${cwd}:\n${r.stderr}`);
    return r.stdout;
  };
  /** The repository git would act on from `cwd` with `env`, or null when there is none. */
  const repoFor = (): string | null => {
    const r = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, env, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const assertJailed = (gitDir: string | null) => {
    if (gitDir == null || !isAbsolute(gitDir) || !inside(jail, gitDir)) {
      throw new Error(
        `fxGit: refusing \`git ${args.join(" ")}\` — it would act on ${gitDir ?? "no repository"}, not a repository inside ${jail}`,
      );
    }
  };
  const sub = args[0] ?? "";
  if (sub === "init") {
    // Before init: git must not already resolve to a repository outside the jail
    // (a leaked GIT_DIR would make `init` re-initialise THAT repository).
    const existing = repoFor();
    if (existing != null) assertJailed(existing);
  } else if (!GIT_READS.has(sub)) {
    assertJailed(repoFor());
  }
  const out = run(args, opts.input);
  if (sub === "init") assertJailed(repoFor());
  return out;
}

/** A non-git child (sh, node, pnpm) inside `jail`, with GIT_* scrubbed. */
function fxRun(
  jail: string,
  cwd: string,
  cmd: string,
  args: string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
): string {
  if (!inside(jail, cwd)) throw new Error(`fxRun: cwd ${cwd} is outside ${jail}`);
  const r = spawnSync(cmd, args, { cwd, env: cleanEnv(baseEnv), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${show(r)}`);
  return r.stdout;
}

// ── Units ──────────────────────────────────────────────────────────────

const pkg = (dir: string, name: string, deps: string[]): [string, WorkspacePackage] => [
  dir,
  { dir, name, deps, scripts: {} },
];

describe("differential-tree units", () => {
  it("cleanEnv removes every GIT_* variable and keeps the rest", () => {
    const env = cleanEnv({
      GIT_DIR: "/x",
      GIT_WORK_TREE: "/y",
      GIT_INDEX_FILE: "/z",
      GIT_OBJECT_DIRECTORY: "/o",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/a",
      GIT_COMMON_DIR: "/c",
      GIT_CEILING_DIRECTORIES: "/d",
      PATH: "/bin",
    });
    expect(Object.keys(env).filter((k) => k.startsWith("GIT_"))).toEqual([]);
    expect(env.PATH).toBe("/bin");
  });

  it("the script's git helper runs only read-only subcommands", () => {
    expect([...READ_ONLY_GIT].sort()).toEqual(["archive", "ls-files", "rev-parse"]);
    for (const sub of ["init", "config", "commit", "update-ref", "checkout", "reset"]) {
      expect(() => readGit(tmpdir(), [sub])).toThrow(/only .* are allowed/);
    }
  });

  it("maps a path to its workspace package, and nothing outside the workspace", () => {
    expect(packageDirOf("packages/surface-kit/src/index.ts", ROOTS)).toBe("packages/surface-kit");
    expect(packageDirOf("apps/web", ROOTS)).toBe("apps/web");
    expect(packageDirOf("tsconfig.base.json", ROOTS)).toBeNull();
  });

  it("build inputs are every non-test file outside dist", () => {
    expect(isBuildInput("src/index.ts")).toBe(true);
    expect(isBuildInput("scripts/build-browser.mjs")).toBe(true);
    expect(isBuildInput("package.json")).toBe(true);
    expect(isBuildInput("tsup.config.ts")).toBe(true);
    expect(isBuildInput("dist/index.js")).toBe(false);
    expect(isBuildInput("src/__tests__/x.ts")).toBe(false);
    expect(isBuildInput("src/a.test.ts")).toBe(false);
  });

  it("orders rebuilds dependencies first", () => {
    const byDir = new Map([
      pkg("packages/a", "@m/a", ["@m/b"]),
      pkg("packages/b", "@m/b", ["@m/c"]),
      pkg("packages/c", "@m/c", []),
    ]);
    expect(topoOrder(["packages/a", "packages/b", "packages/c"], byDir)).toEqual([
      "packages/c",
      "packages/b",
      "packages/a",
    ]);
  });

  it("counts a root-hoisted package as reachable from every package", () => {
    const byDir = new Map([
      pkg("packages/host", "@m/host", []),
      pkg("packages/hoisted", "@m/hoisted", ["@m/core"]),
      pkg("packages/core", "@m/core", []),
    ]);
    expect(dependencyClosure("packages/host", byDir).has("packages/core")).toBe(false);
    expect(dependencyClosure("packages/host", byDir, ["@m/hoisted"]).has("packages/core")).toBe(
      true,
    );
  });

  it("rewrites tsc build mode so a base rebuild never walks into the working tree", () => {
    expect(baseBuildCommand("tsc -b")).toBe("tsc -p tsconfig.json");
    expect(baseBuildCommand("tsc -b && pnpm run build:browser")).toBe(
      "tsc -p tsconfig.json && pnpm run build:browser",
    );
    expect(baseBuildCommand("tsup")).toBe("tsup");
    expect(baseBuildCommand("echo 'Mobile build via EAS'")).toBeNull();
  });

  it("mirrors node_modules: relative workspace links land in the mirror's tree; caches are not mirrored", () => {
    const t = realpathSync(mkdtempSync(join(tmpdir(), "diff-mirror-")));
    try {
      for (const side of ["head", "base"]) {
        mkdirSync(join(t, side, "pkgs", "b"), { recursive: true });
        writeFileSync(join(t, side, "pkgs", "b", "who"), side);
      }
      const nm = join(t, "head", "pkgs", "a", "node_modules");
      mkdirSync(join(nm, "@m"), { recursive: true });
      symlinkSync("../../../b", join(nm, "@m", "b")); // pnpm's shape
      mkdirSync(join(nm, ".bin"));
      mkdirSync(join(nm, ".vite"));
      mkdirSync(join(nm, ".vite-temp"));
      const out = join(t, "base", "pkgs", "a", "node_modules");
      mirrorNodeModules(nm, out);
      expect(readFileSync(join(out, "@m", "b", "who"), "utf-8")).toBe("base");
      expect(realpathSync(join(out, ".bin"))).toBe(join(nm, ".bin"));
      expect(existsSync(join(out, ".vite"))).toBe(false);
      expect(existsSync(join(out, ".vite-temp"))).toBe(false);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

// ── Behavioural fixture ────────────────────────────────────────────────

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const BUNDLER_BUILD = `import { VALUE } from "@fx/proto";
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.js", "export const BUNDLED = " + JSON.stringify(VALUE) + ";\\n");
`;
const TSCONFIG_BASE = json({
  compilerOptions: {
    composite: true,
    declaration: true,
    module: "nodenext",
    moduleResolution: "nodenext",
    target: "es2022",
    strict: true,
    skipLibCheck: true,
    types: [],
  },
});

interface Fixture {
  jail: string;
  root: string;
  mainSha: string;
}

/**
 * A mini-workspace whose only difference between `main` and head is one
 * string in @fx/proto, reachable from apps/mobile only through a bundle and
 * through a root-hoisted package. Every git and build command is jailed to
 * `jail` and runs with GIT_* scrubbed from `baseEnv`.
 */
function buildFixture(jail: string, baseEnv: NodeJS.ProcessEnv = process.env): Fixture {
  const root = join(jail, "repo");
  write(
    join(root, "package.json"),
    json({ name: "fx-root", private: true, devDependencies: { "@fx/hoisted": "workspace:*" } }),
  );
  write(
    join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\n  - "apps/*"\n  - "services/*"\n',
  );
  write(join(root, ".gitignore"), "node_modules\ndist\n*.tsbuildinfo\n*.generated.txt\n");
  write(join(root, "tsconfig.base.json"), TSCONFIG_BASE);

  const lib = (name: string, deps: string[], build: string, files: Record<string, string>) => {
    const d = join(root, "packages", name);
    write(
      join(d, "package.json"),
      json({
        name: `@fx/${name}`,
        type: "module",
        main: "dist/index.js",
        types: "dist/index.d.ts",
        scripts: { build },
        dependencies: Object.fromEntries(deps.map((x) => [x, "workspace:*"])),
      }),
    );
    for (const [f, c] of Object.entries(files)) write(join(d, f), c);
  };
  const tsconfig = (refs: string[]) =>
    json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { outDir: "dist", rootDir: "src" },
      include: ["src"],
      references: refs.map((path) => ({ path })),
    });
  lib("proto", [], "tsc -b", {
    "tsconfig.json": tsconfig([]),
    "src/index.ts": 'export const VALUE: string = "main";\n',
  });
  // The bundler INLINES proto's value at build time (render-engine's browser bundle).
  lib("bundler", ["@fx/proto"], "node build.mjs", {
    "build.mjs": BUNDLER_BUILD,
    "src/index.js": "// Bundled at build time from @fx/proto; see build.mjs.\n",
  });
  // Re-exports proto at runtime; declared only by the ROOT package.json (semiring).
  lib("hoisted", ["@fx/proto"], "tsc -b", {
    "tsconfig.json": tsconfig(["../proto"]),
    "src/index.ts": 'export { VALUE } from "@fx/proto";\n',
  });

  const mobile = join(root, "apps", "mobile");
  write(
    join(mobile, "package.json"),
    json({
      name: "@fx/mobile",
      type: "module",
      scripts: { pretest: "node gen.mjs" },
      dependencies: { "@fx/bundler": "workspace:*" },
    }),
  );
  // Generated from the bundle before tests (apps/mobile's creature bundle).
  write(
    join(mobile, "gen.mjs"),
    `import { BUNDLED } from "@fx/bundler";
import { writeFileSync } from "node:fs";
writeFileSync("src/bundle.generated.txt", BUNDLED);
`,
  );
  write(join(mobile, "src", "__tests__", ".gitkeep"), "");
  const relay = join(root, "services", "relay");
  write(join(relay, "package.json"), json({ name: "@fx/relay", type: "module" }));
  write(join(relay, "src", "__tests__", ".gitkeep"), "");

  // pnpm's node_modules shape, with the real repo's vitest and typescript.
  const nm = join(root, "node_modules");
  mkdirSync(join(nm, "@fx"), { recursive: true });
  symlinkSync("../../packages/hoisted", join(nm, "@fx", "hoisted"));
  const vitestDir = realpathSync(join(ROOT, "node_modules", "vitest"));
  const tsDir = realpathSync(join(ROOT, "node_modules", "typescript"));
  symlinkSync(vitestDir, join(nm, "vitest"));
  symlinkSync(tsDir, join(nm, "typescript"));
  write(join(nm, ".bin", "vitest"), `#!/bin/sh\nexec node "${vitestDir}/vitest.mjs" "$@"\n`);
  write(join(nm, ".bin", "tsc"), `#!/bin/sh\nexec node "${tsDir}/bin/tsc" "$@"\n`);
  fxRun(jail, root, "chmod", ["+x", join(nm, ".bin", "vitest"), join(nm, ".bin", "tsc")], baseEnv);
  const link = (from: string, name: string, target: string) => {
    mkdirSync(join(root, from, "node_modules", "@fx"), { recursive: true });
    symlinkSync(target, join(root, from, "node_modules", "@fx", name));
  };
  link("packages/bundler", "proto", "../../../proto");
  link("packages/hoisted", "proto", "../../../proto");
  link("apps/mobile", "bundler", "../../../../packages/bundler");

  const git = (...args: string[]) => fxGit(jail, root, args, { baseEnv }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "main");
  const mainSha = git("rev-parse", "HEAD");
  write(
    join(root, "packages", "proto", "src", "index.ts"),
    'export const VALUE: string = "head";\n',
  );
  git("commit", "-q", "-am", "head: proto says head");
  const fx = { jail, root, mainSha };
  buildAll(fx, baseEnv);
  return fx;
}

/** Build the fixture's head packages in dependency order, as a developer would. */
function buildAll(fx: Fixture, baseEnv: NodeJS.ProcessEnv = process.env): void {
  const tsc = join(fx.root, "node_modules", ".bin", "tsc");
  fxRun(fx.jail, join(fx.root, "packages", "proto"), tsc, ["-b"], baseEnv);
  fxRun(fx.jail, join(fx.root, "packages", "hoisted"), tsc, ["-b"], baseEnv);
  fxRun(fx.jail, join(fx.root, "packages", "bundler"), "node", ["build.mjs"], baseEnv);
}

/** Set the mtime of every file under `dir` (skipping node_modules) to `t` seconds. */
function setTimes(dir: string, t: number, pick: (rel: string) => boolean): void {
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(d, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else if (lstatSync(p).isFile() && pick(r)) utimesSync(p, t, t);
    }
  };
  walk(dir, "");
}

const FIXTURE_PROBE = `import { afterAll, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
const obs: Record<string, unknown> = {};
it("observes", async () => {
  if (process.env.FX_MODE === "mobile") {
    obs.throughBundle = readFileSync("src/bundle.generated.txt", "utf-8");
    obs.throughRootHoisted = ((await import("@fx/hoisted")) as { VALUE: string }).VALUE;
  } else {
    obs.cwdTail = process.cwd().split("/").slice(-2).join("/");
  }
});
afterAll(() => { writeFileSync(process.env.PROBE_OUT!, JSON.stringify(obs)); });
`;

interface Report {
  pkg: string;
  pkgReason: string;
  aperture: {
    fromMain: string[];
    rebuiltFromMain: string[];
    rebuiltFromHead: string[];
    rootWorkspaceDeps: string[];
    rootHeldAtHead: string[];
  };
  head: Record<string, unknown>;
  baseObs: Record<string, unknown>;
}

/** Run the real script; `env` is passed AS GIVEN (the script must scrub it itself). */
function runScript(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(TSX, [SCRIPT, ...args], { cwd, encoding: "utf8", env });
}

function mobileArgs(fx: Fixture, out: string, fromMain = "packages/proto"): string[] {
  return [
    "--probe",
    join(fx.jail, "fixture.probe.ts"),
    "--pkg",
    "apps/mobile",
    "--base",
    fx.mainSha,
    "--from-main",
    fromMain,
    "--out",
    out,
  ];
}

const fxEnv = (extra: Record<string, string> = {}) => cleanEnv(process.env, extra);

describe("differential-vs-main behaviour (fixture)", () => {
  let fx: Fixture;
  beforeAll(() => {
    const jail = realpathSync(mkdtempSync(join(tmpdir(), "diff-fixture-")));
    fx = buildFixture(jail);
    writeFileSync(join(jail, "fixture.probe.ts"), FIXTURE_PROBE); // outside the workspace
  }, 60_000);
  afterAll(() => rmSync(fx.jail, { recursive: true, force: true }));

  it("a change reachable only through a bundle, and only through a root-hoisted package, reads DIFF", () => {
    const out = join(fx.jail, "mobile.json");
    const r = runScript(fx.root, mobileArgs(fx, out), fxEnv({ FX_MODE: "mobile" }));
    expect(r.status, show(r)).toBe(0);
    const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
    expect(rep.head).toEqual({ throughBundle: "head", throughRootHoisted: "head" });
    // The aperture says proto came from main; the probe must SEE main's proto both ways.
    expect(rep.baseObs).toEqual({ throughBundle: "main", throughRootHoisted: "main" });
    expect(rep.aperture.fromMain).toEqual(["apps/mobile", "packages/proto"]);
    expect(rep.aperture.rebuiltFromMain).toEqual(["packages/proto"]);
    expect([...rep.aperture.rebuiltFromHead].sort()).toEqual([
      "packages/bundler",
      "packages/hoisted",
    ]);
    expect(rep.aperture.rootHeldAtHead).toEqual([]);
    expect(r.stdout).not.toMatch(/reach a [0-9a-f]/);
  }, 120_000);

  it("a probe outside the workspace with no --pkg runs in services/relay, and says so", () => {
    const out = join(fx.jail, "relay.json");
    const r = runScript(
      fx.root,
      [
        "--probe",
        join(fx.jail, "fixture.probe.ts"),
        "--base",
        fx.mainSha,
        "--from-main",
        "host",
        "--out",
        out,
      ],
      fxEnv(),
    );
    expect(r.status, show(r)).toBe(0);
    const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
    expect(rep.pkg).toBe("services/relay");
    expect(rep.pkgReason).toMatch(/default/);
    expect(rep.baseObs.cwdTail).toBe("services/relay");
    expect(r.stdout).toContain("default: the probe is outside every workspace package");
  }, 120_000);

  it("a root file builds read (tsconfig.base.json) differing from main refuses; --root-from-head says it is not differentialled", () => {
    const file = join(fx.root, "tsconfig.base.json");
    write(
      file,
      TSCONFIG_BASE.replace('"strict": true', '"strict": true,\n    "removeComments": true'),
    );
    try {
      const out = join(fx.jail, "root.json");
      const refused = runScript(fx.root, mobileArgs(fx, out), fxEnv({ FX_MODE: "mobile" }));
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("refused");
      expect(refused.stderr).toContain("tsconfig.base.json");
      expect(existsSync(out)).toBe(false);

      const held = runScript(
        fx.root,
        [...mobileArgs(fx, out), "--root-from-head"],
        fxEnv({ FX_MODE: "mobile" }),
      );
      expect(held.status, show(held)).toBe(0);
      const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
      expect(rep.aperture.rootHeldAtHead).toEqual(["tsconfig.base.json"]);
      expect(held.stdout).toContain("NOT differentialled");
    } finally {
      write(file, TSCONFIG_BASE);
    }
  }, 120_000);

  it("a changed build input outside src/ refuses until rebuilt, then reads DIFF", () => {
    const file = join(fx.root, "packages", "bundler", "build.mjs");
    write(file, BUNDLER_BUILD.replace("JSON.stringify(VALUE)", 'JSON.stringify("v2:" + VALUE)'));
    try {
      const out = join(fx.jail, "outside-src.json");
      const args = mobileArgs(fx, out, "packages/bundler");
      const refused = runScript(fx.root, args, fxEnv({ FX_MODE: "mobile" }));
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("packages/bundler");
      const repair = /Fix: (pnpm .*)$/m.exec(refused.stderr)?.[1];
      expect(repair).toContain("--filter ./packages/bundler");
      fxRun(fx.jail, fx.root, "sh", ["-c", repair!]);

      const r = runScript(fx.root, args, fxEnv({ FX_MODE: "mobile" }));
      expect(r.status, show(r)).toBe(0);
      const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
      expect(rep.head.throughBundle).toBe("v2:head");
      expect(rep.baseObs.throughBundle).toBe("head"); // main's build.mjs, over the working tree's proto
    } finally {
      write(file, BUNDLER_BUILD);
      buildAll(fx);
    }
  }, 180_000);

  /**
   * Every build input older than every build (proto built before its
   * dependents, so they are up to date with it), then proto's source touched
   * without changing its content. tsc -b re-checks proto, emits NOTHING and
   * refreshes only proto's tsbuildinfo.
   */
  function touchProtoSource(): void {
    const now = Date.now() / 1000;
    for (const p of ["proto", "hoisted", "bundler"]) {
      const d = join(fx.root, "packages", p);
      setTimes(d, now - 120, (r) => !r.startsWith("dist/") && !r.endsWith(".tsbuildinfo"));
      const built = p === "proto" ? now - 90 : now - 60;
      setTimes(d, built, (r) => r.startsWith("dist/") || r.endsWith(".tsbuildinfo"));
    }
    const touched = join(fx.root, "packages", "proto", "src", "index.ts");
    utimesSync(touched, now - 30, now - 30);
  }

  it("the printed repair clears a staleness refusal in one round", () => {
    touchProtoSource();
    const out = join(fx.jail, "repair.json");
    const refused = runScript(fx.root, mobileArgs(fx, out), fxEnv({ FX_MODE: "mobile" }));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("refused");
    expect(refused.stderr).toContain("packages/proto");
    const repair = /Fix: (pnpm .*)$/m.exec(refused.stderr)?.[1];
    expect(repair).toBeDefined();
    fxRun(fx.jail, fx.root, "sh", ["-c", repair!]);

    const r = runScript(fx.root, mobileArgs(fx, out), fxEnv({ FX_MODE: "mobile" }));
    expect(r.status, `after \`${repair}\`:\n${show(r)}`).toBe(0);
  }, 180_000);

  it("a dependency re-checked without re-emitting does not make its dependents stale", () => {
    // The #835 regression: rebuilding ONLY proto refreshes its tsbuildinfo, not
    // its output; hoisted consumes that output, which did not change, and
    // tsc -b will never touch hoisted for it. A check against proto's
    // tsbuildinfo would refuse forever; the check reads proto's emitted output.
    touchProtoSource();
    fxRun(
      fx.jail,
      join(fx.root, "packages", "proto"),
      join(fx.root, "node_modules", ".bin", "tsc"),
      ["-b"],
    );
    const out = join(fx.jail, "recheck.json");
    const r = runScript(fx.root, mobileArgs(fx, out), fxEnv({ FX_MODE: "mobile" }));
    expect(r.status, show(r)).toBe(0);
  }, 180_000);
});

// ── Decoy: the fixture and the script must never touch a repository they did not create ──

function snapshotRepo(gitDir: string): string {
  const files: Record<string, string> = {};
  const add = (rel: string) => {
    const p = join(gitDir, rel);
    if (!existsSync(p)) return;
    if (lstatSync(p).isDirectory()) {
      for (const e of readdirSync(p)) add(`${rel}/${e}`);
    } else files[rel] = readFileSync(p).toString("base64");
  };
  for (const rel of ["config", "HEAD", "index", "packed-refs", "refs"]) add(rel);
  return JSON.stringify(files);
}

describe("differential-vs-main safety (decoy repository)", () => {
  it("with GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/… aimed at a decoy, the fixture and the script leave the decoy byte-identical", () => {
    const decoyJail = realpathSync(mkdtempSync(join(tmpdir(), "diff-decoy-")));
    const fxJail = realpathSync(mkdtempSync(join(tmpdir(), "diff-decoy-fixture-")));
    try {
      const decoy = join(decoyJail, "decoy");
      write(join(decoy, "README"), "decoy\n");
      const dg = (...args: string[]) => fxGit(decoyJail, decoy, args);
      dg("init", "-q", "-b", "decoy");
      dg("config", "user.email", "decoy@example.invalid");
      dg("config", "user.name", "decoy");
      dg("config", "commit.gpgsign", "false");
      dg("add", "-A");
      dg("commit", "-q", "-m", "decoy");
      const gitDir = join(decoy, ".git");
      const before = snapshotRepo(gitDir);

      // What a pre-push hook in a linked worktree exports.
      const hostile: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: decoy,
        GIT_INDEX_FILE: join(gitDir, "index"),
        GIT_OBJECT_DIRECTORY: join(gitDir, "objects"),
        GIT_COMMON_DIR: gitDir,
      };
      let failure: unknown = null;
      let fx: Fixture | null = null;
      let r: ReturnType<typeof runScript> | null = null;
      const out = join(fxJail, "decoy.json");
      try {
        fx = buildFixture(fxJail, hostile);
        writeFileSync(join(fxJail, "fixture.probe.ts"), FIXTURE_PROBE);
        r = runScript(fx.root, mobileArgs(fx, out), { ...hostile, FX_MODE: "mobile" });
      } catch (err) {
        failure = err;
      }
      // First and whatever happened above: the decoy is byte-identical.
      expect(snapshotRepo(gitDir)).toBe(before);
      if (failure != null) throw failure;
      expect(r!.status, show(r!)).toBe(0);
      const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
      expect(rep.baseObs).toEqual({ throughBundle: "main", throughRootHoisted: "main" });
      // The fixture's history went to the fixture's own repository.
      expect(fxGit(fxJail, fx!.root, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
    } finally {
      rmSync(decoyJail, { recursive: true, force: true });
      rmSync(fxJail, { recursive: true, force: true });
    }
  }, 180_000);
});

// ── Real-repo smoke (opt-in) ───────────────────────────────────────────

const SMOKE = process.env.MOTEBIT_DIFFERENTIAL_SMOKE === "1";
const PLANT_MODE = "full-planted-818";
const PLANT_SCORE = 0.918;

/**
 * HEAD + a planted protocol change, as a commit in a TEMP bare repository
 * whose object store borrows the real one read-only (objects/info/alternates).
 * Every write is jailed to `jail`; the real repository is only read.
 */
function plantedBase(jail: string): { repo: string; sha: string } {
  const repo = join(jail, "planted.git");
  mkdirSync(repo);
  fxGit(jail, repo, ["init", "-q", "--bare"]);
  const common = readGit(ROOT, ["rev-parse", "--git-common-dir"]).trim();
  const objects = resolve(ROOT, common, "objects");
  write(join(repo, "objects", "info", "alternates"), `${objects}\n`);
  const headSha = readGit(ROOT, ["rev-parse", "HEAD"]).trim();
  const g = (args: string[], input?: string) =>
    fxGit(jail, repo, args, {
      extraEnv: { GIT_INDEX_FILE: join(jail, "planted.index") },
      input,
    }).trim();
  g(["read-tree", headSha]);
  const plant = (path: string, from: string, to: string) => {
    const before = g(["show", `${headSha}:${path}`]);
    expect(before).toContain(from);
    const blob = g(["hash-object", "-w", "--stdin"], `${before.replace(from, to)}\n`);
    g(["update-index", "--cacheinfo", `100644,${blob},${path}`]);
  };
  plant("packages/protocol/src/index.ts", 'Full = "full",', `Full = "${PLANT_MODE}",`);
  plant("packages/protocol/src/trust-algebra.ts", "trusted: 0.9,", `trusted: ${PLANT_SCORE},`);
  const tree = g(["write-tree"]);
  const sha = g([
    "-c",
    "user.name=smoke",
    "-c",
    "user.email=smoke@example.invalid",
    "commit-tree",
    tree,
    "-p",
    headSha,
    "-m",
    "differential smoke: planted protocol",
  ]);
  return { repo, sha };
}

const SMOKE_PROBE = `import { afterAll, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
const obs: Record<string, unknown> = {};
it("observes", async () => {
  const mode = process.env.SMOKE_MODE;
  if (mode === "mobile") {
    const bundle = readFileSync("src/creature-webview-bundle.generated.ts", "utf-8");
    obs.plantedInCreatureBundle = bundle.includes(${JSON.stringify(PLANT_MODE)});
  } else if (mode === "surface-kit") {
    const semiring = (await import("@motebit/semiring")) as { trustLevelToScore(l: string): number };
    obs.trustedScoreViaSemiring = semiring.trustLevelToScore("trusted");
  } else {
    obs.ran = true;
  }
});
afterAll(() => { writeFileSync(process.env.PROBE_OUT!, JSON.stringify(obs)); });
`;

describe.skipIf(!SMOKE)(
  "differential-vs-main real-repo smoke (MOTEBIT_DIFFERENTIAL_SMOKE=1)",
  () => {
    let jail: string;
    let planted: { repo: string; sha: string };
    let probe: string;
    beforeAll(() => {
      jail = realpathSync(mkdtempSync(join(tmpdir(), "diff-smoke-")));
      planted = plantedBase(jail);
      probe = join(jail, "smoke.probe.ts");
      writeFileSync(probe, SMOKE_PROBE);
    });
    afterAll(() => rmSync(jail, { recursive: true, force: true }));

    function run(args: string[], mode: string): Report {
      const out = join(jail, `${mode}.json`);
      const r = runScript(
        ROOT,
        [
          "--probe",
          probe,
          "--base-repo",
          planted.repo,
          "--base",
          planted.sha,
          "--out",
          out,
          ...args,
        ],
        fxEnv({ SMOKE_MODE: mode }),
      );
      expect(r.status, show(r)).toBe(0);
      return JSON.parse(readFileSync(out, "utf-8")) as Report;
    }

    it("services/relay by default for an out-of-workspace probe", () => {
      const rep = run(["--from-main", "host"], "relay");
      expect(rep.pkg).toBe("services/relay");
      expect(rep.baseObs.ran).toBe(true);
    }, 600_000);

    it("a protocol change seen through mobile's creature bundle (render-engine's browser.iife.js) reads DIFF", () => {
      const rep = run(["--pkg", "apps/mobile", "--from-main", "packages/protocol"], "mobile");
      expect(rep.head.plantedInCreatureBundle).toBe(false);
      expect(rep.baseObs.plantedInCreatureBundle).toBe(true);
      expect(rep.aperture.rebuiltFromHead).toContain("packages/render-engine");
    }, 1_200_000);

    it("a protocol change seen through root-hoisted semiring from surface-kit reads DIFF", () => {
      const rep = run(
        ["--pkg", "packages/surface-kit", "--from-main", "packages/protocol"],
        "surface-kit",
      );
      expect(rep.head.trustedScoreViaSemiring).toBe(0.9);
      expect(rep.baseObs.trustedScoreViaSemiring).toBe(PLANT_SCORE);
      expect(rep.aperture.rebuiltFromHead).toContain("packages/semiring");
    }, 1_200_000);
  },
);
