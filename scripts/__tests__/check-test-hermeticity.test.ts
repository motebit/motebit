/**
 * check-test-hermeticity — L1 of the test-cache law, one fixture per rule.
 *
 * A miniature workspace in a temp dir (its `*.test.ts` files must not sit under
 * scripts/__tests__). Every package below violates exactly ONE rule through the
 * shape named in its test; the gate must refuse to prove it. The clean package
 * must be proven. The config-agreement clauses (root default uncached, cached ⇒
 * proven, proven ⇒ cached, exemptions exact and live) are pinned on the CLI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyze, type Rule } from "../check-test-hermeticity.js";
import { hasApertureDisclosure, hasRepairInstruction } from "../lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE = resolve(__dirname, "..", "check-test-hermeticity.ts");
const TSX = resolve(__dirname, "..", "..", "node_modules", ".bin", "tsx");

const CONFIG =
  `import { defineMotebitTest } from "../../vitest.shared.js";\n` +
  `export default defineMotebitTest({ thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 } });\n`;

/** package → [rule it must trip (null = clean), test file body]. */
const PKGS: Record<string, [Rule | null, string]> = {
  clean: [
    null,
    `import { readFileSync, mkdtempSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\n` +
      `const d = mkdtempSync(join(tmpdir(), "x-"));\nexport const a = readFileSync(join(__dirname, "../own.json"), "utf-8") + d + process.env.TZ + process.env["LANG"];\n` +
      `const { TZ } = process.env; void TZ;\nif ("x" === "..") throw new Error();\n`,
  ],
  spawn: ["spawn", `import { execSync } from "node:child_process";\nexecSync("git log");\n`],
  "spawn-dynamic": ["spawn", `await import("node:child_process");\n`],
  execa: ["spawn", `import { execa } from "execa";\nvoid execa;\n`],
  worker: ["worker", `import { Worker } from "node:worker_threads";\nvoid Worker;\n`],
  "new-worker": ["worker", `export const w = new Worker(new URL("./w.js", import.meta.url));\n`],
  glob: ["glob", `export const m = import.meta.glob("./*.ts");\n`],
  raw: ["asset-outside", `import raw from "../../../../spec/x.md?raw";\nvoid raw;\n`],
  "import-escape": ["escape", `import { x } from "../../../other/src/index.js";\nvoid x;\n`],
  "cwd-relative": [
    "escape",
    `import { readFileSync } from "node:fs";\nreadFileSync("../../data.txt", "utf-8");\n`,
  ],
  "join-literal": [
    "escape",
    `import { readFileSync } from "node:fs";\nimport { join } from "node:path";\nreadFileSync(join("..", "..", "data.txt"));\n`,
  ],
  "template-up": [
    "escape",
    'import { readFileSync } from "node:fs";\nreadFileSync(`${__dirname}/../../../../data.txt`);\n',
  ],
  absolute: [
    "absolute-path",
    `import { readFileSync } from "node:fs";\nreadFileSync("/opt/thing/data.txt");\n`,
  ],
  "tmp-fixed": [
    "tmpdir-fixed",
    `import { readFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\nreadFileSync(join(tmpdir(), "fixed.txt"));\n`,
  ],
  "tmp-binding": [
    "tmpdir-fixed",
    'import { tmpdir } from "node:os";\nconst t = tmpdir();\nexport const p = `${t}/fixed.txt`;\n',
  ],
  "env-spread": ["env-whole", `export const e = { ...process.env };\n`],
  "env-keys": ["env-whole", `export const k = Object.keys(process.env);\n`],
  "env-in": ["env-whole", `export const has = "GITHUB_SHA" in process.env;\n`],
  "env-descriptor": [
    "env-whole",
    `export const d = Object.getOwnPropertyDescriptor(process.env, "GITHUB_SHA");\n`,
  ],
  "env-computed": ["env-whole", `const k = "GITHUB_SHA";\nexport const v = process.env[k];\n`],
  "env-rest": ["env-whole", `const { TZ, ...rest } = process.env;\nexport { TZ, rest };\n`],
  "env-alias": ["env-whole", `const env = process.env;\nexport const v = env.GITHUB_SHA;\n`],
  "env-import": ["env-whole", `import { env } from "node:process";\nexport const v = env.X;\n`],
};

/** Config-level shapes: the package's vitest.config itself. */
const CONFIG_PKGS: Record<string, [Rule, string]> = {
  "config-io": [
    "config-io",
    `import { readFileSync } from "node:fs";\nimport { defineMotebitTest } from "../../vitest.shared.js";\n` +
      `const v = readFileSync(new URL("../../data.txt", import.meta.url), "utf-8");\n` +
      `export default defineMotebitTest({ thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 }, vite: { define: { V: v } } });\n`,
  ],
  "config-env": [
    "config-io",
    `import { defineMotebitTest } from "../../vitest.shared.js";\n` +
      `export default defineMotebitTest({ thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 }, vite: { define: { V: JSON.stringify(process.env.GITHUB_SHA) } } });\n`,
  ],
  "global-setup": [
    "global-setup",
    `import { defineMotebitTest } from "../../vitest.shared.js";\n` +
      `export default defineMotebitTest({ thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 }, extra: { globalSetup: ["./gs.ts"] } });\n`,
  ],
};

