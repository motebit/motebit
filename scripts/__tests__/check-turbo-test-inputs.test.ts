/**
 * check-turbo-test-inputs — the static pre-check behind cached test results.
 *
 * The fixture is a miniature monorepo written to a temp dir (its `*.test.ts`
 * files must not sit under scripts/__tests__, where `pnpm test:gates` would try
 * to run them). The clean tree passes; every other case changes exactly one
 * thing and asserts the one violation it must produce. Every claim in the
 * gate's header is pinned here — scripts/turbo-cache-mutations.ts applies a
 * single-line mutation per claim and requires this file to go red.
 *
 * The pass-through set is injected (FAKE_PT) except in the one test that
 * measures the installed turbo for real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  measurePassthrough,
  probeCandidates,
  runGate,
  type Passthrough,
} from "../check-turbo-test-inputs.js";
import { hasApertureDisclosure, hasRepairInstruction } from "../lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const GATE = resolve(__dirname, "..", "check-turbo-test-inputs.ts");

const TEST_ENV = [
  "CI",
  "TZ",
  "LANG",
  "NODE_OPTIONS",
  "LD_LIBRARY_PATH",
  "GITHUB_PAT",
  "MOTEBIT_TEST_RUNTIME",
];
const ROOT_TURBO = {
  globalDependencies: [
    "vitest.shared.ts",
    "tsconfig.base.json",
    ".node-version",
    "scripts/test-support/**",
  ],
  tasks: {
    build: { dependsOn: ["^build"], outputs: ["dist/**"] },
    test: { dependsOn: ["build"], env: [...TEST_ENV], outputs: [] as string[] },
    "test:coverage": {
      dependsOn: ["build"],
      env: [...TEST_ENV],
      outputs: ["coverage/**"],
    },
  },
};

/** A measured set as the installed turbo would report it (every entry classified). */
const FAKE_PT: Passthrough = {
  exact: ["CI", "HOME", "LANG", "NODE_OPTIONS", "PATH", "TZ", "XDG_RUNTIME_DIR"],
  prefixes: ["GITHUB_"],
  injected: ["TURBO_HASH"],
  source: "fixture",
};

const declaredInputs = (paths: string[]) => ({
  extends: ["//"],
  tasks: {
    test: { inputs: ["$TURBO_DEFAULT$", ...paths] },
    "test:coverage": { inputs: ["$TURBO_DEFAULT$", ...paths] },
  },
});

const READ_CORPUS = `import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/corpus.json");
export const corpus = JSON.parse(readFileSync(CORPUS, "utf-8"));
`;

const VITEST_CONFIG = `import { defineMotebitTest } from "../../vitest.shared.js";\nexport default defineMotebitTest({ thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 } });\n`;

type Tree = Record<string, string>;

function pkg(name: string, deps: Record<string, string> = {}): string {
  return JSON.stringify({
    name,
    scripts: { build: "tsc", test: "vitest run", "test:coverage": "vitest run --coverage" },
    devDependencies: deps,
  });
}

/** A package with a test script and a tracer-registering vitest config. */
function testPkg(dir: string, name: string, deps: Record<string, string> = {}): Tree {
  return {
    [`${dir}/package.json`]: pkg(name, deps),
    [`${dir}/vitest.config.ts`]: VITEST_CONFIG,
  };
}

const ROOT_PJ = {
  name: "fx-root",
  private: true,
  scripts: {
    test: "node scripts/turbo-run.mjs run test",
    "test:coverage": "node scripts/turbo-run.mjs run test:coverage",
  },
  devDependencies: { turbo: "2.10.9" },
};

const WORKFLOW = `jobs:
  check:
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version-file: .node-version
      - run: node scripts/turbo-run.mjs run test:coverage --concurrency=4
`;

