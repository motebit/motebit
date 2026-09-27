/**
 * differential-vs-main — the base side must run the same probe the head side
 * runs, in any workspace package, and every package the aperture says came
 * from the base ref must actually be what the probe observes (#818, #833).
 *
 * #833 was withdrawn for two false SAMEs with an aperture that claimed
 * otherwise: a working-tree bundle copied into the base tree had already
 * inlined the working tree's version of a from-main package, and a
 * root-hoisted package (declared only in the root package.json) stayed linked
 * to the working tree. Path assertions did not catch either; these tests
 * assert BEHAVIOUR — a planted change must read as DIFF.
 *
 * Three layers:
 *
 *   - Unit (always on, milliseconds).
 *   - Behavioural fixture (always on, in `pnpm test:gates`, ~10 s): a
 *     five-package mini-workspace built in a temp dir with its own git
 *     history. The change between its "main" commit and its head commit is
 *     one string in `@fx/proto`, and the probe (in `apps/mobile`) can see it
 *     only (a) through `@fx/bundler`, whose build INLINES proto's value, via
 *     a `pretest` step that generates a file from the bundle — the shape of
 *     apps/mobile ← render-engine's browser.iife.js ← protocol — and (b)
 *     through `@fx/hoisted`, which mobile never declares and resolves only
 *     through the root package.json — the shape of surface-kit ← semiring.
 *     Both must read DIFF. It also pins the out-of-workspace probe default
 *     (services/relay) and the stale-build refusal.
 *   - Real-repo smoke (opt-in, `MOTEBIT_DIFFERENTIAL_SMOKE=1`): the same two
 *     shapes on the real packages, against a synthetic base commit that is
 *     HEAD plus a planted protocol change (written to the object store only —
 *     no ref, no working-tree change). Needs the working tree's builds current
 *     (the script refuses otherwise and prints the repair). Takes minutes:
 *     almost every package reaches protocol, so the base side rebuilds the
 *     probe's reach inside the base tree.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  baseBuildCommand,
  dependencyClosure,
  mirrorNodeModules,
  packageDirOf,
  topoOrder,
  type WorkspacePackage,
} from "../lib/differential-tree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = realpathSync(resolve(__dirname, "..", ".."));
const SCRIPT = resolve(ROOT, "scripts", "differential-vs-main.ts");
const TSX = resolve(ROOT, "node_modules", ".bin", "tsx");
const ROOTS = ["packages", "apps", "services"];

const pkg = (dir: string, name: string, deps: string[]): [string, WorkspacePackage] => [
  dir,
  { dir, name, deps, scripts: {} },
];

describe("differential-tree units", () => {
  it("maps a path to its workspace package, and nothing outside the workspace", () => {
    expect(packageDirOf("packages/surface-kit/src/index.ts", ROOTS)).toBe("packages/surface-kit");
    expect(packageDirOf("apps/web", ROOTS)).toBe("apps/web");
    expect(packageDirOf("scripts/check.ts", ROOTS)).toBeNull();
    expect(packageDirOf("vitest.shared.ts", ROOTS)).toBeNull();
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
    expect(baseBuildCommand(undefined)).toBeNull();
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

function sh(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const COPY_BUILD = `import { mkdirSync, copyFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
copyFileSync("src/index.js", "dist/index.js");
`;

/**
 * A mini-workspace whose only difference between `main` and head is one
 * string in @fx/proto, reachable from apps/mobile only through a bundle and
 * through a root-hoisted package. Returns the fixture root and main's sha.
 */
