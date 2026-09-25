/**
 * The one way this CLI replaces, keeps, or moves a file it cannot afford to
 * tear or lose.
 *
 * `~/.motebit/config.json` holds `cli_encrypted_key` — for a CLI identity the
 * only copy of the private key — and, for anyone who has not migrated, the
 * deprecated `cli_private_key` in plaintext. `pending-rotation.json` holds a
 * rotation's new key. `motebit.md` is a signed snapshot (public, but binding
 * material). None of them may be left half-written, and the key files may
 * never be readable by anyone but their owner, not even for the instant
 * between create and chmod. The rules are `docs/proposals/key-file-durability-v1.md`
 * R1–R3.
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
 *  - A symlinked target is replaced at the file it points to; a symlink that
 *    cannot be resolved is refused (see `resolveWriteTarget`).
 *
 * A reader sees the old file or the new one, never a partial one.
 */
export function writeFileAtomic(requested: string, contents: string, mode: number): void {
  const target = resolveWriteTarget(requested);
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
  fsyncDir(dir);
}

/**
 * Where a replacement of `requested` must land. A symlink (a config kept in
 * a dotfiles repo, say) is followed to its target: renaming over the LINK
 * would silently turn it into a regular file and orphan the real one. A name
 * that does not exist yet is written where it was named. A symlink whose
 * target cannot be resolved — a dangling link into an unmounted volume — is
 * REFUSED: renaming over it destroys the binding to a file that may still
 * hold the bytes, and "the target is missing" is damage, never absence.
 */
function resolveWriteTarget(requested: string): string {
  try {
    return fs.realpathSync(requested);
  } catch (err) {
    let isLink = false;
    try {
      isLink = fs.lstatSync(requested).isSymbolicLink();
    } catch {
      /* nothing there at all — a first write */
    }
    if (isLink) {
      throw new Error(
        `${requested} is a symlink whose target cannot be resolved; refusing to replace the link. Nothing was changed.`,
        { cause: err },
      );
    }
    return requested;
  }
}

/**
 * Is an ENOENT a read just got really ABSENCE? A dangling symlink reads
 * ENOENT too, but the NAME exists and points somewhere that is merely not
 * there right now: that is damage. Every key-file reader asks this before
 * answering "absent" (rule R1: only ENOENT of the name itself is absence).
 */
