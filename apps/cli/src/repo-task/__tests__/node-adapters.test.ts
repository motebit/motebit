/**
 * The repo-task Node adapters against a real temporary git repository:
 * the tree reader sees only the tip's tree (never the worktree), the change
 * stager writes only git objects and builds the change commit on a private
 * index (the worktree, the repository's index and its refs are untouched),
 * the receipt file sink is durable and append-only — and a whole run over
 * them stages exactly the allowed file and records every receipt.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  bytesToHex,
  generateKeypair,
  signDelegation,
  signStandingDelegation,
  subjectBindingDigest,
} from "@motebit/crypto";
import type { StreamingProvider } from "@motebit/ai-core";
import { runRepoTask } from "@motebit/runtime";
import type { RepoTaskScope } from "@motebit/protocol";
import type { AIResponse, ContextPack, ToolCall } from "@motebit/sdk";

import { createGitTreeReader } from "../git-tree-reader.js";
import { createReceiptFileSink, readReceiptFile } from "../receipt-file-sink.js";
import { createGitChangeStager } from "../git-change-stager.js";

let root = "";
let repo = "";
let outside = "";
let tip = "";

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
}
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: gitEnv(), encoding: "utf8" }).trim();
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-task-adapters-")));
  repo = path.join(root, "repo");
  outside = path.join(root, "outside");
  fs.mkdirSync(repo);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(repo, "docs"));
  fs.writeFileSync(path.join(repo, "docs", "a.md"), "teh typo\n");
  fs.mkdirSync(path.join(repo, "bin"));
  fs.writeFileSync(path.join(repo, "bin", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync("docs/a.md", path.join(repo, "link"));
  fs.symlinkSync(outside, path.join(repo, "escape"));
  git("add", "docs/a.md", "bin/run.sh", "link", "escape");
  git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`);
  git("commit", "-q", "-m", "init");
  tip = git("rev-parse", "HEAD");
  // The worktree diverges from the tip: an edit and an untracked file.
  fs.writeFileSync(path.join(repo, "docs", "a.md"), "edited in the worktree\n");
  fs.writeFileSync(path.join(repo, "untracked.md"), "not tracked\n");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("git tree reader: the tip's tree, never the worktree", () => {
  it("reads a tracked blob as committed, not as edited in the worktree", async () => {
    const reader = createGitTreeReader({ gitDir: path.join(repo, ".git"), tip });
    const entry = await reader.lookup("docs/a.md");
    expect(entry).toMatchObject({ kind: "blob", mode: "100644" });
    expect(new TextDecoder().decode(await reader.readBlob(entry!.oid))).toBe("teh typo\n");
  });

  it("reports executables, symlinks, gitlinks and trees by kind", async () => {
    const reader = createGitTreeReader({ gitDir: path.join(repo, ".git"), tip });
    expect(await reader.lookup("bin/run.sh")).toMatchObject({ kind: "blob", mode: "100755" });
    expect(await reader.lookup("link")).toMatchObject({ kind: "symlink", mode: "120000" });
    expect(await reader.lookup("sub")).toMatchObject({ kind: "gitlink", mode: "160000" });
    expect(await reader.lookup("docs")).toMatchObject({ kind: "tree", mode: "040000" });
  });

  it("sees nothing untracked, nothing through a symlinked directory, no glob", async () => {
    const reader = createGitTreeReader({ gitDir: path.join(repo, ".git"), tip });
    expect(await reader.lookup("untracked.md")).toBeNull();
    expect(await reader.lookup("escape/secret.txt")).toBeNull();
    expect(await reader.lookup("docs/*.md")).toBeNull();
    expect(await reader.lookup("docs/a")).toBeNull();
    expect(await reader.lookup("DOCS/a.md")).toBeNull();
    // A directory spelling lists the directory's children: none of them is the path asked for.
    expect(await reader.lookup("docs/")).toBeNull();
  });

  it("lists every tracked path at the tip, as git's bytes", async () => {
    const reader = createGitTreeReader({ gitDir: path.join(repo, ".git"), tip });
    const listed = (await reader.listTrackedPaths()).map((b) => new TextDecoder().decode(b)).sort();
    expect(listed).toEqual(["bin/run.sh", "docs/a.md", "escape", "link", "sub"]);
  });

  it("refuses a tip that is not a full object id", () => {
    expect(() => createGitTreeReader({ gitDir: path.join(repo, ".git"), tip: "HEAD" })).toThrow();
  });
});

/** Every file under `dir` (relative path → bytes, hex), `.git` excluded unless asked. */
function snapshot(dir: string, withGit = false): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (!withGit && rel === ".git") continue;
      if (e.isSymbolicLink()) out.set(rel, `symlink:${fs.readlinkSync(full)}`);
      else if (e.isDirectory()) walk(full);
      else out.set(rel, fs.readFileSync(full).toString("hex"));
    }
  };
  walk(dir);
  return out;
}

