/**
 * The runtime input tracer (scripts/test-support/input-tracer.ts), end to end:
 * a miniature workspace carrying the REAL tracer, vitest.shared.ts and
 * turbo.json runs vitest with enforcement on, one test file per clause. A file
 * that observes an input outside its turbo hash must FAIL with a repair line;
 * a file whose inputs are all hashed must pass. Every clause is pinned here —
 * scripts/turbo-cache-mutations.ts mutates each one and requires red.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeId } from "../test-support/env-policy.js";
import {
  buildFixture,
  fakeDep,
  linkDep,
  lockfile,
  pkgJson,
  testFile,
} from "../turbo-stale-cache-harness.js";

const ROOT_EXPR = `const ROOT = resolve(__dir, "../../../..");\n`;
const t = (name: string, body: string) =>
  testFile(
    ROOT_EXPR + `describe("${name}", () => {\n  it("${name}", async () => {\n${body}\n  });\n});\n`,
  );

/** file → expected: "pass", or a substring the failure must carry. */
const EXPECT: Record<string, string> = {
  "ok-own": "pass",
  "read-outside":
    'REPAIR-JSON {"file":"packages/p/turbo.json","tasks":["test","test:coverage"],"key":"inputs","add":"$TURBO_ROOT$/spec/undeclared.md"}',
  "read-half-declared": '"add":"$TURBO_ROOT$/spec/half.md"',
  "readdir-root": '"add":"$TURBO_ROOT$/spec/**"',
  "readdir-ancestor": '"add":"$TURBO_ROOT$/**"',
  "import-json": '"add":"$TURBO_ROOT$/spec/imported.json"',
  "env-read":
    'REPAIR-JSON {"file":"turbo.json","tasks":["test","test:coverage"],"key":"env","add":"XDG_RUNTIME_DIR"}',
  "env-hashed": "pass",
  "env-spread": "process.env enumerated",
  "module-closure": "fx-fetch@1.0.0 is outside @fx/p's lockfile closure",
  "exec-path": '"add":"$TURBO_ROOT$/scripts/tool.mjs"',
  promisify: "spawn execFile(",
  home: "user state under $HOME",
  "dep-file": "pass",
  "native-esm": "fx-inner@1.0.0 is outside @fx/p's lockfile closure",
  "resolve-only": "fx-fetch@1.0.0 is outside @fx/p's lockfile closure",
  // ── round 2: every clause below replayed a stale PASS before it existed ──
  "promises-read": '"add":"$TURBO_ROOT$/spec/undeclared.md"',
  "promises-readdir": '"add":"$TURBO_ROOT$/spec/**"',
  "exec-cat": "spawn execSync(cat ../../spec/declared.md)",
  "exec-bare": "spawn execSync(git --version)",
  "in-env": '"key":"env","add":"XDG_RUNTIME_DIR"',
  "descriptor-env": '"key":"env","add":"XDG_RUNTIME_DIR"',
  "write-then-read": "pass",
  "read-then-write": '"key":"env","add":"XDG_RUNTIME_DIR"',
  "absent-guarded": "env GITHUB_SHA (absent)",
  "absent-unclassified": "pass",
  enumerate: "process.env enumerated",
  worker: "spawn new Worker(",
  ignored: "a git-IGNORED file inside the package",
  "tmp-foreign": "under tmp the test did not create",
  "tmp-own": "pass",
  "system-probe": "a system path outside the repo",
  glob: "import.meta.glob in packages/p/src/__tests__/glob.test.ts",
};

/** A cached package with its own vitest config and one passing test. */
function configPkg(name: string, config: string): Record<string, string> {
  return {
    [`packages/${name}/package.json`]: pkgJson(`@fx/${name}`),
    [`packages/${name}/turbo.json`]: JSON.stringify({
      extends: ["//"],
      tasks: { test: { cache: true }, "test:coverage": { cache: true } },
    }),
    [`packages/${name}/vitest.config.ts`]: config,
    [`packages/${name}/src/__tests__/ok.test.ts`]: testFile(
      `describe("ok", () => {\n  it("ok", () => {\n    expect(1).toBe(1);\n  });\n});\n`,
    ),
  };
}

/** A fixed tmp file the TEST never creates (the fixture writes it). */
const FOREIGN_TMP = "motebit-input-tracer-foreign.txt";

