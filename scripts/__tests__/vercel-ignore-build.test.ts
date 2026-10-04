/**
 * scripts/vercel-ignore-build.sh — the Vercel "Ignored Build Step" every
 * motebit Vercel project routes through (held by check-vercel-ignore-build).
 * Vercel semantics: exit 0 = SKIP, exit 1 = BUILD.
 *
 * Runs the real script in a throwaway git repo. The fixture git is isolated:
 * every inherited GIT_* variable is scrubbed (a hook or worktree env would
 * otherwise point it at the motebit repo), GIT_CEILING_DIRECTORIES stops
 * discovery above the fixture, and HOME / system config are neutralised.
 *
 * The incident shape (#1012 → 42ce27f): a production build whose previous
 * deployment SHA has the same watched paths as the new commit was canceled.
 * Production must build whatever the diff says.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "vercel-ignore-build.sh");
const WATCHED = ["services/proxy", "packages/crypto", "pnpm-lock.yaml"];
/** The watch file as the vercel.json passes it: relative to the Root Directory. */
const WATCH_ARGS = ["--watch", "../../scripts/vercel-watch/proxy.txt"];

let root: string;
let fakeBin: string;
let base: string; // initial commit
let unrelated: string; // base + change outside the watched paths
let watchedChange: string; // unrelated + change inside services/proxy

function cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || k.startsWith("VERCEL")) continue;
    env[k] = v;
  }
  env["GIT_CEILING_DIRECTORIES"] = dirname(root);
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["HOME"] = root;
  env["GIT_AUTHOR_NAME"] = "fixture";
  env["GIT_AUTHOR_EMAIL"] = "fixture@example.invalid";
  env["GIT_COMMITTER_NAME"] = "fixture";
  env["GIT_COMMITTER_EMAIL"] = "fixture@example.invalid";
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: cleanEnv(), encoding: "utf8" }).trim();
}

function commitFile(path: string, body: string): string {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
  git("add", "-A");
  git("commit", "-q", "-m", `touch ${path}`);
  return git("rev-parse", "HEAD");
}

/** Runs the script from services/proxy — Vercel runs it from the Root Directory. */
function run(env: Record<string, string | undefined>, args: string[] = WATCH_ARGS): number {
  const r = spawnSync("sh", [SCRIPT, ...args], {
    cwd: join(root, "services/proxy"),
    env: cleanEnv(env),
    encoding: "utf8",
  });
  return r.status ?? -1;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "vercel-ignore-"));
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "services/proxy"), { recursive: true });
  writeFileSync(join(root, "services/proxy/index.ts"), "v1\n");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lock\n");
  mkdirSync(join(root, "packages/crypto"), { recursive: true });
  writeFileSync(join(root, "packages/crypto/index.ts"), "crypto\n");
  mkdirSync(join(root, "scripts/vercel-watch"), { recursive: true });
  writeFileSync(
    join(root, "scripts/vercel-watch/proxy.txt"),
    `# watched paths, repo-root relative\n${WATCHED.join("\n")}\n`,
  );
  base = commitFile("README.md", "readme\n");
  unrelated = commitFile("apps/web/page.ts", "web\n");
  watchedChange = commitFile("services/proxy/index.ts", "v2 security fix\n");
  fakeBin = join(root, ".fake-bin");
  mkdirSync(fakeBin);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeNpx(exitCode: number): string {
  const npx = join(fakeBin, "npx");
  writeFileSync(npx, `#!/bin/sh\nexit ${exitCode}\n`);
  chmodSync(npx, 0o755);
  return `${fakeBin}:${process.env["PATH"] ?? ""}`;
}

describe("vercel-ignore-build.sh — production is never skipped", () => {
  it("builds on production even with no diff in the watched paths", () => {
    expect(
      run({
        VERCEL_ENV: "production",
        VERCEL_GIT_PREVIOUS_SHA: base,
        VERCEL_GIT_COMMIT_SHA: unrelated,
      }),
    ).toBe(1);
  });

  it("INCIDENT shape: previous sha has the same watched paths as the new commit → production builds", () => {
    // The previous deployment's commit IS the new commit's watched tree (same
    // sha is the extreme of "watched paths equal"); the old inline
    // `git diff --quiet` ignoreCommand exited 0 here and canceled the deploy.
    expect(
      run({
        VERCEL_ENV: "production",
        VERCEL_GIT_PREVIOUS_SHA: watchedChange,
        VERCEL_GIT_COMMIT_SHA: watchedChange,
      }),
    ).toBe(1);
    expect(
      run({
        VERCEL_ENV: "production",
        VERCEL_GIT_PREVIOUS_SHA: base,
        VERCEL_GIT_COMMIT_SHA: unrelated,
      }),
    ).toBe(1);
  });

  it("builds when VERCEL_ENV is unset or any non-preview value", () => {
    const shas = { VERCEL_GIT_PREVIOUS_SHA: base, VERCEL_GIT_COMMIT_SHA: unrelated };
    expect(run({ ...shas, VERCEL_ENV: undefined })).toBe(1);
    expect(run({ ...shas, VERCEL_ENV: "development" })).toBe(1);
    expect(run({ ...shas, VERCEL_ENV: "Production" })).toBe(1);
  });

  it("builds on production in --turbo-ignore mode without consulting turbo-ignore", () => {
    expect(
      run({ VERCEL_ENV: "production", PATH: fakeNpx(0) }, ["--turbo-ignore", "@motebit/docs"]),
    ).toBe(1);
  });
});

