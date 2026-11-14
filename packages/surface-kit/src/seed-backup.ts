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
import { boundIdentityFile } from "./machine-roster-identity-file.js";

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
  | { status: "not_backed_up"; reason: "never" }
  /**
   * Acknowledged for a KNOWN key that is not the current one (a rotation
   * since): the recorded seed recovers only that retired key. The only
   * variant a surface may describe as "a retired key".
   */
  | { status: "not_backed_up"; reason: "retired_key"; coveredPublicKeyHex: string }
  /**
   * Acknowledged, but which key it covers is unknown (a legacy, unbound
   * acknowledgment no evidence ties to the current key). Nothing says the
   * key is retired: the honest ask is to re-confirm the seed.
   */
  | { status: "not_backed_up"; reason: "unconfirmed" };

/**
 * The posture of a seed backup for the identity's CURRENT key.
 *
 * A legacy acknowledgment (no key recorded) is honoured only when the
 * current key is provably the identity's genesis key — the only key it
 * ever had, so the only one the acknowledgment can have covered. Either:
 *
 *   - the motebit_id is the sovereign commitment to it
 *     (`deriveSovereignMotebitId`); or
 *   - an identity file this surface holds is BOUND to it
 *     (`boundIdentityFile`: signature and chain verify, it names this
 *     motebit_id, its current key is the current key), records ZERO
 *     successions, AND was signed no later than the acknowledgment (its
 *     signed `created_at` ≤ `ack.at`). The last condition is load-bearing:
 *     a zero-succession file can be REGENERATED for the current key after
 *     a rotation (create-motebit's regenerate path signs a fresh one, dated
 *     now), and a file signed after the acknowledgment proves nothing about
 *     what that acknowledgment covered. One signed before it does: keys
 *     only move forward, so the key it names was already current at signing
 *     and is still current now — it was the key the owner was shown.
 *     Works for a legacy (random) motebit_id too.
 *
 * Any rotation ends both proofs, so an already-rotated owner who upgrades
 * reads "not backed up". Without either proof the coverage is unknown:
 * `unconfirmed`, never `retired_key`. A false alarm costs one prompt; a
 * false "backed up" can cost funds — so every doubt reads `unconfirmed`.
 */
export async function seedBackupPosture(input: {
  ack: SeedBackupAcknowledgment;
  currentPublicKeyHex: string | null | undefined;
  motebitId: string | null | undefined;
  /** Identity file contents (motebit.md) this surface can read. Untrusted: each is verified here. */
  identityFiles?: readonly (string | null | undefined)[];
}): Promise<SeedBackupPosture> {
  const { ack, currentPublicKeyHex, motebitId } = input;
  if (typeof ack.at !== "number") return { status: "not_backed_up", reason: "never" };
  const current = (currentPublicKeyHex ?? "").toLowerCase();
  if (typeof ack.publicKeyHex === "string" && ack.publicKeyHex !== "") {
    const covered = ack.publicKeyHex.toLowerCase();
    if (current === "") return { status: "not_backed_up", reason: "unconfirmed" };
    return covered === current
      ? { status: "backed_up", at: ack.at }
      : { status: "not_backed_up", reason: "retired_key", coveredPublicKeyHex: covered };
  }
  // Legacy, unbound.
  if (current !== "" && motebitId != null && motebitId !== "") {
    if (await isGenesisKey(current, motebitId, ack.at, input.identityFiles ?? [])) {
      return { status: "backed_up", at: ack.at };
    }
  }
  return { status: "not_backed_up", reason: "unconfirmed" };
}

/**
 * Is `current` provably the key the acknowledgment (made at `ackAt`)
 * covered? Never throws; false on any doubt.
 */
async function isGenesisKey(
  current: string,
  motebitId: string,
  ackAt: number,
  identityFiles: readonly (string | null | undefined)[],
): Promise<boolean> {
  try {
    if ((await deriveSovereignMotebitId(current)) === motebitId.toLowerCase()) return true;
  } catch {
    // malformed key: not proven
  }
  for (const content of identityFiles) {
    const bound = await boundIdentityFile(motebitId, content ?? null, current);
    if (bound == null || bound.records.length !== 0) continue;
    // Signed after the acknowledgment (or undated): proves nothing about it.
    if (bound.createdAtMs != null && bound.createdAtMs <= ackAt) return true;
  }
  return false;
}

/**
 * What a flat surface says, once, when a rotation commits. The recovery
 * seed is the key, so it changed; the old one still recovers the retired
 * key (and whatever its address holds), so it is kept, not thrown away.
 */
export const ROTATION_SEED_BACKUP_NOTICE =
  "Your recovery seed changed with the key. The seed you saved before recovers only the retired key — keep it, and back up the new one from Settings → Identity → Recovery seed.";
