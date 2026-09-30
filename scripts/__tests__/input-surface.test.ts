/**
 * The declared hash surface (scripts/test-support/input-surface.ts) and the env
 * policy (scripts/test-support/env-policy.ts), as pure functions: lockfile
 * closure, env classification, and the classifier's per-kind decisions.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { classifyEnv, envPatternMatches } from "../test-support/env-policy.js";
import {
  classifyEnvRead,
  classifyPath,
  computeSurface,
  lockfileClosure,
  parseLockfile,
  storeIdOf,
} from "../test-support/input-surface.js";

const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      turbo:
        specifier: 2.10.9
        version: 2.10.9

  packages/a:
    dependencies:
      '@fx/b':
        specifier: workspace:*
        version: link:../b
      react-native:
        specifier: 0.83.10
        version: 0.83.10(@babel/core@7.29.7)(react@19.2.0)

  packages/b:
    dependencies:
      ws:
        specifier: ^8.21.3
        version: 8.21.3

  packages/c:
    {}

packages:

  ws@8.21.3:
    resolution: {integrity: sha512-x}

snapshots:

  react-native@0.83.10(@babel/core@7.29.7)(react@19.2.0):
    dependencies:
      whatwg-fetch: 3.6.20
      string-width-cjs: string-width@4.2.3

  whatwg-fetch@3.6.20: {}

  string-width@4.2.3: {}

  ws@8.21.3: {}

  turbo@2.10.9: {}
`;

describe("lockfile closure", () => {
  const lock = parseLockfile(LOCK);

  it("follows workspace links, strips peer suffixes, resolves aliases, and includes the root", () => {
    const a = lockfileClosure(lock, "packages/a");
    expect([...a].sort()).toEqual([
      "react-native@0.83.10",
      "string-width@4.2.3",
      "turbo@2.10.9",
      "whatwg-fetch@3.6.20",
      "ws@8.21.3",
    ]);
  });

  it("does not leak another importer's closure (C5)", () => {
    const c = lockfileClosure(lock, "packages/c");
    expect([...c]).toEqual(["turbo@2.10.9"]);
  });
});

describe("env policy", () => {
  it("the longest matching pattern wins", () => {
    expect(classifyEnv("TURBO_HASH")?.class).toBe("benign");
    expect(classifyEnv("TURBO_TOKEN")?.class).toBe("guarded");
    expect(classifyEnv("npm_package_name")?.class).toBe("benign");
    expect(classifyEnv("npm_config_registry")?.class).toBe("guarded");
  });

  it("the longest pattern wins regardless of table order", () => {
    const general = { pattern: "A_*", class: "guarded" as const, reason: "g" };
    const specific = { pattern: "A_B", class: "benign" as const, reason: "s" };
    expect(classifyEnv("A_B", [general, specific])?.class).toBe("benign");
    expect(classifyEnv("A_B", [specific, general])?.class).toBe("benign");
    expect(classifyEnv("A_C", [general, specific])?.class).toBe("guarded");
  });

  it("a `*` pattern is a prefix; an exact pattern is exact", () => {
    expect(envPatternMatches("GITHUB_*", "GITHUB_TOKEN")).toBe(true);
    expect(envPatternMatches("GITHUB_*", "XGITHUB_TOKEN")).toBe(false);
    expect(envPatternMatches("TZ", "TZX")).toBe(false);
    expect(classifyEnv("MOTEBIT_UNKNOWN")).toBeNull();
  });
});

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(pkgTurbo?: object): string {
  const root = mkdtempSync(join(tmpdir(), "input-surface-"));
  roots.push(root);
  const files: Record<string, string> = {
    "turbo.json": JSON.stringify({
      globalDependencies: ["vitest.shared.ts"],
      tasks: {
        test: { env: ["TZ"] },
        "test:coverage": { env: ["TZ"] },
      },
    }),
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "pnpm-lock.yaml": LOCK,
    "vitest.shared.ts": "",
    "spec/x.md": "",
    "packages/a/package.json": JSON.stringify({ name: "@fx/a" }),
    "packages/a/src/own.ts": "",
    "packages/b/package.json": JSON.stringify({ name: "@fx/b" }),
    "packages/b/src/b.ts": "",
    "packages/c/package.json": JSON.stringify({ name: "@fx/c" }),
    "node_modules/.pnpm/whatwg-fetch@3.6.20/node_modules/whatwg-fetch/package.json": JSON.stringify(
      {
        name: "whatwg-fetch",
        version: "3.6.20",
      },
    ),
    "node_modules/.pnpm/whatwg-fetch@3.6.20/node_modules/whatwg-fetch/fetch.js": "",
  };
  if (pkgTurbo) files["packages/c/turbo.json"] = JSON.stringify(pkgTurbo);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

describe("classifyPath / classifyEnvRead", () => {
  const FETCH = "node_modules/.pnpm/whatwg-fetch@3.6.20/node_modules/whatwg-fetch/fetch.js";

  it("a store file resolves to its name@version", () => {
    const root = workspace();
    expect(storeIdOf(join(root, FETCH))).toBe("whatwg-fetch@3.6.20");
  });

  it("C5: a store package outside the closure is refused; inside it is accepted", () => {
    const root = workspace();
    const c = computeSurface(root, join(root, "packages/c"));
    expect(classifyPath(c, join(root, FETCH), "module")?.repairJson.add).toBe(
      "$TURBO_ROOT$/pnpm-lock.yaml",
    );
    const a = computeSurface(root, join(root, "packages/a"));
    expect(classifyPath(a, join(root, FETCH), "module")).toBeNull();
  });

  it("declaring the lockfile on both tasks accepts any store package", () => {
    const lockInputs = { inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/pnpm-lock.yaml"] };
    const root = workspace({
      extends: ["//"],
      tasks: { test: lockInputs, "test:coverage": lockInputs },
    });
    const c = computeSurface(root, join(root, "packages/c"));
    expect(classifyPath(c, join(root, FETCH), "module")).toBeNull();
  });

  it("own files, global deps and workspace-dep files are hashed; an undeclared outside file is not", () => {
    const root = workspace();
    const a = computeSurface(root, join(root, "packages/a"));
    expect(classifyPath(a, join(root, "packages/a/src/own.ts"), "read")).toBeNull();
    expect(classifyPath(a, join(root, "vitest.shared.ts"), "read")).toBeNull();
    expect(classifyPath(a, join(root, "packages/b/src/b.ts"), "read")).toBeNull();
    expect(classifyPath(a, join(root, "spec/x.md"), "read")?.repairJson).toEqual({
      file: "packages/a/turbo.json",
      tasks: ["test", "test:coverage"],
      key: "inputs",
      add: "$TURBO_ROOT$/spec/x.md",
    });
    // c does not depend on b.
    const c = computeSurface(root, join(root, "packages/c"));
    expect(classifyPath(c, join(root, "packages/b/src/b.ts"), "read")).not.toBeNull();
  });

  it("a probe of an ancestor directory is config discovery; a READ of it is an input", () => {
    const root = workspace();
    const a = computeSurface(root, join(root, "packages/a"));
    expect(classifyPath(a, root, "probe")).toBeNull();
    expect(classifyPath(a, root, "readdir")?.repairJson.add).toBe("$TURBO_ROOT$/**");
  });

  it("tmp is an input unless the test created it; $HOME is user state; system paths are machine state", () => {
    const root = workspace();
    const a = computeSurface(root, join(root, "packages/a"));
    const foreign = classifyPath(a, join(tmpdir(), "anything.json"), "read");
    expect(foreign?.why).toContain("under tmp the test did not create");
    expect(foreign?.repairJson).toMatchObject({ key: "cache", set: false });
    const own = join(tmpdir(), "made-by-the-test");
    const created = (p: string) => p === own || p.startsWith(own + "/");
    expect(classifyPath(a, join(own, "f.json"), "read", { created })).toBeNull();
    expect(classifyPath(a, "/opt/somewhere/data.txt", "read")?.why).toContain("a system path");
    expect(classifyPath(a, "/opt/.devin", "probe")).toBeNull(); // reviewed tooling probe
    expect(classifyPath(a, process.execPath, "read")).toBeNull(); // the running Node install
    const home = process.env.HOME;
    if (home && !home.startsWith(tmpdir()))
      expect(classifyPath(a, join(home, ".motebit", "config.json"), "read")?.why).toContain(
        "user state",
      );
  });

  it("an env read is accepted only when hashed or benign", () => {
    const root = workspace();
    const a = computeSurface(root, join(root, "packages/a"));
    expect(classifyEnvRead(a, "TZ")).toBeNull(); // hashed
    expect(classifyEnvRead(a, "PATH")).toBeNull(); // benign
    expect(classifyEnvRead(a, "XDG_RUNTIME_DIR")?.repairJson.add).toBe("XDG_RUNTIME_DIR"); // guarded
    expect(classifyEnvRead(a, "LANG")?.why).toContain("must be hashed"); // hash-class, unhashed here
    // Absent: a pass-through var could be set later; an unclassified one never reaches the task.
    expect(classifyEnvRead(a, "GITHUB_SHA", false)?.what).toBe("env GITHUB_SHA (absent)");
    expect(classifyEnvRead(a, "MOTEBIT_NEVER_PASSED", false)).toBeNull();
  });
});