/** The base tree: root config + one clean package + a dependency package. */
function baseTree(): Tree {
  return {
    "package.json": JSON.stringify(ROOT_PJ),
    "turbo.json": JSON.stringify(ROOT_TURBO),
    ".node-version": "22.22.2\n",
    ".husky/pre-push": `node scripts/turbo-run.mjs run typecheck lint test:coverage --filter=x\n`,
    ".github/workflows/ci.yml": WORKFLOW,
    "vitest.shared.ts": "export {};\n",
    "tsconfig.base.json": "{}\n",
    "spec/corpus.json": "[]\n",
    "spec/other/a.json": "{}\n",
    // A dependency with no test script — the gate only checks packages that test.
    "packages/lib/package.json": JSON.stringify({ name: "@fx/lib", scripts: { build: "tsc" } }),
    "packages/lib/src/index.ts": "export const x = 1;\n",
    "packages/lib/src/fixture.json": "{}\n",
    // Clean: declares its spec read; imports vitest.shared (global) and its dep's file.
    ...testPkg("packages/declared", "@fx/declared", { "@fx/lib": "workspace:*" }),
    "packages/declared/turbo.json": JSON.stringify(
      declaredInputs(["$TURBO_ROOT$/spec/corpus.json"]),
    ),
    "packages/declared/src/__tests__/a.test.ts":
      READ_CORPUS +
      `export const fix = readFileSync(new URL("../../../lib/src/fixture.json", import.meta.url));\n` +
      `export const k = process.env.MOTEBIT_SOME_KEY; // stripped by strict mode\n` +
      `export const tz = process.env.TZ; // hashed\n`,
  };
}

function write(root: string, tree: Tree): void {
  for (const [p, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
}

const roots: string[] = [];
function fixture(extra: Tree = {}, drop: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "turbo-test-inputs-"));
  roots.push(root);
  const tree = { ...baseTree(), ...extra };
  for (const d of drop) delete tree[d];
  write(root, tree);
  return root;
}

const gate = (root: string, pt: Passthrough = FAKE_PT) => runGate(root, { passthrough: pt });
const details = (root: string, pt: Passthrough = FAKE_PT) =>
  gate(root, pt).violations.map((v) => v.detail);

function runCli(root: string): { status: number | null; out: string } {
  const ptFile = join(root, "pt.json");
  writeFileSync(ptFile, JSON.stringify(FAKE_PT));
  const r = spawnSync("npx", ["tsx", GATE, "--root", root, "--passthrough", ptFile], {
    encoding: "utf-8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("check-turbo-test-inputs — clean tree and CLI", () => {
  let clean: string;
  beforeAll(() => {
    clean = fixture();
  });

  it("passes a tree whose every out-of-package read is hashed, and states its aperture", () => {
    const { violations, stats } = gate(clean);
    expect(violations).toEqual([]);
    expect(stats.coveredByInputs).toBe(1); // spec/corpus.json
    expect(stats.coveredByGlobal).toBe(1); // vitest.shared.ts
    expect(stats.coveredByDeps).toBe(1); // @fx/lib's fixture
    expect(stats.envStripped).toBe(1);
    expect(stats.envHashed).toBe(1);
    expect(stats.entryPoints).toBe(4); // 2 root scripts, pre-push, workflow
    expect(stats.workflows).toBe(1);
    const cli = runCli(clean);
    expect(cli.status).toBe(0);
    expect(hasApertureDisclosure(cli.out).ok).toBe(true);
  });

  it("FAILS on an UNDECLARED out-of-package read, with a repair instruction", () => {
    const root = fixture({
      ...testPkg("packages/undeclared", "@fx/undeclared"),
      "packages/undeclared/src/__tests__/b.test.ts": READ_CORPUS,
    });
    const { violations } = gate(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ pkg: "@fx/undeclared", kind: "path" });
    expect(violations[0]!.detail).toContain("$TURBO_ROOT$/spec/corpus.json");
    const cli = runCli(root);
    expect(cli.status).toBe(1);
    expect(hasRepairInstruction(cli.out).ok).toBe(true);
  });
});

