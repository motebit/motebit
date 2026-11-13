/**
 * `@motebit/verify/git` — the isolated session, tip resolution from the ref
 * files, tree reads and the commit-state reader, each against real fixture
 * repositories (or, for a listing git itself never emits, a scripted session),
 * every refusal by its message.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalJson } from "@motebit/crypto";

import {
  RepoStateError,
  RepoTipError,
  commitParents,
  computeEntries,
  gitBlobId,
  isGrantSpent,
  listTree,
  openIsolatedGit,
  readRepoState,
  resolveGitDirectories,
  resolveObjectDirectory,
  resolveRepoTip,
} from "../git/index.js";
import type { IsolatedGit, TreeEntry } from "../git/index.js";
import { printable } from "../repo-change-cli.js";
import { POLICY, git, identityFile, parties } from "./helpers/repo-change-fixture.js";

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-git-reader-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(repo: string, rel: string, content: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
}

/** A repository with one commit holding `files`. */
function repoWith(files: Record<string, string | Uint8Array>, format = "sha1"): string {
  const repo = fs.mkdtempSync(path.join(tmp, "r-"));
  git(repo, "init", "-q", "-b", "main", `--object-format=${format}`);
  for (const [p, c] of Object.entries(files)) write(repo, p, c);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

async function session(repo: string, format: "sha1" | "sha256" = "sha1"): Promise<IsolatedGit> {
  return openIsolatedGit({ gitEntry: path.join(repo, ".git"), objectFormat: format });
}

/** A session that answers every call with `out` (a listing git never emits). */
function scripted(out: string): IsolatedGit {
  return {
    objectDirectory: "",
    objectFormat: "sha1",
    sessionDir: "",
    run: async () => Buffer.from(out, "latin1"),
    close: () => {},
  };
}

// -- The isolated session ------------------------------------------------------

describe("@motebit/verify/git: the isolated session", () => {
  it("resolves a linked worktree through its gitdir file and commondir", async () => {
    const repo = repoWith({ "a.txt": "a\n" });
    const wt = path.join(tmp, "wt");
    git(repo, "worktree", "add", "-q", "-b", "side", wt);
    const dirs = resolveGitDirectories(path.join(wt, ".git"));
    expect(fs.realpathSync(dirs.commonDir)).toBe(fs.realpathSync(path.join(repo, ".git")));
    expect(dirs.gitDir).not.toBe(dirs.commonDir);
    const g = await session(wt);
    try {
      expect((await listTree(g, git(repo, "rev-parse", "HEAD"))).length).toBe(1);
    } finally {
      g.close();
    }
  });

  it.each([
    [
      "the .git entry does not exist",
      (r: string) => fs.rmSync(path.join(r, ".git"), { recursive: true }),
    ],
    [
      "neither a directory nor a gitdir file",
      (r: string) => {
        fs.renameSync(path.join(r, ".git"), path.join(r, "real.git"));
        fs.symlinkSync(path.join(r, "real.git"), path.join(r, ".git"));
      },
    ],
  ])("refuses: %s", (message, mutate) => {
    const repo = repoWith({});
    mutate(repo);
    expect(() => resolveGitDirectories(path.join(repo, ".git"))).toThrow(message);
  });

  it.each([
    ["gitdir: x\ngitdir: y\n", "the .git file is malformed"],
    ["something: else\n", "the .git file is malformed"],
    ["gitdir: \n", "the .git file is malformed"],
    ["gitdir:  padded\n", "the .git file is malformed"],
    ["gitdir: missing-dir\n", "the gitdir does not exist"],
    [`gitdir: ${"x".repeat(5000)}\n`, "the .git file is not a small regular file"],
  ])("refuses a .git file %#", (content, message) => {
    const dir = fs.mkdtempSync(path.join(tmp, "w-"));
    fs.writeFileSync(path.join(dir, ".git"), content);
    expect(() => resolveGitDirectories(path.join(dir, ".git"))).toThrow(message);
  });

  it("refuses a gitdir or commondir that is a symlink, and a symlinked object directory", () => {
    const repo = repoWith({});
    const dir = fs.mkdtempSync(path.join(tmp, "w-"));
    fs.symlinkSync(path.join(repo, ".git"), path.join(dir, "link"));
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: link\n");
    expect(() => resolveGitDirectories(path.join(dir, ".git"))).toThrow(
      "the gitdir is not a real directory",
    );
    const gd = fs.mkdtempSync(path.join(tmp, "gd-"));
    fs.symlinkSync(path.join(repo, ".git"), path.join(gd, "common"));
    fs.writeFileSync(path.join(gd, "commondir"), "common\n");
    expect(() => resolveGitDirectories(gd)).toThrow(
      "the common git directory is not a real directory",
    );
    const objs = path.join(repo, ".git", "objects");
    fs.renameSync(objs, path.join(repo, "objs"));
    fs.symlinkSync(path.join(repo, "objs"), objs);
    expect(() => resolveObjectDirectory(path.join(repo, ".git"))).toThrow(
      "the object directory is not a real directory",
    );
  });

  it("refuses an unsupported object format, and a call on a closed session", async () => {
    const repo = repoWith({});
    await expect(
      openIsolatedGit({
        gitEntry: path.join(repo, ".git"),
        objectFormat: "md5" as unknown as "sha1",
      }),
    ).rejects.toThrow("unsupported object format");
    const g = await session(repo);
    g.close();
    await expect(g.run(["version"])).rejects.toThrow("the session is closed");
  });

  it("a call that times out is killed and ends the session", async () => {
    const repo = repoWith({});
    const g = await session(repo);
    // `run` arms its timer synchronously; hold the event loop past the
    // deadline so the timer fires before the child's exit is polled.
    const call = g.run(["version"], { timeoutMs: 1 });
    const until = Date.now() + 50;
    while (Date.now() < until) {
      // busy-wait
    }
    await expect(call).rejects.toThrow(/timed out after 1 ms/);
    expect(fs.existsSync(g.sessionDir)).toBe(false);
    await expect(g.run(["version"])).rejects.toThrow("the session is closed");
  });

  it("a call whose output passes the ceiling is killed and fails", async () => {
    const repo = repoWith({ "big.bin": new Uint8Array(17 * 1024 * 1024).fill(0x62) });
    const g = await session(repo);
    try {
      const oid = git(repo, "rev-parse", "HEAD:big.bin");
      await expect(g.run(["cat-file", "blob", oid])).rejects.toThrow(/git cat-file failed/);
      await expect(g.run([])).rejects.toThrow(/^git {2}failed/);
    } finally {
      g.close();
    }
  });

  it("a git that stops reading its input never crashes the process", async () => {
    const repo = repoWith({});
    const g = await session(repo);
    const uncaught: unknown[] = [];
    const saved = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const capture = (e: unknown) => void uncaught.push(e);
    process.on("uncaughtException", capture);
    try {
      // `git version` never reads stdin: the write of 8 MiB breaks (EPIPE).
      const big = new Uint8Array(8 * 1024 * 1024).fill(0x61);
      await g.run(["version"], { input: big }).catch((e: unknown) => {
        expect(String(e)).toMatch(/stopped reading its input/);
      });
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("uncaughtException", capture);
      for (const l of saved) process.on("uncaughtException", l);
      g.close();
    }
    expect(uncaught).toEqual([]);
  });

  it("a git that cannot be started fails closed and leaves no session directory", async () => {
    const repo = repoWith({});
    // A private temp root: other test files open sessions in the shared
    // os.tmpdir() concurrently, so counting there races.
    const root = path.join(tmp, "tmpdir");
    fs.mkdirSync(root);
    const saved = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
    process.env.PATH = path.join(tmp, "no-git-here");
    process.env.TMPDIR = root;
    try {
      expect(os.tmpdir()).toBe(root);
      await expect(session(repo)).rejects.toThrow();
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.TMPDIR === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved.TMPDIR;
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("a failing call names git's error; stdin is passed through", async () => {
    const repo = repoWith({});
    const g = await session(repo);
    try {
      await expect(g.run(["cat-file", "blob", "0".repeat(40)])).rejects.toThrow(
        /git cat-file failed \(128\)/,
      );
      const id = (await g.run(["hash-object", "--stdin"], { input: Buffer.from("x\n") }))
        .toString()
        .trim();
      expect(id).toBe(gitBlobId(Buffer.from("x\n"), "sha1"));
    } finally {
      g.close();
    }
  });

  it("reads a sha256 repository with a sha256 session", async () => {
    const repo = repoWith({ "a.txt": "a\n" }, "sha256");
    const g = await session(repo, "sha256");
    try {
      const head = git(repo, "rev-parse", "HEAD");
      expect(head).toHaveLength(64);
      const tree = await listTree(g, head);
      expect(tree[0]!.oid).toBe(gitBlobId(Buffer.from("a\n"), "sha256"));
      expect(await commitParents(g, head)).toEqual([]);
    } finally {
      g.close();
    }
  });
});

// -- Tree reads ------------------------------------------------------------------

describe("@motebit/verify/git: tree reads", () => {
  it("refuses a listing git never emits", async () => {
    await expect(listTree(scripted("100644 blob abc\0"), "x")).rejects.toThrow("has no path");
    await expect(listTree(scripted("100644\tp\0"), "x")).rejects.toThrow("malformed record");
    await expect(listTree(scripted("100644 blob abc\tp"), "x")).rejects.toThrow(
      "not NUL-terminated",
    );
  });

  it("computes entries in-process: add, modify, mode change, delete, a type change, NUL content", async () => {
    const e = (p: string, mode: string, type: string, oid: string): TreeEntry => ({
      mode,
      type,
      oid,
      path: new TextEncoder().encode(p),
    });
    const blobs: Record<string, string> = { b1: "x", b2: "a\0b", b3: "y" };
    const g: IsolatedGit = {
      ...scripted(""),
      run: async (args) => Buffer.from(blobs[args[2]!] ?? "", "latin1"),
    };
    const from = [
      e("keep", "100644", "blob", "b1"),
      e("mod", "100644", "blob", "b1"),
      e("mode", "100644", "blob", "b1"),
      e("gone", "100644", "blob", "b1"),
      e("sub", "160000", "commit", "c1"),
    ];
    const to = [
      e("keep", "100644", "blob", "b1"),
      e("mod", "100644", "blob", "b2"),
      e("mode", "100755", "blob", "b1"),
      e("new", "100644", "blob", "b3"),
      e("sub", "100644", "blob", "b3"),
    ];
    const out = await computeEntries(g, from, to);
    const show = out.map(
      (x) => `${x.kind} ${new TextDecoder().decode(x.path)} ${x.mode} ${x.containsNul}`,
    );
    expect(show.sort()).toEqual(
      [
        "modify mod 100644 true",
        "modify mode 100755 false",
        "add new 100644 false",
        "delete sub 160000 false",
        "add sub 100644 false",
        "delete gone 100644 false",
      ].sort(),
    );
  });

  it("escapes every control character for the terminal", () => {
    expect(printable("a\nb\u001bc ")).toBe("a\\u000ab\\u001bc\\u2028");
  });
});

// -- Tip resolution ------------------------------------------------------------------

describe("@motebit/verify/git: the tip from the ref files", () => {
  it("resolves a loose ref, and a packed one (peeled lines allowed)", () => {
    const repo = repoWith({ "a.txt": "a\n" });
    const head = git(repo, "rev-parse", "HEAD");
    expect(resolveRepoTip(repo, "main", "sha1").tip).toBe(head);
    git(repo, "tag", "-a", "-m", "t", "v1");
    git(repo, "pack-refs", "--all");
    expect(fs.existsSync(path.join(repo, ".git/refs/heads/main"))).toBe(false);
    expect(resolveRepoTip(repo, "main", "sha1").tip).toBe(head);
  });

  it.each<[string, (repo: string, head: string) => void, string, string?]>([
    ["a base ref that is not a plain branch name", () => {}, "is not a plain branch name", "../x"],
    ["a dot segment", () => {}, "is not a plain branch name", "a/./b"],
    [
      "not a worktree",
      (r) => fs.rmSync(path.join(r, ".git"), { recursive: true }),
      "is not a git worktree",
    ],
    ["a reftable repository", (r) => fs.mkdirSync(path.join(r, ".git/reftable")), "reftable"],
    ["no HEAD", (r) => fs.rmSync(path.join(r, ".git/HEAD")), "has no HEAD"],
    [
      "a detached HEAD",
      (r, h) => fs.writeFileSync(path.join(r, ".git/HEAD"), `${h}\n`),
      "detached",
    ],
    [
      "HEAD on another branch",
      (r) => fs.writeFileSync(path.join(r, ".git/HEAD"), "ref: refs/heads/other\n"),
      "HEAD is on",
    ],
    [
      "HEAD not a regular file",
      (r) => {
        fs.rmSync(path.join(r, ".git/HEAD"));
        fs.mkdirSync(path.join(r, ".git/HEAD"));
      },
      "HEAD is not a regular file",
    ],
    [
      "HEAD not UTF-8",
      (r) => fs.writeFileSync(path.join(r, ".git/HEAD"), Buffer.from([0xff, 0xfe])),
      "HEAD is not UTF-8",
    ],
    [
      "a loose ref that is not one object id",
      (r) => fs.writeFileSync(path.join(r, ".git/refs/heads/main"), "abc\n"),
      "does not hold one sha1 object id",
    ],
    [
      "no commit on the branch",
      (r) => fs.rmSync(path.join(r, ".git/refs/heads/main")),
      "does not exist (the branch has no commit)",
    ],
    [
      "a branch packed-refs does not name",
      (r, h) => {
        fs.rmSync(path.join(r, ".git/refs/heads/main"));
        fs.writeFileSync(path.join(r, ".git/packed-refs"), `${h} refs/heads/other\n`);
      },
      "does not exist (the branch has no commit)",
    ],
    [
      "a malformed packed-refs line",
      (r) => {
        fs.rmSync(path.join(r, ".git/refs/heads/main"));
        fs.writeFileSync(path.join(r, ".git/packed-refs"), "nonsense\n");
      },
      "packed-refs line 1 is malformed",
    ],
    [
      "a peeled line first",
      (r, h) => {
        fs.rmSync(path.join(r, ".git/refs/heads/main"));
        fs.writeFileSync(path.join(r, ".git/packed-refs"), `^${h}\n`);
      },
      "packed-refs line 1 is malformed",
    ],
    [
      "the ref named twice",
      (r, h) => {
        fs.rmSync(path.join(r, ".git/refs/heads/main"));
        fs.writeFileSync(
          path.join(r, ".git/packed-refs"),
          `# pack-refs with: peeled\n${h} refs/heads/main\n${h} refs/heads/main\n`,
        );
      },
      "names refs/heads/main twice",
    ],
  ])("refuses %s", (_name, mutate, message, baseRef = "main") => {
    const repo = repoWith({ "a.txt": "a\n" });
    mutate(repo, git(repo, "rev-parse", "HEAD"));
    let err: unknown;
    try {
      resolveRepoTip(repo, baseRef, "sha1");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RepoTipError);
    expect((err as Error).message).toContain(message);
  });
});

// -- What a commit says ----------------------------------------------------------------

describe("@motebit/verify/git: the pins, revocations and policy at a commit", () => {
  async function stateOf(
    files: Record<string, string | Uint8Array>,
    links: Record<string, string> = {},
  ) {
    const repo = repoWith(files);
    for (const [p, target] of Object.entries(links)) {
      fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
      fs.symlinkSync(target, path.join(repo, p));
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "--allow-empty", "-m", "links");
    const head = git(repo, "rev-parse", "HEAD");
    const g = await session(repo);
    try {
      return await readRepoState(g, head, await listTree(g, head));
    } finally {
      g.close();
    }
  }

  it("reads intact pins, the revocations and the policy", async () => {
    const { f, a } = await parties();
    const s = await stateOf({
      ".motebit/principals/principal.md": await identityFile(f),
      ".motebit/principals/agents/a.md": await identityFile(a),
      ".motebit/repo-path-policy.json": POLICY,
      ".motebit/revocations/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.json": canonicalJson({
        grant_id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      }),
    });
    expect(s.problems).toEqual([]);
    expect(s.principal).toEqual({ motebit_id: f.motebitId, public_key: f.publicKey });
    expect(s.agents).toEqual([{ motebit_id: a.motebitId, public_key: a.publicKey }]);
    expect(s.revocations.set).toHaveLength(1);
    expect(s.policy).not.toBeNull();
  });

  it("names every rule that did not hold, and never reads a bad file as a pin or a revocation", async () => {
    const { f } = await parties();
    const bad = Buffer.from([0xff, 0xfe]);
    const s = await stateOf(
      {
        ".motebit/principals/agents/x.txt": "x",
        ".motebit/principals/agents/sub/y.md": "x",
        ".motebit/principals/agents/bad.md": bad,
        ".motebit/principals/agents/forged.md": (await identityFile(f)).replace("owner", "0wner"),
        ".motebit/repo-path-policy.json": bad,
        ".motebit/revocations/notes.txt": "x",
        ".motebit/revocations/sub/x.json": "{}",
        ".motebit/revocations/bad.json": bad,
        ".motebit/revocations/arr.json": "[]",
        ".motebit/revocations/wrong.json": JSON.stringify({ grant_id: "other" }),
        ".motebit/revocations/null.json": "null",
      },
      {
        ".motebit/principals/principal.md": "elsewhere",
        ".motebit/principals/agents/link.md": "elsewhere",
        ".motebit/revocations/link.json": "elsewhere",
      },
    );
    expect(s.principal).toBeNull();
    expect(s.agents).toEqual([]);
    expect(s.policy).toBeNull();
    expect(s.revocations.set).toEqual([]);
    const problems = s.problems.join("\n");
    expect(problems).toContain(".motebit/principals/principal.md is not a regular 100644 file");
    expect(problems).toContain('".motebit/principals/agents/x.txt" is not an agent pin file');
    expect(problems).toContain('".motebit/principals/agents/sub/y.md" is not an agent pin file');
    expect(problems).toContain(".motebit/principals/agents/bad.md is not UTF-8");
    expect(problems).toContain(
      ".motebit/principals/agents/forged.md is not an intact identity file",
    );
    expect(problems).toContain(".motebit/principals/agents/link.md is not a regular 100644 file");
    expect(problems).toContain(".motebit/repo-path-policy.json does not parse");
    const failures = s.revocations.failures.join("\n");
    expect(failures).toContain('".motebit/revocations/notes.txt" is not a <grant_id>.json file');
    expect(failures).toContain('".motebit/revocations/sub/x.json" is not a <grant_id>.json file');
    expect(failures).toContain(".motebit/revocations/bad.json is not UTF-8 JSON");
    expect(failures).toContain(".motebit/revocations/arr.json: the file name is not");
    expect(failures).toContain(".motebit/revocations/wrong.json: the file name is not");
    expect(failures).toContain(".motebit/revocations/null.json: the file name is not");
    expect(failures).toContain(".motebit/revocations/link.json is not a regular 100644 file");
  });

  it("a principal pin that is not UTF-8 or not intact, a missing policy, a policy that is a symlink", async () => {
    const s1 = await stateOf({ ".motebit/principals/principal.md": Buffer.from([0xff]) });
    expect(s1.problems.join("\n")).toContain(".motebit/principals/principal.md is not UTF-8");
    expect(s1.problems.join("\n")).toContain("no agent pin at the tip");
    expect(s1.problems.join("\n")).toContain("no path policy at the tip");
    const s2 = await stateOf(
      { ".motebit/principals/principal.md": "not an identity file" },
      { ".motebit/repo-path-policy.json": "elsewhere" },
    );
    expect(s2.problems.join("\n")).toContain("principal.md is not an intact identity file");
    expect(s2.problems.join("\n")).toContain(
      ".motebit/repo-path-policy.json is not a regular 100644 file",
    );
  });

  it("spent refuses a malformed grant id and a shallow clone", async () => {
    const repo = repoWith({ "a.txt": "a\n" });
    const head = git(repo, "rev-parse", "HEAD");
    const g = await session(repo);
    try {
      await expect(isGrantSpent(g, head, "NOT-A-UUID", path.join(repo, ".git"))).rejects.toThrow(
        RepoStateError,
      );
      fs.writeFileSync(path.join(repo, ".git/shallow"), `${head}\n`);
      await expect(
        isGrantSpent(g, head, "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", path.join(repo, ".git")),
      ).rejects.toThrow("shallow");
    } finally {
      g.close();
    }
  });
});
