/**
 * ci-diff-base.sh — the diff base under a simulated pull_request and merge_group
 * context, with the env GitHub provides to the step.
 *
 * Builds a throwaway repo shaped like a merge queue: `main` (the base), a PR
 * branch, and a `gh-readonly-queue/main/pr-1-<sha>` commit = the PR merged onto
 * main. Asserts the resolver returns the queue commit's base_sha, that the diff
 * it feeds the diff-scoped required checks is the PR's real change set (never
 * empty), and that every vacuous / wrong-context case fails closed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "..", "ci-diff-base.sh");

let repo = "";
let mainSha = "";
let queueSha = "";
let emptyQueueSha = "";
let strayBase = "";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function run(env: Record<string, string>): { status: number | null; out: string; base: string } {
  const outFile = join(repo, "..", `gh-output-${Math.random().toString(36).slice(2)}`);
  writeFileSync(outFile, "");
  const r = spawnSync("bash", [SCRIPT], {
    cwd: repo,
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GITHUB_OUTPUT: outFile,
      ...env,
    },
  });
  const m = /^base=(.*)$/m.exec(readFileSync(outFile, "utf-8"));
  return { status: r.status, out: r.stdout + r.stderr, base: m?.[1] ?? "<none>" };
}

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "ci-diff-base-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  write("README.md", "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  mainSha = git("rev-parse", "HEAD");

  git("checkout", "-q", "-b", "pr");
  write("scripts/check-x.ts", "export {};\n");
  write("packages/sdk/src/index.ts", "export const x = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "pr change");

  // The queue commit: the PR squashed onto main, on a gh-readonly-queue ref.
  git("checkout", "-q", "-b", "gh-readonly-queue/main/pr-1-abc", "main");
  git("merge", "-q", "--squash", "pr");
  git("commit", "-q", "-m", "queue: pr-1");
  queueSha = git("rev-parse", "HEAD");

  // A queue commit that changes nothing vs its base (a PR already on main).
  git("checkout", "-q", "-b", "gh-readonly-queue/main/pr-2-def", "main");
  git("commit", "-q", "--allow-empty", "-m", "queue: pr-2 (no-op)");
  emptyQueueSha = git("rev-parse", "HEAD");

  // A commit that is not an ancestor of the queue commit.
  git("checkout", "-q", "--orphan", "stray");
  write("other.txt", "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "stray");
  strayBase = git("rev-parse", "HEAD");

  // `origin/main` for the pull_request path.
  git("update-ref", "refs/remotes/origin/main", mainSha);
  git("checkout", "-q", "gh-readonly-queue/main/pr-1-abc");
});

describe("ci-diff-base.sh under merge_group", () => {
  it("resolves the queue commit's base_sha and a non-empty PR diff", () => {
    const r = run({ EVENT_NAME: "merge_group", MG_BASE_SHA: mainSha, MG_HEAD_SHA: queueSha });
    expect(r.status).toBe(0);
    expect(r.base).toBe(mainSha);
    expect(r.out).toContain("2 changed file(s)");
    // What sibling-audit / changes / changeset then diff:
    expect(git("diff", "--name-only", r.base, "HEAD").split("\n").sort()).toEqual([
      "packages/sdk/src/index.ts",
      "scripts/check-x.ts",
    ]);
  });

  it("the old PR-only computation is vacuous here (why the resolver exists)", () => {
    // github.base_ref is empty under merge_group: `origin/...HEAD` is not a diff.
    const old = spawnSync("git", ["diff", "--name-only", "origin/...HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    });
    expect(old.status === 0 && old.stdout.trim() !== "").toBe(false);
  });

  it("fails closed without a base_sha", () => {
    const r = run({ EVENT_NAME: "merge_group", MG_BASE_SHA: "", MG_HEAD_SHA: queueSha });
    expect(r.status).toBe(1);
    expect(r.out).toContain("without github.event.merge_group.base_sha");
  });

  it("fails closed when HEAD is not the queue commit", () => {
    const r = run({ EVENT_NAME: "merge_group", MG_BASE_SHA: mainSha, MG_HEAD_SHA: mainSha });
    expect(r.status).toBe(1);
    expect(r.out).toContain("is not the queue commit");
  });

  it("fails closed when base_sha is absent from the clone (shallow checkout)", () => {
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const r = run({ EVENT_NAME: "merge_group", MG_BASE_SHA: missing, MG_HEAD_SHA: queueSha });
    expect(r.status).toBe(1);
    expect(r.out).toContain("fetch-depth: 0");
  });

  it("fails closed when base_sha is not an ancestor", () => {
    const r = run({ EVENT_NAME: "merge_group", MG_BASE_SHA: strayBase, MG_HEAD_SHA: queueSha });
    expect(r.status).toBe(1);
    expect(r.out).toContain("not an ancestor");
  });

  it("fails closed on an empty queue diff instead of passing vacuously", () => {
    git("checkout", "-q", "gh-readonly-queue/main/pr-2-def");
    try {
      const r = run({
        EVENT_NAME: "merge_group",
        MG_BASE_SHA: mainSha,
        MG_HEAD_SHA: emptyQueueSha,
      });
      expect(r.status).toBe(1);
      expect(r.out).toContain("changes no files");
    } finally {
      git("checkout", "-q", "gh-readonly-queue/main/pr-1-abc");
    }
  });
});

describe("ci-diff-base.sh under pull_request and other events", () => {
  it("pull_request keeps the prior origin/<base_ref>...HEAD semantics (merge-base)", () => {
    git("checkout", "-q", "pr");
    try {
      const r = run({ EVENT_NAME: "pull_request", PR_BASE_REF: "main" });
      expect(r.status).toBe(0);
      expect(r.base).toBe(git("merge-base", "origin/main", "HEAD"));
      expect(git("diff", "--name-only", r.base, "HEAD")).toBe(
        git("diff", "--name-only", "origin/main...HEAD"),
      );
    } finally {
      git("checkout", "-q", "gh-readonly-queue/main/pr-1-abc");
    }
  });

  it("pull_request without a base ref fails closed", () => {
    const r = run({ EVENT_NAME: "pull_request", PR_BASE_REF: "" });
    expect(r.status).toBe(1);
  });

  it("push is not diff-scoped: empty base, exit 0", () => {
    const r = run({ EVENT_NAME: "push" });
    expect(r.status).toBe(0);
    expect(r.base).toBe("");
  });
});