describe("check-turbo-test-inputs — root config (1)", () => {
  it("rejects a non-strict envMode", () => {
    const root = fixture({ "turbo.json": JSON.stringify({ ...ROOT_TURBO, envMode: "loose" }) });
    expect(details(root)).toEqual([expect.stringContaining(`envMode is "loose"`)]);
  });

  it("requires every GLOBAL_TEST_FILES entry, one by one", () => {
    for (const f of ROOT_TURBO.globalDependencies) {
      const root = fixture({
        "turbo.json": JSON.stringify({
          ...ROOT_TURBO,
          globalDependencies: ROOT_TURBO.globalDependencies.filter((g) => g !== f),
        }),
      });
      expect(details(root), f).toContain(
        `globalDependencies is missing "${f}" (every package's test task reads it)`,
      );
    }
  });

  it("requires dependsOn build on both test tasks", () => {
    const bad = structuredClone(ROOT_TURBO);
    (bad.tasks.test as { dependsOn: string[] }).dependsOn = [];
    const root = fixture({ "turbo.json": JSON.stringify(bad) });
    expect(details(root)).toEqual([expect.stringContaining(`task "test" must dependsOn "build"`)]);
  });

  it("requires every REQUIRED_TEST_ENV var hashed on both tasks, one by one", () => {
    for (const e of TEST_ENV) {
      for (const t of ["test", "test:coverage"] as const) {
        const bad = structuredClone(ROOT_TURBO);
        bad.tasks[t].env = TEST_ENV.filter((x) => x !== e);
        const root = fixture({ "turbo.json": JSON.stringify(bad) });
        expect(details(root), `${t} ${e}`).toEqual(
          expect.arrayContaining([expect.stringContaining(`task "${t}" must hash "${e}" in env`)]),
        );
      }
    }
  });

  it("rejects passThroughEnv on a test task", () => {
    const bad = structuredClone(ROOT_TURBO) as typeof ROOT_TURBO & {
      tasks: { test: { passThroughEnv?: string[] } };
    };
    bad.tasks.test.passThroughEnv = ["FOO"];
    const root = fixture({ "turbo.json": JSON.stringify(bad) });
    expect(details(root)).toEqual([expect.stringContaining("declares passThroughEnv")]);
  });

  it("requires coverage/** as the test:coverage output", () => {
    const bad = structuredClone(ROOT_TURBO);
    bad.tasks["test:coverage"].outputs = [];
    const root = fixture({ "turbo.json": JSON.stringify(bad) });
    expect(details(root)).toEqual([expect.stringContaining(`outputs ["coverage/**"]`)]);
  });
});

describe("check-turbo-test-inputs — runtime (2, C1)", () => {
  it("requires an EXACT .node-version", () => {
    for (const v of ["22", "22.22", "lts/*", ""]) {
      const root = fixture({ ".node-version": `${v}\n` });
      expect(details(root), v).toEqual([
        expect.stringContaining("must hold an exact Node version"),
      ]);
    }
    expect(details(fixture({}, [".node-version"]))).toEqual([
      expect.stringContaining("must hold an exact Node version"),
    ]);
  });

  it("requires turbo pinned exactly", () => {
    for (const v of ["^2.10.9", "~2.10.9", "2.x", "latest"]) {
      const root = fixture({
        "package.json": JSON.stringify({ ...ROOT_PJ, devDependencies: { turbo: v } }),
      });
      expect(details(root), v).toEqual([expect.stringContaining("pin it exactly")]);
    }
  });

  it("requires root scripts that run a test task to go through the wrapper", () => {
    const root = fixture({
      "package.json": JSON.stringify({
        ...ROOT_PJ,
        scripts: { ...ROOT_PJ.scripts, "test:ci": "turbo run test:coverage --concurrency=4" },
      }),
    });
    expect(gate(root).violations.map((v) => v.site)).toEqual(["package.json scripts.test:ci"]);
  });

  it("requires pre-push and workflows to run test tasks through the wrapper", () => {
    const root = fixture({
      ".husky/pre-push": `# pnpm turbo run test is documented here, not run\npnpm turbo run typecheck lint test:coverage --filter=x\n`,
      ".github/workflows/ci.yml": WORKFLOW.replace(
        "node scripts/turbo-run.mjs run test:coverage",
        "pnpm exec turbo run test:coverage",
      ),
    });
    expect(gate(root).violations.map((v) => v.site)).toEqual([
      ".husky/pre-push:2",
      ".github/workflows/ci.yml:7",
    ]);
  });

  it("requires every setup-node to read .node-version", () => {
    const root = fixture({
      ".github/workflows/release.yml": WORKFLOW.replace(
        "node-version-file: .node-version",
        'node-version: "22"',
      ),
    });
    expect(gate(root).violations.map((v) => v.site)).toEqual([".github/workflows/release.yml:6"]);
  });
});

