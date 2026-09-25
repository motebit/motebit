/**
 * How create-motebit reads and replaces `config.json` — the file the motebit
 * CLI keeps its identity key in (`cli_encrypted_key`, for a CLI identity the
 * only copy of the private key). Three rules, identical to the CLI's:
 *
 *  1. Absence is not damage. ENOENT reads as `{}` (a first run); anything
 *     else unreadable, unparseable, or valid JSON that is not an object is
 *     DAMAGE and throws `ConfigDamagedError`, file untouched.
 *  2. Damage is never overwritten. A write over a damaged file first
 *     preserves its bytes as `config.json.clobbered-<time>` — the one backup
 *     name every motebit reader looks for — or refuses.
 *  3. A replacement is staged, fsync'd and renamed, owner-only (0600) from
 *     the moment it exists, scratch removed on every failure path, directory
 *     fsync'd after the rename.
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
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
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

/** Rule 1: absent ⇒ `{}`; damaged ⇒ throw; never "empty" for anything but absence. */
export function readConfigFile<T extends object>(path: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {} as T;
    throw new ConfigDamagedError(path, code ?? "unreadable", err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigDamagedError(path, "not valid JSON", err);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigDamagedError(path, "not a JSON object");
  }
  // A config written before owner-only was the rule is world-readable; a
  // read is the first chance to close that. Best effort, never a refusal.
  tightenToOwnerOnly(path);
  return parsed as T;
}

/**
 * Rules 2 + 3: replace the config at `path` atomically and owner-only,
 * preserving a damaged predecessor first. Returns the backup's path when one
 * was made.
 */
export function writeConfigFile(path: string, config: object): string | null {
  mkdirSync(dirname(path), { recursive: true });
  let preservedAs: string | null = null;
  try {
    readConfigFile(path);
  } catch (err) {
    if (!(err instanceof ConfigDamagedError)) throw err;
    preservedAs = preserveAside(path, CONFIG_BACKUP_INFIX);
  }
  writeFileAtomic(path, JSON.stringify(config, null, 2) + "\n", 0o600);
  return preservedAs;
}

/** Stage (exclusive create at `mode`, explicit chmod, fsync) → rename → fsync dir; scratch removed on failure. */
export function writeFileAtomic(requested: string, contents: string, mode: number): void {
  // Replace a symlink's TARGET, not the link (renaming over the link would
  // turn it into a regular file and orphan the real one).
  let target = requested;
  try {
    target = realpathSync(requested);
  } catch {
    /* not there yet — write it where it was named */
  }
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
  try {
    const dirFd = openSync(dirname(target), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Not every platform allows fsync on a directory; the rename is still atomic.
  }
}

/** The permission bits `file` has now, or `fallback` when it does not exist. */
export function currentModeOr(file: string, fallback: number): number {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return fallback;
  }
}

function tightenToOwnerOnly(file: string): void {
  try {
    const st = statSync(file);
    if (st.isFile() && (st.mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

/** The one timestamp spelling every backup name uses: ISO-8601 with `:` and `.` as `-`. */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** Keep `target`'s bytes under `${target}${infix}<time>` without reading them (hard link; copy as fallback), or throw. */
export function preserveAside(target: string, infix: string, now: Date = new Date()): string {
  // Link or copy the REAL file, never the name as given: link(2) on Linux
  // does not follow symlinks, so linking a symlinked config's NAME makes the
  // "backup" a second name for the link — reading the NEW bytes once
  // `writeFileAtomic` (which replaces the link's target) lands.
  const real = resolveRealFile(target);
  const stamp = backupStamp(now);
  let lastErr: unknown;
  for (let n = 0; n < 100; n++) {
    const backup = `${target}${infix}${stamp}${n === 0 ? "" : `-${n}`}`;
    try {
      linkSync(real, backup);
      try {
        chmodSync(backup, 0o600);
      } catch {
        /* best effort — the bytes are preserved */
      }
      return backup;
    } catch (linkErr) {
      if ((linkErr as NodeJS.ErrnoException).code === "EEXIST") continue;
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
