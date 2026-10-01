/**
 * check-tests-typechecked — unit tests for the gate's pure pieces.
 *
 * The end-to-end behaviour (canaries, recorded argv, the options diff against
 * real `tsc --showConfig` output, membership, `@ts-nocheck`) is exercised by
 * check-tests-typechecked.bypass.test.ts against throwaway workspaces. These
 * tests pin the parts a quiet edit could widen: the diff allowlist, the argv
 * allowlist, the workspace enumeration, the chain rules, the canary matcher,
 * and the exact-path shape of KNOWN_UNCOVERED.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  affectsPackage,
  argvViolations,
  canaryContent,
  canaryOwnerLive,
  chainViolations,
  changedScope,
  DIFF_ALLOWED_KEYS,
  isTestFile,
  KNOWN_UNCOVERED,
  nonAndOperators,
  optionDiff,
  parseCanary,
  reportsError,
  VITEST_NON_CODE_KEYS,
  VITEST_TEST_CODE_KEYS,
  KNOWN_CONFIG_IMPORTS,
  LOCK_WAIT_MS,
  NON_VITEST_TEST_SCRIPTS,
  nonVitestProblems,
  readRecording,
  recordedFile,
  TYPECHECK_EXTRA_STEPS,
  type VitestRecord,
  vitestScripts,
  workspacePackageDirs,
} from "../check-tests-typechecked.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tests-typechecked-unit-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("optionDiff — deny by default", () => {
  it("pins the allowlist to exactly the emit/layout keys", () => {
    expect([...DIFF_ALLOWED_KEYS].sort()).toEqual(
      [
        "composite",
        "declaration",
        "declarationMap",
        "emitDeclarationOnly",
        "incremental",
        "noEmit",
        "outDir",
        "rootDir",
        "sourceMap",
        "tsBuildInfoFile",
      ].sort(),
    );
  });

  // Every compiler option TypeScript itself declares: a difference on any of
  // them outside the allowlist must be reported. Widening the allowlist by
  // one key turns this red for that key.
  const allOptions = (
    ts as unknown as { optionDeclarations: { name: string }[] }
  ).optionDeclarations.map((o) => o.name);

  it("covers the options TypeScript declares (sanity: the list is not empty)", () => {
    expect(allOptions.length).toBeGreaterThan(100);
    for (const k of [
      "noCheck",
      "strictBuiltinIteratorReturn",
      "paths",
      "types",
      "lib",
      "allowJs",
      "checkJs",
    ]) {
      expect(allOptions).toContain(k);
    }
  });

  it("reports a difference on every declared option outside the allowlist", () => {
    const missed = allOptions.filter((k) => {
      if (DIFF_ALLOWED_KEYS.has(k)) return false;
      return optionDiff({}, { [k]: true }).differing.length !== 1;
    });
    expect(missed).toEqual([]);
  });

  it("treats set-vs-unset as a difference, never infers equivalence", () => {
    expect(optionDiff({ strict: true }, { strict: true, noImplicitAny: true }).differing).toEqual([
      "noImplicitAny (build unset, typecheck true)",
    ]);
  });

  it("compares structured values (paths, lib) by value", () => {
    expect(optionDiff({ lib: ["es2022"] }, { lib: ["es2022"] }).differing).toEqual([]);
    expect(optionDiff({ paths: { a: ["x"] } }, { paths: { a: ["y"] } }).differing).toHaveLength(1);
  });

  it("lets only allowlisted keys differ, and counts the keys it compared", () => {
    const d = optionDiff(
      { rootDir: "src", strict: true },
      { rootDir: ".", noEmit: true, strict: true },
    );
    expect(d.differing).toEqual([]);
    expect(d.compared).toBe(1);
  });
});

describe("argvViolations", () => {
  it("accepts only -p/--project, -b/--build (with a value), --noEmit, --pretty", () => {
    expect(argvViolations([])).toEqual([]);
    expect(argvViolations(["--noEmit"])).toEqual([]);
    expect(argvViolations(["-p", "tsconfig.test.json"])).toEqual([]);
    expect(
      argvViolations(["--project", "tsconfig.typecheck.json", "--noEmit", "--pretty"]),
    ).toEqual([]);
  });

  it.each([
    [["-p", "tsconfig.test.json", "--noCheck"], ["--noCheck"]],
    [["--listFilesOnly"], ["--listFilesOnly"]],
    [["--showConfig"], ["--showConfig"]],
    [
      ["--strict", "false", "--noImplicitAny", "false"],
      ["--strict", "false", "--noImplicitAny", "false"],
    ],
    [["--skipLibCheck"], ["--skipLibCheck"]],
    [["-p"], ["-p without a value"]],
  ])("rejects %j", (argv, bad) => {
    expect(argvViolations(argv)).toEqual(bad);
  });
});

describe("workspacePackageDirs", () => {
  it("expands every pnpm-workspace.yaml glob", () => {
    write(
      "pnpm-workspace.yaml",
      'packages:\n  - "packages/*"\n  - "apps/*"\n  - services/*\n  - tools\n',
    );
    for (const d of ["packages/a", "apps/b", "services/c", "tools"])
      write(`${d}/package.json`, "{}");
    write("packages/not-a-package/readme.md", "");
    expect(workspacePackageDirs(root).map((d) => d.slice(root.length + 1))).toEqual([
      "packages/a",
      "apps/b",
      "services/c",
      "tools",
    ]);
  });

  it("refuses a glob shape it does not understand", () => {
    write("pnpm-workspace.yaml", 'packages:\n  - "packages/**"\n');
    expect(() => workspacePackageDirs(root)).toThrow(/unsupported/);
  });

  it("reads the real workspace (the three repo groups)", () => {
    const groups = new Set(
      workspacePackageDirs(REPO).map((d) => d.slice(REPO.length + 1).split("/")[0]),
    );
    expect([...groups].sort()).toEqual(["apps", "packages", "services"]);
  });
});

describe("chain rules", () => {
  it("accepts an && chain, through pnpm run hops", () => {
    expect(
      chainViolations({
        typecheck: "tsc --noEmit && pnpm run typecheck:tests",
        "typecheck:tests": "tsc -p tsconfig.test.json",
      }),
    ).toEqual([]);
  });

  it.each(["||", ";", "|", "&", "\n"])("rejects %j", (op) => {
    const v = chainViolations({ typecheck: `tsc --noEmit ${op} tsc -p tsconfig.test.json` });
    expect(v).toHaveLength(1);
  });

  it("rejects an operator in a script reached through a hop", () => {
    const v = chainViolations({
      typecheck: "pnpm typecheck:tests",
      "typecheck:tests": "tsc -p x.json || true",
    });
    expect(v.join("\n")).toMatch(/typecheck:tests.*`\|\|`/);
  });

  it("rejects $ and backtick expansion", () => {
    expect(chainViolations({ typecheck: "tsc -p ${CFG:-tsconfig.json}" })).toHaveLength(1);
    expect(chainViolations({ typecheck: "tsc -p `cat cfg`" })).toHaveLength(1);
  });

  it("P1: every step must be tsc or pnpm run <script> (deny by default)", () => {
    expect(
      chainViolations({ typecheck: "node scripts/tc.mjs && tsc -p tsconfig.test.json" }).join(),
    ).toMatch(/step "node scripts\/tc\.mjs" is neither/);
    expect(chainViolations({ typecheck: "npx tsc --noEmit" }).join()).toMatch(/is neither/);
    expect(chainViolations({ typecheck: "pnpm tsc-baseline" }).join(), "not a script").toMatch(
      /is neither/,
    );
    expect(
      chainViolations({ typecheck: "pnpm run x", x: "node wrap.mjs" }).join(),
      "held through a hop",
    ).toMatch(/script "x" step "node wrap\.mjs"/);
    expect(chainViolations({ typecheck: "pnpm run x --silent", x: "tsc" })).toHaveLength(1);
    expect(chainViolations({ typecheck: "fumadocs-mdx && tsc --noEmit" })).toHaveLength(1);
    expect(
      chainViolations({ typecheck: "fumadocs-mdx && tsc --noEmit" }, "typecheck", {
        "fumadocs-mdx": "codegen",
      }),
    ).toEqual([]);
    expect(Object.keys(TYPECHECK_EXTRA_STEPS)).toEqual(["apps/docs"]);
    expect(Object.keys(TYPECHECK_EXTRA_STEPS["apps/docs"]!)).toEqual(["fumadocs-mdx"]);
  });

  it("ignores operators inside quotes and redirections", () => {
    expect(nonAndOperators(`echo "a || b; c" && tsc 2>&1`)).toEqual([]);
  });
});

describe("reportsError", () => {
  const canary = "/x/src/__tests__/__typecheck_canary_abc123.test.ts";
  it("needs a TS error on a line naming the canary", () => {
    expect(
      reportsError(
        "src/__tests__/__typecheck_canary_abc123.test.ts(2,14): error TS2322: nope",
        canary,
      ),
    ).toBe(true);
    // tsc --pretty colours the path and the word "error" separately.
    const pretty =
      "\u001b[96msrc/__tests__/__typecheck_canary_abc123.test.ts\u001b[0m:\u001b[93m2\u001b[0m:\u001b[93m14\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType 'string' is not assignable";
    expect(reportsError(pretty, canary)).toBe(true);
  });
  it("is not fooled by a file listing", () => {
    expect(
      reportsError(
        "src/__tests__/__typecheck_canary_abc123.test.ts\nerror TS2322 elsewhere",
        canary,
      ),
    ).toBe(false);
  });
});

describe("isTestFile", () => {
  it("matches test-named files (TS or JS) and TS under __tests__, declarations included", () => {
    expect(isTestFile("src/a.test.ts")).toBe(true);
    expect(isTestFile("e2e/a.spec.tsx")).toBe(true);
    expect(isTestFile("src/a.test.mjs")).toBe(true);
    expect(isTestFile("src/__tests__/helpers.ts")).toBe(true);
    expect(isTestFile("src/build/x.test.ts")).toBe(true);
    expect(isTestFile("src/__tests__/stub.cjs")).toBe(false);
    // a declaration under __tests__ is collected — and then RED (tsc skips it)
    expect(isTestFile("src/__tests__/types.d.ts")).toBe(true);
    expect(isTestFile("src/__tests__/api.d.test.ts")).toBe(true);
    expect(isTestFile("src/index.ts")).toBe(false);
  });
});

describe("KNOWN_UNCOVERED", () => {
  it("holds exact, existing file paths — never a prefix", () => {
    for (const [dir, entries] of Object.entries(KNOWN_UNCOVERED)) {
      for (const [file, reason] of Object.entries(entries)) {
        expect(file.endsWith("/"), `${dir}: ${file}`).toBe(false);
        // a test file, or a file the vitest recorder saw load as code (named so in the reason)
        expect(
          isTestFile(file) || /Recorded by the vitest recorder/.test(reason),
          `${dir}: ${file}`,
        ).toBe(true);
        expect(existsSync(join(REPO, dir, file)), `${dir}/${file} exists`).toBe(true);
        expect(reason.length).toBeGreaterThan(40);
      }
    }
  });
});

describe("@ts-nocheck — the pragma forms tsc honours, and only those (asked of the compiler)", () => {
  const { skipReason } = createRequire(import.meta.url)("../lib/tsc-checked-files.cjs") as {
    skipReason: (
      t: typeof ts,
      sf: ts.SourceFile,
      o: ts.CompilerOptions,
      host: unknown,
    ) => string | null;
  };
  const host = { isSourceOfProjectReferenceRedirect: () => false };
  const tscSkipsChecking = (name: string, text: string): boolean =>
    skipReason(ts, ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false), {}, host) !==
    null;
  it.each([
    "// @ts-nocheck\n",
    "// @TS-NOCHECK\n",
    "//@Ts-NoCheck\n",
    "   // @ts-nocheck\n",
    "/// @ts-nocheck\n",
    "\uFEFF// @ts-nocheck\n",
    "\uFEFF// @TS-NoCheck\n",
    "// @ts-nocheck: reason\n",
    "#!/usr/bin/env node\n// @ts-nocheck\n",
    "/* license */\n// @TS-NOCHECK\n",
    "// @ts-check\n// @ts-nocheck\n",
    "\t\n\n// @ts-nocheck\nexport {};\n",
  ])("honoured: %j", (head) => {
    expect(tscSkipsChecking("a.test.ts", `${head}export const x = 1;\n`)).toBe(true);
  });
  it.each([
    "export {};\n// @ts-nocheck\n",
    "/* @ts-nocheck */\n",
    "/** @ts-nocheck */\n",
    "// @ts-nocheck\n// @ts-check\n",
    'export const s = "// @ts-nocheck";\n',
    "// @ts-nocheckx\n",
    "// ts-nocheck\n",
  ])("not honoured: %j", (head) => {
    expect(tscSkipsChecking("a.test.ts", `${head}export const x = 1;\n`)).toBe(false);
  });
});