let root = "";
const write = (rel: string, body: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const pj = (name: string, deps: Record<string, string> = {}) =>
  JSON.stringify({ name, version: "0.0.0", scripts: { test: "vitest run" }, dependencies: deps });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hermeticity-"));
  write(
    "turbo.json",
    JSON.stringify({
      globalDependencies: ["vitest.shared.ts"],
      tasks: { test: { cache: false }, "test:coverage": { cache: false } },
    }),
  );
  write("vitest.shared.ts", "export const defineMotebitTest = (x: unknown) => x;\n");
  write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write("data.txt", "d\n");
  for (const [name, [, body]] of Object.entries(PKGS)) {
    write(`packages/${name}/package.json`, pj(`@h/${name}`));
    write(`packages/${name}/vitest.config.ts`, CONFIG);
    write(`packages/${name}/src/own.json`, "{}\n");
    write(`packages/${name}/src/__tests__/a.test.ts`, body);
  }
  for (const [name, [, config]] of Object.entries(CONFIG_PKGS)) {
    write(`packages/${name}/package.json`, pj(`@h/${name}`));
    write(`packages/${name}/vitest.config.ts`, config);
    write(`packages/${name}/gs.ts`, "export default () => {};\n");
    write(`packages/${name}/src/__tests__/a.test.ts`, "export {};\n");
  }
  // A package whose DEPENDENCY's non-test src spawns: not hermetic either.
  write("packages/dep/package.json", JSON.stringify({ name: "@h/dep", version: "0.0.0" }));
  write(
    "packages/dep/src/index.ts",
    `import { spawn } from "node:child_process";\nexport { spawn };\n`,
  );
  write("packages/dep/src/__tests__/x.test.ts", `import "node:child_process";\n`); // a dep's TESTS are not scanned
  write("packages/uses-dep/package.json", pj("@h/uses-dep", { "@h/dep": "workspace:*" }));
  write("packages/uses-dep/vitest.config.ts", CONFIG);
  write("packages/uses-dep/src/__tests__/a.test.ts", `export {};\n`);
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("check-test-hermeticity — one rule per package", () => {
  it("proves the clean package (named env reads, mkdtemp, in-package paths, comparisons)", () => {
    const v = analyze(root, "@h/clean").verdicts[0]!;
    expect(v.blocking).toEqual([]);
    expect(v.hermetic && v.adoptsTracer).toBe(true);
  });

  for (const [name, [rule]] of [...Object.entries(PKGS), ...Object.entries(CONFIG_PKGS)]) {
    if (rule === null) continue;
    it(`${name}: refused by rule ${rule}`, () => {
      const v = analyze(root, `@h/${name}`).verdicts[0]!;
      expect(v.hermetic).toBe(false);
      expect(v.blocking.map((f) => f.rule)).toContain(rule);
    });
  }

  it("a workspace dependency's non-test src is scanned (its tests are not)", () => {
    const v = analyze(root, "@h/uses-dep").verdicts[0]!;
    expect(v.blocking.map((f) => `${f.rule} ${f.file}`)).toEqual(["spawn src/index.ts"]);
  });
});

function cli(...args: string[]): { status: number; out: string } {
  const r = spawnSync(TSX, [GATE, "--root", root, ...args], { encoding: "utf-8" });
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

describe("check-test-hermeticity — config agreement and exemptions", () => {
  const optIn = (name: string) =>
    write(
      `packages/${name}/turbo.json`,
      JSON.stringify({
        extends: ["//"],
        tasks: { test: { cache: true }, "test:coverage": { cache: true } },
      }),
    );
  const optOut = (name: string) =>
    rmSync(join(root, `packages/${name}/turbo.json`), { force: true });

  it("fails while a proven package is left uncached, passes once it opts in", () => {
    const before = cli();
    expect(before.status).toBe(1);
    expect(before.out).toContain("@h/clean is PROVEN hermetic but not cached");
    optIn("clean");
    const after = cli();
    expect(after.status, after.out).toBe(0);
    expect(hasApertureDisclosure(after.out).ok).toBe(true);
  });

  it("refuses a cached package that L1 does not prove, with a repair", () => {
    optIn("spawn");
    const r = cli();
    optOut("spawn");
    expect(r.status).toBe(1);
    expect(r.out).toContain("@h/spawn is CACHED but not proven hermetic");
    expect(hasRepairInstruction(r.out).ok).toBe(true);
  });

  it("refuses a cached test task when the root default is not uncached", () => {
    const turbo = join(root, "turbo.json");
    const orig = readFileSync(turbo, "utf-8");
    writeFileSync(turbo, orig.replaceAll('"cache":false', '"cache":true'));
    const r = cli();
    writeFileSync(turbo, orig);
    expect(r.out).toContain('root "test" / "test:coverage" must set "cache": false');
  });

  it("an exact, reasoned exemption proves the site; a stale one fails the gate", () => {
    write(
      "packages/absolute/test-hermeticity.json",
      JSON.stringify({
        exemptions: [
          {
            file: "src/__tests__/a.test.ts",
            rule: "absolute-path",
            text: '"/opt/thing/data.txt"',
            why: "fixture: pretend this path is data handed to a pure function",
          },
        ],
      }),
    );
    expect(analyze(root, "@h/absolute").verdicts[0]!.hermetic).toBe(true);
    optIn("absolute");
    expect(cli().status).toBe(0);
    write(
      "packages/absolute/test-hermeticity.json",
      JSON.stringify({
        exemptions: [
          {
            file: "src/__tests__/a.test.ts",
            rule: "absolute-path",
            text: '"/opt/gone"',
            why: "a site that no longer exists anywhere",
          },
        ],
      }),
    );
    const r = cli();
    optOut("absolute");
    rmSync(join(root, "packages/absolute/test-hermeticity.json"));
    expect(r.status).toBe(1);
    expect(r.out).toContain("matches no finding");
  });

  it("--verdict exits 0 only for a proven package", () => {
    expect(cli("--verdict", "@h/clean").status).toBe(0);
    expect(cli("--verdict", "@h/env-spread").status).toBe(1);
  });
});
