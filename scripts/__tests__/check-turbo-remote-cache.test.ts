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
    expect(judgeTurboCacheValue("local:rw")).toBeNull();
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
  it("requires remoteCache.signature AND futureFlags.longerSignatureKey", () => {
    const flags = { futureFlags: { longerSignatureKey: true } };
    expect(checkTurboJson(JSON.stringify({ tasks: {}, ...flags }))).toHaveLength(1);
    expect(
      checkTurboJson(JSON.stringify({ remoteCache: { signature: false }, ...flags })),
    ).toHaveLength(1);
    expect(
      checkTurboJson(JSON.stringify({ remoteCache: { signature: "true" }, ...flags })),
    ).toHaveLength(1);
    expect(checkTurboJson(JSON.stringify({ remoteCache: { signature: true } }))).toHaveLength(1);
    expect(checkTurboJson(JSON.stringify({ remoteCache: { signature: true }, ...flags }))).toEqual(
      [],
    );
    expect(checkTurboJson("{")).toHaveLength(1);
  });
});

describe("checkWorkflow (key only on main)", () => {
  const withCheckEnv = (extra: string): string =>
    KEY_ONLY_ON_MAIN_CI.replace(
      `      TURBO_CACHE: ${WRITER_CACHE}\n`,
      `      TURBO_CACHE: ${WRITER_CACHE}\n${extra}`,
    );

  it("passes the canonical shape and names the writer", () => {
    const v = checkWorkflow(".github/workflows/ci.yml", KEY_ONLY_ON_MAIN_CI, SCRIPTS);
    expect(v.violations).toEqual([]);
    expect(v.writerJobs).toEqual(["ci.yml#check"]);
    expect(v.holdsToken).toBe(true);
    expect(v.turboLines).toBe(3);
  });
  it("admits the literal environment name only in a push-to-[main]-only workflow", () => {
    const pushOnly = `on:\n  push:\n    branches: [main]\njobs:\n  w:\n    environment: turbo-cache-writer\n    env:\n      TURBO_TOKEN: \${{ secrets.TURBO_WRITER_TOKEN }}\n    steps:\n      - run: pnpm build\n`;
    expect(checkWorkflow("w.yml", pushOnly, SCRIPTS).violations).toEqual([]);
    const tags = pushOnly.replace(
      "    branches: [main]\n",
      "    branches: [main]\n    tags: ['v*']\n",
    );
    expect(checkWorkflow("w.yml", tags, SCRIPTS).violations.join()).toMatch(/turbo-cache-writer/);
    const mq = pushOnly.replace("on:\n", "on:\n  merge_group:\n");
    expect(checkWorkflow("w.yml", mq, SCRIPTS).violations.join()).toMatch(/turbo-cache-writer/);
    const widened = KEY_ONLY_ON_MAIN_CI.replace(
      "github.event_name == 'push' && github.ref == 'refs/heads/main' && 'turbo-cache-writer'",
      "github.ref == 'refs/heads/main' && 'turbo-cache-writer'",
    );
    expect(checkWorkflow("ci.yml", widened, SCRIPTS).violations.join()).toMatch(
      /turbo-cache-writer/,
    );
  });
  it("the writer takes only the environment-only secret names", () => {
    const legacy = KEY_ONLY_ON_MAIN_CI.replace("secrets.TURBO_WRITER_TOKEN", "secrets.TURBO_TOKEN");
    expect(checkWorkflow("ci.yml", legacy, SCRIPTS).violations.join()).toMatch(
      /TURBO_WRITER_TOKEN/,
    );
  });
  it("the writer's TURBO_CACHE is still held to main + a trusted event", () => {
    const text = KEY_ONLY_ON_MAIN_CI.replace(
      `TURBO_CACHE: ${WRITER_CACHE}`,
      "TURBO_CACHE: ${{ github.ref == 'refs/heads/main' && 'local:rw,remote:rw' || 'local:rw' }}",
    );
    expect(checkWorkflow("ci.yml", text, SCRIPTS).violations.join()).toMatch(/pull_request_target/);
  });
  it("flags a remote-writing TURBO_CACHE, flag or variable on a non-writer job", () => {
    const lint = (extra: string, run = "pnpm build"): string =>
      KEY_ONLY_ON_MAIN_CI.replace(
        "  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm build\n",
        `  lint:\n    runs-on: ubuntu-latest\n${extra}    steps:\n      - run: ${run}\n`,
      );
    const bad = (t: string): string => checkWorkflow("ci.yml", t, SCRIPTS).violations.join();
    expect(bad(lint("    env:\n      TURBO_CACHE: local:rw,remote:rw\n"))).toMatch(/TURBO_CACHE/);
    expect(bad(lint("    env:\n      TURBO_CACHE: ${{ vars.X }}\n"))).toMatch(/TURBO_CACHE/);
    expect(bad(lint("    env: ${{ fromJSON(vars.E) }}\n"))).toMatch(/expression/);
    expect(bad(lint("", "pnpm build --force"))).toMatch(/--force/);
    expect(bad(lint("", "pnpm turbo run lint --remote-only"))).toMatch(/--remote-only/);
    expect(bad(lint("", "turbo run lint --remote-cache-read-only=false"))).toMatch(
      /read-only=false/,
    );
    expect(bad(lint("", "TURBO_CACHE=remote:rw pnpm build"))).toMatch(/shell assignment/);
    expect(bad(lint("", "export TURBO_REMOTE_ONLY=1"))).toMatch(/TURBO_REMOTE_ONLY/);
    expect(bad(lint("", "TURBO_TOKEN=$T pnpm build"))).toMatch(/TURBO_TOKEN/);
    expect(
      bad(lint("", "cat >> $GITHUB_ENV <<EOF\n          TURBO_FORCE=1\n          EOF")),
    ).toMatch(/GITHUB_ENV/);
    expect(
      bad(lint("    container:\n      image: node\n      env:\n        TURBO_FORCE: 1\n")),
    ).toMatch(/container\.env\.TURBO_FORCE/);
    // Harmless look-alikes stay green.
    expect(bad(lint("", "git push --force"))).toBe("");
    expect(bad(lint("", "pnpm exec turbo run lint --cache-dir=.turbo --cache=local:rw"))).toBe("");
  });
  it("signing switched off is flagged anywhere, the writer included", () => {
    expect(
      checkWorkflow(
        "ci.yml",
        withCheckEnv("      TURBO_SIGNATURE: 'false'\n"),
        SCRIPTS,
      ).violations.join(),
    ).toMatch(/signing OFF/);
  });
  it("unparseable YAML and duplicate keys fail closed", () => {
    expect(checkWorkflow("x.yml", "on: [push\njobs: {", SCRIPTS).violations.join()).toMatch(
      /not parseable/,
    );
    expect(
      checkWorkflow(
        "x.yml",
        "on: push\njobs:\n  a:\n    env:\n      TURBO_CACHE: local:rw\n      TURBO_CACHE: remote:rw\n",
        SCRIPTS,
      ).violations.join(),
    ).toMatch(/not parseable/);
  });
  it("ignores a workflow without turbo, and YAML comments", () => {
    const v = checkWorkflow("x.yml", "on:\n  push:\n# TURBO_CACHE: remote:rw\njobs: {}\n", SCRIPTS);
    expect(v.violations).toEqual([]);
    expect(v.holdsToken).toBe(false);
  });
});

