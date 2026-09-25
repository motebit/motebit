/**
 * How create-motebit reads, replaces, keeps and moves the files the motebit
 * CLI keeps an identity in: `config.json` (`cli_encrypted_key` — for a CLI
 * identity the only copy of the private key), `pending-rotation.json` (a
 * `motebit rotate` in flight: its new key), and `motebit.md` (public, but
 * binding material). The rules are `docs/proposals/key-file-durability-v1.md`
 * R1–R3, identical to the CLI's:
 *
 *  1. Absence is not damage. Only ENOENT of the name itself reads as `{}` (a
 *     first run); anything else unreadable, unparseable, valid JSON that is
 *     not an object, or a symlink whose target is missing is DAMAGE and
 *     throws `ConfigDamagedError`, file untouched — narrowed to owner-only
 *     first, since damaged bytes are still key bytes.
 *  2. Key material is never destroyed. A write over a damaged file, or one
 *     that replaces a key or signed identity, first keeps the old bytes as a
 *     byte copy (`config.json.clobbered-<time>`), or refuses. A write never
 *     reverts an identity another process committed since it was read.
 *  3. A replacement is staged, fsync'd and renamed, owner-only (0600) from
 *     the moment it exists, scratch removed on every failure path, directory
 *     fsync'd after the rename, under the config lock the CLI also takes.
 *
 * TWIN of `apps/cli/src/durable-file.ts` + the config half of
 * `apps/cli/src/config.ts`. A copy, not an import, on purpose: this package
 * is Apache-2.0 and bundles only the permissive floor, the CLI is BSL, and no
 * permissive-floor package does filesystem I/O — neither may depend on the
 * other. Change one, change both.
 */
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Infix of the one backup name: `config.json.clobbered-<time>`. Shared with the CLI and the desktop. */
export const CONFIG_BACKUP_INFIX = ".clobbered-";