const FILES: Record<string, string> = {
  "packages/p/turbo.json": JSON.stringify({
    extends: ["//"],
    tasks: {
      test: {
        cache: true,
        inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/spec/declared.md", "$TURBO_ROOT$/spec/half.md"],
      },
      "test:coverage": {
        cache: true,
        inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/spec/declared.md"],
      },
    },
  }),
  "packages/p/.gitignore": "*.local\n",
  "packages/p/fixture.local": "ignored\n",
  "packages/p/package.json": pkgJson("@fx/p", { dependencies: { "@fx/lib": "workspace:*" } }),
  "packages/p/src/own.json": "{}\n",
  "packages/lib/package.json": pkgJson("@fx/lib"),
  "packages/lib/src/data.json": '{"v":1}\n',
  "apps/mob/package.json": pkgJson("@fx/mob", { dependencies: { "fx-fetch": "1.0.0" } }),
  "spec/declared.md": "d\n",
  "spec/half.md": "h\n",
  "spec/undeclared.md": "u\n",
  "spec/imported.json": '{"v":1}\n',
  "scripts/tool.mjs": "process.exit(0);\n",
  "packages/p/src/__tests__/ok-own.test.ts": t(
    "ok-own",
    `    readFileSync(resolve(__dir, "../own.json"));\n` +
      `    readFileSync(join(ROOT, "vitest.shared.ts"));\n` +
      `    expect(readFileSync(join(ROOT, "spec/declared.md"), "utf-8")).toBe("d\\n");`,
  ),
  "packages/p/src/__tests__/read-outside.test.ts": t(
    "read-outside",
    `    readFileSync(\`\${ROOT}/spec/undeclared.md\`, "utf-8");`,
  ),
  "packages/p/src/__tests__/read-half-declared.test.ts": t(
    "read-half-declared",
    `    readFileSync(join(ROOT, "spec/half.md"), "utf-8");`,
  ),
  "packages/p/src/__tests__/readdir-root.test.ts": t(
    "readdir-root",
    `    const { readdirSync } = await import("node:fs");\n    readdirSync(join(ROOT, "spec"));`,
  ),
  "packages/p/src/__tests__/readdir-ancestor.test.ts": t(
    "readdir-ancestor",
    `    const { readdirSync } = await import("node:fs");\n    readdirSync(ROOT);`,
  ),
  "packages/p/src/__tests__/import-json.test.ts":
    `import data from "../../../../spec/imported.json";\n` +
    t("import-json", `    expect(data.v).toBe(1);`),
  "packages/p/src/__tests__/env-read.test.ts": t(
    "env-read",
    `    expect(process.env.XDG_RUNTIME_DIR).toBe("/run/tracer");`,
  ),
  "packages/p/src/__tests__/env-hashed.test.ts": t(
    "env-hashed",
    `    expect(process.env.TZ).toBe("UTC");\n    expect(process.env.HOME).toBeTruthy();`,
  ),
  "packages/p/src/__tests__/env-spread.test.ts": t(
    "env-spread",
    `    const { spawnSync } = await import("node:child_process");\n` +
      `    const copy = { ...process.env };\n` +
      `    const r = spawnSync(process.execPath, ["-e", "0"], { env: copy });\n` +
      `    const r2 = spawnSync(process.execPath, ["-e", "0"]);\n` +
      `    expect(r.status).toBe(0);\n    expect(r2.status).toBe(0);`,
  ),
  "packages/p/src/__tests__/module-closure.test.ts": t(
    "module-closure",
    `    const req = createRequire(join(ROOT, "apps/mob/package.json"));\n    expect(req("fx-fetch").value).toBe(1);`,
  ),
  "packages/p/src/__tests__/exec-path.test.ts": t(
    "exec-path",
    `    const { spawnSync } = await import("node:child_process");\n` +
      `    expect(spawnSync(process.execPath, [join(ROOT, "scripts/tool.mjs")]).status).toBe(0);`,
  ),
  "packages/p/src/__tests__/promisify.test.ts": t(
    "promisify",
    `    const { execFile } = await import("node:child_process");\n` +
      `    const { promisify } = await import("node:util");\n` +
      `    const r = await promisify(execFile)(process.execPath, ["-e", "process.stdout.write('hi')"]);\n` +
      `    expect(r.stdout).toBe("hi");`,
  ),
  "packages/p/src/__tests__/home.test.ts": t(
    "home",
    `    const { homedir } = await import("node:os");\n    existsSync(join(homedir(), ".motebit-input-tracer-probe"));`,
  ),
  // fx-outer is in p's closure; its native ESM import of fx-inner escapes it —
  // only the loader's resolve hook sees that module (no JS fs call reads it).
  "packages/p/src/__tests__/native-esm.test.ts": t(
    "native-esm",
    `    const m = await import("fx-outer");\n    expect(m.v).toBe(2);`,
  ),
  // A resolution with no read: the outcome depends on WHERE fx-fetch resolves
  // (another package's closure), and only the loader's resolve hook sees it.
  "packages/p/src/__tests__/resolve-only.test.ts": t(
    "resolve-only",
    `    const req = createRequire(join(ROOT, "apps/mob/package.json"));\n` +
      `    expect(req.resolve("fx-fetch")).toMatch(/index\\.cjs$/);`,
  ),
  "packages/p/src/__tests__/promises-read.test.ts": t(
    "promises-read",
    `    const { readFile } = await import("node:fs/promises");\n` +
      `    await readFile(join(ROOT, "spec/undeclared.md"), "utf-8");`,
  ),
  "packages/p/src/__tests__/promises-readdir.test.ts": t(
    "promises-readdir",
    `    const { readdir } = await import("node:fs/promises");\n    await readdir(join(ROOT, "spec"));`,
  ),
  "packages/p/src/__tests__/exec-cat.test.ts": t(
    "exec-cat",
    `    const { execSync } = await import("node:child_process");\n` +
      `    expect(execSync("cat ../../spec/declared.md", { encoding: "utf-8" })).toBe("d\\n");`,
  ),
  "packages/p/src/__tests__/exec-bare.test.ts": t(
    "exec-bare",
    `    const { execSync } = await import("node:child_process");\n    execSync("git --version");`,
  ),
  "packages/p/src/__tests__/in-env.test.ts": t(
    "in-env",
    `    expect("XDG_RUNTIME_DIR" in process.env).toBe(true);`,
  ),
  "packages/p/src/__tests__/descriptor-env.test.ts": t(
    "descriptor-env",
    `    expect(Object.getOwnPropertyDescriptor(process.env, "XDG_RUNTIME_DIR")?.value).toBe("/run/tracer");`,
  ),
  "packages/p/src/__tests__/write-then-read.test.ts": t(
    "write-then-read",
    `    process.env.XDG_RUNTIME_DIR = "/run/set-by-test";\n` +
      `    expect(process.env.XDG_RUNTIME_DIR).toBe("/run/set-by-test");\n` +
      `    expect("XDG_RUNTIME_DIR" in process.env).toBe(true);`,
  ),
  "packages/p/src/__tests__/read-then-write.test.ts": t(
    "read-then-write",
    `    const before = process.env.XDG_RUNTIME_DIR;\n` +
      `    process.env.XDG_RUNTIME_DIR = "/run/set-by-test";\n    expect(before).toBe("/run/tracer");`,
  ),
  "packages/p/src/__tests__/absent-guarded.test.ts": t(
    "absent-guarded",
    `    expect(process.env.GITHUB_SHA).toBeUndefined();`,
  ),
  "packages/p/src/__tests__/absent-unclassified.test.ts": t(
    "absent-unclassified",
    `    expect(process.env.MOTEBIT_NEVER_PASSED_THROUGH).toBeUndefined();`,
  ),
  "packages/p/src/__tests__/enumerate.test.ts": t(
    "enumerate",
    `    expect(Object.keys(process.env).length).toBeGreaterThan(0);`,
  ),
  "packages/p/src/__tests__/worker.test.ts": t(
    "worker",
    `    const { Worker } = await import("node:worker_threads");\n` +
      `    const w = new Worker("0", { eval: true });\n    await new Promise((ok) => w.once("exit", ok));`,
  ),
  "packages/p/src/__tests__/ignored.test.ts": t(
    "ignored",
    `    expect(readFileSync(join(__dir, "../../fixture.local"), "utf-8")).toBe("ignored\\n");`,
  ),
  "packages/p/src/__tests__/tmp-foreign.test.ts": t(
    "tmp-foreign",
    `    const { tmpdir } = await import("node:os");\n` +
      `    readFileSync(join(tmpdir(), "${FOREIGN_TMP}"), "utf-8");`,
  ),
  "packages/p/src/__tests__/tmp-own.test.ts": t(
    "tmp-own",
    `    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } = await import("node:fs");\n` +
      `    const { tmpdir } = await import("node:os");\n` +
      `    const dir = mkdtempSync(join(tmpdir(), "tracer-own-"));\n` +
      `    mkdirSync(join(dir, "a", "b"), { recursive: true });\n` +
      `    writeFileSync(join(dir, "a", "b", "f.txt"), "x");\n` +
      `    expect(readFileSync(join(dir, "a", "b", "f.txt"), "utf-8")).toBe("x");\n` +
      `    expect(readdirSync(dir)).toEqual(["a"]);\n` +
      `    rmSync(dir, { recursive: true, force: true });`,
  ),
  "packages/p/src/__tests__/system-probe.test.ts": t(
    "system-probe",
    `    expect(existsSync("/etc/motebit-input-tracer-probe")).toBe(false);`,
  ),
  "packages/p/src/__tests__/glob.test.ts": t(
    "glob",
    `    const mods = import.meta.glob("../../../../spec/*.md", { eager: true, query: "?raw" });\n` +
      `    expect(Object.keys(mods).length).toBeGreaterThan(0);`,
  ),
  // Config-phase packages (the vitest MAIN process): each fails at startup.
  ...configPkg(
    "cfg",
    `import { readFileSync } from "node:fs";\n` +
      `import { defineMotebitTest } from "../../vitest.shared.js";\n` +
      `const v = readFileSync(new URL("../../spec/undeclared.md", import.meta.url), "utf-8");\n` +
      `export default defineMotebitTest({\n  thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 },\n` +
      `  vite: { define: { __V__: JSON.stringify(v) } },\n});\n`,
  ),
  ...configPkg(
    "gs",
    `import { defineMotebitTest } from "../../vitest.shared.js";\n` +
      `export default defineMotebitTest({\n  thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 },\n` +
      `  extra: { globalSetup: ["./setup.ts"] },\n});\n`,
  ),
  "packages/gs/setup.ts": "export default function setup(): void {}\n",
  "packages/p/src/__tests__/dep-file.test.ts": t(
    "dep-file",
    `    expect(readFileSync(join(ROOT, "packages/lib/src/data.json"), "utf-8")).toContain("1");`,
  ),
};

