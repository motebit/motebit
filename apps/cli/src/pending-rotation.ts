/**
 * A rotation that has been sent to the relay but not yet committed here.
 *
 * Rotation is all-or-nothing, which means there is a moment where the
 * relay may have recorded the succession and this machine does not know
 * it: the response was lost, or the request timed out after the relay
 * committed. Without a record of what was sent, the next run mints a
 * FRESH keypair and a record departing from a key the relay has already
 * retired — which it refuses, permanently. The identity is then stranded
 * with no way back but its guardian.
 *
 * Holding the record is what makes the relay's "already recorded" answer
 * reachable: the next run re-presents the SAME record, the relay says it
 * has it, and local state is committed to match. Either the relay had it
 * or it takes it now; both converge.
 *
 * The new private key is held ENCRYPTED under the same passphrase as the
 * identity's key, because committing locally afterwards needs it. The
 * file is removed the moment local state agrees with the relay.
 */
import * as fs from "node:fs";
import * as path from "node:path";
// Via the SDK, not `@motebit/protocol` directly: apps consume the product
// vocabulary, and the SDK re-exports every protocol type.
import type { KeySuccessionRecord } from "@motebit/sdk";
import { CONFIG_DIR } from "./config.js";

export interface PendingRotation {
  motebit_id: string;
  /** The key this rotation departs from — it must still be the local key to resume. */
  old_public_key: string;
  new_public_key: string;
  record: KeySuccessionRecord;
  /** The new private key, encrypted under the identity's passphrase — the same shape `cli_encrypted_key` holds. */
  encrypted_new_key: { ciphertext: string; nonce: string; tag: string; salt: string };
}

function pendingPath(): string {
  return path.join(CONFIG_DIR, "pending-rotation.json");
}

export function savePendingRotation(pending: PendingRotation): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Owner-only: it holds an encrypted private key, and the passphrase is
  // the only thing between that and the identity.
  fs.writeFileSync(pendingPath(), JSON.stringify(pending, null, 2), { mode: 0o600 });
}

/**
 * The held rotation, if it is one THIS identity can still finish. A record
 * departing from a key this machine no longer holds cannot be resumed —
 * it is evidence of a different problem, not an instruction.
 */
export function loadPendingRotation(
  motebitId: string,
  currentPublicKey: string,
): PendingRotation | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pendingPath(), "utf-8");
  } catch {
    return null;
  }
  try {
    const pending = JSON.parse(raw) as PendingRotation;
    if (pending.motebit_id !== motebitId) return null;
    if (pending.old_public_key !== currentPublicKey) return null;
    return pending;
  } catch {
    return null;
  }
}

export function clearPendingRotation(): void {
  try {
    fs.unlinkSync(pendingPath());
  } catch {
    // Nothing held, or already gone.
  }
}
