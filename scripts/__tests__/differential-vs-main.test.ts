/**
 * differential-vs-main — both sides are built fresh from source, every
 * package the aperture says came from the base ref must be what the probe
 * observes, the run must refuse whenever it cannot say that, and nothing here
 * may touch a repository it did not create (#818, #833, #835, #837).
 *
 * SAFETY (#835): this file's fixture once ran `git init`/`config`/`commit`
 * with the caller's environment. Under `pnpm test:gates` from a pre-push hook
 * in a linked worktree, GIT_DIR pointed at the real repository, so those
 * commands rewrote the real repository. Rules now:
 *   - every child process gets `fixtureGitEnv()` (EVERY `GIT_*` removed) and an
 *     explicit `cwd` inside this test's temp dir;
 *   - every git command runs through `fxGit`, which sets
 *     GIT_CEILING_DIRECTORIES to the temp dir and, before any command that
 *     writes (init included), asserts `git rev-parse --absolute-git-dir`
 *     resolves inside the temp dir, and throws otherwise;
 *   - the decoy test aims GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE /
 *     GIT_OBJECT_DIRECTORY / GIT_COMMON_DIR at a DECOY repository in another
 *     temp dir, runs the whole fixture and the script, and asserts EVERY byte
 *     of the decoy (work tree and all of .git, objects included) is unchanged.
 *
 * Layers:
 *   - Unit (always on, milliseconds).
 *   - Fixture: a five-package mini-workspace in a temp dir with its own git
 *     history. The change between its "main" and head commits is one string
 *     in `@fx/proto`, built tsup-like (it re-emits on every build, as crypto
 *     does). apps/mobile sees it only through `@fx/bundler`, which INLINES it
 *     transitively via `@fx/hoisted` (tsc -b) at build time and feeds a
 *     `pretest`-generated file (apps/mobile ← render-engine's browser.iife.js
 *     ← protocol), and through `@fx/hoisted` itself, declared only by the root
 *     package.json (surface-kit ← semiring). The working tree's packages are
 *     never built; the cases plant wrong `dist` output there instead.
 *     In `pnpm test:gates`: the new-package and dependency-change refusals and the decoy test (which
 *     also asserts the bundle + root-hoisted DIFF). Every case with
 *     MOTEBIT_DIFFERENTIAL_FIXTURE=1 (`pnpm test:differential`).
 *   - Real-repo smoke (opt-in, `MOTEBIT_DIFFERENTIAL_SMOKE=1`; minutes): a
 *     planted protocol change observed through mobile's creature bundle and
 *     through semiring from surface-kit. The planted base commit lives in a
 *     temp bare repository whose object store borrows the real one READ-ONLY
 *     through `objects/info/alternates`; the script reads it with
 *     `--base-repo`. Nothing is written to the real repository.
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
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  READ_ONLY_GIT,
  baseBuildCommand,
  dependencyClosure,
  installLevelDifferences,
  mirrorNodeModules,
  packageDirOf,
  readGit,
  shimLeaks,
  topoOrder,
  type WorkspacePackage,
} from "../lib/differential-tree.js";
import { fixtureGitEnv } from "../lib/fixture-git-env.js";

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

/** `-c maintenance.auto=false` as environment: no background git outlives an fxGit call. */
const NO_AUTO_MAINTENANCE = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
};

/**
 * Run git in `cwd` (which must be inside `jail`) with every GIT_* from
 * `baseEnv` removed, discovery fenced at `jail`, and — for anything that
 * writes — a check that the repository it would write resolves inside `jail`.
 *
 * Auto-maintenance is off for every call (through the environment, so no
 * repository's config is written): `git commit` otherwise starts a DETACHED
 * `git maintenance run --auto` that outlives the call. Under git 2.55 its
 * `objects/maintenance.lock` was caught by the decoy's "before" snapshot and
 * gone by "after" — main went red on a decoy nothing had touched.
 */