let root = "";

interface FileResult {
  status: string;
  message: string;
}

function vitest(env: Record<string, string>): Map<string, FileResult> {
  const pkgDir = join(root, "packages", "p");
  const out = join(root, "report.json");
  rmSync(out, { force: true });
  spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--reporter=json",
      `--outputFile=${out}`,
    ],
    {
      cwd: pkgDir,
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TZ: "UTC",
        XDG_RUNTIME_DIR: "/run/tracer",
        ...env,
      },
    },
  );
  const report = JSON.parse(readFileSync(out, "utf-8")) as {
    testResults: {
      name: string;
      status: string;
      message: string;
      assertionResults: { failureMessages: string[] }[];
    }[];
  };
  const res = new Map<string, FileResult>();
  for (const f of report.testResults) {
    const name = f.name.replace(/^.*\//, "").replace(/\.test\.ts$/, "");
    const msgs = [f.message, ...f.assertionResults.flatMap((a) => a.failureMessages)].join("\n");
    res.set(name, { status: f.status, message: msgs });
  }
  return res;
}

const ENFORCE = { MOTEBIT_INPUT_TRACER: "enforce", MOTEBIT_TEST_RUNTIME: runtimeId() };

beforeAll(() => {
  root = buildFixture({
    name: "tracer",
    claim: "",
    pkg: "p",
    files: FILES,
    mutate: () => undefined,
    setup: (r) => {
      writeFileSync(join(tmpdir(), FOREIGN_TMP), "not the test's\n");
      writeFileSync(
        join(r, "pnpm-lock.yaml"),
        lockfile({
          ".": {},
          "apps/mob": { "fx-fetch": "1.0.0" },
          "packages/p": {},
          "packages/lib": {},
        }).replace(
          "  packages/p:\n    {}\n",
          "  packages/p:\n    dependencies:\n      '@fx/lib':\n        specifier: workspace:*\n        version: link:../lib\n" +
            "      fx-outer:\n        specifier: 1.0.0\n        version: 1.0.0\n",
        ) + "\n  fx-outer@1.0.0: {}\n", // a snapshot with no deps: fx-inner is outside the closure
      );
      linkDep(r, "apps/mob", "fx-fetch", fakeDep(r, "fx-fetch", "1.0.0", 1));
      const store = (n: string) =>
        join(r, "node_modules", ".pnpm", `${n}@1.0.0`, "node_modules", n);
      for (const n of ["fx-outer", "fx-inner"]) {
        mkdirSync(store(n), { recursive: true });
        writeFileSync(
          join(store(n), "package.json"),
          JSON.stringify({ name: n, version: "1.0.0", type: "module", exports: "./index.mjs" }),
        );
      }
      writeFileSync(join(store("fx-inner"), "index.mjs"), "export const v = 2;\n");
      writeFileSync(
        join(store("fx-outer"), "index.mjs"),
        'export { v } from "../../../fx-inner@1.0.0/node_modules/fx-inner/index.mjs";\n',
      );
      linkDep(r, "packages/p", "fx-outer", store("fx-outer"));
    },
  });
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  rmSync(join(tmpdir(), FOREIGN_TMP), { force: true });
});