/** The repository's own index, HEAD and refs (what a change commit must not move). */
function repoState(): Map<string, string> {
  const gitDir = path.join(repo, ".git");
  const out = new Map<string, string>();
  for (const f of ["index", "HEAD"]) {
    const full = path.join(gitDir, f);
    out.set(f, fs.existsSync(full) ? fs.readFileSync(full).toString("hex") : "absent");
  }
  out.set("refs", git("for-each-ref", "--format=%(refname) %(objectname)"));
  return out;
}

const COMMIT = {
  message: "governed change\n",
  authorName: "motebit-agent",
  authorEmail: "agent@example.com",
  timestamp: 1_900_000_000,
};

describe("git change stager: blobs and a private index, never the worktree", () => {
  it("stages content as blobs and builds the change commit; worktree, index and refs untouched", async () => {
    const before = snapshot(repo);
    const outsideBefore = snapshot(outside);
    const stateBefore = repoState();
    const stager = createGitChangeStager({ gitDir: path.join(repo, ".git"), tip });
    await stager.stage("docs/a.md", new TextEncoder().encode("fixed\n"));
    await stager.stage("docs/new.md", new TextEncoder().encode("new\n"));
    const { headCommit, entries } = await stager.buildChangeCommit(COMMIT);

    // Nothing on disk moved: the worktree, everything outside it, the
    // repository's own index, HEAD and refs are byte-identical.
    expect(snapshot(repo)).toEqual(before);
    expect(snapshot(outside)).toEqual(outsideBefore);
    expect(repoState()).toEqual(stateBefore);

    // The change commit sits on the tip and differs from it only at the
    // staged paths, as 100644 blobs of exactly the staged bytes.
    expect(git("rev-parse", `${headCommit}^`)).toBe(tip);
    const blobOf = (text: string): string =>
      execFileSync("git", ["hash-object", "--stdin"], { cwd: repo, env: gitEnv(), input: text })
        .toString()
        .trim();
    expect(entries).toEqual([
      { path: "docs/a.md", mode: "100644", blob: blobOf("fixed\n") },
      { path: "docs/new.md", mode: "100644", blob: blobOf("new\n") },
    ]);
    const diff = git("diff-tree", "-r", "--no-renames", "--name-status", tip, headCommit);
    expect(diff.split("\n").sort()).toEqual(["A\tdocs/new.md", "M\tdocs/a.md"]);
    expect(git("cat-file", "-p", `${headCommit}:docs/a.md`)).toBe("fixed");
    // Everything else is the tip's, including the symlinks and the gitlink.
    expect(git("rev-parse", `${headCommit}:link`)).toBe(git("rev-parse", `${tip}:link`));
    expect(git("rev-parse", `${headCommit}:bin/run.sh`)).toBe(
      git("rev-parse", `${tip}:bin/run.sh`),
    );
  });

  it("a later stage of the same path replaces the earlier one; an unchanged path is no entry", async () => {
    const stager = createGitChangeStager({ gitDir: path.join(repo, ".git"), tip });
    await stager.stage("docs/a.md", new TextEncoder().encode("first\n"));
    await stager.stage("docs/a.md", new TextEncoder().encode("teh typo\n"));
    const { entries } = await stager.buildChangeCommit(COMMIT);
    expect(entries).toEqual([]);
  });

  it("paths go in as exact bytes: spaces, a leading dash and option-like names are never interpreted", async () => {
    const before = snapshot(repo);
    const stager = createGitChangeStager({ gitDir: path.join(repo, ".git"), tip });
    const names = ["docs/with space.md", "-rf.md", "--output=pwned", "docs/-n"];
    for (const n of names) await stager.stage(n, new TextEncoder().encode(`${n}\n`));
    const { headCommit, entries } = await stager.buildChangeCommit(COMMIT);
    expect(entries.map((e) => e.path).sort()).toEqual([...names].sort());
    for (const n of names) {
      expect(
        execFileSync("git", ["cat-file", "blob", `${headCommit}:${n}`], {
          cwd: repo,
          env: gitEnv(),
        }).toString(),
      ).toBe(`${n}\n`);
    }
    expect(fs.existsSync(path.join(repo, "pwned"))).toBe(false);
    expect(snapshot(repo)).toEqual(before);
  });

  it("refuses a path that is not repository-relative and a tip that is not an object id", async () => {
    const stager = createGitChangeStager({ gitDir: path.join(repo, ".git"), tip });
    await expect(stager.stage("/etc/passwd", new Uint8Array())).rejects.toThrow();
    await expect(stager.stage("a\0b", new Uint8Array())).rejects.toThrow();
    expect(() => createGitChangeStager({ gitDir: path.join(repo, ".git"), tip: "HEAD" })).toThrow();
  });
});

describe("receipt file sink: durable, one run per file", () => {
  it("appends each receipt as a line and refuses to reuse a file", async () => {
    const file = path.join(root, "receipts-1.jsonl");
    const sink = createReceiptFileSink(file);
    await sink.append({ a: 1 } as never);
    await sink.append({ b: 2 } as never);
    await sink.close();
    expect(readReceiptFile(file)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => createReceiptFileSink(file)).toThrow();
  });

  it("rejects an append once the file is closed", async () => {
    const sink = createReceiptFileSink(path.join(root, "receipts-2.jsonl"));
    await sink.close();
    await expect(sink.append({} as never)).rejects.toThrow();
  });
});

