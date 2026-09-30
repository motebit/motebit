/**
 * check-tests-typechecked — fixture tests.
 *
 * Each fixture is a throwaway workspace package on disk: a package.json with a
 * `typecheck` script, a tsconfig (or two), and test files. The gate asks the
 * TypeScript config parser which files each tsconfig includes, so the fixtures
 * exercise the real `include` / `exclude` / `extends` resolution.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findTestFiles,
  isTestFile,
  resolveTypecheckConfigs,
  scanPackage,
} from "../check-tests-typechecked.js";

let root: string;

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function json(rel: string, value: unknown): void {
  write(rel, JSON.stringify(value, null, 2));
}

/** A package whose build tsconfig excludes its tests — the #1000 shape. */
function buildOnlyPackage(dir: string, typecheck = "tsc --noEmit"): void {
  json(`${dir}/package.json`, { name: `@fixture/${dir}`, scripts: { typecheck } });
  json(`${dir}/tsconfig.json`, {
    compilerOptions: { rootDir: "src", outDir: "dist" },
    include: ["src"],
    exclude: ["src/__tests__"],
  });
  write(`${dir}/src/index.ts`, "export const x = 1;\n");
  write(`${dir}/src/__tests__/index.test.ts`, "import { x } from '../index';\nvoid x;\n");
  write(`${dir}/src/__tests__/helpers.ts`, "export const h = 1;\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tests-typechecked-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isTestFile", () => {
  it("matches *.test / *.spec and anything under __tests__, never declarations", () => {
    expect(isTestFile("src/a.test.ts")).toBe(true);
    expect(isTestFile("e2e/a.spec.tsx")).toBe(true);
    expect(isTestFile("src/__tests__/helpers.ts")).toBe(true);
    expect(isTestFile("src/__tests__/types.d.ts")).toBe(false);
    expect(isTestFile("src/__tests__/fixture.json")).toBe(false);
    expect(isTestFile("src/index.ts")).toBe(false);
  });

  it("skips build output and node_modules when walking", () => {
    buildOnlyPackage("pkg");
    write("pkg/dist/__tests__/index.test.ts", "");
    write("pkg/node_modules/dep/a.test.ts", "");
    expect(findTestFiles(join(root, "pkg"))).toEqual([
      "src/__tests__/helpers.ts",
      "src/__tests__/index.test.ts",
    ]);
  });
});

describe("resolveTypecheckConfigs", () => {
  it("defaults a bare tsc to tsconfig.json", () => {
    expect(resolveTypecheckConfigs({ typecheck: "tsc --noEmit" }).configs).toEqual([
      "tsconfig.json",
    ]);
  });

  it("reads -p / --project and chains through && and pnpm run hops", () => {
    const r = resolveTypecheckConfigs({
      typecheck: "tsc --noEmit && pnpm run typecheck:tests",
      "typecheck:tests": "tsc --project tsconfig.test.json",
    });
    expect(r.configs).toEqual(["tsconfig.json", "tsconfig.test.json"]);
    expect(r.unresolved).toEqual([]);
  });

  it("ignores non-tsc steps rather than guessing a config for them", () => {
    expect(
      resolveTypecheckConfigs({
        typecheck: "fumadocs-mdx && tsc -p tsconfig.typecheck.json --noEmit",
      }).configs,
    ).toEqual(["tsconfig.typecheck.json"]);
  });
});

describe("scanPackage", () => {
  it("flags every test file the build tsconfig excludes (the #1000 shape)", () => {
    buildOnlyPackage("pkg");
    const r = scanPackage(join(root, "pkg"), root, {});
    expect(r?.uncovered).toEqual(["src/__tests__/helpers.ts", "src/__tests__/index.test.ts"]);
  });

  it("passes when the typecheck script also compiles a test-inclusive tsconfig", () => {
    buildOnlyPackage("pkg", "tsc --noEmit && tsc -p tsconfig.test.json");
    json("pkg/tsconfig.test.json", {
      extends: "./tsconfig.json",
      compilerOptions: { rootDir: ".", noEmit: true },
      include: ["src"],
      exclude: [],
    });
    const r = scanPackage(join(root, "pkg"), root, {});
    expect(r?.uncovered).toEqual([]);
    expect(r?.problems).toEqual([]);
  });

  it("does not count a test-inclusive tsconfig the typecheck script never runs", () => {
    // tsconfig.eslint.json includes the tests but only the linter reads it.
    buildOnlyPackage("pkg");
    json("pkg/tsconfig.eslint.json", { extends: "./tsconfig.json", include: ["src"], exclude: [] });
    expect(scanPackage(join(root, "pkg"), root, {})?.uncovered).toHaveLength(2);
  });

  it("flags test files outside src that the tsconfig include never reaches", () => {
    json("pkg/package.json", { name: "@fixture/pkg", scripts: { typecheck: "tsc --noEmit" } });
    json("pkg/tsconfig.json", { include: ["src"] });
    write("pkg/src/a.test.ts", "export {};\n");
    write("pkg/e2e/b.spec.ts", "export {};\n");
    expect(scanPackage(join(root, "pkg"), root, {})?.uncovered).toEqual(["e2e/b.spec.ts"]);
  });

  it("reports a typecheck script pointing at a missing tsconfig", () => {
    buildOnlyPackage("pkg", "tsc --noEmit && tsc -p tsconfig.missing.json");
    const r = scanPackage(join(root, "pkg"), root, {});
    expect(r?.problems.some((p) => p.includes("tsconfig.missing.json"))).toBe(true);
  });

  it("skips packages without a typecheck script", () => {
    json("pkg/package.json", { name: "@fixture/pkg", scripts: {} });
    expect(scanPackage(join(root, "pkg"), root, {})).toBeNull();
  });

  it("honors an allowlist entry and fails when that entry goes stale", () => {
    buildOnlyPackage("pkg");
    const known = { pkg: { "src/__tests__/": "fixture reason" } };
    const r = scanPackage(join(root, "pkg"), root, known);
    expect(r?.uncovered).toEqual([]);
    expect(r?.allowlisted).toHaveLength(2);
    expect(r?.problems).toEqual([]);

    const stale = scanPackage(join(root, "pkg"), root, { pkg: { "e2e/": "nothing here" } });
    expect(stale?.problems.some((p) => p.includes("stale KNOWN_UNCOVERED entry"))).toBe(true);
  });
});

describe("check-tests-typechecked (smoke)", () => {
  it("passes against the real repo and states its aperture", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const result = spawnSync("npx", ["tsx", join(repoRoot, "scripts/check-tests-typechecked.ts")], {
      encoding: "utf-8",
      cwd: repoRoot,
    });
    // Non-zero = a package's test files escaped its typecheck. Fix the
    // package's tsconfig.test.json / typecheck script, don't loosen this.
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d+ of \d+ test file\(s\) across \d+ package\(s\)/);
  });
});
