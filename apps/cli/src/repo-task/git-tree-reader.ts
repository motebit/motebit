/**
 * Node adapter for the repo-task run's `RepoTreeReader` port
 * (`@motebit/runtime`, packages/runtime/src/repo-task/tools.ts).
 *
 * Reads the tip commit's tree through git — `git ls-tree` for the entry at
 * one exact path, `git cat-file blob` for its bytes — and never the working
 * tree: a file the agent wrote, an untracked file, or anything outside the
 * repository is invisible to it. The refusal logic (untracked, symlink,
 * gitlink, tree, out-of-tree spellings) is the runtime handler's; this
 * adapter only reports what git records.
 *
 * Git runs with no system or global config, no replace objects and literal
 * pathspecs, so no config file, replace ref or glob can change what a path
 * names. Not wired to any command yet: `motebit repo-task run` (build step 4)
 * constructs it after its preflight pins the tip.
 */
import { execFile } from "node:child_process";

import type { RepoTreeEntry, RepoTreeReader } from "@motebit/runtime";

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_BLOB_BYTES = 16 * 1024 * 1024;

export interface GitTreeReaderOptions {
  /** The repository's git directory (`.git`, or a bare repository). */
  readonly gitDir: string;
  /** The tip commit, as a full lowercase object id (pinned by the preflight). */
  readonly tip: string;
}

/** The environment every git call runs under: nothing outside the repository steers it. */
export function isolatedGitEnv(gitDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_DIR: gitDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function git(gitDir: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { env: isolatedGitEnv(gitDir), encoding: "buffer", maxBuffer: MAX_BLOB_BYTES + 1024 },
      (err, stdout) => {
        if (err) reject(new Error(`git ${args[0] ?? ""} failed: ${err.message}`, { cause: err }));
        else resolve(stdout);
      },
    );
  });
}

function kindOf(mode: string, type: string): RepoTreeEntry["kind"] | null {
  if (type === "blob" && (mode === "100644" || mode === "100755")) return "blob";
  if (type === "blob" && mode === "120000") return "symlink";
  if (type === "commit" && mode === "160000") return "gitlink";
  if (type === "tree" && mode === "040000") return "tree";
  return null;
}

export function createGitTreeReader(opts: GitTreeReaderOptions): RepoTreeReader {
  if (!OID.test(opts.tip))
    throw new Error("git tree reader: tip must be a full lowercase object id");
  const { gitDir, tip } = opts;
  return {
    async lookup(path: string): Promise<RepoTreeEntry | null> {
      if (path.length === 0 || path.includes("\0")) return null;
      // `-z`: NUL-terminated records, paths unquoted. `--full-tree`: paths are
      // repository-relative whatever the working directory.
      const out = await git(gitDir, ["ls-tree", "-z", "--full-tree", tip, "--", path]);
      const want = Buffer.from(path, "utf8");
      for (const rec of out.toString("latin1").split("\0")) {
        if (rec.length === 0) continue;
        const tab = rec.indexOf("\t");
        if (tab < 0) continue;
        const [mode, type, oid] = rec.slice(0, tab).split(" ");
        // Compare git's own path bytes with the requested bytes, exactly.
        const got = Buffer.from(rec.slice(tab + 1), "latin1");
        if (!got.equals(want) || mode === undefined || type === undefined || oid === undefined)
          continue;
        const kind = kindOf(mode, type);
        if (kind === null || !OID.test(oid)) return null;
        return { kind, mode, oid };
      }
      return null;
    },
    async readBlob(oid: string): Promise<Uint8Array> {
      if (!OID.test(oid)) throw new Error("git tree reader: not an object id");
      const bytes = await git(gitDir, ["cat-file", "blob", oid]);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    async listTrackedPaths(): Promise<readonly Uint8Array[]> {
      // Every path of the tip's tree, recursively, as git's own bytes
      // (`-z`: NUL-separated, never quoted or re-encoded).
      const out = await git(gitDir, ["ls-tree", "-r", "-z", "--full-tree", "--name-only", tip]);
      const paths: Uint8Array[] = [];
      let start = 0;
      for (let i = 0; i < out.length; i++) {
        if (out[i] !== 0) continue;
        if (i > start) paths.push(new Uint8Array(out.subarray(start, i)));
        start = i + 1;
      }
      return paths;
    },
  };
}