export class ConfigDamagedError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
    cause?: unknown,
  ) {
    super(
      `${path} exists but could not be read (${reason}). It has NOT been changed. ` +
        `It may hold the only copy of an identity key — copy it aside before running anything that writes config.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "ConfigDamagedError";
  }
}

/** The identity in the config changed on disk after this run read it; writing would revert that commit. */
export class ConfigIdentityChangedError extends Error {
  constructor(readonly path: string) {
    super(
      `the identity in ${path} changed while create-motebit ran (the motebit CLI, the desktop app, or another create-motebit committed a new key or identity). Nothing was changed — run it again.`,
    );
    this.name = "ConfigIdentityChangedError";
  }
}

/** The fields of a config that ARE the identity (same list as the CLI's `config.ts`). */
const IDENTITY_FIELDS = [
  "motebit_id",
  "device_id",
  "device_public_key",
  "cli_encrypted_key",
  "cli_private_key",
  "_identity_file",
] as const;

/** The identity fields as last READ from disk, carried on the config object (spread copies it; JSON never writes it). */
const IDENTITY_BASELINE: unique symbol = Symbol("motebit.config.identityBaseline");
type Baselined = Record<string | symbol, unknown> & { [IDENTITY_BASELINE]?: string };

/** A canonical fingerprint of a config's identity fields (absent ≡ empty). */
export function identityFingerprint(config: object): string {
  const c = config as Record<string, unknown>;
  return JSON.stringify(
    IDENTITY_FIELDS.map((f) => {
      const v = c[f];
      return v === undefined || v === null || v === "" ? null : v;
    }),
  );
}

function losesIdentityMaterial(from: object, to: object): boolean {
  const f = from as Record<string, unknown>;
  const t = to as Record<string, unknown>;
  for (const field of ["cli_encrypted_key", "cli_private_key", "_identity_file"] as const) {
    const v = f[field];
    if (v === undefined || v === null || v === "") continue;
    if (JSON.stringify(v) !== JSON.stringify(t[field])) return true;
  }
  return false;
}

/** Only ENOENT of the NAME is absence: a dangling symlink reads ENOENT too, and it is damage. */
export function isTrulyAbsent(file: string): boolean {
  try {
    lstatSync(file);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Rule 1: absent ⇒ `{}`; damaged ⇒ throw (after narrowing); never "empty" for anything but absence. */
export function readConfigFile<T extends object>(path: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && isTrulyAbsent(path)) return {} as T;
    narrowOnLoad(path);
    throw new ConfigDamagedError(
      path,
      code === "ENOENT" ? "a symlink whose target is missing" : (code ?? "unreadable"),
      err,
    );
  }
  // A config written before owner-only was the rule is world-readable; a
  // read is the first chance to close that — before any damage is reported.
  narrowOnLoad(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigDamagedError(path, "not valid JSON", err);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigDamagedError(path, "not a JSON object");
  }
  const config = parsed as Baselined;
  config[IDENTITY_BASELINE] = identityFingerprint(config);
  return config as unknown as T;
}

/**
 * How a write that changes the identity fields treats what it replaces:
 * `"preserve-replaced"` keeps replaced key/binding material as
 * `config.json.clobbered-<time>` first (the default); `"retired-kept-elsewhere"`
 * is for a caller that has ALREADY kept the replaced bytes itself (the
 * rotation commit's `pre-rotation-` copy).
 */
export type IdentityChange = "preserve-replaced" | "retired-kept-elsewhere";

/**
 * Rules 2 + 3: replace the config at `path` atomically and owner-only, under
 * the config lock. A damaged predecessor is kept first. A write that does
 * not change the identity never changes it — if another process committed
 * a new identity since `config` was read, the on-disk identity is kept and
 * only this write's other fields land. A write that changes the identity is
 * refused (`ConfigIdentityChangedError`) if the identity on disk is no longer
 * the one it was read with, and keeps any key or signed identity it
 * replaces. Returns the path of a kept copy when one was made.
 */
export function writeConfigFile(
  path: string,
  config: object,
  opts: { identityChange?: IdentityChange } = {},
): string | null {
  mkdirOwnerOnly(dirname(path));
  return withFileLock(path, () => {
    const write = config as Baselined;
    const baseline = write[IDENTITY_BASELINE];
    let preservedAs: string | null = null;
    let onDisk: object | null;
    try {
      // Absent: nothing on disk to protect or revert — the write lands as given.
      onDisk = isTrulyAbsent(path) ? null : readConfigFile(path);
    } catch (err) {
      if (!(err instanceof ConfigDamagedError)) throw err;
      preservedAs = preserveAside(path, CONFIG_BACKUP_INFIX);
      onDisk = null;
    }
    if (onDisk != null && identityFingerprint(onDisk) !== identityFingerprint(write)) {
      const untouched = baseline !== undefined && identityFingerprint(write) === baseline;
      if (opts.identityChange === undefined && untouched) {
        const d = onDisk as Record<string, unknown>;
        for (const f of IDENTITY_FIELDS) {
          if (d[f] === undefined) delete write[f];
          else write[f] = d[f];
        }
      } else {
        if (baseline !== undefined && baseline !== identityFingerprint(onDisk)) {
          throw new ConfigIdentityChangedError(path);
        }
        const mode = opts.identityChange ?? "preserve-replaced";
        if (mode === "preserve-replaced" && losesIdentityMaterial(onDisk, write)) {
          preservedAs = preserveAside(path, CONFIG_BACKUP_INFIX);
        }
      }
    }
    writeFileAtomic(path, JSON.stringify(write, null, 2) + "\n", 0o600);
    write[IDENTITY_BASELINE] = identityFingerprint(write);
    return preservedAs;
  });
}

/** Stage (exclusive create at `mode`, explicit chmod, fsync) → rename → fsync dir; scratch removed on failure. */
export function writeFileAtomic(requested: string, contents: string, mode: number): void {
  const target = resolveWriteTarget(requested);
  const staged = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(staged, "wx", mode);
    try {
      writeFileSync(fd, contents, "utf-8");
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staged, target);
  } catch (err) {
    try {
      rmSync(staged, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
  fsyncDir(dirname(target));
}

/**
 * Replace a symlink's TARGET, never the link (renaming over it would turn it
 * into a regular file and orphan the real one); a name not there yet is
 * written where named; a symlink whose target cannot be resolved is REFUSED
 * — replacing the link would lose the binding to bytes that may still exist.
 */
function resolveWriteTarget(requested: string): string {
  try {
    return realpathSync(requested);
  } catch (err) {
    let isLink = false;
    try {
      isLink = lstatSync(requested).isSymbolicLink();
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

/** fsync a directory so an entry created, renamed or removed in it survives power loss. Best effort. */
export function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not every platform allows fsync on a directory; the rename is still atomic.
  }
}

/** Create `dir` owner-only (0700) — it holds key files. An existing directory keeps its mode. */
export function mkdirOwnerOnly(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** The permission bits `file` has now, or `fallback` when it does not exist. */
export function currentModeOr(file: string, fallback: number): number {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return fallback;
  }
}

/** Narrow a key file readable by others to 0600; say so on stderr when it cannot be narrowed. Never refuses a read. */
export function narrowOnLoad(file: string): void {
  let st;
  try {
    st = statSync(file);
  } catch {
    return;
  }
  if (!st.isFile() || (st.mode & 0o077) === 0) return;
  try {
    chmodSync(file, 0o600);
  } catch {
    process.stderr.write(
      `Warning: ${file} is readable by other users and its permissions could not be narrowed (it may be owned by another user). Fix with: chmod 600 "${file}"\n`,
    );
  }
}

/** The one timestamp spelling every backup name uses: ISO-8601 with `:` and `.` as `-`. */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Keep `target`'s current BYTES under `${target}${infix}<time>` — a byte
 * COPY, created 0600 exclusively and fsync'd, its directory fsync'd — or
 * throw. Never a hard link for a readable file: a link is a second name for
 * the same inode, so any in-place write through the live name (an older
 * installed `motebit` CLI or desktop — version skew is the normal case for
 * an `npx` package) would rewrite the "kept" bytes. Only a file this process
 * cannot read is kept by hard link. The REAL file is kept, never a symlink's
 * name; a symlink that cannot be resolved is refused.
 */
export function preserveAside(target: string, infix: string, now: Date = new Date()): string {
  const real = resolveRealFile(target);
  const stamp = backupStamp(now);
  let lastErr: unknown;
  for (let n = 0; n < 100; n++) {
    const backup = `${target}${infix}${stamp}${n === 0 ? "" : `-${n}`}`;
    try {
      copyOwnerOnly(real, backup);
      fsyncDir(dirname(backup));
      return backup;
    } catch (copyErr) {
      const code = (copyErr as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (code !== "EACCES" && code !== "EPERM") {
        lastErr = copyErr;
        break;
      }
      try {
        linkSync(real, backup);
      } catch (linkErr) {
        if ((linkErr as NodeJS.ErrnoException).code === "EEXIST") continue;
        lastErr = linkErr;
        break;
      }
      try {
        chmodSync(backup, 0o600);
      } catch {
        /* another owner's inode — no more exposed than the original */
      }
      fsyncDir(dirname(backup));
      return backup;
    }
  }
  throw new Error(`could not preserve ${target} before replacing it; nothing was changed`, {
    cause: lastErr,
  });
}

/**
 * Move a key file out of its active name WITHOUT destroying its bytes: one
 * atomic rename to `${target}${infix}<time>` (owner-only; a symlink's target
 * bytes are copied and only the link removed), directory fsync'd. Returns
 * the kept path, `null` when nothing was there; throws — name left in place —
 * when the bytes cannot be kept.
 */
export function moveAside(target: string, infix: string, now: Date = new Date()): string | null {
  let st;
  try {
    st = lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (st.isSymbolicLink()) {
    const kept = preserveAside(target, infix, now);
    unlinkSync(target);
    fsyncDir(dirname(target));
    return kept;
  }
  const stamp = backupStamp(now);
  for (let n = 0; n < 100; n++) {
    const backup = `${target}${infix}${stamp}${n === 0 ? "" : `-${n}`}`;
    if (!isTrulyAbsent(backup)) continue;
    renameSync(target, backup);
    try {
      chmodSync(backup, 0o600);
    } catch {
      /* best effort */
    }
    fsyncDir(dirname(backup));
    return backup;
  }
  throw new Error(`could not find a free name to keep ${target} under; nothing was changed`);
}

/** The file `target` names, through symlinks; refuses when a link cannot be resolved. */
function resolveRealFile(target: string): string {
  try {
    return realpathSync(target);
  } catch (err) {
    let isLink = true;
    try {
      isLink = lstatSync(target).isSymbolicLink();
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
  const bytes = readFileSync(src);
  const fd = openSync(dest, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    rmSync(dest, { force: true });
    throw err;
  }
}

/**
 * Run `fn` holding the exclusive advisory lock `${target}.lock` — the SAME
 * lock the motebit CLI takes around its config compare-and-replace
 * (`apps/cli/src/durable-file.ts` `withFileLock`), so the two never
 * interleave. A lock whose holder is dead, or older than `staleMs`, is
 * broken; a live one is waited on for up to `timeoutMs`, then refused.
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
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  const staleMs = opts.staleMs ?? 30_000;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (fd != null) {
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      heldLocks.add(lock);
      try {
        return fn();
      } finally {
        heldLocks.delete(lock);
        try {
          unlinkSync(lock);
        } catch {
          /* already gone */
        }
      }
    }
    if (lockIsStale(lock, staleMs)) {
      try {
        unlinkSync(lock);
      } catch {
        /* another waiter broke it first */
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${target} is locked by another motebit process (${lock}); nothing was changed. If no other motebit command is running, remove that lock file and retry.`,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

/** Locks this process holds right now (for re-entrancy). */
const heldLocks = new Set<string>();

function lockIsStale(lock: string, staleMs: number): boolean {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(lock, "utf-8");
    mtimeMs = statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  const pid = Number.parseInt(raw, 10);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
  }
  return Date.now() - mtimeMs > staleMs;
}

/**
 * Replace a signed identity file (`motebit.md`): atomically, at its current
 * mode (`0644` when new), and — when the file there names a DIFFERENT
 * identity, or cannot be read to tell — only after its bytes are kept as
 * `${file}.clobbered-<time>`. Public, but binding material: for a legacy id
 * it is the only recovery path. Returns the kept path, or `null`.
 */
export function replaceIdentityFile(file: string, contents: string): string | null {
  let existing: string | null = null;
  let unreadable = false;
  try {
    existing = readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !isTrulyAbsent(file)) {
      unreadable = true;
    }
  }
  let kept: string | null = null;
  if (unreadable) {
    kept = preserveAside(file, CONFIG_BACKUP_INFIX);
  } else if (existing != null && existing !== contents) {
    const before = identityFileMotebitId(existing);
    if (before == null || before !== identityFileMotebitId(contents)) {
      kept = preserveAside(file, CONFIG_BACKUP_INFIX);
    }
  }
  writeFileAtomic(file, contents, currentModeOr(file, 0o644));
  return kept;
}

/** The `motebit_id` a signed identity file's YAML frontmatter names, or null. */
export function identityFileMotebitId(contents: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents);
  if (!fm) return null;
  const m = /^motebit_id:\s*["']?([^"'\s]+)["']?\s*$/m.exec(fm[1]!);
  return m ? m[1]! : null;
}

/** Where a `motebit rotate` keeps its write-ahead in a config directory (the CLI's `pending-rotation.ts`). */
export function pendingRotationPathIn(configDir: string): string {
  return join(configDir, "pending-rotation.json");
}