function buildFixture(dir: string): { root: string; mainSha: string } {
  const root = join(dir, "repo");
  write(
    join(root, "package.json"),
    json({ name: "fx-root", private: true, devDependencies: { "@fx/hoisted": "workspace:*" } }),
  );
  write(
    join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\n  - "apps/*"\n  - "services/*"\n',
  );
  write(join(root, ".gitignore"), "node_modules\ndist\n*.generated.txt\n");

  const lib = (name: string, deps: string[], build: string, src: string) => {
    const d = join(root, "packages", name);
    write(
      join(d, "package.json"),
      json({
        name: `@fx/${name}`,
        type: "module",
        main: "dist/index.js",
        scripts: { build: "node build.mjs" },
        dependencies: Object.fromEntries(deps.map((x) => [x, "workspace:*"])),
      }),
    );
    write(join(d, "build.mjs"), build);
    write(join(d, "src", "index.js"), src);
  };
  lib("proto", [], COPY_BUILD, 'export const VALUE = "main";\n');
  // The bundler INLINES proto's value at build time (render-engine's browser bundle).
  lib(
    "bundler",
    ["@fx/proto"],
    `import { VALUE } from "@fx/proto";
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.js", "export const BUNDLED = " + JSON.stringify(VALUE) + ";\\n");
`,
    "// Bundled at build time from @fx/proto; see build.mjs.\n",
  );
  // Re-exports proto at runtime; declared only by the ROOT package.json (semiring).
  lib("hoisted", ["@fx/proto"], COPY_BUILD, 'export { VALUE } from "@fx/proto";\n');

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

  // pnpm's node_modules shape, with the real repo's vitest.
  const vitestDir = realpathSync(join(ROOT, "node_modules", "vitest"));
  const nm = join(root, "node_modules");
  mkdirSync(join(nm, "@fx"), { recursive: true });
  symlinkSync("../../packages/hoisted", join(nm, "@fx", "hoisted"));
  symlinkSync(vitestDir, join(nm, "vitest"));
  write(join(nm, ".bin", "vitest"), `#!/bin/sh\nexec node "${vitestDir}/vitest.mjs" "$@"\n`);
  sh("chmod", ["+x", join(nm, ".bin", "vitest")], root);
  const link = (from: string, name: string, target: string) => {
    mkdirSync(join(root, from, "node_modules", "@fx"), { recursive: true });
    symlinkSync(target, join(root, from, "node_modules", "@fx", name));
  };
  link("packages/bundler", "proto", "../../../proto");
  link("packages/hoisted", "proto", "../../../proto");
  link("apps/mobile", "bundler", "../../../../packages/bundler");

  const git = (...args: string[]) => sh("git", args, root).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "main");
  const mainSha = git("rev-parse", "HEAD");
  write(join(root, "packages", "proto", "src", "index.js"), 'export const VALUE = "head";\n');
  git("commit", "-q", "-am", "head: proto says head");
  for (const p of ["proto", "bundler", "hoisted"])
    sh("node", ["build.mjs"], join(root, "packages", p));
  return { root, mainSha };
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
  };
  head: Record<string, unknown>;
  baseObs: Record<string, unknown>;
}

