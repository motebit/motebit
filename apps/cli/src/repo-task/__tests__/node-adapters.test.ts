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
import { createGitChangeStager, gitTimestamp } from "../git-change-stager.js";
import { openIsolatedGit, resolveObjectDirectory } from "../git.js";
import type { IsolatedGit } from "../git.js";

let root = "";
let repo = "";
let outside = "";
let tip = "";
let session: IsolatedGit;

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

beforeAll(async () => {
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
  session = await openIsolatedGit({ gitEntry: path.join(repo, ".git"), objectFormat: "sha1" });
});

afterAll(() => {
  session.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("git tree reader: the tip's tree, never the worktree", () => {
  it("reads a tracked blob as committed, not as edited in the worktree", async () => {
    const reader = createGitTreeReader({ git: session, tip });
    const entry = await reader.lookup("docs/a.md");
    expect(entry).toMatchObject({ kind: "blob", mode: "100644" });
    expect(new TextDecoder().decode(await reader.readBlob(entry!.oid))).toBe("teh typo\n");
  });

  it("reports executables, symlinks, gitlinks and trees by kind", async () => {
    const reader = createGitTreeReader({ git: session, tip });
    expect(await reader.lookup("bin/run.sh")).toMatchObject({ kind: "blob", mode: "100755" });
    expect(await reader.lookup("link")).toMatchObject({ kind: "symlink", mode: "120000" });
    expect(await reader.lookup("sub")).toMatchObject({ kind: "gitlink", mode: "160000" });
    expect(await reader.lookup("docs")).toMatchObject({ kind: "tree", mode: "040000" });
  });

  it("sees nothing untracked, nothing through a symlinked directory, no glob", async () => {
    const reader = createGitTreeReader({ git: session, tip });
    expect(await reader.lookup("untracked.md")).toBeNull();
    expect(await reader.lookup("escape/secret.txt")).toBeNull();
    expect(await reader.lookup("docs/*.md")).toBeNull();
    expect(await reader.lookup("docs/a")).toBeNull();
    expect(await reader.lookup("DOCS/a.md")).toBeNull();
    // A directory spelling lists the directory's children: none of them is the path asked for.
    expect(await reader.lookup("docs/")).toBeNull();
  });

  it("lists every tracked path at the tip, as git's bytes", async () => {
    const reader = createGitTreeReader({ git: session, tip });
    const listed = (await reader.listTrackedPaths()).map((b) => new TextDecoder().decode(b)).sort();
    expect(listed).toEqual(["bin/run.sh", "docs/a.md", "escape", "link", "sub"]);
  });

  it("refuses a tip that is not a full object id", () => {
    expect(() => createGitTreeReader({ git: session, tip: "HEAD" })).toThrow();
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

/** Every entry under a git directory (relative path → content hash or "dir"/"socket"). */
function snapshotGitDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (e.isDirectory()) {
        out.set(rel, "dir");
        walk(full);
      } else if (e.isFile()) out.set(rel, fs.readFileSync(full).toString("base64"));
      else out.set(rel, "special");
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
    const stager = createGitChangeStager({ git: session, tip });
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
    const stager = createGitChangeStager({ git: session, tip });
    await stager.stage("docs/a.md", new TextEncoder().encode("first\n"));
    await stager.stage("docs/a.md", new TextEncoder().encode("teh typo\n"));
    const { entries } = await stager.buildChangeCommit(COMMIT);
    expect(entries).toEqual([]);
  });

  it("paths go in as exact bytes: spaces, a leading dash and option-like names are never interpreted", async () => {
    const before = snapshot(repo);
    const stager = createGitChangeStager({ git: session, tip });
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
    const stager = createGitChangeStager({ git: session, tip });
    await expect(stager.stage("/etc/passwd", new Uint8Array())).rejects.toThrow();
    await expect(stager.stage("a\0b", new Uint8Array())).rejects.toThrow();
    expect(() => createGitChangeStager({ git: session, tip: "HEAD" })).toThrow();
  });
});

describe("git change stager: fail-closed postcondition and timestamps", () => {
  it("staging both a and a/b (a directory/file collision) throws and returns no commit", async () => {
    const stager = createGitChangeStager({ git: session, tip });
    await stager.stage("dfx", new TextEncoder().encode("file\n"));
    await stager.stage("dfx/inner.md", new TextEncoder().encode("inner\n"));
    await expect(stager.buildChangeCommit(COMMIT)).rejects.toThrow(
      /not exactly the staged|missing/,
    );
  });

  it("a path under a tracked file throws (it would delete the file)", async () => {
    const stager = createGitChangeStager({ git: session, tip });
    await stager.stage("docs/a.md/x.md", new TextEncoder().encode("x\n"));
    await expect(stager.buildChangeCommit(COMMIT)).rejects.toThrow(
      /not exactly the staged|missing/,
    );
  });

  it("a path over a tracked symlink or gitlink throws (a type change, not a modify)", async () => {
    for (const p of ["link", "sub"]) {
      const stager = createGitChangeStager({ git: session, tip });
      await stager.stage(p, new TextEncoder().encode("x\n"));
      await expect(stager.buildChangeCommit(COMMIT)).rejects.toThrow(/not exactly the staged/);
    }
  });

  it("a tracked 100755 file is refused by the stager itself (the old mode must be 100644)", async () => {
    const stager = createGitChangeStager({ git: session, tip });
    await stager.stage("bin/run.sh", new TextEncoder().encode("#!/bin/sh\necho changed\n"));
    await expect(stager.buildChangeCommit(COMMIT)).rejects.toThrow(/not exactly the staged/);
  });

  it("a path over a tracked directory throws (it would delete the directory)", async () => {
    const stager = createGitChangeStager({ git: session, tip });
    await stager.stage("docs", new TextEncoder().encode("x\n"));
    await expect(stager.buildChangeCommit(COMMIT)).rejects.toThrow(
      /not exactly the staged|missing/,
    );
  });

  it("the timestamp is integer seconds, formatted as git's @<secs> +0000", async () => {
    expect(gitTimestamp(1_900_000_000)).toBe("@1900000000 +0000");
    for (const bad of [1.5, -1, Number.NaN, 1_900_000_000_000, 2 ** 60]) {
      expect(() => gitTimestamp(bad)).toThrow(/integer seconds/);
    }
    const stager = createGitChangeStager({ git: session, tip });
    await stager.stage("docs/a.md", new TextEncoder().encode("ts\n"));
    await expect(stager.buildChangeCommit({ ...COMMIT, timestamp: Date.now() })).rejects.toThrow(
      /integer seconds/,
    );
    const { headCommit } = await stager.buildChangeCommit(COMMIT);
    expect(git("cat-file", "-p", headCommit)).toContain("> 1900000000 +0000");
  });
});

describe("isolated git: the repository's own config is never read", () => {
  it("a hostile repo config (fsmonitor script and daemon, splitIndex, commitEncoding, include, hooksPath) steers nothing", async () => {
    // A second repository, identical content, with a clean config first.
    const hostile = path.join(root, "hostile");
    fs.mkdirSync(hostile);
    const g = (...args: string[]): string =>
      execFileSync("git", args, {
        cwd: hostile,
        env: { ...gitEnv(), GIT_AUTHOR_DATE: "@1 +0000", GIT_COMMITTER_DATE: "@1 +0000" },
        encoding: "utf8",
      }).trim();
    g("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(hostile, "a.md"), "a\n");
    g("add", "a.md");
    g("commit", "-q", "-m", "init");
    const hostileTip = g("rev-parse", "HEAD");

    const build = async (): Promise<string> => {
      const s2 = await openIsolatedGit({
        gitEntry: path.join(hostile, ".git"),
        objectFormat: "sha1",
      });
      try {
        const reader = createGitTreeReader({ git: s2, tip: hostileTip });
        expect(await reader.lookup("a.md")).toMatchObject({ kind: "blob" });
        await reader.listTrackedPaths();
        const stager = createGitChangeStager({ git: s2, tip: hostileTip });
        await stager.stage("a.md", new TextEncoder().encode("changed\n"));
        return (await stager.buildChangeCommit(COMMIT)).headCommit;
      } finally {
        s2.close();
      }
    };
    const clean = await build();

    // Now the hostile config, set in the repository and in an included file.
    const marker = path.join(root, "fsmonitor-ran");
    const script = path.join(root, "fsmonitor.sh");
    fs.writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    const hooks = path.join(root, "hooks");
    fs.mkdirSync(hooks);
    for (const h of ["pre-commit", "post-commit", "post-index-change", "reference-transaction"]) {
      fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\necho ${h} >> "${marker}"\n`, {
        mode: 0o755,
      });
    }
    const included = path.join(root, "included.config");
    fs.writeFileSync(included, `[core]\n\tfsmonitor = ${script}\n`);
    g("config", "core.splitIndex", "true");
    g("config", "i18n.commitEncoding", "ISO-8859-1");
    g("config", "core.hooksPath", hooks);
    // Not among the pinned keys at all: only the private GIT_DIR keeps it
    // out. Honoured, it would make every new object file and directory
    // unreadable to others (0660 sharing).
    g("config", "core.sharedRepository", "0660");
    g("config", "include.path", included);
    const gitDirBefore = snapshotGitDir(path.join(hostile, ".git"));

    expect(await build()).toBe(clean); // the commit bytes match a clean config's
    g("config", "--unset-all", "include.path");
    g("config", "core.fsmonitor", "true"); // the built-in daemon
    expect(await build()).toBe(clean);

    // New objects under the hostile config (content no clean build made).
    {
      const s3 = await openIsolatedGit({
        gitEntry: path.join(hostile, ".git"),
        objectFormat: "sha1",
      });
      try {
        const stager = createGitChangeStager({ git: s3, tip: hostileTip });
        await stager.stage(
          "fresh.md",
          new TextEncoder().encode("only made under the hostile config\n"),
        );
        await stager.buildChangeCommit(COMMIT);
      } finally {
        s3.close();
      }
    }

    expect(fs.existsSync(marker)).toBe(false); // no script, no hook ever ran
    // No daemon socket, no split-index shard, no file at all in the real
    // .git apart from new objects.
    const after = snapshotGitDir(path.join(hostile, ".git"));
    const added = [...after.keys()].filter(
      (k) => !gitDirBefore.has(k) && !k.startsWith("objects/"),
    );
    expect(added.filter((k) => k !== "config")).toEqual([]);
    for (const [k, v] of gitDirBefore) {
      if (k !== "config") expect(after.get(k), k).toBe(v);
    }
    // core.sharedRepository was never applied: every new object stays
    // readable by others, as git's default (umask 022) makes it.
    const newObjects = [...after.keys()].filter(
      (k) => k.startsWith("objects/") && !gitDirBefore.has(k),
    );
    expect(newObjects.length).toBeGreaterThan(0);
    for (const k of newObjects) {
      const mode = fs.statSync(path.join(hostile, ".git", k)).mode;
      expect(mode & 0o004, `${k} mode ${mode.toString(8)}`).toBe(0o004);
    }
  });
});

describe("isolated git: no git process runs on the real git directory", () => {
  /** A small repository with one commit; returns its dir and tip. */
  function makeRepo(name: string): { dir: string; tip: string; g: (...a: string[]) => string } {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const g = (...args: string[]): string =>
      execFileSync("git", args, {
        cwd: dir,
        env: { ...gitEnv(), GIT_AUTHOR_DATE: "@1 +0000", GIT_COMMITTER_DATE: "@1 +0000" },
        encoding: "utf8",
      }).trim();
    g("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dir, "a.md"), "a\n");
    g("add", "a.md");
    g("commit", "-q", "-m", "init");
    return { dir, tip: g("rev-parse", "HEAD"), g };
  }

  async function readAndStage(gitEntry: string, tip: string): Promise<string> {
    const s2 = await openIsolatedGit({ gitEntry, objectFormat: "sha1" });
    try {
      const reader = createGitTreeReader({ git: s2, tip });
      expect(await reader.lookup("a.md")).toMatchObject({ kind: "blob" });
      const stager = createGitChangeStager({ git: s2, tip });
      await stager.stage("a.md", new TextEncoder().encode("changed\n"));
      return (await stager.buildChangeCommit(COMMIT)).headCommit;
    } finally {
      s2.close();
    }
  }

  it("garbage in .git/config, or an include.path to garbage or to a FIFO, affects nothing", async () => {
    const { dir, tip } = makeRepo("garbage-config");
    const clean = await readAndStage(path.join(dir, ".git"), tip);
    const config = path.join(dir, ".git", "config");
    fs.writeFileSync(config, "[[[ this is not git config \u0000\n");
    expect(await readAndStage(path.join(dir, ".git"), tip)).toBe(clean);
    const garbage = path.join(root, "garbage.inc");
    fs.writeFileSync(garbage, "]]] nope");
    fs.writeFileSync(config, `[include]\n\tpath = ${garbage}\n`);
    expect(await readAndStage(path.join(dir, ".git"), tip)).toBe(clean);
    // A FIFO include would block any git that parsed this config, forever.
    const fifo = path.join(root, "include.fifo");
    execFileSync("mkfifo", [fifo]);
    fs.writeFileSync(config, `[include]\n\tpath = ${fifo}\n`);
    expect(await readAndStage(path.join(dir, ".git"), tip)).toBe(clean);
  });

  it("a linked worktree (.git file plus commondir) works", async () => {
    const { dir, tip, g } = makeRepo("linked");
    const wt = path.join(root, "linked-wt");
    g("worktree", "add", "-q", "--detach", wt, tip);
    expect(fs.lstatSync(path.join(wt, ".git")).isFile()).toBe(true);
    expect(resolveObjectDirectory(path.join(wt, ".git"))).toBe(
      fs.realpathSync(path.join(dir, ".git", "objects")),
    );
    const viaWorktree = await readAndStage(path.join(wt, ".git"), tip);
    expect(await readAndStage(path.join(dir, ".git"), tip)).toBe(viaWorktree);
  });

  it("a symlinked objects directory, a symlinked .git and a malformed .git file are refused", async () => {
    const { dir } = makeRepo("symlinked-objects");
    const moved = path.join(root, "moved-objects");
    fs.renameSync(path.join(dir, ".git", "objects"), moved);
    fs.symlinkSync(moved, path.join(dir, ".git", "objects"));
    expect(() => resolveObjectDirectory(path.join(dir, ".git"))).toThrow(/not a real directory/);
    const linkedGit = path.join(root, "linked-dot-git");
    fs.symlinkSync(path.join(dir, ".git"), linkedGit);
    expect(() => resolveObjectDirectory(linkedGit)).toThrow();
    const badFile = path.join(root, "bad-dot-git");
    fs.writeFileSync(badFile, "gitdir: \n");
    expect(() => resolveObjectDirectory(badFile)).toThrow(/malformed/);
    fs.writeFileSync(badFile, `gitdir:${dir}\n`);
    expect(() => resolveObjectDirectory(badFile)).toThrow(/malformed/);
    await expect(
      openIsolatedGit({ gitEntry: path.join(dir, ".git"), objectFormat: "sha1" }),
    ).rejects.toThrow();
  });

  it("an object format that is not the repository's fails closed at the first lookup", async () => {
    const { dir, tip } = makeRepo("format-mismatch");
    const s2 = await openIsolatedGit({ gitEntry: path.join(dir, ".git"), objectFormat: "sha256" });
    try {
      const reader = createGitTreeReader({ git: s2, tip });
      await expect(reader.lookup("a.md")).rejects.toThrow();
      const stager = createGitChangeStager({ git: s2, tip });
      await expect(stager.buildChangeCommit(COMMIT)).rejects.toThrow();
    } finally {
      s2.close();
    }
  });

  it("a git call past its timeout is killed and fails, and the session ends", async () => {
    const s2 = await openIsolatedGit({ gitEntry: path.join(repo, ".git"), objectFormat: "sha1" });
    await expect(s2.run(["rev-list", "--all"], { timeoutMs: 1 })).rejects.toThrow(/timed out/);
    expect(fs.existsSync(s2.sessionDir)).toBe(false);
    await expect(s2.run(["rev-parse", tip])).rejects.toThrow(/closed/);
  });

  it("a git killed while its stdin is still being written rejects; the process survives", async () => {
    const s2 = await openIsolatedGit({ gitEntry: path.join(repo, ".git"), objectFormat: "sha1" });
    const big = new Uint8Array(4 * 1024 * 1024).fill(0x61);
    // An unhandled EPIPE on the child's stdin is an uncaught exception, which
    // would crash the CLI. Capture uncaught exceptions for the call's
    // duration (the test runner's own handlers set aside, then restored).
    const uncaught: unknown[] = [];
    const saved = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const capture = (e: unknown) => void uncaught.push(e);
    process.on("uncaughtException", capture);
    try {
      await expect(
        s2.run(["hash-object", "--stdin"], { input: big, timeoutMs: 1 }),
      ).rejects.toThrow(/timed out|stopped reading its input/);
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("uncaughtException", capture);
      for (const l of saved) process.on("uncaughtException", l);
    }
    expect(uncaught.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([]);
    expect(fs.existsSync(s2.sessionDir)).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
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
    const stager = createGitChangeStager({ git: session, tip });
    const result = await runRepoTask({
      authority: {
        scope,
        grant,
        tick,
        revocations: { set: [], failures: [], readAt: tip },
        principal: { motebit_id: "f", public_key: bytesToHex(f.publicKey) },
        agents: [{ motebit_id: "a", public_key: bytesToHex(a.publicKey) }],
        expectedRepo: "motebit/motebit",
        isPathPermitted: () => true,
        spent: false,
      },
      agent: {
        motebitId: "a",
        deviceId: "dev-a",
        privateKey: a.privateKey,
        publicKey: a.publicKey,
      },
      provider,
      providerName: "scripted",
      reader: createGitTreeReader({ git: session, tip }),
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