describe("input tracer — enforcement, one clause per file", () => {
  let res = new Map<string, FileResult>();
  beforeAll(() => {
    res = vitest(ENFORCE);
  }, 120_000);

  for (const [file, want] of Object.entries(EXPECT)) {
    it(`${file}: ${want === "pass" ? "passes (every input hashed)" : "fails with its repair"}`, () => {
      const r = res.get(file);
      expect(r, `no result for ${file}`).toBeDefined();
      if (want === "pass") {
        expect(r!.status, r!.message).toBe("passed");
      } else {
        expect(r!.status).toBe("failed");
        expect(r!.message).toContain("[input-tracer]");
        expect(r!.message).toContain(want);
      }
    });
  }
});

describe("config-phase tracer — the vitest main process", () => {
  const run = (pkg: string, env: Record<string, string>): string => {
    const r = spawnSync(
      process.execPath,
      [join(root, "node_modules", "vitest", "vitest.mjs"), "run"],
      {
        cwd: join(root, "packages", pkg),
        encoding: "utf-8",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TZ: "UTC", ...env },
      },
    );
    return `${r.status}\n${r.stdout}${r.stderr}`;
  };

  it("fails a cached package whose config reads a file outside its hash", () => {
    const out = run("cfg", ENFORCE);
    expect(out).toContain("(vitest config): read spec/undeclared.md");
    expect(out.startsWith("0\n")).toBe(false);
  }, 120_000);

  it("fails a cached package whose config declares globalSetup", () => {
    const out = run("gs", ENFORCE);
    expect(out).toContain("(vitest config): vitest globalSetup / provide");
    expect(out.startsWith("0\n")).toBe(false);
  }, 120_000);

  it("only observes outside enforcement", () => {
    expect(run("cfg", { MOTEBIT_TEST_RUNTIME: runtimeId() }).startsWith("0\n")).toBe(true);
  }, 120_000);
});