function runScript(cwd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(TSX, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("differential-vs-main behaviour (fixture)", () => {
  let dir: string;
  let fx: { root: string; mainSha: string };
  let probe: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "diff-fixture-")));
    fx = buildFixture(dir);
    probe = join(dir, "fixture.probe.ts"); // outside the fixture's workspace, as reviewers keep them
    writeFileSync(probe, FIXTURE_PROBE);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("a change reachable only through a bundle, and only through a root-hoisted package, reads DIFF", () => {
    const out = join(dir, "mobile.json");
    const r = runScript(
      fx.root,
      [
        "--probe",
        probe,
        "--pkg",
        "apps/mobile",
        "--base",
        fx.mainSha,
        "--from-main",
        "packages/proto",
        "--out",
        out,
      ],
      { FX_MODE: "mobile" },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
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
    expect(rep.aperture.rootWorkspaceDeps).toEqual(["@fx/hoisted"]);
    expect(r.stdout).toContain("[DIFF]");
  }, 120_000);

  it("a probe outside the workspace with no --pkg runs in services/relay, and says so", () => {
    const out = join(dir, "relay.json");
    const r = runScript(fx.root, [
      "--probe",
      probe,
      "--base",
      fx.mainSha,
      "--from-main",
      "host",
      "--out",
      out,
    ]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const rep = JSON.parse(readFileSync(out, "utf-8")) as Report;
    expect(rep.pkg).toBe("services/relay");
    expect(rep.pkgReason).toMatch(/default/);
    expect(rep.head.cwdTail).toBe("services/relay");
    expect(rep.baseObs.cwdTail).toBe("services/relay");
    expect(r.stdout).toContain("default: the probe is outside every workspace package");
  }, 120_000);

  it("refuses, with the repair, when a build the probe reads is older than its source", () => {
    const src = join(fx.root, "packages", "proto", "src", "index.js");
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(src, future, future);
    try {
      const r = runScript(fx.root, [
        "--probe",
        probe,
        "--pkg",
        "apps/mobile",
        "--base",
        fx.mainSha,
        "--from-main",
        "packages/proto",
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("refused");
      expect(r.stderr).toContain("packages/proto");
      expect(r.stderr).toContain("Fix: pnpm --filter ./packages/proto...");
    } finally {
      const past = new Date(Date.now() - 3_600_000);
      utimesSync(src, past, past);
    }
  }, 60_000);
});

// ── Real-repo smoke (opt-in) ───────────────────────────────────────────

const SMOKE = process.env.MOTEBIT_DIFFERENTIAL_SMOKE === "1";
const PLANT_MODE = "full-planted-818";
const PLANT_SCORE = 0.918;

/** HEAD + a planted protocol change, as a commit object only (no ref, no working-tree change). */
function plantedBaseCommit(scratch: string): string {
  const env = { GIT_INDEX_FILE: join(scratch, "planted.index") };
  const git = (args: string[], input?: string) => {
    const r = spawnSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      input,
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(["read-tree", "HEAD"]);
  const plant = (path: string, from: string, to: string) => {
    const before = git(["show", `HEAD:${path}`]);
    expect(before).toContain(from);
    const blob = git(["hash-object", "-w", "--stdin"], `${before.replace(from, to)}\n`);
    git(["update-index", "--cacheinfo", `100644,${blob},${path}`]);
  };
  plant("packages/protocol/src/index.ts", 'Full = "full",', `Full = "${PLANT_MODE}",`);
  plant("packages/protocol/src/trust-algebra.ts", "trusted: 0.9,", `trusted: ${PLANT_SCORE},`);
  const tree = git(["write-tree"]);
  return git(["commit-tree", tree, "-p", "HEAD", "-m", "differential smoke: planted protocol"]);
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
    let dir: string;
    let planted: string;
    let probe: string;
    beforeAll(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "diff-smoke-")));
      planted = plantedBaseCommit(dir);
      probe = join(dir, "smoke.probe.ts");
      writeFileSync(probe, SMOKE_PROBE);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    function run(args: string[], env: Record<string, string>): Report {
      const out = join(dir, `${env.SMOKE_MODE}.json`);
      const r = runScript(ROOT, ["--probe", probe, "--base", planted, "--out", out, ...args], env);
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      return JSON.parse(readFileSync(out, "utf-8")) as Report;
    }

    it("services/relay by default for an out-of-workspace probe", () => {
      const rep = run(["--from-main", "host"], { SMOKE_MODE: "relay" });
      expect(rep.pkg).toBe("services/relay");
      expect(rep.baseObs.ran).toBe(true);
    }, 600_000);

    it("a protocol change seen through mobile's creature bundle (render-engine's browser.iife.js) reads DIFF", () => {
      const rep = run(["--pkg", "apps/mobile", "--from-main", "packages/protocol"], {
        SMOKE_MODE: "mobile",
      });
      expect(rep.head.plantedInCreatureBundle).toBe(false);
      expect(rep.baseObs.plantedInCreatureBundle).toBe(true);
      expect(rep.aperture.rebuiltFromHead).toContain("packages/render-engine");
    }, 1_200_000);

    it("a protocol change seen through root-hoisted semiring from surface-kit reads DIFF", () => {
      const rep = run(["--pkg", "packages/surface-kit", "--from-main", "packages/protocol"], {
        SMOKE_MODE: "surface-kit",
      });
      expect(rep.head.trustedScoreViaSemiring).toBe(0.9);
      expect(rep.baseObs.trustedScoreViaSemiring).toBe(PLANT_SCORE);
      expect(rep.aperture.rebuiltFromHead).toContain("packages/semiring");
    }, 1_200_000);
  },
);
