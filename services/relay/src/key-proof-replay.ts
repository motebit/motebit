/**
 * key-proof-replay — an accepted proof-of-possession body is accepted ONCE
 * (#875 review F2).
 *
 * A proof of possession (`verifyKeyPossession`: a device-registration request
 * signed by the key it names — bootstrap's body, register-self's body,
 * `/agents/register`'s `key_proof`) carries a timestamp and a ±5-minute
 * window but no audience and no nonce, and the wire format is not changed
 * while released clients send it. So within the window the same bytes could
 * be presented again — to this relay, or to another one (the cross-relay
 * replay is a stated limitation, `spec/device-self-registration-v1.md` §6.3).
 *
 * This relay records every proof it accepted, keyed by
 * (motebit_id, public_key, signature) — Ed25519 is deterministic, so the
 * same body is the same signature, and the three doors share one record (a
 * register-self body replayed at bootstrap is the same proof). An exact
 * replay is idempotent-only: the door answers as for a repeat and writes
 * nothing; it is never fresh evidence for a write the first acceptance did
 * not make. Rows outlive the window they guard and no longer
 * (`KEY_PROOF_RETENTION_MS`), pruned on every record.
 */
import type { DatabaseDriver } from "@motebit/persistence";

/** The doors that accept a proof of possession. */
export type KeyProofDoor = "bootstrap" | "register-self" | "register";

/**
 * How long an accepted proof is remembered: the verifier's ±5-minute window
 * on each side of the signed timestamp, plus a minute of slack. A replay
 * after that is refused as `stale` by the verifier itself.
 */
export const KEY_PROOF_RETENTION_MS = 11 * 60 * 1000;

export interface AcceptedKeyProof {
  motebitId: string;
  publicKey: string;
  signature: string;
}

/** The proof's identifying triple, or null when the body carries no string signature. */
export function keyProofOf(
  body: unknown,
  motebitId: string,
  publicKey: string,
): AcceptedKeyProof | null {
  if (body == null || typeof body !== "object") return null;
  const signature = (body as { signature?: unknown }).signature;
  return typeof signature === "string" && signature !== ""
    ? { motebitId, publicKey, signature }
    : null;
}

/** Whether this exact proof was already accepted (and is still inside its window). */
export function keyProofAccepted(db: DatabaseDriver, proof: AcceptedKeyProof): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM relay_key_proofs_accepted WHERE motebit_id = ? AND public_key = ? AND signature = ?",
      )
      .get(proof.motebitId, proof.publicKey, proof.signature) != null
  );
}

/** Record an accepted proof (idempotent) and prune proofs past their window. */
export function recordKeyProofAccepted(
  db: DatabaseDriver,
  proof: AcceptedKeyProof,
  door: KeyProofDoor,
  now: number,
): void {
  db.prepare("DELETE FROM relay_key_proofs_accepted WHERE accepted_at < ?").run(
    now - KEY_PROOF_RETENTION_MS,
  );
  db.prepare(
    `INSERT OR IGNORE INTO relay_key_proofs_accepted (motebit_id, public_key, signature, door, accepted_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(proof.motebitId, proof.publicKey, proof.signature, door, now);
}