describe("input tracer — run-level clauses", () => {
  it("fails every file when MOTEBIT_TEST_RUNTIME is not the running runtime (C1)", () => {
    for (const bad of [{}, { MOTEBIT_TEST_RUNTIME: "node-v20.0.0-linux-x64" }]) {
      const res = vitest({ MOTEBIT_INPUT_TRACER: "enforce", ...bad });
      const ok = res.get("ok-own")!;
      expect(ok.status).toBe("failed");
      expect(ok.message).toContain("MOTEBIT_TEST_RUNTIME is");
      expect(ok.message).toContain("scripts/turbo-run.mjs");
    }
  }, 120_000);

  it("fails when NODE_OPTIONS is set but not hashed", () => {
    const turbo = join(root, "turbo.json");
    const orig = readFileSync(turbo, "utf-8");
    try {
      writeFileSync(turbo, orig.replaceAll('"NODE_OPTIONS",', ""));
      const res = vitest({ ...ENFORCE, NODE_OPTIONS: "--no-deprecation" });
      expect(res.get("ok-own")!.message).toContain(
        "NODE_OPTIONS is set but not in the test task hash",
      );
      // …and hashed, it is accepted.
      writeFileSync(turbo, orig);
      expect(vitest({ ...ENFORCE, NODE_OPTIONS: "--no-deprecation" }).get("ok-own")!.status).toBe(
        "passed",
      );
    } finally {
      writeFileSync(turbo, orig);
    }
  }, 120_000);

  it("only observes outside a turbo task (a bare vitest run caches nothing)", () => {
    const res = vitest({ MOTEBIT_TEST_RUNTIME: runtimeId() });
    expect(res.get("read-outside")!.status).toBe("passed");
    // The patched exec/execFile keep their promisified { stdout, stderr } shape.
    expect(res.get("promisify")!.status, res.get("promisify")!.message).toBe("passed");
    // TURBO_HASH is what turns enforcement on under turbo.
    expect(
      vitest({ TURBO_HASH: "abc", MOTEBIT_TEST_RUNTIME: runtimeId() }).get("read-outside")!.status,
    ).toBe("failed");
  }, 120_000);
});
