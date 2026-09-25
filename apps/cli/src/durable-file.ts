/**
 * The one way this CLI replaces a file it cannot afford to tear.
 *
 * `~/.motebit/config.json` holds `cli_encrypted_key` — for a CLI identity the
 * only copy of the private key — and, for anyone who has not migrated, the
 * deprecated `cli_private_key` in plaintext. `pending-rotation.json` holds a
 * rotation's new key. `motebit.md` is a signed snapshot. None of them may be
 * left half-written, and the first two may never be readable by anyone but
 * their owner, not even for the instant between create and chmod.
 *
 * `create-motebit` writes the same `config.json` and carries a twin of this
 * helper (`packages/create-motebit/src/config-file.ts`). It is a copy, not an
 * import, on purpose: create-motebit is an Apache-2.0 package that bundles only
 * the permissive floor, and this CLI is BSL — neither may depend on the other,
 * and no permissive-floor package does filesystem I/O. Change one, change both.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Replace `target` atomically with `contents`, at exactly `mode`.
 *
 *  - Staged beside the target (same directory, so the rename is atomic) under
 *    a fresh, exclusively-created name — `mode` applies only on CREATE, so a
 *    name that already existed would keep whatever mode it had. The staged
 *    file is also chmod'ed explicitly: the umask can only narrow a create
 *    mode, and the result must be exact.
 *  - fsync'd before the rename, and the directory fsync'd after it: the file's
 *    bytes are durable after the first, the rename that makes them the file
 *    is a directory change and is durable only after the second.
 *  - The scratch copy is removed on every failure path — it holds the same
 *    bytes as the target, and nothing else would ever clean it up.
 *
 * A reader sees the old file or the new one, never a partial one.
 */
export function writeFileAtomic(requested: string, contents: string, mode: number): void {
  // A symlinked target (a config kept in a dotfiles repo, say) is replaced
  // at the file it points to: renaming over the LINK would silently turn it
  // into a regular file and orphan the real one. A target that does not
  // exist yet (or a dangling link) is written where it was named.
  let target = requested;
  try {
    target = fs.realpathSync(requested);
  } catch {
    /* not there yet — write it where it was named */
  }
  const dir = path.dirname(target);
  const staged = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(staged, "wx", mode);
    try {
      fs.writeFileSync(fd, contents, "utf-8");
      // Tighten BEFORE the rename: after it, the replacement has already
      // landed, and a chmod that failed there would report a failed write
      // that in fact succeeded — at the wrong mode.
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(staged, target);
  } catch (err) {
    try {
      fs.rmSync(staged, { force: true });
    } catch {
      /* best effort — the original error is the one worth reporting */
    }
    throw err;
  }
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Not every platform allows fsync on a directory (Windows). The rename is
    // still atomic; only its durability across power loss is weakened.
  }
}

/**
 * The permission bits `file` has now, or `fallback` when it does not exist.
 * For replacing a PUBLIC file (the signed `motebit.md`) atomically without
 * widening a mode its owner deliberately narrowed.
 */
export function currentModeOr(file: string, fallback: number): number {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return fallback;
  }
}

/**
 * Narrow an existing file to owner-only if it is readable by anyone else.
 * Best effort: a file this process may not chmod (another owner, a read-only
 * mount) is reported by nothing here — refusing a READ because a chmod
 * failed would lock the owner out of their own identity.
 */
export function tightenToOwnerOnly(file: string): void {
  try {
    const st = fs.statSync(file);
    if (st.isFile() && (st.mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

/**
 * Preserve `target`'s current bytes under `${target}${infix}<timestamp>`
 * WITHOUT reading them and without the target ever being absent: a hard link
 * is a second name for the same bytes, created atomically, and needs no read
 * permission. Where links are unsupported, a byte copy. Owner-only either way
 * — a damaged key file is still a key file. Throws when neither works: the
 * caller must then refuse to write, never overwrite unpreserved damage.
 *
 * Returns the backup's path.
 */
export function preserveAside(target: string, infix: string, now: Date = new Date()): string {
  // Link or copy the REAL file, never the name as given. `writeFileAtomic`
  // replaces a symlink's target; link(2) on Linux does NOT follow symlinks,
  // so linking the name would make the "backup" a second name for the LINK —
  // which reads the NEW bytes the moment the write lands.
  const real = resolveRealFile(target);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let lastErr: unknown;
  for (let n = 0; n < 100; n++) {
    const backup = `${target}${infix}${stamp}${n === 0 ? "" : `-${n}`}`;
    try {
      fs.linkSync(real, backup);
      try {
        fs.chmodSync(backup, 0o600);
      } catch {
        /* best effort — the bytes are preserved, which is the load-bearing part */
      }
      return backup;
    } catch (linkErr) {
      if ((linkErr as NodeJS.ErrnoException).code === "EEXIST") continue;
      // No hard links here (another filesystem, FAT, a sandbox): copy the
      // bytes into a file that is owner-only from the moment it exists.
      try {
        copyOwnerOnly(real, backup);
        return backup;
      } catch (copyErr) {
        if ((copyErr as NodeJS.ErrnoException).code === "EEXIST") continue;
        lastErr = copyErr;
        break;
      }
    }
  }
  throw new Error(`could not preserve ${target} before replacing it; nothing was changed`, {
    cause: lastErr,
  });
}

/**
 * The file `target` names, through any symlinks. If it cannot be resolved
 * and `target` is (or may be) a symlink, refuse: preserving the link instead
 * of the file is the failure this exists to prevent.
 */
function resolveRealFile(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch (err) {
    let isLink = true;
    try {
      isLink = fs.lstatSync(target).isSymbolicLink();
    } catch {
      /* unknowable — treat as a link */
    }
    if (isLink) {
      throw new Error(`could not resolve ${target} to preserve it; nothing was changed`, {
        cause: err,
      });
    }
    return target;
  }
}

/** Copy `src` to a NEW file `dest`, created 0600 (exclusive), fsync'd; `dest` removed on failure. */
function copyOwnerOnly(src: string, dest: string): void {
  const bytes = fs.readFileSync(src);
  const fd = fs.openSync(dest, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, bytes);
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
}
