/**
 * Seed-backup acknowledgment, bound to the key it covers.
 *
 * A recovery seed IS one Ed25519 private key, and a key rotation mints a
 * new random key (`rotateIdentityKeys`). So an acknowledgment that the
 * owner wrote the seed down covers exactly one public key — the one that
 * seed derives — and nothing after it. An acknowledgment stored as a bare
 * timestamp outlived the key it covered: after a committed rotation the
 * surface kept saying "backed up" while the paper seed recovered only the
 * RETIRED key.
 *
 * The rule here is structural, not a clear-at-commit step: the posture is a
 * function of (the key the acknowledgment names, the identity's current
 * key). A committed rotation changes the current key, so every surface that
 * reads its posture through this function sees "not backed up" from the
 * moment the new key is committed — including a commit finished on a later
 * resume, and on any code path that never thought about backups. An
 * abandoned or refused rotation leaves the current key where it was, so the
 * posture is unchanged. Nothing is written, so nothing is destroyed: the
 * old acknowledgment stays as the record of which (now retired) key the old
 * paper seed recovers — still the only way to sweep the retired address.
 *
 * Local configuration only. Never wire.
 */
import { deriveSovereignMotebitId } from "@motebit/encryption";

/** What a surface has recorded about a seed backup. */
export interface SeedBackupAcknowledgment {
  /** When the owner confirmed writing the seed down (absent ⇒ never). */
  at?: number;
  /**
   * The public key (hex) of the seed the owner confirmed. Absent on an
   * acknowledgment recorded before the binding existed (legacy).
   */
  publicKeyHex?: string;
}

export type SeedBackupPosture =
  /** The acknowledgment covers the identity's current key. */
  | { status: "backed_up"; at: number }
  /** Never acknowledged. */
  | { status: "not_backed_up"; stale: false }
  /**
   * Acknowledged, but for a key that is not the current one (a rotation
   * since), or a legacy unbound acknowledgment that cannot be shown to
   * cover the current key. The recorded seed recovers only a retired key.
   */
  | { status: "not_backed_up"; stale: true; coveredPublicKeyHex: string | null };

/**
 * The posture of a seed backup for the identity's CURRENT key.
 *
 * A legacy acknowledgment (no key recorded) is honoured only when the
 * current key is provably the identity's genesis key: the motebit_id is
 * the sovereign commitment to it (`deriveSovereignMotebitId`). A sovereign
 * identity's current key stops being its genesis key at its first
 * rotation, forever, so an already-rotated owner who upgrades reads "not
 * backed up". A legacy (random) motebit_id cannot prove that either way,
 * so its unbound acknowledgment is not honoured: one re-confirmation, never
 * a false "backed up".
 */
export async function seedBackupPosture(input: {
  ack: SeedBackupAcknowledgment;
  currentPublicKeyHex: string | null | undefined;
  motebitId: string | null | undefined;
}): Promise<SeedBackupPosture> {
  const { ack, currentPublicKeyHex, motebitId } = input;
  if (typeof ack.at !== "number") return { status: "not_backed_up", stale: false };
  const current = (currentPublicKeyHex ?? "").toLowerCase();
  if (typeof ack.publicKeyHex === "string" && ack.publicKeyHex !== "") {
    const covered = ack.publicKeyHex.toLowerCase();
    return current !== "" && covered === current
      ? { status: "backed_up", at: ack.at }
      : { status: "not_backed_up", stale: true, coveredPublicKeyHex: covered };
  }
  // Legacy, unbound.
  if (current !== "" && motebitId != null && motebitId !== "") {
    let genesis = false;
    try {
      genesis = (await deriveSovereignMotebitId(current)) === motebitId.toLowerCase();
    } catch {
      genesis = false; // malformed key: fail closed
    }
    if (genesis) return { status: "backed_up", at: ack.at };
  }
  return { status: "not_backed_up", stale: true, coveredPublicKeyHex: null };
}

/**
 * What a flat surface says, once, when a rotation commits. The recovery
 * seed is the key, so it changed; the old one still recovers the retired
 * key (and whatever its address holds), so it is kept, not thrown away.
 */
export const ROTATION_SEED_BACKUP_NOTICE =
  "Your recovery seed changed with the key. The seed you saved before recovers only the retired key — keep it, and back up the new one from Settings → Identity → Recovery seed.";
