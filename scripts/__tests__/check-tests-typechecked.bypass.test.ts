/**
 * check-tests-typechecked — bypass harness.
 *
 * Each case is a throwaway workspace (git-initialised, so the file listing is
 * real) holding one package whose `typecheck` script, tsconfigs or file layout
 * reproduces a bypass the round-2 / round-3 cold reviews confirmed or named as
 * plausible: a type error sits in a test file (or a vitest setup file), and the
 * package's own `typecheck` exits 0. The gate is run as a CLI against that
 * workspace (`CHECK_TESTS_TYPECHECKED_ROOT`) and must exit non-zero.
 *
 * Where the bypass hides a real error, the case first PROVES the bypass: the
 * fixture's `pnpm run typecheck` exits 0 with the error in place. A case the
 * harness could not make exit 0 would be testing nothing.
 *
 * Each case also names the mechanism that must catch it (`reason`), so a gate
 * mutation that disables one mechanism turns at least one case red: the
 * wrapper-script case is caught ONLY by the canary being reported, the
 * `sh -c '…; exit 0'` case ONLY by the non-zero-exit requirement, the
 * `@ts-nocheck` case ONLY by the pragma scan, the `paths` / `types` /
 * `lib` / `allowJs` / C3 cases ONLY by the options diff, the vitest-excluded
 * e2e spec ONLY via the git listing, and the setupFiles case ONLY via vitest's
 * collection.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { CANARY_PREFIX, canaryContent } from "../check-tests-typechecked.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(REPO, "scripts/check-tests-typechecked.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");
/** Fixture packages have no node_modules of their own; `tsc` comes from the repo. */
const ENV = {
  ...process.env,
  PATH: `${join(REPO, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`,
};

const TYPE_ERROR = 'export const __bypassProbe: number = "not a number";\n';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

type Files = Record<string, string | object>;

function writeTree(root: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }
}

const BUILD_OPTIONS = {
  target: "es2022",
  module: "esnext",
  moduleResolution: "bundler",
  lib: ["es2022"],
  strict: true,
  noUncheckedIndexedAccess: true,
  skipLibCheck: true,
  types: [],
  rootDir: "src",
  outDir: "dist",
};

/** A correct package: build config excludes tests; a test config compiles them. */
function basePackage(dir: string): Files {
  return {
    [`${dir}/package.json`]: {
      name: `@fixture/${dir.split("/").pop()}`,
      private: true,
      type: "module",
      scripts: { typecheck: "tsc --noEmit && tsc -p tsconfig.test.json" },
    },
    [`${dir}/tsconfig.json`]: {
      compilerOptions: BUILD_OPTIONS,
      include: ["src"],
      exclude: ["src/__tests__"],
    },
    [`${dir}/tsconfig.test.json`]: {
      extends: "./tsconfig.json",
      compilerOptions: { rootDir: ".", noEmit: true },
      include: ["src"],
      exclude: [],
    },
    [`${dir}/src/index.ts`]: "export function double(n: number): number {\n  return n * 2;\n}\n",
    [`${dir}/src/__tests__/index.test.ts`]:
      'import { double } from "../index";\nexport const r: number = double(2);\n',
  };
}

