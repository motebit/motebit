/**
 * A rotation's write-ahead: the new key, encrypted, and the record that
 * introduces it — written BEFORE the request leaves this machine.
 *
 * Rotation is all-or-nothing, which leaves one moment the machine cannot
 * see into: the relay may have recorded the succession and the response was
 * lost. If the new private key existed only in memory then, the relay holds
 * a key this machine cannot produce, and the identity is gone with no way
 * back but its guardian. So the new key is durable before it is ever sent
 * (`docs/proposals/key-rotation-client-v1.md` invariant I2).
 *
 * What the file is NOT: a record to replay. The signed `timestamp` is inside
 * the signature and the relay refuses a new link older than fifteen minutes,
 * so the next run never re-presents this record — it READS the relay's
 * chain. If the relay already holds the new key, the run commits from here;
 * if it still holds the old one, a fresh record is minted and this one is
 * discarded unused. A held rotation therefore never blocks a new one.
 *
 * The new private key is held ENCRYPTED under the same passphrase as the
 * identity's key, because committing locally afterwards needs it. Owner-only
 * on disk. Removed the moment local state agrees with the relay.
 */
import * as fs from "node:fs";
import * as path from "node:path";
// Via the SDK, not `@motebit/protocol` directly: apps consume the product
// vocabulary, and the SDK re-exports every protocol type.
import type { KeySuccessionRecord } from "@motebit/sdk";
import { CONFIG_DIR, type FullConfig } from "./config.js";
import {
  isTrulyAbsent,
  mkdirOwnerOnly,
  moveAside,
  narrowOnLoad,
  writeFileAtomic,
} from "./durable-file.js";

export interface PendingRotation {
  motebit_id: string;
  /** The key this rotation departs from — it must still be the local key to matter. */
  old_public_key: string;
  new_public_key: string;
  record: KeySuccessionRecord;
  /** The new private key, encrypted under the identity's passphrase — the same shape `cli_encrypted_key` holds. */
  encrypted_new_key: NonNullable<FullConfig["cli_encrypted_key"]>;
  /** When it was written, so a stale one can be named as such in output. */
  written_at: number;
}

/**
 * Where the write-ahead lives on THIS machine — the one spelling, and a
 * literal join on `CONFIG_DIR` because that is the on-disk contract
 * `check-cli-surface` reads: a file the CLI writes under `~/.motebit` is part
 * of what an operator's scripts may pin to, and it must appear in the baseline.
 */
export const PENDING_ROTATION_PATH = path.join(CONFIG_DIR, "pending-rotation.json");

export function pendingRotationPath(dir: string = CONFIG_DIR): string {
  return path.join(dir, path.basename(PENDING_ROTATION_PATH));
}

export function savePendingRotation(pending: PendingRotation, dir: string = CONFIG_DIR): void {
  mkdirOwnerOnly(dir);
  const file = pendingRotationPath(dir);
  // Owner-only: it holds an encrypted private key, and the passphrase is
  // the only thing between that and the identity. Staged, fsync'd and
  // renamed so a crash mid-write leaves either the old file or the new one,
  // never a torn one — the same discipline as config.json (`durable-file.ts`).
  writeFileAtomic(file, JSON.stringify(pending, null, 2), 0o600);
}

/**
 * What a read of the write-ahead can find. `null` is ABSENCE only. A file
 * that exists but cannot be read, does not parse, or lacks a field is
 * `"unreadable"` — never `null`: it may be the only copy of a new key the
 * relay has already accepted, and a caller that took it for "nothing held"
 * would clear it (the same rule config.json obeys, `config.ts`).
 */
export type PendingRotationRead = PendingRotation | null | "unreadable";

/**
 * The held rotation, if it is one THIS identity, from THIS key, could still
 * have in flight. A record departing from a key this machine no longer
 * holds is evidence of a different problem (an older config restored over a
 * newer one), not an instruction — it is reported by the caller and cleared.
 * `"unreadable"` passes through: whose it is cannot be known.
 */