describe("check-turbo-test-inputs — measured pass-through env (3, C6)", () => {
  it("requires every measured pass-through var to be classified in ENV_POLICY", () => {
    const root = fixture();
    expect(
      details(root, { ...FAKE_PT, exact: [...FAKE_PT.exact, "MOTEBIT_NEW_PASSTHRU"] }),
    ).toEqual([
      expect.stringContaining(`turbo passes "MOTEBIT_NEW_PASSTHRU" into test tasks unhashed`),
    ]);
    expect(details(root, { ...FAKE_PT, injected: ["MOTEBIT_INJECTED"] })).toEqual([
      expect.stringContaining(`"MOTEBIT_INJECTED"`),
    ]);
  });

  it("requires every measured pass-through PREFIX to be classified", () => {
    const root = fixture();
    expect(details(root, { ...FAKE_PT, prefixes: ["GITHUB_", "MOTEBITX_"] })).toEqual([
      expect.stringContaining(`every "MOTEBITX_*" var`),
    ]);
  });

  it("requires a hash-class pass-through var to be hashed", () => {
    const bad = structuredClone(ROOT_TURBO);
    bad.tasks.test.env = TEST_ENV.filter((x) => x !== "TZ");
    const root = fixture({ "turbo.json": JSON.stringify(bad) });
    const d = details(root);
    expect(d).toContain(
      `"TZ" is a hash-class pass-through var (every local-time Date conversion) — add it to env of both test tasks`,
    );
  });

  it("probeCandidates finds every name packed into the binary's strings, and every prefix", () => {
    const c = probeCandidates("\u0000xyXDG_RUNTIME_DIRXAUTHORITYNODE_OPTIONSVITE_*\u0000");
    for (const n of ["XDG_RUNTIME_DIR", "XAUTHORITY", "NODE_OPTIONS"]) expect(c.exact).toContain(n);
    expect(c.prefixes).toContain("VITE_");
  });

  it("measures the INSTALLED turbo: a probed name passes, TMPDIR is stripped, GITHUB_* is a wildcard", () => {
    const pt = measurePassthrough(REPO);
    expect(pt.exact).toContain("XDG_RUNTIME_DIR");
    expect(pt.exact).toContain("NODE_OPTIONS");
    expect(pt.exact).not.toContain("TMPDIR");
    expect(pt.prefixes).toContain("GITHUB_");
    expect(pt.source).toMatch(/measured from turbo \d/);
  }, 120_000);
});

describe("check-turbo-test-inputs — tracer adoption (4) and UNCACHED (5)", () => {
  it("requires a cached package's vitest config to build through defineMotebitTest", () => {
    const bare = fixture({
      "packages/declared/vitest.config.ts": `import { defineConfig } from "vitest/config";\nexport default defineConfig({});\n`,
    });
    expect(details(bare)).toEqual([expect.stringContaining("does not call defineMotebitTest")]);
    const none = fixture({}, ["packages/declared/vitest.config.ts"]);
    expect(details(none)).toEqual([expect.stringContaining("there is no vitest.config")]);
  });

  it("requires identical inputs on test and test:coverage", () => {
    const half = declaredInputs(["$TURBO_ROOT$/spec/corpus.json"]);
    half.tasks["test:coverage"].inputs = ["$TURBO_DEFAULT$", "$TURBO_ROOT$/spec/corpus.json", "x"];
    const root = fixture({ "packages/declared/turbo.json": JSON.stringify(half) });
    expect(details(root)).toEqual([expect.stringContaining("declare different inputs")]);
  });

  it("rejects package inputs that drop $TURBO_DEFAULT$ (the package's own files)", () => {
    const own = {
      extends: ["//"],
      tasks: {
        test: { inputs: ["$TURBO_ROOT$/spec/corpus.json"] },
        "test:coverage": { inputs: ["$TURBO_ROOT$/spec/corpus.json"] },
      },
    };
    const root = fixture({ "packages/declared/turbo.json": JSON.stringify(own) });
    expect(details(root).filter((d) => d.includes(`drop "$TURBO_DEFAULT$"`))).toHaveLength(2);
  });

  it("an uncached package must be registered in UNCACHED (with its reason)", () => {
    const off = {
      extends: ["//"],
      tasks: { test: { cache: false }, "test:coverage": { cache: false } },
    };
    const root = fixture({ "packages/declared/turbo.json": JSON.stringify(off) });
    expect(details(root)).toEqual([expect.stringContaining("not in UNCACHED")]);
  });

  it("a package in UNCACHED must set cache:false on both test tasks", () => {
    const root = fixture({ ...testPkg("packages/tpm", "@motebit/crypto-tpm") });
    expect(details(root)).toEqual([expect.stringContaining("listed in UNCACHED but")]);
  });
});

