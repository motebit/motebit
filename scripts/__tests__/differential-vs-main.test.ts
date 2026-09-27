/**
 * differential-vs-main — the base side must run the same probe the head side
 * runs, in any workspace package, with the aperture it claims (#818).
 *
 * Two layers:
 *
 *   - Unit (always on, milliseconds): the pure pieces the aperture is built
 *     from — package-of-path, topo order, the `tsc -b` rewrite, and the
 *     node_modules mirror that makes a relative `@motebit/*` link land on the
 *     BASE tree's copy of a package.
 *   - Smoke (opt-in, `MOTEBIT_DIFFERENTIAL_SMOKE=1`, ~25 s): the real script
 *     against the real base ref, with a probe in services/relay, in
 *     packages/surface-kit with a second from-main package it imports, and in
 *     apps/web. Each asserts observations on BOTH sides, and — the part the
 *     old script got wrong — that the base side's `@motebit/sdk` resolves
 *     inside the base tree when sdk is from main and inside the working tree
 *     when it is not. It needs the working tree's builds of surface-kit's
 *     dependencies (`pnpm --filter "@motebit/surface-kit^..." build`) and
 *     `origin/main` fetched. Off by default so `pnpm test:gates` (pre-push)
 *     stays fast.
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  baseBuildCommand,
  mirrorNodeModules,
  packageDirOf,
  topoOrder,
  type WorkspacePackage,
} from "../lib/differential-tree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = realpathSync(resolve(__dirname, "..", ".."));
const SCRIPT = resolve(ROOT, "scripts", "differential-vs-main.ts");
const ROOTS = ["packages", "apps", "services"];

describe("differential-tree units", () => {
  it("maps a path to its workspace package, and nothing outside the workspace", () => {
    expect(packageDirOf("packages/surface-kit/src/index.ts", ROOTS)).toBe("packages/surface-kit");
    expect(packageDirOf("apps/web", ROOTS)).toBe("apps/web");
    expect(packageDirOf("scripts/check.ts", ROOTS)).toBeNull();
    expect(packageDirOf("vitest.shared.ts", ROOTS)).toBeNull();
  });

  it("orders from-main rebuilds dependencies first", () => {
    const pkg = (dir: string, name: string, deps: string[]): [string, WorkspacePackage] => [
      dir,
      { dir, name, deps, scripts: {} },
    ];
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

  it("rewrites tsc build mode so a base rebuild never walks into the working tree", () => {
    expect(baseBuildCommand("tsc -b")).toBe("tsc -p tsconfig.json");
    expect(baseBuildCommand("tsc -b && pnpm run build:browser")).toBe(
      "tsc -p tsconfig.json && pnpm run build:browser",
    );
    expect(baseBuildCommand("tsup")).toBe("tsup");
    expect(baseBuildCommand("echo 'Mobile build via EAS'")).toBeNull();
    expect(baseBuildCommand(undefined)).toBeNull();
  });

  it("mirrors node_modules so a relative workspace link lands in the mirror's tree", () => {
    const t = realpathSync(mkdtempSync(join(tmpdir(), "diff-mirror-")));
    try {
      // head/pkgs/a/node_modules/@m/b -> ../../../b   (pnpm's shape)
      for (const side of ["head", "base"]) {
        mkdirSync(join(t, side, "pkgs", "b"), { recursive: true });
        writeFileSync(join(t, side, "pkgs", "b", "who"), side);
      }
      mkdirSync(join(t, "head", "pkgs", "a", "node_modules", "@m"), { recursive: true });
      symlinkSync("../../../b", join(t, "head", "pkgs", "a", "node_modules", "@m", "b"));
      mkdirSync(join(t, "head", "pkgs", "a", "node_modules", ".bin"));
      mirrorNodeModules(
        join(t, "head", "pkgs", "a", "node_modules"),
        join(t, "base", "pkgs", "a", "node_modules"),
      );
      expect(
        readFileSync(join(t, "base", "pkgs", "a", "node_modules", "@m", "b", "who"), "utf-8"),
      ).toBe("base");
      // Non-scope directories (.bin, .pnpm) are the working tree's, linked absolutely.
      expect(realpathSync(join(t, "base", "pkgs", "a", "node_modules", ".bin"))).toBe(
        join(t, "head", "pkgs", "a", "node_modules", ".bin"),
      );
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

const SMOKE = process.env.MOTEBIT_DIFFERENTIAL_SMOKE === "1";

const PROBE = `import { afterAll, it } from "vitest";
import { writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
const obs: Record<string, unknown> = {};
it("observes", async () => {
  obs.side = process.env.DIFFERENTIAL_SIDE;
  obs.cwd = realpathSync(process.cwd());
  const want = process.env.SMOKE_RESOLVE;
  if (want) {
    // The package directory node's resolver lands on from the host package.
    obs.resolved = realpathSync(join(process.cwd(), "node_modules", want, "package.json"));
    const via = process.env.SMOKE_VIA;
    if (via) {
      // The same package as seen from a working-tree dependency of the host.
      obs.viaDependent = realpathSync(
        join(process.cwd(), "node_modules", via, "node_modules", want, "package.json"),
      );
    }
    if (process.env.SMOKE_IMPORT === "1") {
      const mod = (await import(want)) as Record<string, unknown>;
      obs.importedExports = Object.keys(mod).length;
    }
  }
});
afterAll(() => { writeFileSync(process.env.PROBE_OUT!, JSON.stringify(obs)); });
`;

interface Report {
  baseTree: string;
  aperture: { fromMain: string[]; rebuilt: string[]; materialized: string[] };
  head: Record<string, unknown>;
  baseObs: Record<string, unknown>;
}

describe.skipIf(!SMOKE)("differential-vs-main smoke (MOTEBIT_DIFFERENTIAL_SMOKE=1)", () => {
  let dir: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "diff-smoke-")));
    writeFileSync(join(dir, "smoke.probe.ts"), PROBE);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(pkg: string, fromMain: string, env: Record<string, string> = {}): Report {
    const out = join(dir, `${pkg.replace(/\//g, "_")}.json`);
    const r = spawnSync(
      "npx",
      [
        "tsx",
        SCRIPT,
        "--probe",
        join(dir, "smoke.probe.ts"),
        "--pkg",
        pkg,
        "--from-main",
        fromMain,
        "--out",
        out,
      ],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(existsSync(out)).toBe(true);
    return JSON.parse(readFileSync(out, "utf-8")) as Report;
  }

  it("services/relay: observations on both sides; the base side runs in the base tree", () => {
    const rep = run("services/relay", "host");
    expect(rep.head.side).toBe("head");
    expect(rep.baseObs.side).toBe("base");
    expect(rep.head.cwd).toBe(join(ROOT, "services/relay"));
    expect(rep.baseObs.cwd).toBe(join(rep.baseTree, "services/relay"));
  }, 180_000);

  it("packages/surface-kit (tsconfig references) with sdk from main: sdk resolves AND imports from the base tree", () => {
    const rep = run("packages/surface-kit", "packages/surface-kit,packages/sdk", {
      SMOKE_RESOLVE: "@motebit/sdk",
      SMOKE_IMPORT: "1",
    });
    expect(rep.aperture.fromMain).toEqual(["packages/sdk", "packages/surface-kit"]);
    expect(rep.aperture.rebuilt).toEqual(["packages/sdk"]);
    expect(rep.head.resolved).toBe(join(ROOT, "packages/sdk/package.json"));
    expect(rep.baseObs.resolved).toBe(join(rep.baseTree, "packages/sdk/package.json"));
    expect(rep.baseObs.importedExports).toBeGreaterThan(0);
    expect(rep.baseObs.importedExports).toBe(rep.head.importedExports);
  }, 300_000);

  it("apps/web: sdk from main resolves to the base tree (also through a working-tree dependent); not from main, to the working tree", () => {
    const swapped = run("apps/web", "apps/web,packages/sdk", {
      SMOKE_RESOLVE: "@motebit/sdk",
      SMOKE_VIA: "@motebit/runtime",
    });
    expect(swapped.baseObs.side).toBe("base");
    expect(swapped.baseObs.resolved).toBe(join(swapped.baseTree, "packages/sdk/package.json"));
    expect(swapped.head.resolved).toBe(join(ROOT, "packages/sdk/package.json"));
    // runtime is the working tree's, but it imports sdk: it must reach main's sdk too.
    expect(swapped.aperture.materialized).toContain("packages/runtime");
    expect(swapped.baseObs.viaDependent).toBe(join(swapped.baseTree, "packages/sdk/package.json"));
    expect(swapped.head.viaDependent).toBe(join(ROOT, "packages/sdk/package.json"));

    const hostOnly = run("apps/web", "host", { SMOKE_RESOLVE: "@motebit/sdk" });
    expect(hostOnly.baseObs.resolved).toBe(join(ROOT, "packages/sdk/package.json"));
  }, 300_000);
});
