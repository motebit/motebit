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
  resolvedCompilerOptions,
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

/** The strict build flags the repo's tsconfig.base.json sets. */
const STRICT_BUILD = {
  strict: true,
  noImplicitAny: true,
  strictNullChecks: true,
  noUncheckedIndexedAccess: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  skipLibCheck: true,
};

/** A package with the fixed shape: strict build config + tsconfig.test.json. */
function testConfigPackage(
  dir: string,
  testOptions: Record<string, unknown>,
  typecheck = "tsc --noEmit && tsc -p tsconfig.test.json",
  buildOptions: Record<string, unknown> = STRICT_BUILD,
): void {
  buildOnlyPackage(dir, typecheck);
  json(`${dir}/tsconfig.json`, {
    compilerOptions: { rootDir: "src", outDir: "dist", ...buildOptions },
    include: ["src"],
    exclude: ["src/__tests__"],
  });
  json(`${dir}/tsconfig.test.json`, {
    extends: "./tsconfig.json",
    compilerOptions: { rootDir: ".", noEmit: true, ...testOptions },
    include: ["src"],
    exclude: [],
  });
}

function problemsOf(dir: string): string[] {
  const r = scanPackage(join(root, dir), root, {});
  expect(r).not.toBeNull();
  return r!.problems;
}

describe("scanPackage — the test config is at least as strict as the build config", () => {
  it("passes when the test config inherits the build config's strictness", () => {
    testConfigPackage("pkg", {});
    expect(problemsOf("pkg")).toEqual([]);
  });

  it("passes when the test config is stricter than the build config", () => {
    testConfigPackage("pkg", { exactOptionalPropertyTypes: true, noImplicitOverride: true });
    expect(problemsOf("pkg")).toEqual([]);
  });

  it.each([
    ["strict", { strict: false }],
    ["noImplicitAny", { noImplicitAny: false }],
    ["strictNullChecks", { strictNullChecks: false }],
    ["noUncheckedIndexedAccess", { noUncheckedIndexedAccess: false }],
    ["noUnusedLocals", { noUnusedLocals: false }],
    ["noUnusedParameters", { noUnusedParameters: false }],
    ["useUnknownInCatchVariables", { useUnknownInCatchVariables: false }],
  ])("fails when tsconfig.test.json turns off %s", (flag, opts) => {
    testConfigPackage("pkg", opts);
    const problems = problemsOf("pkg");
    expect(problems.some((p) => p.includes("tsconfig.test.json") && p.includes(flag))).toBe(true);
  });

  it("fails when the test config turns on skipLibCheck the build config keeps off", () => {
    testConfigPackage("pkg", { skipLibCheck: true }, undefined, {
      ...STRICT_BUILD,
      skipLibCheck: false,
    });
    expect(problemsOf("pkg").some((p) => p.includes("skipLibCheck"))).toBe(true);
  });

  it("fails when the test config drops a flag the build config opts into", () => {
    testConfigPackage(
      "pkg",
      { exactOptionalPropertyTypes: false, noImplicitOverride: false },
      undefined,
      {
        ...STRICT_BUILD,
        exactOptionalPropertyTypes: true,
        noImplicitOverride: true,
      },
    );
    const problems = problemsOf("pkg");
    expect(problems.some((p) => p.includes("exactOptionalPropertyTypes"))).toBe(true);
    expect(problems.some((p) => p.includes("noImplicitOverride"))).toBe(true);
  });

  it("resolves strict-family flags as tsc does: `strict: false` weakens every implied flag", () => {
    // The build config sets only `strict: true`; the test config only
    // `strict: false`. No strict-family flag is named explicitly, so the gate
    // must apply strict's implication to see noImplicitAny etc. go off.
    testConfigPackage("pkg", { strict: false }, undefined, { strict: true });
    const problems = problemsOf("pkg");
    for (const flag of ["noImplicitAny", "strictNullChecks", "useUnknownInCatchVariables"]) {
      expect(problems.some((p) => p.includes(flag))).toBe(true);
    }
  });

  it("follows the extends chain: a weakening in an intermediate config is caught", () => {
    testConfigPackage("pkg", {});
    json("pkg/tsconfig.loose.json", {
      extends: "./tsconfig.json",
      compilerOptions: { noUncheckedIndexedAccess: false },
    });
    json("pkg/tsconfig.test.json", {
      extends: "./tsconfig.loose.json",
      compilerOptions: { rootDir: ".", noEmit: true },
      include: ["src"],
      exclude: [],
    });
    expect(problemsOf("pkg").some((p) => p.includes("noUncheckedIndexedAccess"))).toBe(true);
  });

  it("reads the same resolved options `tsc --showConfig` prints", () => {
    testConfigPackage("pkg", { strict: false, noUncheckedIndexedAccess: false });
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const shown = spawnSync(
      join(repoRoot, "node_modules", ".bin", "tsc"),
      ["--showConfig", "-p", join(root, "pkg", "tsconfig.test.json")],
      { encoding: "utf-8" },
    );
    expect(shown.status).toBe(0);
    const showConfig = (JSON.parse(shown.stdout) as { compilerOptions: Record<string, unknown> })
      .compilerOptions;
    const resolved = resolvedCompilerOptions(join(root, "pkg", "tsconfig.test.json"));
    for (const [flag, value] of Object.entries(showConfig)) {
      if (typeof value === "boolean") expect([flag, resolved[flag]]).toEqual([flag, value]);
    }
    expect(resolved.strict).toBe(false);
    expect(resolved.noUncheckedIndexedAccess).toBe(false);
  });
});

describe("scanPackage — the typecheck script runs every tsconfig unconditionally", () => {
  it("accepts an && chain, including through pnpm run hops", () => {
    testConfigPackage("pkg", {}, "tsc --noEmit && pnpm run typecheck:tests");
    json("pkg/package.json", {
      name: "@fixture/pkg",
      scripts: {
        typecheck: "tsc --noEmit && pnpm run typecheck:tests",
        "typecheck:tests": "tsc -p tsconfig.test.json",
      },
    });
    expect(problemsOf("pkg")).toEqual([]);
  });

  it("does not mistake an operator inside quotes for a control operator", () => {
    testConfigPackage("pkg", {}, 'tsc --noEmit && tsc -p tsconfig.test.json && echo "a || b; c"');
    expect(problemsOf("pkg")).toEqual([]);
  });

  it.each([
    ["||", "tsc --noEmit || tsc -p tsconfig.test.json"],
    ["|| true", "tsc --noEmit && tsc -p tsconfig.test.json || true"],
    [";", "tsc --noEmit; tsc -p tsconfig.test.json"],
    ["|", "tsc --noEmit | tee tc.log && tsc -p tsconfig.test.json"],
    ["&", "tsc --noEmit & tsc -p tsconfig.test.json"],
  ])("rejects `%s` in the typecheck script", (op, script) => {
    testConfigPackage("pkg", {}, script);
    const problems = problemsOf("pkg");
    expect(
      problems.some((p) => p.includes(`\`${op.split(" ")[0]}\``) && p.includes("typecheck")),
    ).toBe(true);
  });

  it("rejects a tolerant operator in a script reached through a pnpm run hop", () => {
    testConfigPackage("pkg", {});
    json("pkg/package.json", {
      name: "@fixture/pkg",
      scripts: {
        typecheck: "tsc --noEmit && pnpm run typecheck:tests",
        "typecheck:tests": "tsc -p tsconfig.test.json || echo skipped",
      },
    });
    expect(problemsOf("pkg").some((p) => p.includes("typecheck:tests") && p.includes("`||`"))).toBe(
      true,
    );
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