describe("vitest collection policy", () => {
  it("pins which file-valued vitest keys are test code, and which never run", () => {
    expect([...VITEST_TEST_CODE_KEYS].sort()).toEqual(
      [
        "benchmark.include",
        "environment",
        "globalSetup",
        "include",
        "includeSource",
        "reporters",
        "sequence.sequencer",
        "setupFiles",
        "snapshotSerializers",
        "typecheck.include",
      ].sort(),
    );
    expect(Object.keys(VITEST_NON_CODE_KEYS).sort()).toEqual(
      ["config", "coverage.exclude", "coverage.include", "forceRerunTriggers"].sort(),
    );
  });

  it("runs every test / test:* script and every script mentioning vitest, minus pinned non-vitest scripts", () => {
    expect(
      vitestScripts({
        test: "vitest run",
        "test:coverage": "vitest run --coverage",
        "test:e2e": "playwright test",
        bench: "vitest bench --run",
        build: "tsc",
        tests: "node run.mjs",
      }),
    ).toEqual(["bench", "test", "test:coverage", "test:e2e"]);
    expect(
      vitestScripts({ test: "vitest run", "test:e2e": "playwright test" }, { "test:e2e": {} }),
    ).toEqual(["test"]);
  });

  it("pins the non-vitest test scripts exactly; an entry goes stale when its script or pinned file changes", () => {
    expect(Object.keys(NON_VITEST_TEST_SCRIPTS).sort()).toEqual(["apps/cli", "apps/web"]);
    expect(Object.keys(NON_VITEST_TEST_SCRIPTS["apps/web"]!).sort()).toEqual([
      "test:e2e",
      "test:e2e:ui",
    ]);
    const dir = mkdtempSync(join(tmpdir(), "nonvitest-"));
    writeFileSync(join(dir, "smoke.sh"), "echo hi\n");
    const entries = {
      smoke: {
        command: "./smoke.sh",
        files: { "smoke.sh": "2a2b0e6e8fc0c8d5d6e3ddbd8c7a0b7bb7a6f9b3b9b08f3b6fbd3c4e2f3a4b5c" },
      },
    };
    expect(nonVitestProblems(dir, { smoke: "./smoke.sh" }, entries).join()).toMatch(
      /smoke\.sh changed/,
    );
    expect(nonVitestProblems(dir, { smoke: "./smoke.sh --x" }, entries).join()).toMatch(
      /now "\.\/smoke\.sh --x"/,
    );
    expect(nonVitestProblems(dir, {}, entries).join()).toMatch(/the script is gone/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("pins the config imports exempt from type-checking to exactly vitest.shared.ts", () => {
    expect(Object.keys(KNOWN_CONFIG_IMPORTS)).toEqual(["vitest.shared.ts"]);
  });

  it("recordedFile: repo code files only — no node_modules, virtual ids, data or ?raw imports", () => {
    const root = mkdtempSync(join(tmpdir(), "recorded-"));
    for (const f of ["a.ts", "b.json", "c.cjs", "node_modules/x/i.js", "d.vue"]) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), "");
    }
    expect(recordedFile(join(root, "a.ts"), root)).toBe(join(root, "a.ts"));
    expect(recordedFile(`${join(root, "a.ts")}?v=1`, root)).toBe(join(root, "a.ts"));
    expect(recordedFile(join(root, "c.cjs"), root)).toBe(join(root, "c.cjs"));
    expect(recordedFile(join(root, "d.vue"), root), "unknown extensions count").toBe(
      join(root, "d.vue"),
    );
    expect(recordedFile(join(root, "b.json"), root)).toBeNull();
    expect(recordedFile(`${join(root, "a.ts")}?raw`, root)).toBeNull();
    expect(recordedFile(join(root, "node_modules/x/i.js"), root)).toBeNull();
    expect(recordedFile("\0virtual:x", root)).toBeNull();
    expect(recordedFile("/elsewhere/a.ts", root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("lock wait (C5)", () => {
  it("covers a whole full run (~6 min measured), so a second honest concurrent run waits instead of failing", () => {
    expect(LOCK_WAIT_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });
});

describe("readRecording — deny by default", () => {
  const root = REPO;
  const ok = { status: 0, output: "", timedOut: false };
  const file = join(REPO, "scripts/check-tests-typechecked.ts");
  const healthy = (pid: number): VitestRecord[] => [
    { pid, event: "vitest-loaded", argv: ["/x/vitest.mjs", "run"] },
    { pid, event: "config", configFile: "/c.ts", deps: [] },
    { pid, event: "vitest" },
    { pid, event: "module", id: file },
    { pid, event: "collected", specs: [], failed: [], static: { files: [], fileValued: [] } },
  ];

  it("a healthy run records its modules and has no problems", () => {
    const r = readRecording("test", healthy(1), ok, root);
    expect(r.problems).toEqual([]);
    expect([...r.loaded.keys()]).toEqual([file]);
  });

  it("no vitest observed → problem", () => {
    expect(readRecording("test", [], ok, root).problems.join()).toMatch(
      /started no vitest the recorder observed/,
    );
  });

  it("the plugin never attached → problem; collection never finished → problem", () => {
    const noPlugin = healthy(1).filter((r) => r.event === "vitest-loaded");
    expect(readRecording("test", noPlugin, ok, root).problems.join()).toMatch(
      /plugin never attached/,
    );
    const noCollect = healthy(1).filter((r) => r.event !== "collected");
    expect(readRecording("test", noCollect, ok, root).problems.join()).toMatch(
      /before its collection finished/,
    );
  });

  it("a file that threw during collection → problem; no-suite and run-level errors are not", () => {
    const rec = healthy(1);
    rec[4] = {
      ...rec[4]!,
      failed: [
        { file, error: "boom" },
        { file, error: "No test suite found in file x" },
        { file: null, error: 'Closing rpc while "onUserConsoleLog" was pending' },
      ],
    };
    const p = readRecording("test", rec, ok, root).problems;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/could not collect .*\(boom\)/);
  });

  it("an unsupported mode, a timeout, a node without registerHooks → problems", () => {
    const rec = [...healthy(1), { pid: 1, event: "unsupported", why: ["browser mode"] }];
    expect(readRecording("test", rec, ok, root).problems.join()).toMatch(/browser mode/);
    expect(
      readRecording("test", healthy(1), { ...ok, timedOut: true }, root).problems.join(),
    ).toMatch(/did not finish/);
    expect(
      readRecording(
        "test",
        [...healthy(1), { pid: 2, event: "no-hooks" }],
        ok,
        root,
      ).problems.join(),
    ).toMatch(/registerHooks/);
  });

  it("a config-only import is marked as such, unless something loads it at runtime too", () => {
    const rec = healthy(1);
    rec[1] = { pid: 1, event: "config", configFile: "/c.ts", deps: [file] };
    rec.splice(3, 1);
    expect(readRecording("test", rec, ok, root).loaded.get(file)).toBe(
      "imported by the vitest config",
    );
    expect(
      readRecording("test", healthy(1).toSpliced(1, 1, rec[1]!), ok, root).loaded.get(file),
    ).toBe("transformed by vite for vitest");
  });
});

describe("canaries — identified by content and owner, never by name", () => {
  const owner = { run: "0123abcd0123abcd", pid: process.pid, host: hostname() };
  const name = "/p/__typecheck_canary_0123456789ab.test.ts";

  it("round-trips a canary the gate writes", () => {
    expect(parseCanary(name, canaryContent("0123456789ab", owner))).toEqual(owner);
  });
  it("rejects a prefix-named file with other content, a changed byte, or a mismatched id", () => {
    const c = canaryContent("0123456789ab", owner);
    expect(parseCanary(name, "export const mine = 1;\n")).toBeNull();
    expect(parseCanary(name, `${c} `)).toBeNull();
    expect(parseCanary(name, c.replace("canary 0123", "canary 9123"))).toBeNull();
    expect(parseCanary(name, canaryContent("ffffffffffff", owner))).toBeNull();
    expect(parseCanary("/p/__typecheck_canary_real.test.ts", c)).toBeNull();
  });
  it("owner liveness: a live pid on this host is live; a dead pid, an aged canary are not; another host is live until it ages", () => {
    const now = Date.now();
    expect(canaryOwnerLive({ ...owner, run: "ffff" }, now, now)).toBe(true);
    expect(canaryOwnerLive({ ...owner, run: "ffff", pid: 2 ** 22 + 7 }, now, now)).toBe(false);
    expect(canaryOwnerLive({ ...owner, run: "ffff" }, now - 2 * 3600_000, now)).toBe(false);
    expect(
      canaryOwnerLive({ ...owner, run: "ffff", host: "elsewhere", pid: 2 ** 22 + 7 }, now, now),
    ).toBe(true);
    expect(
      canaryOwnerLive({ ...owner, run: "ffff", host: "elsewhere" }, now - 2 * 3600_000, now),
    ).toBe(false);
  });
});

describe("diff scope", () => {
  it("affectsPackage: every change but documentation", () => {
    for (const p of [
      "src/__tests__/a.ts",
      "e2e/x.spec.ts",
      "tsconfig.test.json",
      "tsconfig.json",
      "vitest.config.ts",
      "package.json",
      "test-setup/setup.ts",
      "src/vitest.setup.ts",
      "fixtures/data.ts",
      "src/__typecheck_canary_x.ts",
    ])
      expect(affectsPackage(p), p).toBe(true);
    // vitest may load ANY file (a harness module a setup file imports), so
    // every change but documentation moves the package's result.
    for (const p of ["src/index.ts", "harness/boot.ts", "src/lib/money.ts"])
      expect(affectsPackage(p), p).toBe(true);
    for (const p of ["README.md", "CHANGELOG.md", "docs/x.mdx"])
      expect(affectsPackage(p), p).toBe(false);
  });

  function repo(): string {
    const g = (...a: string[]): void => {
      const r = spawnSync("git", a, { cwd: root, encoding: "utf-8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    write("tsconfig.base.json", "{}\n");
    for (const n of ["a", "b"]) {
      write(`packages/${n}/package.json`, "{}\n");
      write(`packages/${n}/src/index.ts`, "export {};\n");
      write(`packages/${n}/src/__tests__/i.test.ts`, "export {};\n");
    }
    g("init", "-q");
    g("add", "-A");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    return root;
  }
  const dirsOf = (): string[] => workspacePackageDirs(root);

  it("scopes to packages with a change (committed, unstaged or untracked); none for a docs-only change", () => {
    repo();
    write("packages/a/README.md", "# a\n");
    let s = changedScope(root, dirsOf());
    expect(s).toMatchObject({ kind: "scoped", dirs: [] });
    write("packages/b/src/__tests__/new.test.ts", "export {};\n");
    s = changedScope(root, dirsOf());
    expect(s.kind === "scoped" && s.dirs.map((d) => d.slice(root.length + 1))).toEqual([
      "packages/b",
    ]);
  });

  // Every global trigger, named literally (never read back from the gate's
  // own set): emptying or narrowing the set turns the matching case red.
  it.each([
    "scripts/check-tests-typechecked.ts",
    "scripts/lib/vitest-collect.mjs",
    "scripts/lib/tsc-recorder.cjs",
    "scripts/lib/vitest-recorder.cjs",
    "scripts/lib/vitest-record-plugin.mjs",
    "scripts/lib/tsc-checked-files.cjs",
    "scripts/lib/repo-lock.ts",
    "tsconfig.base.json",
    "tsconfig.json",
    "vitest.config.ts",
    "vitest.workspace.ts",
    "vite.config.ts",
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    ".npmrc",
  ])("fails CLOSED to the full run when %s changes", (p) => {
    repo();
    const abs = join(root, p);
    const extra = p === "pnpm-workspace.yaml" ? "# touched\n" : "\n// touched\n";
    const prev = existsSync(abs) ? String(spawnSync("cat", [abs]).stdout) : "";
    write(p, `${prev}${extra}`);
    expect(changedScope(root, dirsOf())).toEqual({ kind: "full", reason: `${p} changed` });
  });

  it("fails CLOSED to the full run when git diff fails after merge-base succeeded (corrupt index)", () => {
    repo();
    writeFileSync(join(root, ".git/index"), "not an index");
    const s = changedScope(root, dirsOf());
    expect(s.kind, JSON.stringify(s)).toBe("full");
    expect(s.kind === "full" && s.reason).toMatch(/git diff against [0-9a-f]+ failed/);
  });

  it("fails CLOSED to the full run: no origin/main, or a shared config changed", () => {
    repo();
    write("tsconfig.base.json", '{ "compilerOptions": {} }\n');
    expect(changedScope(root, dirsOf())).toMatchObject({
      kind: "full",
      reason: "tsconfig.base.json changed",
    });
    spawnSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: root });
    expect(changedScope(root, dirsOf())).toMatchObject({ kind: "full" });
  });
});

describe("tsc-checked-files — the compiler's own skip decision", () => {
  const lib = createRequire(import.meta.url)("../lib/tsc-checked-files.cjs") as {
    selfTest: (t: typeof ts) => void;
    skipReason: (
      t: typeof ts,
      sf: ts.SourceFile,
      o: ts.CompilerOptions,
      host: unknown,
    ) => string | null;
  };
  const host = { isSourceOfProjectReferenceRedirect: () => false };
  const sf = (name: string, text: string): ts.SourceFile =>
    ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false);

  it("self-test passes on the repo's TypeScript", () => {
    expect(() => lib.selfTest(ts)).not.toThrow();
  });
  it("self-test THROWS when checkJsDirective is stubbed away (a TS upgrade renamed it)", () => {
    const broken = {
      ...ts,
      createSourceFile: (...a: Parameters<typeof ts.createSourceFile>) => {
        const s = ts.createSourceFile(...a) as unknown as Record<string, unknown>;
        delete s.checkJsDirective;
        return s as unknown as ts.SourceFile;
      },
    } as typeof ts;
    expect(() => lib.selfTest(broken)).toThrow(/no longer matches what tsc/);
  });
  it("self-test THROWS when isDeclarationFileName stops treating `.d.test.ts` as a declaration", () => {
    const broken = { ...ts, isDeclarationFileName: (f: string) => /\.d\.ts$/.test(f) } as typeof ts;
    expect(() => lib.selfTest(broken)).toThrow(/no longer matches what tsc/);
  });
  it("names why tsc skips a file, or null when it checks it", () => {
    expect(lib.skipReason(ts, sf("a.test.ts", "export {};\n"), {}, host)).toBeNull();
    expect(
      lib.skipReason(ts, sf("a.d.test.ts", "export {};\n"), { skipLibCheck: true }, host),
    ).toMatch(/declaration file/);
    expect(lib.skipReason(ts, sf("a.d.test.ts", "export {};\n"), {}, host)).toMatch(
      /declaration file/,
    );
    expect(lib.skipReason(ts, sf("a.test.ts", "// @TS-NOCHECK\nexport {};\n"), {}, host)).toMatch(
      /@ts-nocheck/,
    );
    expect(lib.skipReason(ts, sf("a.test.ts", "export {};\n"), { noCheck: true }, host)).toMatch(
      /noCheck/,
    );
  });
});

describe("check-tests-typechecked (scoped smoke against the real repo)", () => {
  it("passes on packages/protocol and states its aperture", () => {
    const r = spawnSync(
      join(REPO, "node_modules/.bin/tsx"),
      ["scripts/check-tests-typechecked.ts"],
      {
        cwd: REPO,
        env: { ...process.env, CHECK_TESTS_TYPECHECKED_ONLY: "packages/protocol" },
        encoding: "utf-8",
      },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/1 package\(s\) scanned \(SCOPED.*canary director/);
  });
});
