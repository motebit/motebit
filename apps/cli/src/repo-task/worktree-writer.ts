/**
 * Node adapter for the repo-task run's `RepoPathWriter` port
 * (`@motebit/runtime`, packages/runtime/src/repo-task/tools.ts).
 *
 * The runtime handler has already refused every path string that is not an
 * allowed path of the scope, and every allowed path that collides by case
 * with a tracked or another allowed path. This adapter makes the filesystem
 * keep that promise:
 *
 *   - it walks the path one component at a time from the worktree's real
 *     root (`realpathSync.native`, the on-disk spelling) with `lstat`, and
 *     refuses a symlink component, a missing directory (it creates files,
 *     never directories: every directory a CLI source creates goes through
 *     `mkdirOwnerOnly`, which a repository directory must not), and anything
 *     that is not a directory where one is needed;
 *   - every component that exists must exist under EXACTLY its name
 *     (`readdirSync` membership): on a case-insensitive filesystem `docs/a.md`
 *     resolves to an existing `Docs/A.md`, and that is refused (`case_variant`);
 *   - it opens the file `O_WRONLY | O_CREAT | O_NOFOLLOW` — without
 *     `O_TRUNC` — then, before writing a byte, checks that the open file is
 *     the one the walk resolved (`fstat` of the descriptor against `lstat` of
 *     the expected path, same device and inode, still listed by exact name)
 *     and that the parent directory's real path is still the walked,
 *     in-worktree one. Only then does it truncate and write. Any mismatch
 *     closes the descriptor and refuses (`path_raced`).
 *
 * STATED COST: Node has no `openat`, so `O_NOFOLLOW` guards only the last
 * component. A concurrent local writer that swaps an intermediate directory
 * for a symlink between the walk and the open can make the `O_CREAT` create
 * an EMPTY file outside the worktree before the post-open check refuses the
 * write. No byte of the content reaches it, and nothing is truncated or
 * overwritten outside the worktree (no `O_TRUNC`; truncation happens only
 * after the check). Removing that empty file is not attempted: by then the
 * path is not one this writer can name safely.
 *
 * A new file is created 0644; an existing file keeps its mode. Not wired to
 * any command yet (build step 4 constructs it over the clean worktree its
 * preflight checked).
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

/** `name` is listed in `dir` under exactly that spelling. */
function listedExactly(dir: string, name: string): boolean {
  return fs.readdirSync(dir).includes(name);
}

export function createWorktreeWriter(opts: WorktreeWriterOptions): RepoPathWriter {
  const root = fs.realpathSync.native(opts.root);
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
      const name = segments[segments.length - 1]!;
      let dir = root;
      for (const seg of segments.slice(0, -1)) {
        const next = path.join(dir, seg);
        const st = lstatOrNull(next);
        if (st === null) return Promise.resolve(refuse("missing_directory"));
        if (!listedExactly(dir, seg)) return Promise.resolve(refuse("case_variant"));
        if (st.isSymbolicLink()) return Promise.resolve(refuse("symlink_component"));
        if (!st.isDirectory()) return Promise.resolve(refuse("not_a_regular_file"));
        dir = next;
      }
      // The directory's real path must still be the walked one, inside the root.
      const realDir = fs.realpathSync.native(dir);
      if (realDir !== dir || !inside(root, realDir)) {
        return Promise.resolve(refuse("outside_worktree"));
      }
      const target = path.join(realDir, name);
      const st = lstatOrNull(target);
      if (st !== null && !listedExactly(realDir, name)) {
        return Promise.resolve(refuse("case_variant"));
      }
      if (st !== null && st.isSymbolicLink()) return Promise.resolve(refuse("symlink_component"));
      if (st !== null && !st.isFile()) return Promise.resolve(refuse("not_a_regular_file"));
      let fd: number;
      try {
        // No O_TRUNC: nothing is cut until the descriptor is proven to be
        // the file the walk resolved.
        fd = fs.openSync(
          target,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
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
        const opened = fs.fstatSync(fd);
        const expected = lstatOrNull(target);
        if (
          expected === null ||
          expected.isSymbolicLink() ||
          !opened.isFile() ||
          opened.dev !== expected.dev ||
          opened.ino !== expected.ino ||
          fs.realpathSync.native(dir) !== realDir ||
          !listedExactly(realDir, name)
        ) {
          return Promise.resolve(refuse("path_raced"));
        }
        fs.ftruncateSync(fd, 0);
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