export function loadPendingRotation(
  motebitId: string,
  currentPublicKey: string,
  dir: string = CONFIG_DIR,
): PendingRotationRead {
  const pending = loadAnyPendingRotation(dir);
  if (pending == null || pending === "unreadable") return pending;
  if (pending.motebit_id !== motebitId || pending.old_public_key !== currentPublicKey) return null;
  return pending;
}

/**
 * Whatever write-ahead exists, whoever it belongs to — for reconciliation
 * (a crash between the two local commit writes leaves the identity file and
 * the config on different keys, and the write-ahead is what bridges them)
 * and for naming a stale one before it is cleared. `null` only when there is
 * none; `"unreadable"` when there is one that cannot be used.
 */
export function loadAnyPendingRotation(dir: string = CONFIG_DIR): PendingRotationRead {
  let raw: string;
  try {
    raw = fs.readFileSync(pendingRotationPath(dir), "utf-8");
  } catch (err) {
    // Only ENOENT of the NAME is absence: a dangling symlink reads ENOENT
    // too, and it is something there that cannot be read.
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && isTrulyAbsent(pendingRotationPath(dir)))
      return null;
    narrowOnLoad(pendingRotationPath(dir));
    return "unreadable";
  }
  // It holds an encrypted private key: one written world-readable (by an
  // older version, or by hand) is narrowed on load, as config.json is.
  narrowOnLoad(pendingRotationPath(dir));
  let pending: unknown;
  try {
    pending = JSON.parse(raw);
  } catch {
    return "unreadable";
  }
  if (pending === null || typeof pending !== "object" || Array.isArray(pending)) {
    return "unreadable";
  }
  const p = pending as Partial<PendingRotation>;
  if (typeof p.motebit_id !== "string" || typeof p.old_public_key !== "string") {
    return "unreadable";
  }
  if (typeof p.new_public_key !== "string" || p.record == null) return "unreadable";
  if (p.encrypted_new_key == null) return "unreadable";
  return p as PendingRotation;
}

/** Infix of a set-aside write-ahead: `pending-rotation.json.clobbered-<time>` (listed by `doctor`). */
export const PENDING_ROTATION_SET_ASIDE_INFIX = ".clobbered-";

/**
 * Move a write-ahead out of the active slot WITHOUT destroying it — the
 * surface-kit port's `setAside` verb. Its bytes become
 * `pending-rotation.json.clobbered-<time>` (owner-only) in one atomic
 * rename, so a write-ahead a concurrent `motebit rotate` saved an instant
 * earlier is kept, never unlinked. Used for every write-ahead that may hold
 * a key the relay accepted: another identity's, an unreadable one, one a
 * fresh rotation supersedes, one the relay refused. Throws — leaving the
 * file where it is — when the bytes cannot be kept. Returns the kept path,
 * or `null` when there was nothing to move.
 */
export function setAsidePendingRotation(dir: string = CONFIG_DIR): string | null {
  return moveAside(pendingRotationPath(dir), PENDING_ROTATION_SET_ASIDE_INFIX);
}

/**
 * Whether ANY write-ahead exists, readable or not. Rule R1: only ENOENT of
 * the name is absence — `existsSync` is also false for a dangling symlink
 * or a directory this process cannot search, both of which are something
 * there.
 */
export function hasPendingRotation(dir: string = CONFIG_DIR): boolean {
  return !isTrulyAbsent(pendingRotationPath(dir));
}

/**
 * DELETE the write-ahead. Only for one whose key is now durably the
 * committed key (the relay recorded the succession and the local commit
 * applied — the kit's post-commit `clear`): it holds nothing the config does
 * not. Every other removal goes through `setAsidePendingRotation`.
 */
export function clearPendingRotation(dir: string = CONFIG_DIR): void {
  try {
    fs.unlinkSync(pendingRotationPath(dir));
  } catch {
    // Nothing held, or already gone.
  }
}