export function isTrulyAbsent(file: string): boolean {
  try {
    fs.lstatSync(file);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
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
 * Called on EVERY load of a key file — including a load that is about to
 * report the file damaged: damaged bytes are still key bytes.
 *
 * Returns `false` only when the file IS readable by group or others and the
 * chmod failed (another owner, a read-only mount); the caller says so via
 * `warnIfExposed`. It never refuses a read on that account — refusing would
 * lock the owner out of their own identity.
 */
export function tightenToOwnerOnly(file: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return true; // not there, or not stat-able: nothing this process could narrow
  }
  if (!st.isFile() || (st.mode & 0o077) === 0) return true;
  try {
    fs.chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** Narrow `file`, and say so on stderr when it stays readable by others. */
export function narrowOnLoad(file: string): void {
  if (tightenToOwnerOnly(file)) return;
  process.stderr.write(
    `Warning: ${file} is readable by other users and its permissions could not be narrowed ` +
      `(it may be owned by another user). Fix with: chmod 600 "${file}"\n`,
  );
}

/**
 * Keep `target`'s current BYTES under `${target}${infix}<timestamp>`, owner-
 * only, before anything replaces or removes it. Throws when they cannot be
 * kept: the caller must then refuse, never proceed unpreserved.
 *
 *  - A byte COPY, created 0600 exclusively and fsync'd, is the default. A
 *    hard link is a second NAME for the same inode, not a copy: any later
 *    in-place write to the live name (an older installed CLI or desktop,
 *    the `write_file` tool) would rewrite the "kept" bytes too.
 *  - Only a file this process cannot READ (EACCES/EPERM) is kept by hard
 *    link — it cannot be copied, and nothing without read access rewrites
 *    it in place. If the chmod to 0600 fails (another owner's inode), the
 *    link is no more exposed than the original already was.
 *  - The backup's directory entry is fsync'd, so a power loss cannot persist
 *    the replacement that follows but lose the kept copy.
 *  - The REAL file is kept, never a symlink's name (link(2) on Linux does
 *    not follow symlinks); a symlink that cannot be resolved is refused.
 *
 * Returns the backup's path.
 */
export function preserveAside(target: string, infix: string, now: Date = new Date()): string {
  const real = resolveRealFile(target);
  const stamp = backupStamp(now);
  let lastErr: unknown;
  for (let n = 0; n < 100; n++) {
    const backup = `${target}${infix}${stamp}${n === 0 ? "" : `-${n}`}`;
    try {
      copyOwnerOnly(real, backup);
      fsyncDir(path.dirname(backup));
      return backup;
    } catch (copyErr) {
      const code = (copyErr as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (code !== "EACCES" && code !== "EPERM") {
        lastErr = copyErr;
        break;
      }
      // Unreadable by this process: keep the inode itself.
      try {
        fs.linkSync(real, backup);
      } catch (linkErr) {
        if ((linkErr as NodeJS.ErrnoException).code === "EEXIST") continue;
        lastErr = linkErr;
        break;
      }
      try {
        fs.chmodSync(backup, 0o600);
      } catch {
        /* another owner's inode — no more exposed than the original */
      }
      fsyncDir(path.dirname(backup));
      return backup;
    }
  }
  throw new Error(`could not preserve ${target} before replacing it; nothing was changed`, {
    cause: lastErr,
  });
}

/**
 * Move a key file OUT of its active name without destroying its bytes: it
 * becomes `${target}${infix}<timestamp>` (owner-only) and the name is free.
 *
 * A regular file is RENAMED — one atomic step, so there is no window in
 * which a concurrent writer's new file at the name could be unlinked unkept:
 * whatever is at the name when the rename runs is exactly what is kept. A
 * symlink's target bytes are copied first, then the LINK (never its target)
 * is removed. The directory is fsync'd. Throws, leaving the name in place,
 * when the bytes cannot be kept. Returns the kept path, or `null` when
 * nothing was there.
 */
export function moveAside(target: string, infix: string, now: Date = new Date()): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (st.isSymbolicLink()) {
    const kept = preserveAside(target, infix, now);
    fs.unlinkSync(target);
    fsyncDir(path.dirname(target));
    return kept;
  }
  const stamp = backupStamp(now);
  for (let n = 0; n < 100; n++) {
    const backup = `${target}${infix}${stamp}${n === 0 ? "" : `-${n}`}`;
    if (!isTrulyAbsent(backup)) continue;
    fs.renameSync(target, backup);
    try {
      fs.chmodSync(backup, 0o600);
    } catch {
      /* best effort: it was written 0600, and every load narrows it */
    }
    fsyncDir(path.dirname(backup));
    return backup;
  }
  throw new Error(`could not find a free name to keep ${target} under; nothing was changed`);
}

/** The one timestamp spelling every backup name uses: ISO-8601 with `:` and `.` as `-`. */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * The file `target` names, through any symlinks. If it cannot be resolved
 * and `target` is (or may be) a symlink, refuse: preserving the link instead
 * of the file is the failure this exists to prevent.
 */
function resolveRealFile(target: string): string {
  // A name that exists and is not a link always resolves (the parents that
  // let it be stat'ed resolve too), so an unresolvable name is a dangling or
  // looping link, or not there at all: nothing to keep, and never the LINK.
  try {
    return fs.realpathSync(target);
  } catch (err) {
    throw new Error(`could not resolve ${target} to preserve it; nothing was changed`, {
      cause: err,
    });
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

/** fsync a directory so an entry created, renamed or removed in it survives power loss. Best effort (Windows cannot open a directory). */
export function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* the rename is still atomic; only its durability across power loss is weakened */
  }
}

/**
 * Create `dir` (and parents) owner-only — `~/.motebit` holds key files, and
 * a 0755 directory shows their names and mtimes to every local user. The
 * mode applies only to directories this call CREATES; an existing directory
 * keeps the mode its owner gave it.
 */
export function mkdirOwnerOnly(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Run `fn` holding an exclusive advisory lock beside `target`
 * (`${target}.lock`, created exclusively and owner-only, holding this pid).
 *
 * The lock covers only a key file's read-compare-replace, which takes
 * milliseconds, so a waiter polls for up to `timeoutMs`. A lock whose holder
 * is no longer alive — or that is older than `staleMs` (a holder this
 * process cannot probe) — is broken. Throws on timeout: a key file is never
 * replaced without the lock. `create-motebit` takes the same lock
 * (`config-file.ts`), so the two never interleave a compare and a replace.
 */
export function withFileLock<T>(
  target: string,
  fn: () => T,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): T {
  const lock = `${target}.lock`;
  // Re-entrant within this process: a caller holding the lock across a
  // multi-file commit (create-motebit's rotation) may call a writer that
  // takes it again.
  if (heldLocks.has(lock)) return fn();
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const staleMs = opts.staleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (fd != null) {
      try {
        fs.writeFileSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      heldLocks.add(lock);
      try {
        return fn();
      } finally {
        heldLocks.delete(lock);
        try {
          fs.unlinkSync(lock);
        } catch {
          /* already gone */
        }
      }
    }
    const staleIno = staleLockInode(lock, staleMs);
    if (staleIno !== null) {
      breakStaleLock(lock, staleIno);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${target} is locked by another motebit process (${lock}); nothing was changed. If no other motebit command is running, remove that lock file and retry.`,
      );
    }
    sleepSync(20);
  }
}

/** Locks this process holds right now (for re-entrancy). */
const heldLocks = new Set<string>();

/**
 * The inode of `lock` when it is stale (its holder is dead, or it is older
 * than `staleMs`), else null. The inode is what `breakStaleLock` checks, so a
 * lock that was broken and re-taken by another waiter in between is never
 * mistaken for the stale one.
 */
function staleLockInode(lock: string, staleMs: number): number | null {
  let raw: string;
  let st: { ino: number; mtimeMs: number };
  try {
    st = fs.statSync(lock);
    raw = fs.readFileSync(lock, "utf-8");
  } catch {
    return null; // gone (the retry acquires it) or unreadable (wait it out)
  }
  const pid = Number.parseInt(raw, 10);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return st.ino;
    }
  }
  return Date.now() - st.mtimeMs > staleMs ? st.ino : null;
}

/**
 * Break the stale lock whose inode is `staleIno` — atomically, and only that
 * one. Two waiters can judge the same lock stale; if the first breaks it and
 * takes a FRESH lock at the same name, a plain unlink by the second would
 * delete the fresh one and let both in. So the name is RENAMED to a private
 * tombstone (one waiter wins the rename); if the tombstone turns out not to be
 * the judged-stale inode, it was someone's live lock and is linked back under
 * the lock name (`link` fails rather than replace a lock taken meanwhile).
 * Exported for tests.
 */
export function breakStaleLock(lock: string, staleIno: number): void {
  const tomb = `${lock}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(lock, tomb);
  } catch {
    return; // another waiter broke it first
  }
  try {
    if (fs.statSync(tomb).ino !== staleIno) {
      try {
        fs.linkSync(tomb, lock);
      } catch {
        /* a lock was taken at the name meanwhile: that one stands */
      }
    }
  } finally {
    try {
      fs.unlinkSync(tomb);
    } catch {
      /* already gone */
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Replace a signed identity file (`motebit.md`). It is PUBLIC — no private
 * key — but it is binding material: it names the `motebit_id` and key,
 * carries the succession chain, and for a legacy (non-sovereign) id it is the
 * only recovery path. So:
 *
 *  - it is replaced atomically, at the mode it already has (`0644` when new);
 *  - if the file there names a DIFFERENT identity — or cannot be read to
 *    tell — its bytes are first kept as `${file}.clobbered-<time>`. A newer
 *    signing of the SAME identity (a re-export, a rotation) replaces it.
 *
 * Returns the kept copy's path, or `null` when nothing needed keeping.
 */
export function replaceIdentityFile(file: string, contents: string): string | null {
  let existing: string | null = null;
  let unreadable = false;
  try {
    existing = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !isTrulyAbsent(file)) {
      unreadable = true;
    }
  }
  let kept: string | null = null;
  if (unreadable) {
    kept = preserveAside(file, ".clobbered-");
  } else if (existing != null && existing !== contents) {
    const before = identityFileMotebitId(existing);
    if (before == null || before !== identityFileMotebitId(contents)) {
      kept = preserveAside(file, ".clobbered-");
    }
  }
  writeFileAtomic(file, contents, currentModeOr(file, 0o644));
  return kept;
}

/**
 * Is `file` — by its name, or the name of the file it resolves to — one of
 * the files that hold key or identity-binding material on a motebit machine?
 * For commands that write an arbitrary user-named path (`motebit init --file
 * … --force`): such a write would replace a key file wholesale.
 */
export function isKeyBearingFile(file: string): boolean {
  const names = [path.basename(file)];
  try {
    names.push(path.basename(fs.realpathSync(file)));
  } catch {
    /* not there, or unresolvable — the name as given is what is checked */
  }
  return names.some(
    (n) =>
      n === "config.json" ||
      n === "pending-rotation.json" ||
      n === "dev-keyring.json" ||
      n === "motebit.md" ||
      n === "identity.md" ||
      n === "motebit.key" ||
      n === "motebit.json" ||
      /^relay\.db(-wal|-shm|-journal)?$/.test(n) ||
      /^smoke-x402-.*-eoa\.txt$/.test(n) ||
      /\.(clobbered|pre-rotation|rotation-next)-/.test(n),
  );
}

/** The `motebit_id` a signed identity file's YAML frontmatter names, or null when none can be read. */
export function identityFileMotebitId(contents: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents);
  if (!fm) return null;
  const m = /^motebit_id:\s*["']?([^"'\s]+)["']?\s*$/m.exec(fm[1]!);
  return m ? m[1]! : null;
}