describe("check-turbo-test-inputs — pre-check scan (6)", () => {
  it("goes red when one declared input is removed (tamper)", () => {
    const root = fixture({ "packages/declared/turbo.json": JSON.stringify(declaredInputs([])) });
    expect(gate(root).violations.map((v) => v.site)).toEqual([
      "packages/declared/src/__tests__/a.test.ts:5",
    ]);
  });

  it("requires the input on BOTH test tasks", () => {
    const half = declaredInputs(["$TURBO_ROOT$/spec/corpus.json"]);
    half.tasks["test:coverage"].inputs = ["$TURBO_DEFAULT$"];
    const root = fixture({ "packages/declared/turbo.json": JSON.stringify(half) });
    expect(details(root).some((d) => d.includes("not hashed by test:coverage"))).toBe(true);
  });

  it("a dynamic tail under an outside root needs the whole directory hashed", () => {
    const dyn = (inputs: string[]): Tree => ({
      ...testPkg("packages/dyn", "@fx/dyn"),
      "packages/dyn/turbo.json": JSON.stringify(declaredInputs(inputs)),
      "packages/dyn/src/__tests__/d.test.ts":
        `import { join } from "node:path";\n` +
        `const ROOT = join(__dirname, "..", "..", "..", "..");\n` +
        `export const read = (n: string) => join(ROOT, "spec", "other", n);\n`,
    });
    expect(details(fixture(dyn(["$TURBO_ROOT$/spec/other/a.json"])))).toEqual([
      expect.stringContaining("$TURBO_ROOT$/spec/other/**"),
    ]);
    expect(gate(fixture(dyn(["$TURBO_ROOT$/spec/other/**"]))).violations).toEqual([]);
  });

  it("reads a sibling package that is NOT a dependency only via declared inputs", () => {
    const root = fixture({
      ...testPkg("packages/nodep", "@fx/nodep"),
      "packages/nodep/src/__tests__/n.test.ts": `import { x } from "../../../lib/src/index.js";\nexport { x };\n`,
    });
    const [v] = gate(root).violations;
    expect(v?.detail).toContain("$TURBO_ROOT$/packages/lib/src/**");
    expect(v?.detail).toContain("or declare @fx/lib as a workspace dependency");
  });

  it("flags a bare import of an undeclared workspace package (resolved through a hoisted link)", () => {
    const root = fixture({
      ...testPkg("packages/hoist", "@fx/hoist"),
      "packages/hoist/src/__tests__/h.test.ts": `import { x } from "@fx/lib";\nexport { x };\n`,
    });
    expect(details(root)).toEqual([expect.stringContaining(`Add "@fx/lib": "workspace:*"`)]);
  });

  it("flags a read of a MEASURED pass-through var (exact or prefix) unless hashed or benign", () => {
    const root = fixture({
      ...testPkg("packages/env", "@fx/env"),
      "packages/env/src/x.test.ts":
        `export const a = process.env.GITHUB_TOKEN; // prefix GITHUB_*\n` +
        `export const b = process.env.XDG_RUNTIME_DIR; // exact\n` +
        `export const c = process.env["OPENAI_API_KEY"]; // stripped\n` +
        `export const d = process.env.HOME; // benign\n` +
        `export const e = process.env.TZ; // hashed\n` +
        `process.env.CI = "1";\n`,
    });
    const vs = gate(root).violations.map((v) => v.detail);
    expect(vs).toHaveLength(2);
    expect(vs[0]).toContain("process.env.GITHUB_TOKEN");
    expect(vs[1]).toContain("process.env.XDG_RUNTIME_DIR");
  });

  it("ignores code outside the test-time closure (a hand-run build script)", () => {
    const root = fixture({
      "packages/declared/scripts/build.ts": READ_CORPUS.replace("../../../../", "../../../"),
    });
    expect(gate(root).violations).toEqual([]);
  });
});