describe("checkPrePush / checkPackageScripts", () => {
  it("requires the hook to pin a non-writing TURBO_CACHE", () => {
    expect(checkPrePush("pnpm build\n", SCRIPTS).join()).toMatch(/no `export TURBO_CACHE/);
    expect(checkPrePush("export TURBO_CACHE=local:rw,remote:rw\n", SCRIPTS).join()).toMatch(
      /writes the remote/,
    );
    expect(checkPrePush("export TURBO_CACHE=local:rw\npnpm build\n", SCRIPTS)).toEqual([]);
    expect(
      checkPrePush("export TURBO_CACHE=local:rw\npnpm turbo run test --force\n", SCRIPTS).join(),
    ).toMatch(/--force/);
  });
  it("rejects a remote-writing flag in a root script", () => {
    expect(
      checkPackageScripts(JSON.stringify({ scripts: { build: "turbo run build --force" } })),
    ).toHaveLength(1);
    expect(
      checkPackageScripts(
        JSON.stringify({ scripts: { b: "npx turbo@2 run build --cache=remote:rw" } }),
      ),
    ).toHaveLength(1);
    expect(checkPackageScripts(JSON.stringify({ scripts: { build: "turbo run build" } }))).toEqual(
      [],
    );
  });
});

describe("runTurboRemoteCacheGate CLI", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const fixture = (opts: { signature: boolean; writer: boolean; hookPin: boolean }): string => {
    const d = mkdtempSync(join(tmpdir(), "turbo-gate-"));
    dirs.push(d);
    mkdirSync(join(d, ".github", "workflows"), { recursive: true });
    mkdirSync(join(d, ".husky"), { recursive: true });
    writeFileSync(
      join(d, "turbo.json"),
      JSON.stringify(
        opts.signature
          ? {
              tasks: {},
              remoteCache: { signature: true },
              futureFlags: { longerSignatureKey: true },
            }
          : { tasks: {} },
      ),
    );
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({ scripts: { build: "turbo run build" } }),
    );
    writeFileSync(
      join(d, ".husky", "pre-push"),
      `${opts.hookPin ? "export TURBO_CACHE=local:rw\n" : ""}pnpm build\n`,
    );
    writeFileSync(
      join(d, ".github", "workflows", "ci.yml"),
      opts.writer
        ? KEY_ONLY_ON_MAIN_CI
        : KEY_ONLY_ON_MAIN_CI.replace(`    environment: ${WRITER_ENV}\n`, ""),
    );
    writeFileSync(join(d, ".github", "workflows", "other.yml"), "on:\n  push:\njobs: {}\n");
    return d;
  };
  const cli = (d: string) =>
    spawnSync("npx", ["tsx", "scripts/check-turbo-remote-cache.ts", "--root", d], {
      cwd: ROOT,
      encoding: "utf8",
    });

  it("is green on a compliant repository and discloses its aperture", () => {
    const d = fixture({ signature: true, writer: true, hookPin: true });
    const r = runTurboRemoteCacheGate(d);
    expect(r.violations).toEqual([]);
    expect(r.workflows).toBe(2);
    expect(r.tokenHolders).toEqual(["ci.yml"]);
    const out = cli(d);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/2 workflow\(s\), 2 job\(s\) parsed as YAML/);
    expect(out.stdout).toMatch(/ci\.yml#check/);
    expect(out.stdout).toMatch(/npx turbo@x/);
    expect(out.stdout).toMatch(/\$GITHUB_ENV/);
    expect(out.stdout).toMatch(/Not examined/);
  });

  it("goes red — with a repair instruction — for each broken half", () => {
    expect(
      runTurboRemoteCacheGate(fixture({ signature: false, writer: true, hookPin: true }))
        .violations,
    ).toHaveLength(2);
    // Without the writer environment the job's token and key are violations.
    expect(
      runTurboRemoteCacheGate(fixture({ signature: true, writer: false, hookPin: true })).violations
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      runTurboRemoteCacheGate(fixture({ signature: true, writer: true, hookPin: false }))
        .violations,
    ).toHaveLength(1);
    const out = cli(fixture({ signature: false, writer: false, hookPin: false }));
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/Fix:/);
    expect(out.stderr).toMatch(/turbo-cache-writer/);
  });
});

// ── "Key only on main" (operator decision 2026-09-30) ───────────────────────
//
// The signing key and the write-capable token live ONLY in the protected
// `turbo-cache-writer` environment (deployment branches: main). A job may
// hold them only if it references that environment AND the reference can
// only resolve on a push to main. Every other job — pull_request,
// merge_group, any non-main ref — holds no token and no key and never
// writes (local cache only). Each fixture below is an escape the
// 9b405695a gate passed (green under the old gate and actionlint).

const WRITER_ENV =
  "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'turbo-cache-writer' || '' }}";
const WRITER_CACHE =
  "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'local:rw,remote:rw' || 'local:rw' }}";

/** The canonical "key only on main" CI workflow. */
const KEY_ONLY_ON_MAIN_CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
env:
  TURBO_TEAM: \${{ vars.TURBO_TEAM }}
jobs:
  check:
    runs-on: ubuntu-latest
    environment: ${WRITER_ENV}
    env:
      TURBO_TOKEN: \${{ secrets.TURBO_WRITER_TOKEN }}
      TURBO_REMOTE_CACHE_SIGNATURE_KEY: \${{ secrets.TURBO_WRITER_SIGNATURE_KEY }}
      TURBO_CACHE: ${WRITER_CACHE}
    steps:
      - run: pnpm build
      - run: pnpm exec turbo run test:coverage --concurrency=4
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm build
`;

/** A pull_request workflow with NO turbo credentials: the base every escape is added to. */
const prWorkflow = (jobExtra: string, run = "pnpm build"): string =>
  `name: PR\non:\n  pull_request:\n    branches: [main]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n${jobExtra}    steps:\n      - run: ${run}\n`;

describe("key only on main — the escapes the 9b405695a gate missed (C2, C3)", () => {
  it("control: the credential-free PR base and the canonical writer workflow are green", () => {
    expect(checkWorkflow("pr.yml", prWorkflow(""), SCRIPTS).violations).toEqual([]);
    expect(checkWorkflow("ci.yml", KEY_ONLY_ON_MAIN_CI, SCRIPTS).violations).toEqual([]);
  });

  it("C2.1 a one-line job-level flow-map env writing the remote cache", () => {
    const text = prWorkflow('    env: { TURBO_CACHE: "local:rw,remote:rw" }\n');
    expect(checkWorkflow("pr.yml", text, SCRIPTS).violations.join("\n")).toMatch(/TURBO_CACHE/);
  });

  it('C2.2 a quoted "TURBO_CACHE": key', () => {
    const text = prWorkflow('    env:\n      "TURBO_CACHE": local:rw,remote:rw\n');
    expect(checkWorkflow("pr.yml", text, SCRIPTS).violations.join("\n")).toMatch(/TURBO_CACHE/);
  });

  it("C2.3a turbo invoked as `npx turbo@2.10.9 run … --cache=…remote:rw`", () => {
    const text = prWorkflow("", "npx turbo@2.10.9 run build --cache=local:rw,remote:rw");
    expect(checkWorkflow("pr.yml", text, SCRIPTS).violations.join("\n")).toMatch(/--cache/);
  });

  it("C2.3b turbo invoked as `./node_modules/.bin/turbo run … --cache=…remote:rw`", () => {
    const text = prWorkflow("", "./node_modules/.bin/turbo run build --cache=local:rw,remote:rw");
    expect(checkWorkflow("pr.yml", text, SCRIPTS).violations.join("\n")).toMatch(/--cache/);
  });

  it('C2.4 `echo "TURBO_CACHE=$X" >> $GITHUB_ENV`', () => {
    const text = prWorkflow("", 'echo "TURBO_CACHE=$X" >> $GITHUB_ENV');
    expect(checkWorkflow("pr.yml", text, SCRIPTS).violations.join("\n")).toMatch(/GITHUB_ENV/);
  });

  it("TURBO_FORCE (a quoted key the old line regex could not see) overrides a read-only TURBO_CACHE", () => {
    const text = prWorkflow('    env:\n      "TURBO_FORCE": "true"\n');
    expect(checkWorkflow("pr.yml", text, SCRIPTS).violations.join("\n")).toMatch(/TURBO_FORCE/);
  });

  it("a --cache flag on a continuation line overrides a read-only TURBO_CACHE", () => {
    const text = `name: PR\non:\n  pull_request:\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          pnpm exec turbo run build \\\n            --cache=local:rw,remote:rw\n`;
    expect(checkWorkflow("pr.yml", text, SCRIPTS).violations.join("\n")).toMatch(/--cache/);
  });

  it("C3 a pull_request job that references the writer environment", () => {
    const text = prWorkflow("    environment: turbo-cache-writer\n");
    expect(checkWorkflow("pr.yml", text, SCRIPTS).violations.join("\n")).toMatch(
      /turbo-cache-writer/,
    );
    const mapped = prWorkflow("    environment:\n      name: turbo-cache-writer\n");
    expect(checkWorkflow("pr.yml", mapped, SCRIPTS).violations.join("\n")).toMatch(
      /turbo-cache-writer/,
    );
  });

  it("C3 the 9b405695a shape: workflow-level secret env hands the token and key to every job", () => {
    const text = `name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\nenv:\n  TURBO_TOKEN: \${{ secrets.TURBO_TOKEN }}\n  TURBO_REMOTE_CACHE_SIGNATURE_KEY: \${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}\n  TURBO_CACHE: ${GOOD_CI}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm build\n`;
    expect(checkWorkflow("ci.yml", text, SCRIPTS).violations.join("\n")).toMatch(/TURBO_TOKEN/);
  });

  it("a job that holds the token without the writer environment", () => {
    const text = prWorkflow("    env:\n      TURBO_TOKEN: ${{ secrets.TURBO_WRITER_TOKEN }}\n");
    expect(checkWorkflow("pr.yml", text, SCRIPTS).violations.join("\n")).toMatch(/TURBO_TOKEN/);
  });
});

describe("key only on main — repository fixtures", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const repo = (opts: { turbo?: object; workflows: Record<string, string> }): string => {
    const d = mkdtempSync(join(tmpdir(), "turbo-gate-kom-"));
    dirs.push(d);
    mkdirSync(join(d, ".github", "workflows"), { recursive: true });
    mkdirSync(join(d, ".husky"), { recursive: true });
    writeFileSync(
      join(d, "turbo.json"),
      JSON.stringify(
        opts.turbo ?? {
          tasks: {},
          remoteCache: { signature: true },
          futureFlags: { longerSignatureKey: true },
        },
      ),
    );
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({ scripts: { build: "turbo run build" } }),
    );
    writeFileSync(join(d, ".husky", "pre-push"), "export TURBO_CACHE=local:rw\npnpm build\n");
    for (const [f, t] of Object.entries(opts.workflows)) {
      writeFileSync(join(d, ".github", "workflows", f), t);
    }
    return d;
  };
  const PUBLISH = `name: Publish\non:\n  workflow_dispatch:\nenv:\n  TURBO_CACHE: local:rw\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm build\n`;

  it("is green on the key-only-on-main shape and names the writer jobs", () => {
    const r = runTurboRemoteCacheGate(
      repo({ workflows: { "ci.yml": KEY_ONLY_ON_MAIN_CI, "publish.yml": PUBLISH } }),
    );
    expect(r.violations).toEqual([]);
    expect(r.writerJobs).toEqual(["ci.yml#check"]);
  });

  it("C1: turbo.json without futureFlags.longerSignatureKey is red", () => {
    const r = runTurboRemoteCacheGate(
      repo({
        turbo: { tasks: {}, remoteCache: { signature: true } },
        workflows: { "ci.yml": KEY_ONLY_ON_MAIN_CI },
      }),
    );
    expect(r.violations.join("\n")).toMatch(/longerSignatureKey/);
  });

  it("publish/release never read the remote cache: remote:r in publish.yml is red", () => {
    const readsRemote = PUBLISH.replace("TURBO_CACHE: local:rw", "TURBO_CACHE: local:rw,remote:r");
    const r = runTurboRemoteCacheGate(
      repo({ workflows: { "ci.yml": KEY_ONLY_ON_MAIN_CI, "publish.yml": readsRemote } }),
    );
    expect(r.violations.join("\n")).toMatch(/publish\.yml/);
    const noPin = PUBLISH.replace("env:\n  TURBO_CACHE: local:rw\n", "");
    expect(
      runTurboRemoteCacheGate(
        repo({ workflows: { "ci.yml": KEY_ONLY_ON_MAIN_CI, "publish.yml": noPin } }),
      ).violations.join("\n"),
    ).toMatch(/publish\.yml/);
  });
});

describe("this repository", () => {
  it("passes check-turbo-remote-cache with the key only on main", () => {
    const r = runTurboRemoteCacheGate(ROOT);
    expect(r.violations).toEqual([]);
    // Only ci.yml's `check` job, on a push to main, holds the writer
    // environment; publish.yml and release.yml hold no turbo credential.
    expect(r.writerJobs).toEqual(["ci.yml#check"]);
    expect(r.tokenHolders).not.toContain("publish.yml");
    expect(r.tokenHolders).not.toContain("release.yml");
  });
});