describe("a repo-task run over the Node adapters", () => {
  it("stages exactly the allowed file, refuses the rest, writes nothing on disk, and records every receipt", async () => {
    const f = await generateKeypair();
    const a = await generateKeypair();
    const T0 = Date.now();
    const scope: RepoTaskScope = {
      schema: "motebit.repo-task-scope.v1",
      spec: "motebit/repo-task-scope@1.0",
      repo: "motebit/motebit",
      base_ref: "main",
      object_format: "sha1",
      allowed_paths: ["docs/a.md"],
      max_changed_files: 1,
      task: "Fix the typo in docs/a.md.",
    };
    const parties = {
      delegator_id: "f",
      delegator_public_key: bytesToHex(f.publicKey),
      delegate_id: "a",
      delegate_public_key: bytesToHex(a.publicKey),
    };
    const grant = await signStandingDelegation(
      {
        grant_id: "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8",
        ...parties,
        scope: "repo_read_blob,repo_write_path",
        subject: "repo-change",
        subject_binding: {
          schema: "motebit.subject-binding.v1",
          artifact_schema: "motebit.repo-task-scope.v1",
          digest_method: "jcs-sha256-hex",
          digest: await subjectBindingDigest(scope),
        },
        cadence_ms: 3_600_000,
        issued_at: T0 - 1000,
        not_before: null,
        expires_at: T0 - 1000 + 3_600_000,
        max_token_ttl_ms: 3_600_000,
      },
      f.privateKey,
    );
    const tick = await signDelegation(
      {
        ...parties,
        scope: "repo_read_blob,repo_write_path",
        issued_at: T0 - 1000,
        expires_at: T0 - 1000 + 3_600_000,
        grant_id: grant.grant_id,
      },
      f.privateKey,
    );
    const turns: ToolCall[][] = [
      [
        { id: "1", name: "repo_read_blob", args: { path: "docs/a.md" } },
        { id: "2", name: "repo_write_path", args: { path: "escape/secret.txt", content: "x" } },
        { id: "3", name: "repo_write_path", args: { path: "docs/a.md", content: "the typo\n" } },
      ],
    ];
    let n = 0;
    const respond = (): AIResponse => {
      const calls = turns[n++];
      return calls
        ? { text: "", confidence: 1, memory_candidates: [], state_updates: {}, tool_calls: calls }
        : { text: "Fixed.", confidence: 1, memory_candidates: [], state_updates: {} };
    };
    const provider: StreamingProvider = {
      model: "model-1",
      setModel: vi.fn(),
      generate: async (_: ContextPack) => respond(),
      estimateConfidence: async () => 1,
      extractMemoryCandidates: async () => [],
      async *generateStream(_: ContextPack) {
        yield { type: "done" as const, response: respond() };
      },
    };
    const file = path.join(root, "run.jsonl");
    const sink = createReceiptFileSink(file);
    const worktreeBefore = snapshot(repo);
    const outsideBefore = snapshot(outside);
    const stateBefore = repoState();
    const stager = createGitChangeStager({ gitDir: path.join(repo, ".git"), tip });
    const result = await runRepoTask({
      authority: {
        scope,
        grant,
        tick,
        revocations: { set: [], failures: [], readAt: tip },
        principal: { motebit_id: "f", public_key: bytesToHex(f.publicKey) },
        expectedRepo: "motebit/motebit",
        isPathPermitted: () => true,
      },
      agent: {
        motebitId: "a",
        deviceId: "dev-a",
        privateKey: a.privateKey,
        publicKey: a.publicKey,
      },
      provider,
      providerName: "scripted",
      reader: createGitTreeReader({ gitDir: path.join(repo, ".git"), tip }),
      stager,
      receipts: sink,
      runtimeVersion: "test",
    });
    await sink.close();
    expect(result.ended).toBe("model_done");
    // The run wrote nothing on disk: the worktree, outside it, the index and refs.
    expect(snapshot(repo)).toEqual(worktreeBefore);
    expect(snapshot(outside)).toEqual(outsideBefore);
    expect(repoState()).toEqual(stateBefore);
    const { headCommit, entries } = await stager.buildChangeCommit(COMMIT);
    expect(entries.map((e) => [e.path, e.mode])).toEqual([["docs/a.md", "100644"]]);
    expect(git("cat-file", "-p", `${headCommit}:docs/a.md`)).toBe("the typo");
    const onDisk = readReceiptFile(file) as Array<{
      tool_name: string;
      status: string;
      task_id: string;
    }>;
    expect(onDisk.map((r) => [r.tool_name, r.status])).toEqual([
      ["repo_read_blob", "completed"],
      ["repo_write_path", "denied"],
      ["repo_write_path", "completed"],
    ]);
    expect(new Set(onDisk.map((r) => r.task_id))).toEqual(new Set([result.task_id]));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(result.tool_receipts)));
  });
});