function workspace(files: Files, globs = ["packages/*"]): string {
  const root = mkdtempSync(join(tmpdir(), "tests-typechecked-bypass-"));
  roots.push(root);
  writeTree(root, {
    "pnpm-workspace.yaml": `packages:\n${globs.map((g) => `  - "${g}"`).join("\n")}\n`,
    ...files,
  });
  spawnSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function typecheck(pkgAbs: string): number | null {
  return spawnSync("pnpm", ["--silent", "run", "typecheck"], { cwd: pkgAbs, env: ENV }).status;
}

function gitAdd(root: string, ...rels: string[]): void {
  const r = spawnSync("git", ["add", "--", ...rels], { cwd: root, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git add failed: ${r.stderr}`);
}

function gate(root: string): { status: number | null; out: string } {
  const r = spawnSync(TSX, [GATE], {
    cwd: REPO,
    env: { ...ENV, CHECK_TESTS_TYPECHECKED_ROOT: root },
    encoding: "utf-8",
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function patchJson(files: Files, rel: string, patch: (v: Record<string, unknown>) => void): void {
  const v = structuredClone(files[rel]) as Record<string, unknown>;
  patch(v);
  files[rel] = v;
}

function testOptions(files: Files, dir: string, extra: Record<string, unknown>): void {
  patchJson(files, `${dir}/tsconfig.test.json`, (v) => {
    v.compilerOptions = { ...(v.compilerOptions as object), ...extra };
  });
}

function script(files: Files, dir: string, typecheckScript: string): void {
  patchJson(files, `${dir}/package.json`, (v) => {
    v.scripts = { typecheck: typecheckScript };
  });
}

/** The gate's repair line for each mechanism. */
const BY = {
  canary: /a canary with a type error there was not reported/,
  argv: /a typecheck tsc may take only/,
  diff: /resolves compiler options differently from the build config/,
  membership: /is not a root file of any tsc the typecheck script runs/,
  nocheck: /carries `@ts-nocheck`/,
  chain: /chain with `&&` only/,
  outside: /is outside the package/,
  reserved: /reserved canary prefix/,
  expansion: /parameter\/command expansion/,
} as const;

interface Case {
  id: string;
  /** Mechanisms that must each report the case. */
  reason: (keyof typeof BY)[];
  /** Build the fixture; returns the package dir (workspace-relative). */
  build: (files: Files) => string;
  /** The fixture's own `typecheck` exits 0 with a type error in a test file. */
  hidesError: boolean;
  globs?: string[];
}

const P = "packages/pkg";
const TEST = `${P}/src/__tests__/index.test.ts`;
const appendError = (files: Files, rel: string, text = TYPE_ERROR): void => {
  files[rel] = `${(files[rel] as string | undefined) ?? ""}${text}`;
};

const CASES: Case[] = [
  ...["--noCheck", "--listFilesOnly", "--showConfig"].map((flag): Case => ({
    id: `C1 extra tsc flag ${flag}`,
    reason: ["argv"],
    hidesError: true,
    build: (f) => {
      script(f, P, `tsc --noEmit && tsc -p tsconfig.test.json ${flag}`);
      appendError(f, TEST);
      return P;
    },
  })),
  {
    id: "C1 --strict false --noImplicitAny false",
    reason: ["argv"],
    hidesError: true,
    build: (f) => {
      script(
        f,
        P,
        "tsc --noEmit && tsc -p tsconfig.test.json --strict false --noImplicitAny false",
      );
      appendError(f, TEST, "export function loose(x) {\n  return x;\n}\n");
      return P;
    },
  },
  {
    id: 'C2 "noCheck": true in tsconfig.test.json',
    reason: ["diff", "canary"],
    hidesError: true,
    build: (f) => {
      testOptions(f, P, { noCheck: true });
      appendError(f, TEST);
      return P;
    },
  },
  {
    id: "C3 strictBuiltinIteratorReturn: false",
    reason: ["diff"],
    hidesError: true,
    build: (f) => {
      testOptions(f, P, { strictBuiltinIteratorReturn: false });
      appendError(
        f,
        TEST,
        "const step = [1].values().next();\nexport const n: number = step.done ? step.value : step.value;\n",
      );
      return P;
    },
  },
  {
    id: "C4 // @ts-nocheck in a test file",
    reason: ["nocheck"],
    hidesError: true,
    build: (f) => {
      f[TEST] = `// @ts-nocheck\n${f[TEST] as string}${TYPE_ERROR}`;
      return P;
    },
  },
  // Round 4 C1: tsc matches the pragma name case-insensitively, in any
  // single-line comment (`//` or `///`) of the file's leading comment block —
  // after a BOM, a shebang, leading blanks or a license block comment. Each
  // fixture's own typecheck exits 0 with the error in place (hidesError).
  ...(
    [
      ["upper case", "// @TS-NOCHECK\n"],
      ["mixed case, no space", "//@Ts-NoCheck\n"],
      ["leading spaces", "   // @ts-nocheck\n"],
      ["triple slash", "/// @ts-nocheck\n"],
      ["BOM then upper case", "\uFEFF// @Ts-Nocheck\n"],
      ["with a reason", "// @TS-NOCHECK: legacy fixture\n"],
      ["after a license block comment", "/* license */\n\n// @ts-NoCheck\n"],
      ["after a shebang", "#!/usr/bin/env node\n// @TS-NOCHECK\n"],
      ["overriding an earlier @ts-check", "// @ts-check\n// @TS-NOCHECK\n"],
    ] as const
  ).map(([label, head]): Case => ({
    id: `R4-C1 @ts-nocheck variant: ${label}`,
    reason: ["nocheck"],
    hidesError: true,
    build: (f) => {
      f[TEST] = `${head}${f[TEST] as string}${TYPE_ERROR}`;
      return P;
    },
  })),
  {
    id: 'R4-C3 vitest collects a test outside the package dir (`dir: ".."`)',
    reason: ["outside"],
    hidesError: true,
    build: (f) => {
      f[`${P}/vitest.config.mjs`] = 'export default { test: { dir: ".." } };\n';
      f["packages/stray/probe.test.ts"] = TYPE_ERROR;
      return P;
    },
  },
  ...["build", ".hidden", "coverage"].map((d): Case => ({
    id: `C5 test under src/${d}/ excluded from both tsconfigs`,
    reason: ["canary", "membership"],
    hidesError: true,
    build: (f) => {
      patchJson(f, `${P}/tsconfig.json`, (v) => {
        v.exclude = ["src/__tests__", `src/${d}`];
      });
      patchJson(f, `${P}/tsconfig.test.json`, (v) => {
        v.exclude = [`src/${d}`];
      });
      f[`${P}/src/${d}/probe.test.ts`] = TYPE_ERROR;
      return P;
    },
  })),
  {
    id: "paths: test config redirects a module to a stub",
    reason: ["diff"],
    hidesError: true,
    build: (f) => {
      patchJson(f, `${P}/tsconfig.json`, (v) => {
        v.compilerOptions = {
          ...(v.compilerOptions as object),
          paths: { "#lib": ["./src/index.ts"] },
        };
      });
      testOptions(f, P, { paths: { "#lib": ["./stub/index.ts"] } });
      f[`${P}/stub/index.ts`] = "export const double = (n: any): any => n;\n";
      f[`${P}/tsconfig.test.json`] = {
        ...(f[`${P}/tsconfig.test.json`] as object),
        include: ["src", "stub"],
      };
      appendError(
        f,
        TEST,
        'import { double as d2 } from "#lib";\nexport const s: number = d2("x");\n',
      );
      return P;
    },
  },
  {
    id: "types: test config changes `types`",
    reason: ["diff"],
    hidesError: false,
    build: (f) => {
      testOptions(f, P, { types: ["node"] });
      return P;
    },
  },
  {
    id: "lib: test config widens `lib`",
    reason: ["diff"],
    hidesError: true,
    build: (f) => {
      testOptions(f, P, { lib: ["es2023"] });
      appendError(f, TEST, "export const last = [1, 2].findLast((x) => x > 1);\n");
      return P;
    },
  },
  {
    id: "allowJs/checkJs: test config changes JS checking",
    reason: ["diff"],
    hidesError: false,
    build: (f) => {
      testOptions(f, P, { allowJs: true, checkJs: false });
      return P;
    },
  },
  {
    id: "vitest setupFiles outside src",
    reason: ["canary", "membership"],
    hidesError: true,
    build: (f) => {
      f[`${P}/vitest.config.mjs`] =
        'export default { test: { setupFiles: ["./test-setup/setup.ts"] } };\n';
      f[`${P}/test-setup/setup.ts`] = TYPE_ERROR;
      return P;
    },
  },
  {
    id: "new file under an allowlisted prefix (apps/web e2e/)",
    reason: ["canary", "membership"],
    hidesError: true,
    globs: ["apps/*"],
    build: (f) => {
      const W = "apps/web";
      for (const [rel, v] of Object.entries(basePackage(W))) f[rel] = v;
      f[`${W}/e2e/golden.spec.ts`] = "export {};\n";
      f[`${W}/e2e/new.spec.ts`] = TYPE_ERROR;
      return W;
    },
  },
  {
    id: "`;` chain hides a failing test tsc",
    reason: ["chain"],
    hidesError: true,
    build: (f) => {
      script(f, P, "tsc -p tsconfig.test.json; tsc --noEmit");
      appendError(f, TEST);
      return P;
    },
  },
  {
    id: "`|| true` chain",
    reason: ["chain"],
    hidesError: true,
    build: (f) => {
      script(f, P, "tsc --noEmit && tsc -p tsconfig.test.json || true");
      appendError(f, TEST);
      return P;
    },
  },
  {
    id: "spec vitest's config excludes (a Playwright-style e2e/)",
    reason: ["canary", "membership"],
    hidesError: true,
    build: (f) => {
      f[`${P}/vitest.config.mjs`] =
        'export default { test: { exclude: ["**/node_modules/**", "e2e/**"] } };\n';
      f[`${P}/e2e/flow.spec.ts`] = TYPE_ERROR;
      return P;
    },
  },
  {
    id: "wrapper script runs a different tsc when it is being recorded",
    reason: ["canary"],
    hidesError: true,
    build: (f) => {
      script(f, P, "tsc --noEmit && node tc.mjs");
      f[`${P}/tc.mjs`] =
        'import { execFileSync } from "node:child_process";\n' +
        'const cfg = process.env.MOTEBIT_TSC_RECORD_ONLY === "1" ? "tsconfig.test.json" : "tsconfig.json";\n' +
        'execFileSync("tsc", ["--noEmit", "-p", cfg], { stdio: "inherit" });\n';
      appendError(f, TEST);
      return P;
    },
  },
  {
    id: "`sh -c '…; exit 0'` swallows the test tsc's failure",
    reason: ["canary"],
    hidesError: true,
    build: (f) => {
      script(f, P, "tsc --noEmit && sh -c 'tsc -p tsconfig.test.json; exit 0'");
      appendError(f, TEST);
      return P;
    },
  },
  {
    id: "`$` expansion in the typecheck script",
    reason: ["expansion"],
    hidesError: true,
    build: (f) => {
      script(f, P, "tsc --noEmit && tsc -p ${TC_CONFIG:-tsconfig.json}");
      appendError(f, TEST);
      return P;
    },
  },
];

describe("check-tests-typechecked bypass harness", () => {
  it("control: a correct package passes, and its typecheck reports a test-file error", () => {
    const files = basePackage(P);
    const root = workspace(files);
    expect(gate(root).status).toBe(0);
    appendError(files, TEST);
    writeTree(root, { [TEST]: files[TEST] as string });
    expect(typecheck(join(root, P))).not.toBe(0);
  });

  it.concurrent.each(CASES.map((c) => [c.id, c] as const))("%s → gate RED", async (_id, c) => {
    const files = basePackage(P);
    const dir = c.build(files);
    const root = workspace(files, c.globs);
    if (c.hidesError) expect(typecheck(join(root, dir)), "bypass must be real").toBe(0);
    const g = gate(root);
    expect(g.status, g.out).not.toBe(0);
    for (const r of c.reason) expect(g.out, `${r} must report it`).toMatch(BY[r]);
  });
});

describe("check-tests-typechecked — round-4 canary-prefix and concurrency cases", () => {
  it("R4-C2 a COMMITTED test named with the canary prefix, in a dir no tsconfig covers → gate RED", () => {
    const files = basePackage(P);
    patchJson(files, `${P}/tsconfig.json`, (v) => {
      v.exclude = ["src/__tests__", "src/extra"];
    });
    patchJson(files, `${P}/tsconfig.test.json`, (v) => {
      v.exclude = ["src/extra"];
    });
    const rel = `${P}/src/extra/${CANARY_PREFIX}real.test.ts`;
    files[rel] = TYPE_ERROR;
    const root = workspace(files);
    gitAdd(root, rel);
    expect(typecheck(join(root, P)), "bypass must be real").toBe(0);
    const g = gate(root);
    expect(g.status, g.out).not.toBe(0);
    expect(g.out).toMatch(BY.reserved);
    expect(g.out).toMatch(BY.canary);
    expect(g.out).toMatch(BY.membership);
  });

  it("R4-C2 an UNTRACKED user file with the canary prefix survives the gate (never deleted by name)", () => {
    const files = basePackage(P);
    const rel = `${P}/src/__tests__/${CANARY_PREFIX}mine.test.ts`;
    const mine = "export const mine = 1;\n";
    files[rel] = mine;
    const root = workspace(files);
    const g = gate(root);
    expect(existsSync(join(root, rel)), "the user's file must survive").toBe(true);
    expect(g.status, g.out).not.toBe(0);
    expect(g.out).toMatch(BY.reserved);
  });

  it("R4-C2 a file whose content is a canary template with a different id than its name is not drained", () => {
    const files = basePackage(P);
    const rel = `${P}/src/__tests__/${CANARY_PREFIX}aaaaaaaaaaaa.test.ts`;
    // a dead owner, but the id inside does not match the file name: not ours
    files[rel] = canaryContent("bbbbbbbbbbbb", { run: "r", pid: 2 ** 22 + 7, host: hostname() });
    const root = workspace(files);
    gate(root);
    expect(existsSync(join(root, rel))).toBe(true);
  });

  it("R4-concurrency: a live canary of ANOTHER running gate is neither drained nor flagged; a dead run's canary is drained", async () => {
    const files = basePackage(P);
    const other = spawn("sleep", ["120"], { stdio: "ignore" });
    try {
      const livePid = other.pid!;
      const dead = spawnSync(
        process.execPath,
        ["-e", "process.stdout.write(String(process.pid))"],
        {
          encoding: "utf-8",
        },
      );
      const deadPid = Number(dead.stdout);
      const liveRel = `${P}/src/__tests__/${CANARY_PREFIX}0123456789ab.test.ts`;
      const deadRel = `${P}/src/__tests__/${CANARY_PREFIX}ba9876543210.test.ts`;
      files[liveRel] = canaryContent("0123456789ab", {
        run: "otherrun",
        pid: livePid,
        host: hostname(),
      });
      files[deadRel] = canaryContent("ba9876543210", {
        run: "deadrun",
        pid: deadPid,
        host: hostname(),
      });
      const root = workspace(files);
      const g = gate(root);
      expect(existsSync(join(root, liveRel)), "a live run's canary must survive").toBe(true);
      expect(existsSync(join(root, deadRel)), "a dead run's canary is drained").toBe(false);
      expect(g.status, g.out).toBe(0);
    } finally {
      other.kill();
    }
  });

  it("R4-concurrency: two gate runs at once on one workspace both pass and leave no canary", async () => {
    const root = workspace(basePackage(P));
    const run = (): Promise<{ status: number | null; out: string }> =>
      new Promise((done) => {
        const c = spawn(TSX, [GATE], {
          cwd: REPO,
          env: { ...ENV, CHECK_TESTS_TYPECHECKED_ROOT: root },
        });
        let out = "";
        c.stdout.on("data", (d: Buffer) => (out += d.toString()));
        c.stderr.on("data", (d: Buffer) => (out += d.toString()));
        c.on("close", (status) => done({ status, out }));
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.status, a.out).toBe(0);
    expect(b.status, b.out).toBe(0);
    const left = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf-8",
    }).stdout;
    expect(left).not.toContain(CANARY_PREFIX);
  });

  it("control: a pragma tsc does not honour is not flagged (string mention, after code, overridden by a later @ts-check, block comment)", () => {
    const files = basePackage(P);
    files[TEST] =
      '// @ts-nocheck\n// @ts-check\n/* @ts-nocheck */\nimport { double } from "../index";\nexport const r: number = double(2);\nexport const s = "// @ts-nocheck";\n// @TS-NOCHECK\n';
    const root = workspace(files);
    appendError(files, TEST);
    writeTree(root, { [TEST]: files[TEST] as string });
    expect(typecheck(join(root, P)), "tsc still checks this file").not.toBe(0);
    writeTree(root, { [TEST]: (files[TEST] as string).replace(TYPE_ERROR, "") });
    const g = gate(root);
    expect(g.status, g.out).toBe(0);
  });
});
