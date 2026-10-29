/**
 * The repo-task Node adapters against a real temporary git repository:
 * the tree reader sees only the tip's tree (never the worktree), the writer
 * refuses symlink components and anything outside the worktree, the receipt
 * file sink is durable and append-only — and a whole run over them writes
 * exactly the allowed file and records every receipt.
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
import { createWorktreeWriter } from "../worktree-writer.js";

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

describe("worktree writer: by real path, never through a symlink", () => {
  it("writes a new allowed file 0644 in an existing directory", async () => {
    const writer = createWorktreeWriter({ root: repo });
    expect(await writer.write("docs/b.md", new TextEncoder().encode("b\n"))).toEqual({
      ok: true,
    });
    expect(fs.readFileSync(path.join(repo, "docs", "b.md"), "utf8")).toBe("b\n");
    expect(fs.statSync(path.join(repo, "docs", "b.md")).mode & 0o777).toBe(0o644);
  });

  it("refuses a path under a missing directory and creates none", async () => {
    const writer = createWorktreeWriter({ root: repo });
    expect(await writer.write("docs/new/b.md", new TextEncoder().encode("b\n"))).toEqual({
      ok: false,
      refusal: "missing_directory",
    });
    expect(fs.existsSync(path.join(repo, "docs", "new"))).toBe(false);
  });

  it("refuses a symlinked directory component and leaves the target untouched", async () => {
    const writer = createWorktreeWriter({ root: repo });
    expect(await writer.write("escape/secret.txt", new TextEncoder().encode("pwned"))).toEqual({
      ok: false,
      refusal: "symlink_component",
    });
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("outside\n");
  });

  it("refuses a symlink as the final component", async () => {
    const writer = createWorktreeWriter({ root: repo });
    expect(await writer.write("link", new TextEncoder().encode("x"))).toEqual({
      ok: false,
      refusal: "symlink_component",
    });
    expect(fs.readFileSync(path.join(repo, "docs", "a.md"), "utf8")).toBe(
      "edited in the worktree\n",
    );
  });

  it("refuses a directory at the path and a file as a directory component", async () => {
    const writer = createWorktreeWriter({ root: repo });
    expect(await writer.write("docs", new TextEncoder().encode("x"))).toEqual({
      ok: false,
      refusal: "not_a_regular_file",
    });
    expect(await writer.write("docs/a.md/x", new TextEncoder().encode("x"))).toEqual({
      ok: false,
      refusal: "not_a_regular_file",
    });
  });

  it("refuses traversal, absolute and .git spellings", async () => {
    const writer = createWorktreeWriter({ root: repo });
    for (const p of ["../outside/secret.txt", "/etc/x", "docs/../../x", ".git/config", "a\\b"]) {
      expect(await writer.write(p, new TextEncoder().encode("x"))).toEqual({
        ok: false,
        refusal: "outside_worktree",
      });
    }
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("outside\n");
  });

  it("refuses a name that exists only under another case (no case-variant match)", async () => {
    fs.mkdirSync(path.join(repo, "Upper"));
    fs.writeFileSync(path.join(repo, "Upper", "B.md"), "upper\n");
    fs.writeFileSync(path.join(repo, "docs", "C.md"), "capital\n");
    const caseInsensitive = fs.existsSync(path.join(repo, "UPPER"));
    const writer = createWorktreeWriter({ root: repo });
    const dirVariant = await writer.write("upper/b.md", new TextEncoder().encode("x"));
    const nameVariant = await writer.write("docs/c.md", new TextEncoder().encode("x"));
    if (caseInsensitive) {
      expect(dirVariant).toEqual({ ok: false, refusal: "case_variant" });
      expect(nameVariant).toEqual({ ok: false, refusal: "case_variant" });
    } else {
      // A case-sensitive filesystem: the lowercase names are other paths.
      expect(dirVariant).toEqual({ ok: false, refusal: "missing_directory" });
      expect(nameVariant).toEqual({ ok: true });
    }
    expect(fs.readFileSync(path.join(repo, "Upper", "B.md"), "utf8")).toBe("upper\n");
    expect(fs.readFileSync(path.join(repo, "docs", "C.md"), "utf8")).toBe("capital\n");
  });

  it("refuses a file with a second hard link (the other name could be outside)", async () => {
    fs.writeFileSync(path.join(outside, "linked.txt"), "outside original\n");
    fs.linkSync(path.join(outside, "linked.txt"), path.join(repo, "docs", "h.md"));
    const writer = createWorktreeWriter({ root: repo });
    expect(await writer.write("docs/h.md", new TextEncoder().encode("pwned\n"))).toEqual({
      ok: false,
      refusal: "hard_link",
    });
    expect(fs.readFileSync(path.join(outside, "linked.txt"), "utf8")).toBe("outside original\n");
  });

  it("refuses Windows device names in any segment, with any extension, in any case", async () => {
    const writer = createWorktreeWriter({ root: repo });
    for (const p of [
      "docs/con.md",
      "docs/NUL",
      "docs/Aux.tar.gz",
      "docs/com1.txt",
      "lpt9/x.md",
      "docs/prn",
    ]) {
      expect(await writer.write(p, new TextEncoder().encode("x"))).toEqual({
        ok: false,
        refusal: "reserved_name",
      });
    }
    // Lookalikes are ordinary names.
    expect(await writer.write("docs/console.md", new TextEncoder().encode("x"))).toEqual({
      ok: true,
    });
  });

  it("keeps an existing file's mode", async () => {
    const writer = createWorktreeWriter({ root: repo });
    expect(await writer.write("bin/run.sh", new TextEncoder().encode("#!/bin/sh\necho\n"))).toEqual(
      { ok: true },
    );
    expect(fs.statSync(path.join(repo, "bin", "run.sh")).mode & 0o777).toBe(0o755);
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
  it("writes exactly the allowed file, refuses the rest, and records every receipt on disk", async () => {
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
      writer: createWorktreeWriter({ root: repo }),
      receipts: sink,
      runtimeVersion: "test",
    });
    await sink.close();
    expect(result.ended).toBe("model_done");
    expect(fs.readFileSync(path.join(repo, "docs", "a.md"), "utf8")).toBe("the typo\n");
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("outside\n");
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
