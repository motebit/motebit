/**
 * Node adapter for the repo-task run's `RepoPathWriter` port
 * (`@motebit/runtime`, packages/runtime/src/repo-task/tools.ts).
 *
 * The runtime handler has already refused every path string that is not an
 * allowed path of the scope. This adapter makes the filesystem keep that
 * promise: it walks the path one component at a time from the worktree's
 * real root with `lstat`, refuses any component that is a symlink, refuses a
 * real path that leaves the worktree, refuses a missing directory (it creates
 * files, never directories: every directory a CLI source creates goes through
 * `mkdirOwnerOnly`, which a repository directory must not), and opens the
 * file with `O_NOFOLLOW`, so a symlink planted
 * between the walk and the write is refused too. A new file is created
 * 0644; an existing file keeps its mode.
 *
 * Not wired to any command yet (build step 4 constructs it over the clean
 * worktree its preflight checked).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { RepoPathWriter, RepoPathWriteResult } from "@motebit/runtime";

export interface WorktreeWriterOptions {
  /** The worktree's root directory. */
  readonly root: string;
}

const refuse = (
  refusal: Extract<RepoPathWriteResult, { ok: false }>["refusal"],
): RepoPathWriteResult => ({
  ok: false,
  refusal,
});

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

export function createWorktreeWriter(opts: WorktreeWriterOptions): RepoPathWriter {
  const root = fs.realpathSync(opts.root);
  return {
    write(rel: string, content: Uint8Array): Promise<RepoPathWriteResult> {
      // Defensive: the handler only passes canonical relative paths.
      const segments = rel.split("/");
      if (
        path.isAbsolute(rel) ||
        rel.includes("\\") ||
        rel.includes("\0") ||
        segments.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git")
      ) {
        return Promise.resolve(refuse("outside_worktree"));
      }
      let dir = root;
      for (const seg of segments.slice(0, -1)) {
        const next = path.join(dir, seg);
        const st = lstatOrNull(next);
        if (st === null) {
          return Promise.resolve(refuse("missing_directory"));
        } else if (st.isSymbolicLink()) {
          return Promise.resolve(refuse("symlink_component"));
        } else if (!st.isDirectory()) {
          return Promise.resolve(refuse("not_a_regular_file"));
        }
        dir = next;
      }
      // The directory's real path must still be the walked one, inside the root.
      const realDir = fs.realpathSync(dir);
      if (realDir !== dir || !inside(root, realDir))
        return Promise.resolve(refuse("outside_worktree"));
      const target = path.join(realDir, segments[segments.length - 1]!);
      const st = lstatOrNull(target);
      if (st !== null && st.isSymbolicLink()) return Promise.resolve(refuse("symlink_component"));
      if (st !== null && !st.isFile()) return Promise.resolve(refuse("not_a_regular_file"));
      let fd: number;
      try {
        fd = fs.openSync(
          target,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC |
            fs.constants.O_NOFOLLOW,
          0o644,
        );
      } catch (err) {
        // A symlink planted after the walk: O_NOFOLLOW refuses it.
        if ((err as NodeJS.ErrnoException).code === "ELOOP") {
          return Promise.resolve(refuse("symlink_component"));
        }
        throw err;
      }
      try {
        let off = 0;
        while (off < content.length) off += fs.writeSync(fd, content, off, content.length - off);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return Promise.resolve({ ok: true });
    },
  };
}