function fxGit(
  jail: string,
  cwd: string,
  args: string[],
  opts: { baseEnv?: NodeJS.ProcessEnv; extraEnv?: Record<string, string>; input?: string } = {},
): string {
  if (!inside(jail, cwd)) throw new Error(`fxGit: cwd ${cwd} is outside ${jail}`);
  const env = fixtureGitEnv(opts.baseEnv ?? process.env, {
    GIT_CEILING_DIRECTORIES: realpathSync(jail),
    ...NO_AUTO_MAINTENANCE,
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
  const r = spawnSync(cmd, args, { cwd, env: fixtureGitEnv(baseEnv), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${show(r)}`);
  return r.stdout;
}
// ── Units ──────────────────────────────────────────────────────────────

const pkg = (dir: string, name: string, deps: string[]): [string, WorkspacePackage] => [
  dir,
  { dir, name, deps, scripts: {} },
];

describe("differential-tree units", () => {
  it("fixtureGitEnv removes every GIT_* and credential variable and keeps the rest", () => {
    const env = fixtureGitEnv({
      GIT_DIR: "/x",
      GIT_WORK_TREE: "/y",
      GIT_INDEX_FILE: "/z",
      GIT_OBJECT_DIRECTORY: "/o",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/a",
      GIT_COMMON_DIR: "/c",
      GIT_CEILING_DIRECTORIES: "/d",
      GIT_CONFIG_COUNT: "1",
      GIT_ASKPASS: "/p",
      SSH_AUTH_SOCK: "/s",
      GH_TOKEN: "t",
      GITHUB_TOKEN: "t",
      PATH: "/bin",
    });
    expect(Object.keys(env).filter((k) => k.startsWith("GIT_"))).toEqual([]);
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
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

  it("install-level root differences: dependency fields structurally, lock/workspace/patch/npm files; nothing else", () => {
    const t = realpathSync(mkdtempSync(join(tmpdir(), "diff-install-")));
    try {
      const pj = (dir: string, v: unknown) => write(join(t, dir, "package.json"), json(v));
      const base = { name: "r", scripts: { a: "x" }, devDependencies: { a: "1", b: "2" } };
      pj("base", base);
      // Scripts-only change, and dependency keys merely reordered: per side, not shared.
      pj("head", { ...base, scripts: { a: "y", b: "z" }, devDependencies: { b: "2", a: "1" } });
      const rootPaths = ["package.json", "tsconfig.base.json", "scripts/x.ts", "docs/a.md"];
      expect(installLevelDifferences(join(t, "head"), join(t, "base"), rootPaths)).toEqual([]);
      pj("head", { ...base, devDependencies: { a: "1", b: "3" }, pnpm: { overrides: { c: "1" } } });
      expect(installLevelDifferences(join(t, "head"), join(t, "base"), rootPaths)).toEqual([
        "package.json (devDependencies, pnpm.overrides)",
      ]);
      expect(
        installLevelDifferences(join(t, "head"), join(t, "base"), [
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "patches/x.patch",
          ".npmrc",
          ".pnpmfile.cjs",
          "vitest.shared.ts",
        ]),
      ).toEqual([
        ".npmrc",
        ".pnpmfile.cjs",
        "patches/x.patch",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
      ]);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("a rewritten shim that still names a path outside its tree and the store refuses", () => {
    const rehome = { from: "/work/repo", to: "/tmp/tree" };
    const ok = `#!/bin/sh\nexport NODE_PATH="/tmp/tree/node_modules/.pnpm/node_modules:/tmp/tree/node_modules/.pnpm/vitest@4/node_modules:$NODE_PATH"\nexec node "$basedir/../vitest/vitest.mjs" "$@"\n`;
    expect(shimLeaks(ok, rehome)).toEqual([]);
    // A store entry of the working tree's install is allowed; its hoisted fallback is not.
    expect(
      shimLeaks(
        'export NODE_PATH="/work/repo/node_modules/.pnpm/esbuild@0.2/node_modules"',
        rehome,
      ),
    ).toEqual([]);
    expect(
      shimLeaks('export NODE_PATH="/work/repo/node_modules/.pnpm/node_modules"', rehome),
    ).toEqual(["/work/repo/node_modules/.pnpm/node_modules"]);
    // A moved or copied install: the shim names ANOTHER checkout, which the rewrite cannot re-home.
    const moved = `#!/bin/sh\nexport NODE_PATH="/old/checkout/node_modules/.pnpm/node_modules"\nexec node "/old/checkout/node_modules/vitest/vitest.mjs"\n`;
    expect(shimLeaks(moved, rehome)).toEqual([
      "/old/checkout/node_modules/.pnpm/node_modules",
      "/old/checkout/node_modules/vitest/vitest.mjs",
    ]);
    const t = realpathSync(mkdtempSync(join(tmpdir(), "diff-shim-")));
    try {
      write(join(t, "src", ".bin", "vitest"), moved);
      expect(() =>
        mirrorNodeModules(join(t, "src"), join(t, "dst"), {
          from: join(t, "src"),
          to: join(t, "dst"),
        }),
      ).toThrow(/names a path outside its tree/);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("orders builds dependencies first", () => {
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

  it("rewrites tsc build mode to a single-project build", () => {
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
      mkdirSync(join(nm, ".vite"));
      mkdirSync(join(nm, ".vite-temp"));
      // A pnpm shim whose NODE_PATH points into the working tree's hoisted store.
      write(
        join(nm, ".bin", "tool"),
        `#!/bin/sh\nexport NODE_PATH="${join(t, "head")}/node_modules/.pnpm/node_modules"\n`,
      );
      // pnpm's hoisted fallback: a relative workspace link, and a store entry.
      mkdirSync(join(nm, ".pnpm", "node_modules", "@m"), { recursive: true });
      symlinkSync("../../../../../b", join(nm, ".pnpm", "node_modules", "@m", "b"));
      mkdirSync(join(nm, ".pnpm", "thing@1.0.0"));
      const out = join(t, "base", "pkgs", "a", "node_modules");
      mirrorNodeModules(nm, out, { from: join(t, "head"), to: join(t, "base") });
      expect(readFileSync(join(out, "@m", "b", "who"), "utf-8")).toBe("base");
      expect(readFileSync(join(out, ".bin", "tool"), "utf-8")).toContain(
        `NODE_PATH="${join(t, "base")}/node_modules/.pnpm/node_modules"`,
      );
      expect(readFileSync(join(out, ".pnpm", "node_modules", "@m", "b", "who"), "utf-8")).toBe(
        "base",
      );
      expect(realpathSync(join(out, ".pnpm", "thing@1.0.0"))).toBe(
        join(nm, ".pnpm", "thing@1.0.0"),
      );
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

/** tsup-like: re-emits dist on every build, whatever the mtimes say (crypto's shape). */
const PROTO_BUILD = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const value = /VALUE: string = "([^"]*)"/.exec(readFileSync("src/index.ts", "utf-8"))[1];
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.js", "export const VALUE = " + JSON.stringify(value) + ";\\n");
writeFileSync("dist/index.d.ts", "export declare const VALUE: string;\\n");
`;
/** Inlines hoisted's VALUE — proto's, TRANSITIVELY — at build time (render-engine's browser bundle). */
const BUNDLER_BUILD = `import { VALUE } from "@fx/hoisted";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
// bundler never declares @fx/proto: a build step reaches it only through NODE_PATH
// (as esbuild's resolver falls back to it). Its value goes into the output.
const protoMain = createRequire(import.meta.url).resolve("@fx/proto");
const UNDECLARED = /VALUE = "([^"]*)"/.exec(readFileSync(protoMain, "utf-8"))[1];
mkdirSync("dist", { recursive: true });
writeFileSync(
  "dist/index.js",
  "export const BUNDLED = " + JSON.stringify(VALUE) + ";\\nexport const UNDECLARED = " + JSON.stringify(UNDECLARED) + ";\\n",
);
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
 * string in @fx/proto (built tsup-like). apps/mobile sees it only through
 * @fx/bundler, which INLINES it transitively via @fx/hoisted (tsc -b), and
 * through @fx/hoisted itself, declared only by the root package.json. The
 * working tree's packages are NOT built: the tool must never need them.
 * Every git and child command is jailed to `jail` and scrubbed of GIT_*.
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
  write(join(root, "docs", "notes.md"), "# notes\n");

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
  lib("proto", [], "node build.mjs", {
    "build.mjs": PROTO_BUILD,
    "src/index.ts": 'export const VALUE: string = "main";\n',
  });
  lib("hoisted", ["@fx/proto"], "tsc -b", {
    "tsconfig.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { outDir: "dist", rootDir: "src" },
      include: ["src"],
    }),
    "src/index.ts":
      '// fx-comment: emitted unless tsconfig.base.json sets removeComments\nexport { VALUE } from "@fx/proto";\n',
  });
  lib("bundler", ["@fx/hoisted"], "node build.mjs", {
    "build.mjs": BUNDLER_BUILD,
    "src/index.js": "// Bundled at build time; see build.mjs.\n",
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
  // pnpm's shape: the shim exports NODE_PATH into the hoisted store, which links
  // EVERY workspace package — the #840 leak when it points at the working tree.
  const hoistedStore = join(nm, ".pnpm", "node_modules");
  write(
    join(nm, ".bin", "vitest"),
    `#!/bin/sh\nbasedir=$(dirname "$0")\nif [ -z "$NODE_PATH" ]; then export NODE_PATH="${hoistedStore}"; else export NODE_PATH="${hoistedStore}:$NODE_PATH"; fi\nexec node "$basedir/../vitest/vitest.mjs" "$@"\n`,
  );
  mkdirSync(join(hoistedStore, "@fx"), { recursive: true });
  for (const p of ["proto", "hoisted", "bundler"]) {
    symlinkSync(`../../../../packages/${p}`, join(hoistedStore, "@fx", p));
  }
  write(
    join(nm, ".bin", "tsc"),
    `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../typescript/bin/tsc" "$@"\n`,
  );
  fxRun(jail, root, "chmod", ["+x", join(nm, ".bin", "vitest"), join(nm, ".bin", "tsc")], baseEnv);
  const link = (from: string, name: string, target: string) => {
    mkdirSync(join(root, from, "node_modules", "@fx"), { recursive: true });
    symlinkSync(target, join(root, from, "node_modules", "@fx", name));
  };
  link("packages/hoisted", "proto", "../../../proto");
  link("packages/bundler", "hoisted", "../../../hoisted");
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
  return { jail, root, mainSha };
}

/** Wrong, half-built working-tree output: the tool must never read it. */
function plantStaleDists(fx: Fixture): void {
  const stale = 'export const VALUE = "stale-working-tree-dist";\n';
  write(join(fx.root, "packages", "proto", "dist", "index.js"), stale);
  write(join(fx.root, "packages", "hoisted", "dist", "index.js"), stale);
  write(
    join(fx.root, "packages", "bundler", "dist", "index.js"),
    'export const BUNDLED = "stale-working-tree-bundle";\n',
  );
}

const FIXTURE_PROBE = `import { afterAll, it } from "vitest";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const obs: Record<string, unknown> = {};
it("observes", async () => {
  if (process.env.FX_MODE === "mobile") {
    obs.throughBundle = readFileSync("src/bundle.generated.txt", "utf-8");
    obs.throughRootHoisted = ((await import("@fx/hoisted")) as { VALUE: string }).VALUE;
    // mobile never declares @fx/proto: CommonJS require reaches it only through NODE_PATH.
    const where = realpathSync(createRequire(import.meta.url).resolve("@fx/proto"));
    obs.undeclaredInOwnTree = where.startsWith(realpathSync(resolve(process.cwd(), "../..")) + "/");
    obs.undeclaredValue = ((await import(pathToFileURL(where).href)) as { VALUE: string }).VALUE;
    obs.bundlerUndeclared = ((await import("@fx/bundler")) as { UNDECLARED?: string }).UNDECLARED ?? null;
  } else if (process.env.FX_MODE === "rootpkg") {
    const pkg = JSON.parse(readFileSync("../../package.json", "utf-8"));
    obs.description = pkg.description ?? null;
    obs.scripts = pkg.scripts ?? null;
    obs.devDependencies = pkg.devDependencies ?? null;
  } else if (process.env.FX_MODE === "emit") {
    // What tsc EMITTED for hoisted in this side's tree, under this side's tsconfig.base.json.
    obs.hoistedEmitKeepsComment = readFileSync("../../packages/hoisted/dist/index.js", "utf-8").includes("fx-comment");
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
    builtBase: string[];
    builtHead: string[];
    rootWorkspaceDeps: string[];
    rootHeldAtHead: string[];
    rootPerSide: string[];
    fromMainUnbuilt: string[];
    headFromWorkingTree: boolean;
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

const fxEnv = (extra: Record<string, string> = {}) => fixtureGitEnv(process.env, extra);

/**
 * The slower fixture cases run only with MOTEBIT_DIFFERENTIAL_FIXTURE=1
 * (`pnpm test:differential`), so every pre-push `pnpm test:gates` pays only for
 * the units, the new-package refusal and the decoy test (which also asserts the
 * bundle + root-hoisted DIFF over stale working-tree dists). Run
 * `pnpm test:differential` when reviewing a change to the differential tooling.
 */
const FIXTURE = process.env.MOTEBIT_DIFFERENTIAL_FIXTURE === "1";

describe("differential-vs-main behaviour (fixture)", () => {
  let fx: Fixture;
  beforeAll(() => {
    const jail = realpathSync(mkdtempSync(join(tmpdir(), "diff-fixture-")));
    fx = buildFixture(jail);
    writeFileSync(join(jail, "fixture.probe.ts"), FIXTURE_PROBE); // outside the workspace
  }, 60_000);
  afterAll(() => rmSync(fx.jail, { recursive: true, force: true }));

  it("a probe package that is new on this branch refuses: nothing on the base to compare", () => {
    const d = join(fx.root, "apps", "newhost");
    write(join(d, "package.json"), json({ name: "@fx/newhost", type: "module" }));
    write(join(d, "src", "__tests__", ".gitkeep"), "");
    try {
      const r = runScript(
        fx.root,
        [
          "--probe",
          join(fx.jail, "fixture.probe.ts"),
          "--pkg",
          "apps/newhost",
          "--base",
          fx.mainSha,
          "--out",
          join(fx.jail, "newhost.json"),
        ],
        fxEnv(),
      );
      expect(r.status, show(r)).toBe(1);
      expect(r.stderr).toContain("apps/newhost is new on this branch");
      expect(existsSync(join(fx.jail, "newhost.json"))).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

  it("a dependency change in the root package.json refuses: the install is shared by both sides", () => {
    const pkgJson = join(fx.root, "package.json");
    const original = readFileSync(pkgJson, "utf-8");
    try {
      const withDep = { ...JSON.parse(original) };
      withDep.devDependencies = { ...withDep.devDependencies, "left-pad": "1.3.0" };
      write(pkgJson, json(withDep));
      const out = join(fx.jail, "dep.json");
      const r = runScript(fx.root, mobileArgs(fx, out), fxEnv());
      expect(r.status, show(r)).toBe(1);
      expect(r.stderr).toContain("install-level root files differ");
      expect(r.stderr).toContain("package.json (devDependencies)");
      expect(existsSync(out)).toBe(false);
    } finally {
      write(pkgJson, original);
    }
  }, 60_000);

  it.skipIf(!FIXTURE)(
    "stale working-tree dists are never read: the transitive bundle and the root-hoisted package both read DIFF",
    () => {
      plantStaleDists(fx);
      const out = join(fx.jail, "mobile.json");
      const r = runScript(fx.root, mobileArgs(fx, out), fxEnv({ FX_MODE: "mobile" }));
      expect(r.status, show(r)).toBe(0);
      const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
      expect(rep.head).toEqual({
        throughBundle: "head",
        throughRootHoisted: "head",
        undeclaredInOwnTree: true,
        undeclaredValue: "head",
        bundlerUndeclared: "head",
      });
      expect(rep.baseObs).toEqual({
        throughBundle: "main",
        throughRootHoisted: "main",
        undeclaredInOwnTree: true,
        undeclaredValue: "main",
        bundlerUndeclared: "main",
      });
      expect(rep.aperture.builtBase).toEqual([
        "packages/proto",
        "packages/hoisted",
        "packages/bundler",
      ]);
      expect(rep.aperture.builtHead).toEqual(rep.aperture.builtBase);
      expect(r.stdout).not.toMatch(/reach a [0-9a-f]/);
    },
    120_000,
  );

  it.skipIf(!FIXTURE)(
    "--head-from-working-tree reads the working tree's own builds, and says they are not freshness-checked",
    () => {
      plantStaleDists(fx);
      const out = join(fx.jail, "fast.json");
      const r = runScript(
        fx.root,
        [...mobileArgs(fx, out), "--head-from-working-tree"],
        fxEnv({ FX_MODE: "mobile" }),
      );
      expect(r.status, show(r)).toBe(0);
      const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
      expect(rep.head.throughBundle).toBe("stale-working-tree-bundle");
      expect(rep.baseObs).toEqual({
        throughBundle: "main",
        throughRootHoisted: "main",
        undeclaredInOwnTree: true,
        undeclaredValue: "main",
        bundlerUndeclared: "main",
      });
      expect(rep.aperture.headFromWorkingTree).toBe(true);
      expect(r.stdout).toContain("NOT freshness-checked");
    },
    120_000,
  );

  it.skipIf(!FIXTURE)(
    "a changed build input outside src/ (build.mjs) reads DIFF, with no refusal and no rebuild by hand",
    () => {
      const file = join(fx.root, "packages", "bundler", "build.mjs");
      write(file, BUNDLER_BUILD.replace("JSON.stringify(VALUE)", 'JSON.stringify("v2:" + VALUE)'));
      try {
        const out = join(fx.jail, "outside-src.json");
        const r = runScript(
          fx.root,
          mobileArgs(fx, out, "packages/bundler"),
          fxEnv({ FX_MODE: "mobile" }),
        );
        expect(r.status, show(r)).toBe(0);
        const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
        expect(rep.head.throughBundle).toBe("v2:head");
        expect(rep.baseObs.throughBundle).toBe("head"); // main's build.mjs over the working tree's proto
      } finally {
        write(file, BUNDLER_BUILD);
      }
    },
    120_000,
  );

  it.skipIf(!FIXTURE)(
    "a probe outside the workspace with no --pkg runs in services/relay, says so, and lists a from-main package it never built",
    () => {
      const out = join(fx.jail, "relay.json");
      const r = runScript(
        fx.root,
        [
          "--probe",
          join(fx.jail, "fixture.probe.ts"),
          "--base",
          fx.mainSha,
          "--from-main",
          "packages/bundler",
          "--out",
          out,
        ],
        fxEnv(),
      );
      expect(r.status, show(r)).toBe(0);
      const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
      // bundler is from main but outside relay's declared + root-hoisted reach:
      // the aperture must say it was NOT built, not just "from main".
      expect(rep.aperture.fromMainUnbuilt).toEqual(["packages/bundler"]);
      expect(r.stdout).toMatch(/NOT built[^\n]*packages\/bundler/);
      expect(rep.pkg).toBe("services/relay");
      expect(rep.pkgReason).toMatch(/default/);
      expect(rep.baseObs.cwdTail).toBe("services/relay");
      expect(r.stdout).toContain("default: the probe is outside every workspace package");
    },
    120_000,
  );

  it.skipIf(!FIXTURE)(
    "a root build file (tsconfig.base.json) is per side: it runs, and the emitted output reads DIFF",
    () => {
      const tsconfig = join(fx.root, "tsconfig.base.json");
      write(
        tsconfig,
        TSCONFIG_BASE.replace('"strict": true', '"strict": true,\n    "removeComments": true'),
      );
      try {
        const out = join(fx.jail, "tsconfig.json");
        const r = runScript(fx.root, mobileArgs(fx, out), fxEnv({ FX_MODE: "emit" }));
        expect(r.status, show(r)).toBe(0);
        const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
        expect(rep.head.hoistedEmitKeepsComment).toBe(false);
        expect(rep.baseObs.hoistedEmitKeepsComment).toBe(true);
        expect(rep.aperture.rootPerSide).toContain("tsconfig.base.json");
        expect(rep.aperture.rootHeldAtHead).toEqual([]);
        expect(r.stdout).toContain("install-level files are shared and identical");
      } finally {
        write(tsconfig, TSCONFIG_BASE);
      }
    },
    120_000,
  );

  it.skipIf(!FIXTURE)(
    "a scripts-only root package.json change runs; a lockfile change refuses; --root-from-head holds a dependency change",
    () => {
      const pkgJson = join(fx.root, "package.json");
      const original = readFileSync(pkgJson, "utf-8");
      const lock = join(fx.root, "pnpm-lock.yaml");
      try {
        write(pkgJson, json({ ...JSON.parse(original), scripts: { hello: "echo hi" } }));
        const out = join(fx.jail, "scripts-only.json");
        const ok = runScript(fx.root, mobileArgs(fx, out), fxEnv({ FX_MODE: "mobile" }));
        expect(ok.status, show(ok)).toBe(0);
        expect((JSON.parse(readFileSync(out, "utf-8")) as Report).aperture.rootPerSide).toContain(
          "package.json",
        );

        write(lock, "lockfileVersion: '9.0'\n");
        const refused = runScript(fx.root, mobileArgs(fx, join(fx.jail, "lock.json")), fxEnv());
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("install-level root files differ");
        expect(refused.stderr).toContain("pnpm-lock.yaml");
        rmSync(lock, { force: true });

        const withDep = { ...JSON.parse(original) };
        withDep.devDependencies = { ...withDep.devDependencies, "left-pad": "1.3.0" };
        write(pkgJson, json(withDep));
        const heldOut = join(fx.jail, "held.json");
        const held = runScript(
          fx.root,
          [...mobileArgs(fx, heldOut), "--root-from-head"],
          fxEnv({ FX_MODE: "mobile" }),
        );
        expect(held.status, show(held)).toBe(0);
        const rep = JSON.parse(readFileSync(heldOut, "utf-8")) as Report;
        expect(rep.aperture.rootHeldAtHead).toEqual(["package.json (devDependencies)"]);
        expect(held.stdout).toContain("NOT differentialled");
      } finally {
        write(pkgJson, original);
        rmSync(lock, { force: true });
      }
    },
    180_000,
  );
  it.skipIf(!FIXTURE)(
    "--root-from-head holds ONLY the dependency fields of the root package.json; its other fields and scripts stay per side",
    () => {
      const pkgJson = join(fx.root, "package.json");
      const original = readFileSync(pkgJson, "utf-8");
      try {
        const changed = { ...JSON.parse(original) };
        changed.description = "head description";
        changed.scripts = { hello: "echo head" };
        changed.devDependencies = { ...changed.devDependencies, "left-pad": "1.3.0" };
        write(pkgJson, json(changed));
        const out = join(fx.jail, "rootpkg.json");
        const r = runScript(
          fx.root,
          [...mobileArgs(fx, out), "--root-from-head"],
          fxEnv({ FX_MODE: "rootpkg" }),
        );
        expect(r.status, show(r)).toBe(0);
        const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
        expect(rep.aperture.rootHeldAtHead).toEqual(["package.json (devDependencies)"]);
        // Held: the dependency field is the working tree's on both sides.
        expect(rep.baseObs.devDependencies).toEqual(rep.head.devDependencies);
        // Not held: everything else in the file is each side's own.
        expect(rep.head.description).toBe("head description");
        expect(rep.baseObs.description).toBeNull();
        expect(rep.head.scripts).toEqual({ hello: "echo head" });
        expect(rep.baseObs.scripts).toBeNull();
      } finally {
        write(pkgJson, original);
      }
    },
    120_000,
  );
});

// ── Decoy: the fixture and the script must never touch a repository they did not create ──

/** Every file of the decoy — its work tree and ALL of .git, objects included. */
function snapshotDir(dir: string): string {
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    const p = rel === "" ? dir : join(dir, rel);
    const st = lstatSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p).sort()) walk(rel === "" ? e : `${rel}/${e}`);
    } else if (st.isSymbolicLink()) files[rel] = `link:${readlinkSync(p)}`;
    else files[rel] = readFileSync(p).toString("base64");
  };
  walk("");
  return JSON.stringify(files);
}

/**
 * The decoy paths that differ between two snapshots, one line each (added,
 * removed, or changed with both sizes), so a red decoy assertion names the file
 * that was written instead of a truncated blob diff.
 */
function snapshotDiff(before: string, after: string): string {
  const a = JSON.parse(before) as Record<string, string>;
  const b = JSON.parse(after) as Record<string, string>;
  const size = (v: string) => (v.startsWith("link:") ? v : `${Buffer.from(v, "base64").length}B`);
  const lines: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!(k in b)) lines.push(`  removed  ${k} (${size(a[k]!)})`);
    else if (!(k in a)) lines.push(`  added    ${k} (${size(b[k]!)})`);
    else if (a[k] !== b[k]) lines.push(`  changed  ${k} (${size(a[k]!)} -> ${size(b[k]!)})`);
  }
  return lines.length === 0
    ? "decoy unchanged"
    : `the decoy was written — ${lines.length} path(s) differ:\n${lines.join("\n")}`;
}

describe("differential-vs-main safety (decoy repository)", () => {
  it("an fxGit commit starts no background maintenance, so nothing writes the decoy after its snapshot", () => {
    const jail = realpathSync(mkdtempSync(join(tmpdir(), "diff-maint-")));
    try {
      const repo = join(jail, "repo");
      write(join(repo, "README"), "x\n");
      const trace = join(jail, "trace2.txt");
      const g = (...args: string[]) => fxGit(jail, repo, args, { extraEnv: { GIT_TRACE2: trace } });
      g("init", "-q", "-b", "main");
      g("config", "user.email", "m@example.invalid");
      g("config", "user.name", "m");
      g("config", "commit.gpgsign", "false");
      g("add", "-A");
      g("commit", "-q", "-m", "x");
      const children = readFileSync(trace, "utf-8")
        .split("\n")
        .filter((l) => l.includes("child_start"));
      expect(children.filter((l) => l.includes("maintenance"))).toEqual([]);
    } finally {
      rmSync(jail, { recursive: true, force: true });
    }
  });

  it("with every GIT_* aimed at a decoy, the fixture and the script leave the decoy byte-identical — and a transitive bundle and a root-hoisted package read DIFF over stale working-tree dists", () => {
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
      const before = snapshotDir(decoy);

      // What a pre-push hook in a linked worktree exports, and more.
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
        plantStaleDists(fx);
        writeFileSync(join(fxJail, "fixture.probe.ts"), FIXTURE_PROBE);
        r = runScript(fx.root, mobileArgs(fx, out), { ...hostile, FX_MODE: "mobile" });
      } catch (err) {
        failure = err;
      }
      // First, whatever happened above: every byte of the decoy is unchanged.
      const after = snapshotDir(decoy);
      expect(after === before, snapshotDiff(before, after)).toBe(true);
      if (failure != null) throw failure;
      expect(r!.status, show(r!)).toBe(0);
      const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
      expect(rep.head).toEqual({
        throughBundle: "head",
        throughRootHoisted: "head",
        undeclaredInOwnTree: true,
        undeclaredValue: "head",
        bundlerUndeclared: "head",
      });
      expect(rep.baseObs).toEqual({
        throughBundle: "main",
        throughRootHoisted: "main",
        undeclaredInOwnTree: true,
        undeclaredValue: "main",
        bundlerUndeclared: "main",
      });
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
      expect(rep.aperture.builtBase).toContain("packages/render-engine");
      expect(rep.aperture.builtHead).toContain("packages/render-engine");
    }, 1_200_000);

    it("a protocol change seen through root-hoisted semiring from surface-kit reads DIFF", () => {
      const rep = run(
        ["--pkg", "packages/surface-kit", "--from-main", "packages/protocol"],
        "surface-kit",
      );
      expect(rep.head.trustedScoreViaSemiring).toBe(0.9);
      expect(rep.baseObs.trustedScoreViaSemiring).toBe(PLANT_SCORE);
      expect(rep.aperture.builtBase).toContain("packages/semiring");
      expect(rep.aperture.builtHead).toContain("packages/semiring");
    }, 1_200_000);
  },
);