describe("vercel-ignore-build.sh — preview skips only when proven safe", () => {
  it("skips a preview with no change in the watched paths", () => {
    expect(
      run({
        VERCEL_ENV: "preview",
        VERCEL_GIT_PREVIOUS_SHA: base,
        VERCEL_GIT_COMMIT_SHA: unrelated,
      }),
    ).toBe(0);
  });

  it("builds a preview with a change in a watched path (paths are repo-root relative, run from the Root Directory)", () => {
    expect(
      run({
        VERCEL_ENV: "preview",
        VERCEL_GIT_PREVIOUS_SHA: unrelated,
        VERCEL_GIT_COMMIT_SHA: watchedChange,
      }),
    ).toBe(1);
  });

  it("builds a preview when VERCEL_GIT_PREVIOUS_SHA is unset or empty (a branch's first deploy)", () => {
    // First deploy of a branch: Vercel has no previous sha. Diffing against
    // HEAD^ would skip a 2-commit PR whose tip only touches README even though
    // its first commit changed a watched path — so no previous sha builds.
    // Probe: COMMIT = unrelated, HEAD^..unrelated has no watched change.
    expect(run({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: unrelated })).toBe(1);
    expect(
      run({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: "", VERCEL_GIT_COMMIT_SHA: unrelated }),
    ).toBe(1);
    expect(run({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: watchedChange })).toBe(1);
  });

  it("builds a preview whose previous sha is unknown (shallow clone)", () => {
    expect(
      run({
        VERCEL_ENV: "preview",
        VERCEL_GIT_PREVIOUS_SHA: "0123456789abcdef0123456789abcdef01234567",
        VERCEL_GIT_COMMIT_SHA: unrelated,
      }),
    ).toBe(1);
  });

  it("builds a preview with no commit sha, or no watched paths", () => {
    expect(run({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: base })).toBe(1);
    expect(
      run(
        { VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: base, VERCEL_GIT_COMMIT_SHA: unrelated },
        [],
      ),
    ).toBe(1);
  });
});

describe("vercel-ignore-build.sh — the watch file (#1027: an inline path list overflowed Vercel's 256-char ignoreCommand)", () => {
  /** A preview with no watched change (set in beforeAll: the SHAs exist only after the fixture). */
  let skippable: Record<string, string>;
  beforeAll(() => {
    skippable = {
      VERCEL_ENV: "preview",
      VERCEL_GIT_PREVIOUS_SHA: base,
      VERCEL_GIT_COMMIT_SHA: unrelated,
    };
  });
  const withWatch = (name: string, body: string | null): string[] => {
    const p = join(root, "scripts/vercel-watch", name);
    if (body != null) writeFileSync(p, body);
    return ["--watch", `../../scripts/vercel-watch/${name}`];
  };

  it("control: the committed-shape watch file skips an irrelevant preview", () => {
    expect(run(skippable)).toBe(0);
  });

  it("builds on production with a watch file", () => {
    expect(run({ ...skippable, VERCEL_ENV: "production" })).toBe(1);
  });

  it("builds when the watch file is missing, empty or only comments", () => {
    expect(run(skippable, withWatch("missing.txt", null))).toBe(1);
    expect(run(skippable, withWatch("empty.txt", ""))).toBe(1);
    expect(run(skippable, withWatch("comments.txt", "# nothing\n\n"))).toBe(1);
    expect(run(skippable, ["--watch"])).toBe(1);
    expect(run(skippable, [...WATCH_ARGS, "extra"])).toBe(1);
  });

  it("builds when a watched path does not exist at the commit (a typo would diff nothing and skip)", () => {
    expect(run(skippable, withWatch("typo.txt", "services/proxyy\npnpm-lock.yaml\n"))).toBe(1);
    expect(run(skippable, withWatch("crlf.txt", "services/proxy\r\npnpm-lock.yaml\r\n"))).toBe(1);
    expect(run(skippable, withWatch("abs.txt", "/services/proxy\n"))).toBe(1);
  });

  it("builds a preview whose change is in a path listed in the watch file", () => {
    expect(
      run({
        VERCEL_ENV: "preview",
        VERCEL_GIT_PREVIOUS_SHA: unrelated,
        VERCEL_GIT_COMMIT_SHA: watchedChange,
      }),
    ).toBe(1);
  });

  it("builds for the retired inline-path form (the list lives only in a watch file)", () => {
    expect(run(skippable, WATCHED)).toBe(1);
  });

  it("--turbo-ignore: skips only when turbo-ignore exits 0; any other exit builds", () => {
    const args = ["--turbo-ignore", "@motebit/docs"];
    expect(run({ VERCEL_ENV: "preview", PATH: fakeNpx(0) }, args)).toBe(0);
    expect(run({ VERCEL_ENV: "preview", PATH: fakeNpx(1) }, args)).toBe(1);
    expect(run({ VERCEL_ENV: "preview", PATH: fakeNpx(7) }, args)).toBe(1);
    expect(run({ VERCEL_ENV: "preview", PATH: fakeNpx(0) }, ["--turbo-ignore"])).toBe(1);
  });
});
