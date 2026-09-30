/**
 * check-turbo-test-inputs — a cached test result is only valid if every input
 * that can change its outcome is in its turbo task hash.
 *
 * The fixture is a miniature monorepo written to a temp dir (its `*.test.ts`
 * files must not sit under scripts/__tests__, where `pnpm test:gates` would try
 * to run them). One package declares its out-of-package read; the others each
 * carry exactly one kind of hole the gate exists to catch.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runGate } from "../check-turbo-test-inputs.js";
import { hasApertureDisclosure, hasRepairInstruction } from "../lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE = resolve(__dirname, "..", "check-turbo-test-inputs.ts");

const ROOT_TURBO = {
  globalDependencies: ["vitest.shared.ts", "tsconfig.base.json"],
  tasks: {
    build: { dependsOn: ["^build"], outputs: ["dist/**"] },
    test: { dependsOn: ["build"], env: ["CI", "TZ", "LANG"], outputs: [] },
    "test:coverage": {
      dependsOn: ["build"],
      env: ["CI", "TZ", "LANG"],
      outputs: ["coverage/**"],
    },
  },
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

type Tree = Record<string, string>;

function pkg(name: string, deps: Record<string, string> = {}): string {
  return JSON.stringify({
    name,
    scripts: { build: "tsc", test: "vitest run", "test:coverage": "vitest run --coverage" },
    devDependencies: deps,
  });
}

/** The base tree: root config + one clean package + a dependency package. */
function baseTree(): Tree {
  return {
    "turbo.json": JSON.stringify(ROOT_TURBO),
    "vitest.shared.ts": "export {};\n",
    "tsconfig.base.json": "{}\n",
    "spec/corpus.json": "[]\n",
    "spec/other/a.json": "{}\n",
    "packages/lib/package.json": pkg("@fx/lib"),
    "packages/lib/src/index.ts": "export const x = 1;\n",
    "packages/lib/src/fixture.json": "{}\n",
    // Clean: declares its spec read; imports vitest.shared (global) and its dep's file.
    "packages/declared/package.json": pkg("@fx/declared", { "@fx/lib": "workspace:*" }),
    "packages/declared/turbo.json": JSON.stringify(
      declaredInputs(["$TURBO_ROOT$/spec/corpus.json"]),
    ),
    "packages/declared/vitest.config.ts": `import "../../vitest.shared.js";\nexport default {};\n`,
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

function runCli(root: string): { status: number | null; out: string } {
  const r = spawnSync("npx", ["tsx", GATE, "--root", root], { encoding: "utf-8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("check-turbo-test-inputs", () => {
  let clean: string;
  beforeAll(() => {
    clean = fixture();
  });

  it("passes a tree whose every out-of-package read is hashed, and states its aperture", () => {
    const { violations, stats } = runGate(clean);
    expect(violations).toEqual([]);
    expect(stats.coveredByInputs).toBe(1); // spec/corpus.json
    expect(stats.coveredByGlobal).toBe(1); // vitest.shared.ts
    expect(stats.coveredByDeps).toBe(1); // @fx/lib's fixture
    expect(stats.envStripped).toBe(1);
    expect(stats.envHashed).toBe(1);
    const cli = runCli(clean);
    expect(cli.status).toBe(0);
    expect(hasApertureDisclosure(cli.out).ok).toBe(true);
  });

  it("FAILS on a fixture package with an UNDECLARED out-of-package read, with a repair instruction", () => {
    const root = fixture({
      "packages/undeclared/package.json": pkg("@fx/undeclared"),
      "packages/undeclared/src/__tests__/b.test.ts": READ_CORPUS,
    });
    const { violations } = runGate(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ pkg: "@fx/undeclared", kind: "path" });
    expect(violations[0]!.detail).toContain("$TURBO_ROOT$/spec/corpus.json");
    const cli = runCli(root);
    expect(cli.status).toBe(1);
    expect(hasRepairInstruction(cli.out).ok).toBe(true);
  });

  it("goes red when one declared input is removed (tamper)", () => {
    const root = fixture({ "packages/declared/turbo.json": JSON.stringify(declaredInputs([])) });
    const { violations } = runGate(root);
    expect(violations.map((v) => v.site)).toEqual(["packages/declared/src/__tests__/a.test.ts:5"]);
  });

  it("requires the input on BOTH test tasks", () => {
    const half = declaredInputs(["$TURBO_ROOT$/spec/corpus.json"]);
    half.tasks["test:coverage"].inputs = ["$TURBO_DEFAULT$"];
    const root = fixture({ "packages/declared/turbo.json": JSON.stringify(half) });
    const [v] = runGate(root).violations;
    expect(v?.detail).toContain("not hashed by test:coverage");
  });

  it("rejects package inputs that drop $TURBO_DEFAULT$ (the package's own files)", () => {
    const own = declaredInputs(["$TURBO_ROOT$/spec/corpus.json"]);
    own.tasks.test.inputs = ["$TURBO_ROOT$/spec/corpus.json"];
    const root = fixture({ "packages/declared/turbo.json": JSON.stringify(own) });
    expect(runGate(root).violations.some((v) => v.detail.includes("$TURBO_DEFAULT$"))).toBe(true);
  });

  it("a dynamic tail under an outside root needs the whole directory hashed", () => {
    const root = fixture({
      "packages/dyn/package.json": pkg("@fx/dyn"),
      "packages/dyn/turbo.json": JSON.stringify(declaredInputs(["$TURBO_ROOT$/spec/other/a.json"])),
      "packages/dyn/src/__tests__/d.test.ts":
        `import { join } from "node:path";\n` +
        `const ROOT = join(__dirname, "..", "..", "..", "..");\n` +
        `export const read = (n: string) => join(ROOT, "spec", "other", n);\n`,
    });
    const [v] = runGate(root).violations;
    expect(v?.detail).toContain("$TURBO_ROOT$/spec/other/**");
    const ok = fixture({
      "packages/dyn/package.json": pkg("@fx/dyn"),
      "packages/dyn/turbo.json": JSON.stringify(declaredInputs(["$TURBO_ROOT$/spec/other/**"])),
      "packages/dyn/src/__tests__/d.test.ts":
        `import { join } from "node:path";\n` +
        `const ROOT = join(__dirname, "..", "..", "..", "..");\n` +
        `export const read = (n: string) => join(ROOT, "spec", "other", n);\n`,
    });
    expect(runGate(ok).violations).toEqual([]);
  });

  it("reads a sibling package that is NOT a dependency only via declared inputs", () => {
    const root = fixture({
      "packages/nodep/package.json": pkg("@fx/nodep"),
      "packages/nodep/src/__tests__/n.test.ts": `import { x } from "../../../lib/src/index.js";\nexport { x };\n`,
    });
    const [v] = runGate(root).violations;
    expect(v?.detail).toContain("$TURBO_ROOT$/packages/lib/src/**");
    expect(v?.detail).toContain("or declare @fx/lib as a workspace dependency");
  });

  it("flags a bare import of an undeclared workspace package (resolved through a hoisted link)", () => {
    const root = fixture({
      "packages/hoist/package.json": pkg("@fx/hoist"),
      "packages/hoist/src/__tests__/h.test.ts": `import { x } from "@fx/lib";\nexport { x };\n`,
    });
    const [v] = runGate(root).violations;
    expect(v?.detail).toContain(`Add "@fx/lib": "workspace:*"`);
  });

  it("flags an unhashed pass-through env read, ignores stripped ones", () => {
    const root = fixture({
      "packages/env/package.json": pkg("@fx/env"),
      "packages/env/src/x.test.ts":
        `export const a = process.env.GITHUB_TOKEN;\nexport const b = process.env["OPENAI_API_KEY"];\n` +
        `process.env.CI = "1";\n`,
    });
    const vs = runGate(root).violations;
    expect(vs).toHaveLength(1);
    expect(vs[0]!.detail).toContain("process.env.GITHUB_TOKEN");
  });

  it("requires the root test tasks to hash CI/TZ/LANG, output coverage/**, and keep globalDependencies", () => {
    const bad = structuredClone(ROOT_TURBO) as Record<string, unknown> & typeof ROOT_TURBO;
    bad.tasks.test.env = [];
    bad.tasks["test:coverage"].outputs = [];
    bad.globalDependencies = [];
    const root = fixture({ "turbo.json": JSON.stringify(bad) });
    const details = runGate(root).violations.map((v) => v.detail);
    expect(details.filter((d) => d.includes(`task "test" must hash`))).toHaveLength(3);
    expect(details.some((d) => d.includes("coverage/**"))).toBe(true);
    expect(details.filter((d) => d.includes("globalDependencies is missing"))).toHaveLength(2);
  });

  it("an uncached package must be registered in UNCACHED (with its reason)", () => {
    const off = {
      extends: ["//"],
      tasks: { test: { cache: false }, "test:coverage": { cache: false } },
    };
    const root = fixture({ "packages/declared/turbo.json": JSON.stringify(off) });
    const [v] = runGate(root).violations;
    expect(v?.detail).toContain("not in UNCACHED");
  });

  it("ignores code outside the test-time closure (a hand-run build script)", () => {
    const root = fixture({
      "packages/declared/scripts/build.ts": READ_CORPUS.replace("../../../../", "../../../"),
    });
    expect(runGate(root).violations).toEqual([]);
  });
});
