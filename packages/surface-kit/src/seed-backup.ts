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
import { boundIdentityFile, type BoundIdentityFile } from "./machine-roster-identity-file.js";

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
 *     (`deriveSovereignMotebitId`) — unless every identity file bound to it
 *     was signed after the acknowledgment (see `legacyAckCoversCurrentKey`:
 *     the date evidence binds this rule too); or
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
  /** Clock for the future-acknowledgment check; defaults to `Date.now`. */
  now?: () => number;
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
  const now = (input.now ?? Date.now)();
  // An acknowledgment dated in the future cannot be ordered against any
  // file: the date rules are unproven, so nothing is honoured.
  if (ack.at > now + ACK_FUTURE_SKEW_MS) return { status: "not_backed_up", reason: "unconfirmed" };
  if (current !== "" && motebitId != null && motebitId !== "") {
    if (await legacyAckCoversCurrentKey(current, motebitId, ack.at, input.identityFiles ?? [])) {
      return { status: "backed_up", at: ack.at };
    }
  }
  return { status: "not_backed_up", reason: "unconfirmed" };
}

/** How far in the future an acknowledgment may be dated (clock skew) before it is unproven. */
export const ACK_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Does a legacy acknowledgment made at `ackAt` provably cover `current`?
 * Never throws; false on any doubt.
 *
 * The date evidence comes first and binds BOTH rules: when this surface
 * holds any identity file bound to the current key, at least one of them
 * must have been signed at or before the acknowledgment. If every one was
 * signed after it (or carries no usable date), the current key's own record
 * starts after the acknowledgment, so nothing says the acknowledgment was
 * for it — even a sovereign (v8) id derived from it. That is the state
 * main's create-motebit replace left on disk: an old identity's unbound
 * acknowledgment, a new identity minted with a v8 id, and the new
 * identity's motebit.md written at mint time, after the acknowledgment.
 * With no bound file at all, the v8 rule stands alone.
 *
 * KNOWN DEPENDENCY (spec/identity-v1.md §3.1 defines `created_at` as the
 * identity's creation time; this proof reads it as the time the file was
 * SIGNED). Every writer in this repo stamps `created_at` at write time —
 * `@motebit/identity-file` `generate` (the CLI's export, the desktop, web
 * and mobile surfaces) and create-motebit's `generateIdentity` /
 * `regenerateIdentityFile` — and
 * `src/__tests__/seed-backup-writers.test.ts` goes red if one stops. A
 * writer that PRESERVED a genesis `created_at` on a fresh file (for a later
 * key, or with the succession chain dropped) would make this proof unsound:
 * it could date a file "before" an acknowledgment that never covered its
 * key.
 */
async function legacyAckCoversCurrentKey(
  current: string,
  motebitId: string,
  ackAt: number,
  identityFiles: readonly (string | null | undefined)[],
): Promise<boolean> {
  const bound: BoundIdentityFile[] = [];
  for (const content of identityFiles) {
    const b = await boundIdentityFile(motebitId, content ?? null, current);
    if (b != null) bound.push(b);
  }
  const signedByAck = (b: BoundIdentityFile): boolean =>
    b.createdAtMs != null && b.createdAtMs <= ackAt;
  // Files for this key exist, and every one was signed after the
  // acknowledgment: it cannot have been for this key.
  if (bound.length > 0 && !bound.some(signedByAck)) return false;
  let sovereign = false;
  try {
    sovereign = (await deriveSovereignMotebitId(current)) === motebitId.toLowerCase();
  } catch {
    sovereign = false; // malformed key: not proven
  }
  if (sovereign) return true;
  // A zero-succession file signed no later than the acknowledgment.
  return bound.some((b) => b.records.length === 0 && signedByAck(b));
}

/**
 * What a flat surface says, once, when a rotation commits. The recovery
 * seed is the key, so it changed; the old one still recovers the retired
 * key (and whatever its address holds), so it is kept, not thrown away.
 */
export const ROTATION_SEED_BACKUP_NOTICE =
  "Your recovery seed changed with the key. The seed you saved before recovers only the retired key — keep it, and back up the new one from Settings → Identity → Recovery seed.";
