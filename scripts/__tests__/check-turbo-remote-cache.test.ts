/**
 * check-turbo-remote-cache (#997) — every rule driven red by a fixture, the
 * compliant shapes driven green, and the real repository held to the gate.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { runTurboRemoteCacheGate } from "../check-turbo-remote-cache.js";
import {
  checkPackageScripts,
  checkPrePush,
  checkTurboJson,
  checkWorkflow,
  invokesTurbo,
  judgeTurboCacheValue,
  parseCacheSpec,
  remoteWriteFlags,
  turboScripts,
} from "../lib/turbo-remote-cache.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS = ["build", "test", "test:coverage", "typecheck", "lint", "lint:pack"];
const GOOD_CI =
  "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'local:rw,remote:rw' || 'local:rw,remote:r' }}";

describe("parseCacheSpec", () => {
  it("reads both separators and rejects junk", () => {
    expect(parseCacheSpec("local:rw,remote:r")).toEqual({ local: "rw", remote: "r" });
    expect(parseCacheSpec("remote:r;local:rw")).toEqual({ local: "rw", remote: "r" });
    expect(parseCacheSpec("local:rw")).toEqual({ local: "rw", remote: "" });
    expect(parseCacheSpec("remote:rwx")).toBeNull();
    expect(parseCacheSpec("")).toBeNull();
  });
});

describe("judgeTurboCacheValue", () => {
  it("accepts the canonical main-push condition and read-only literals", () => {
    expect(judgeTurboCacheValue(GOOD_CI)).toBeNull();
    expect(
      judgeTurboCacheValue(
        "${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && 'local:rw,remote:rw' || 'local:rw,remote:r' }}",
      ),
    ).toBeNull();
    expect(judgeTurboCacheValue('"local:rw,remote:r"')).toBeNull();
    expect(judgeTurboCacheValue("local:rw # no remote")).toBeNull();
  });
  it("rejects an unconditional remote write", () => {
    expect(judgeTurboCacheValue("local:rw,remote:rw")).toMatch(/unconditionally/);
    expect(judgeTurboCacheValue("remote:w")).toMatch(/unconditionally/);
  });
  it("rejects a writing fallback", () => {
    expect(
      judgeTurboCacheValue(
        "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'local:rw,remote:rw' || 'local:rw,remote:rw' }}",
      ),
    ).toMatch(/fallback/);
  });
  it("rejects a write not tied to main", () => {
    expect(
      judgeTurboCacheValue(
        "${{ github.event_name == 'push' && 'local:rw,remote:rw' || 'local:rw,remote:r' }}",
      ),
    ).toMatch(/refs\/heads\/main/);
  });
  it("rejects a ref-only condition (pull_request_target runs with ref = base)", () => {
    expect(
      judgeTurboCacheValue(
        "${{ github.ref == 'refs/heads/main' && 'local:rw,remote:rw' || 'local:rw,remote:r' }}",
      ),
    ).toMatch(/pull_request_target/);
  });
  it("rejects a pull_request event and a widened condition", () => {
    expect(
      judgeTurboCacheValue(
        "${{ github.event_name == 'pull_request_target' && github.ref == 'refs/heads/main' && 'local:rw,remote:rw' || 'local:rw,remote:r' }}",
      ),
    ).toMatch(/untrusted/);
    expect(
      judgeTurboCacheValue(
        "${{ (github.event_name == 'push' || github.event_name == 'pull_request') && github.ref == 'refs/heads/main' && 'local:rw,remote:rw' || 'local:rw,remote:r' }}",
      ),
    ).toMatch(/conjunction/);
    expect(
      judgeTurboCacheValue(
        "${{ github.event_name == 'push' && github.ref != 'refs/heads/main' && 'local:rw,remote:rw' || 'local:rw,remote:r' }}",
      ),
    ).toMatch(/conjunction/);
  });
  it("rejects shapes it does not understand", () => {
    expect(judgeTurboCacheValue("${{ vars.TURBO_CACHE }}")).toMatch(/not of the form/);
    expect(judgeTurboCacheValue("everything")).toMatch(/not a cache spec/);
  });
});

describe("turbo invocations", () => {
  it("derives the turbo-backed root scripts", () => {
    expect(
      turboScripts(
        JSON.stringify({
          scripts: { build: "turbo run build", check: "npx tsx scripts/check.ts" },
        }),
      ),
    ).toEqual(["build"]);
  });
  it("recognises direct and root-script invocations, not filtered package scripts", () => {
    expect(invokesTurbo("pnpm exec turbo run test:coverage --concurrency=4", SCRIPTS)).toBe(true);
    expect(invokesTurbo("npx turbo run build", SCRIPTS)).toBe(true);
    expect(invokesTurbo("        run: pnpm build", SCRIPTS)).toBe(true);
    expect(invokesTurbo("        run: pnpm lint:pack", SCRIPTS)).toBe(true);
    expect(invokesTurbo("pnpm --filter @motebit/sdk test", SCRIPTS)).toBe(false);
    expect(invokesTurbo("pnpm check", SCRIPTS)).toBe(false);
  });
  it("finds every remote-writing flag", () => {
    expect(remoteWriteFlags("turbo run build --cache=local:rw,remote:r")).toEqual([]);
    expect(remoteWriteFlags("turbo run build --cache=remote:rw")).toHaveLength(1);
    expect(remoteWriteFlags('turbo run build --cache "local:rw,remote:w"')).toHaveLength(1);
    expect(remoteWriteFlags("pnpm build --force")).toHaveLength(1);
    expect(remoteWriteFlags("turbo run build --remote-only")).toHaveLength(1);
    expect(remoteWriteFlags("turbo run build --remote-cache-read-only=false")).toHaveLength(1);
  });
});

describe("checkTurboJson", () => {
  it("requires remoteCache.signature === true", () => {
    expect(checkTurboJson(JSON.stringify({ tasks: {} }))).toHaveLength(1);
    expect(checkTurboJson(JSON.stringify({ remoteCache: { signature: false } }))).toHaveLength(1);
    expect(checkTurboJson(JSON.stringify({ remoteCache: { signature: "true" } }))).toHaveLength(1);
    expect(checkTurboJson(JSON.stringify({ remoteCache: { signature: true } }))).toEqual([]);
    expect(checkTurboJson("{")).toHaveLength(1);
  });
});

const wf = (env: string, run = "pnpm build"): string =>
  `name: X\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n\nenv:\n  TURBO_TOKEN: \${{ secrets.TURBO_TOKEN }}\n${env}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`;

describe("checkWorkflow", () => {
  it("passes the canonical shape", () => {
    const v = checkWorkflow("ci.yml", wf(`  TURBO_CACHE: ${GOOD_CI}`), SCRIPTS);
    expect(v.violations).toEqual([]);
    expect(v.holdsToken).toBe(true);
    expect(v.turboLines).toBe(1);
  });
  it("flags a token holder with no workflow-level TURBO_CACHE (turbo default = rw)", () => {
    expect(checkWorkflow("ci.yml", wf(""), SCRIPTS).violations.join()).toMatch(
      /declares no workflow-level/,
    );
  });
  it("does not count a job-level TURBO_CACHE as the workflow-level policy", () => {
    const text = wf("").replace(
      "    runs-on:",
      `    env:\n      TURBO_CACHE: local:rw,remote:r\n    runs-on:`,
    );
    expect(checkWorkflow("ci.yml", text, SCRIPTS).violations.join()).toMatch(
      /declares no workflow-level/,
    );
  });
  it("flags a job-level override that writes", () => {
    const text = wf(`  TURBO_CACHE: ${GOOD_CI}`).replace(
      "    runs-on:",
      `    env:\n      TURBO_CACHE: local:rw,remote:rw\n    runs-on:`,
    );
    expect(checkWorkflow("ci.yml", text, SCRIPTS).violations.join()).toMatch(/unconditionally/);
  });
  it("flags a flag that overrides the env", () => {
    expect(
      checkWorkflow(
        "ci.yml",
        wf(`  TURBO_CACHE: ${GOOD_CI}`, "pnpm exec turbo run build --cache=local:rw,remote:rw"),
        SCRIPTS,
      ).violations.join(),
    ).toMatch(/overrides TURBO_CACHE/);
    expect(
      checkWorkflow("ci.yml", wf(`  TURBO_CACHE: ${GOOD_CI}`, "pnpm build --force"), SCRIPTS)
        .violations,
    ).toHaveLength(1);
  });
  it("flags an inline TURBO_CACHE that writes, and signing switched off", () => {
    expect(
      checkWorkflow(
        "ci.yml",
        wf(`  TURBO_CACHE: ${GOOD_CI}`, "TURBO_CACHE=remote:rw pnpm build"),
        SCRIPTS,
      ).violations.join(),
    ).toMatch(/inline TURBO_CACHE/);
    expect(
      checkWorkflow(
        "ci.yml",
        wf(`  TURBO_CACHE: ${GOOD_CI}\n  TURBO_SIGNATURE: "0"`),
        SCRIPTS,
      ).violations.join(),
    ).toMatch(/signing OFF/);
    expect(
      checkWorkflow(
        "ci.yml",
        wf(`  TURBO_CACHE: ${GOOD_CI}\n  TURBO_REMOTE_ONLY: "true"`),
        SCRIPTS,
      ).violations.join(),
    ).toMatch(/re-opens remote writes/);
  });
  it("ignores a workflow without the token, and comment lines", () => {
    const v = checkWorkflow("x.yml", "on:\n  push:\n# TURBO_CACHE: remote:rw\njobs: {}\n", SCRIPTS);
    expect(v.violations).toEqual([]);
    expect(v.holdsToken).toBe(false);
  });
});

describe("checkPrePush / checkPackageScripts", () => {
  it("requires the hook to pin a non-writing TURBO_CACHE", () => {
    expect(checkPrePush("pnpm build\n", SCRIPTS).join()).toMatch(/no `export TURBO_CACHE/);
    expect(checkPrePush("export TURBO_CACHE=local:rw,remote:rw\n", SCRIPTS).join()).toMatch(
      /write the remote/,
    );
    expect(checkPrePush("export TURBO_CACHE=local:rw,remote:r\npnpm build\n", SCRIPTS)).toEqual([]);
    expect(
      checkPrePush(
        "export TURBO_CACHE=local:rw,remote:r\npnpm turbo run test --force\n",
        SCRIPTS,
      ).join(),
    ).toMatch(/--force/);
  });
  it("rejects a remote-writing flag in a root script", () => {
    expect(
      checkPackageScripts(JSON.stringify({ scripts: { build: "turbo run build --force" } })),
    ).toHaveLength(1);
    expect(checkPackageScripts(JSON.stringify({ scripts: { build: "turbo run build" } }))).toEqual(
      [],
    );
  });
});

describe("runTurboRemoteCacheGate against a fixture repository", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const fixture = (opts: { signature: boolean; cache: boolean; hookPin: boolean }): string => {
    const d = mkdtempSync(join(tmpdir(), "turbo-gate-"));
    dirs.push(d);
    mkdirSync(join(d, ".github", "workflows"), { recursive: true });
    mkdirSync(join(d, ".husky"), { recursive: true });
    writeFileSync(
      join(d, "turbo.json"),
      JSON.stringify(
        opts.signature ? { tasks: {}, remoteCache: { signature: true } } : { tasks: {} },
      ),
    );
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({ scripts: { build: "turbo run build" } }),
    );
    writeFileSync(
      join(d, ".husky", "pre-push"),
      `${opts.hookPin ? "export TURBO_CACHE=local:rw,remote:r\n" : ""}pnpm build\n`,
    );
    writeFileSync(
      join(d, ".github", "workflows", "ci.yml"),
      wf(opts.cache ? `  TURBO_CACHE: ${GOOD_CI}` : ""),
    );
    writeFileSync(join(d, ".github", "workflows", "other.yml"), "on:\n  push:\njobs: {}\n");
    return d;
  };

  it("is green on a compliant repository and discloses its aperture", () => {
    const d = fixture({ signature: true, cache: true, hookPin: true });
    const r = runTurboRemoteCacheGate(d);
    expect(r.violations).toEqual([]);
    expect(r.workflows).toBe(2);
    expect(r.tokenHolders).toEqual(["ci.yml"]);
    const cli = spawnSync("npx", ["tsx", "scripts/check-turbo-remote-cache.ts", "--root", d], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(cli.status).toBe(0);
    expect(cli.stdout).toMatch(/2 workflow\(s\) scanned/);
  });

  it("goes red — with a repair instruction — for each broken half", () => {
    expect(
      runTurboRemoteCacheGate(fixture({ signature: false, cache: true, hookPin: true })).violations,
    ).toHaveLength(1);
    expect(
      runTurboRemoteCacheGate(fixture({ signature: true, cache: false, hookPin: true })).violations,
    ).toHaveLength(1);
    expect(
      runTurboRemoteCacheGate(fixture({ signature: true, cache: true, hookPin: false })).violations,
    ).toHaveLength(1);
    const d = fixture({ signature: false, cache: false, hookPin: false });
    const cli = spawnSync("npx", ["tsx", "scripts/check-turbo-remote-cache.ts", "--root", d], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/Fix:/);
    expect(cli.stderr).toMatch(/remoteCache/);
  });
});

describe("this repository", () => {
  it("passes check-turbo-remote-cache", () => {
    const r = runTurboRemoteCacheGate(ROOT);
    expect(r.violations).toEqual([]);
    // ci.yml, publish.yml and release.yml hold TURBO_TOKEN (#997).
    expect(r.tokenHolders).toEqual(
      expect.arrayContaining(["ci.yml", "publish.yml", "release.yml"]),
    );
  });
});
