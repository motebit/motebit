/**
 * Applying a key succession — ONE writer for the two doors that record one.
 *
 * `/api/v1/agents/:id/rotate-key` and the succession path of
 * `/api/v1/agents/register` both accept a signed `KeySuccessionRecord`.
 * Until #702's relay half, only the first retired the old key: the register
 * door recorded the link and moved the registry key but left every device
 * row — the place a bearer is verified against FIRST (`auth.ts`) — on the
 * retired key, and left any pairing approval carrying it able to write it
 * back through a bearer-less route. That is a rotation that ended nothing,
 * reachable from a shipped client. A second route that "finishes" what the
 * first left half-done is a state machine with a state nobody wants; this
 * module makes the state unrepresentable instead
 * (`docs/doctrine/composition-preserves-enforcement.md`): both doors call
 * `applySuccession`, so a recorded link and an applied one are the same
 * thing.
 *
 * Every write is idempotent and scoped to the key being retired, so a retry
 * after a lost response converges on the same state as the first attempt.
 * The chain grows only when the link is not already its head — "held" means
 * HEAD, not "some earlier row with these two keys": a legitimate rotation
 * back to a previously used key (K1→K2, K2→K1, K1→K2 again) is a new link
 * and must append, or the served chain stops at a key the registry has left
 * and every external verifier reports it broken.
 */
import type { DatabaseDriver } from "@motebit/persistence";
import type { KeySuccessionRecord } from "@motebit/encryption";
import { recordIdentityKey } from "./identity-keys.js";

interface ChainHead {
  old_public_key: string;
  new_public_key: string;
}

/** The newest link this relay has recorded for the identity, if any. */
export function successionHead(db: DatabaseDriver, motebitId: string): ChainHead | undefined {
  return db
    .prepare(
      "SELECT old_public_key, new_public_key FROM relay_key_successions WHERE motebit_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(motebitId) as ChainHead | undefined;
}

/**
 * Is this record the link the relay recorded LAST for the identity? Only
 * then is a re-presentation a retry rather than a new rotation — and only
 * then may a route skip the freshness and key-on-file rules, because the
 * relay already accepted this exact record once and the key it departs
 * from has by definition moved on.
 */
export function successionAtHead(
  db: DatabaseDriver,
  motebitId: string,
  record: Pick<KeySuccessionRecord, "old_public_key" | "new_public_key">,
): boolean {
  const head = successionHead(db, motebitId);
  return (
    head !== undefined &&
    head.old_public_key === record.old_public_key &&
    head.new_public_key === record.new_public_key
  );
}

/**
 * The key this relay holds for an identity, and whether a rotation may
 * depart from a given key — the ONE precedence rule, in precedence order
 * (`services/relay/CLAUDE.md` rule 21, `spec/identity-v1.md` §7.5): the
 * registry key; else the head of the chain this relay has already recorded;
 * else a key one of the identity's device rows holds. Refusing when it holds
 * none is fail-closed.
 *
 * Exported because a CLIENT must be able to ask this question before it
 * mints anything (`docs/proposals/key-rotation-client-v1.md` D3), and a
 * client that re-derives it from the served chain and registry key alone
 * gets it wrong in both directions: it cannot see device rows (a daemon that
 * shut down leaves its key only there), and its precedence inverts the
 * relay's whenever registry and chain disagree. So the public succession
 * route serves this function's answer, and `/rotate-key` enforces it — same
 * function, so they cannot disagree.
 */
export interface KeyOnFile {
  /** The registry key, when the row exists and holds one (`''` is not a key). */
  registryKey: string | null;
  /** The `new_public_key` of the newest recorded link, by insertion order. */
  chainHead: string | null;
  /** The single most authoritative key: registry, else chain head, else null. */
  held: string | null;
}

export function keyOnFile(db: DatabaseDriver, motebitId: string): KeyOnFile {
  // The ONE holder answers first (#703 Inc 2); the registry and chain rungs
  // stay named because a departure verdict reports which rung it used.
  const held = db
    .prepare("SELECT public_key FROM identity_keys WHERE motebit_id = ?")
    .get(motebitId) as { public_key: string } | undefined;
  const row = db
    .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
    .get(motebitId) as { public_key: string | null } | undefined;
  const registryKey =
    held?.public_key ?? (row?.public_key != null && row.public_key !== "" ? row.public_key : null);
  const chainHead = successionHead(db, motebitId)?.new_public_key ?? null;
  return { registryKey, chainHead, held: registryKey ?? chainHead };
}

export type Departure =
  | { admissible: true; rung: "registry" | "chain" | "device" }
  | {
      admissible: false;
      reason: "not_from_current_key" | "not_from_chain_head" | "no_key_on_file";
    };

/** May a succession departing from `key` be recorded for this identity? */
export function departureFrom(db: DatabaseDriver, motebitId: string, key: string): Departure {
  const { registryKey, chainHead } = keyOnFile(db, motebitId);
  if (registryKey !== null) {
    return registryKey === key
      ? { admissible: true, rung: "registry" }
      : { admissible: false, reason: "not_from_current_key" };
  }
  if (chainHead !== null) {
    return chainHead === key
      ? { admissible: true, rung: "chain" }
      : { admissible: false, reason: "not_from_chain_head" };
  }
  const heldByDevice = db
    .prepare("SELECT 1 FROM devices WHERE motebit_id = ? AND public_key = ? LIMIT 1")
    .get(motebitId, key);
  return heldByDevice != null
    ? { admissible: true, rung: "device" }
    : { admissible: false, reason: "no_key_on_file" };
}

export interface SuccessionApplied {
  /** Whether the chain grew. False for a retry of the link already at its head. */
  applied: boolean;
}

/**
 * Everything a recorded rotation changes, in ONE transaction. Written as
 * separate statements, a crash between them left the registry saying the
 * new key while the device rows still verified tokens under the old one —
 * and from there the owner could not rotate again (the record no longer
 * departs from the stored key), could not re-register (the row disagrees)
 * and could not authenticate. There was no way back without the operator.
 *
 * Devices are written FIRST for the same reason: if this ever stops being
 * one transaction, the half-applied state that remains is the recoverable
 * one.
 *
 * The caller has verified the record's signatures and decided whether it is
 * admissible (freshness, key on file). This function only applies it.
 */
export function applySuccession(
  db: DatabaseDriver,
  motebitId: string,
  record: KeySuccessionRecord,
): SuccessionApplied {
  return db.transaction((): SuccessionApplied => {
    const atHead = successionAtHead(db, motebitId, record);

    // The old key stops being a credential HERE. A device row's `public_key`
    // is what an owner token is verified against, and it is resolved BEFORE
    // the registry key, so a stale row shadows the rotation entirely. Scoped
    // to rows holding the key being retired: a device linked without key
    // transfer holds its own key, which this rotation is not about
    // (`docs/doctrine/security-boundaries.md` — rotating an identity must
    // not rotate independent device keypairs). The attached
    // hardware-attestation credential names the key it was bound to
    // (`sync-routes.ts` refuses a mismatch at attach time), so carrying it
    // across a rotation would publish a credential naming a key the row no
    // longer holds — dropped, so the device re-attaches against the key it
    // now holds.
    db.prepare(
      "UPDATE devices SET public_key = ?, hardware_attestation_credential = NULL WHERE motebit_id = ? AND public_key = ?",
    ).run(record.new_public_key, motebitId, record.old_public_key);

    // A pairing session approved before this rotation carries the key that
    // was just retired, and pairing's key-transfer route takes no bearer.
    // Left alone, whoever holds that pairing id could write the retired key
    // back onto a device row and authenticate again — the rotation undone by
    // an unauthenticated route. Clearing the payload is what makes that
    // route refuse ("this session approved none"); `status` is left alone
    // because clients switch on its values. Scoped to approvals carrying the
    // key being retired — clearing every session would strand a pairing
    // approved under a key this rotation is not about, mid-transfer and with
    // no signal. A payload this relay cannot read cannot be shown to be
    // safe, so an invalid one is cleared too.
    db.prepare(
      `UPDATE pairing_sessions SET key_transfer_payload = NULL
       WHERE motebit_id = ? AND key_transfer_payload IS NOT NULL
         AND (json_valid(key_transfer_payload) = 0
              OR json_extract(key_transfer_payload, '$.identity_pubkey_check') = ?)`,
    ).run(motebitId, record.old_public_key);

    // The registry key moves only FROM the key this link retires, or into an
    // empty slot (a master-token registration writes `''`). Unscoped, a
    // stray re-presentation of an old link could drag a registry that had
    // moved on to a later key back to this one, and the next rotation,
    // departing from the real head, would be refused as "not from the
    // current key". Filling an empty slot is always right here: a fresh link
    // becomes the head, and a retry is at the head by definition.
    db.prepare(
      "UPDATE agent_registry SET public_key = ? WHERE motebit_id = ? AND (public_key = ? OR COALESCE(public_key, '') = '')",
    ).run(record.new_public_key, motebitId, record.old_public_key);
    // The one holder moves with the chain, in the same transaction (#703 Inc 2).
    recordIdentityKey(db, {
      motebitId,
      publicKey: record.new_public_key,
      source: "succession",
      now: Date.now(),
    });

    // The chain grows unless this link is already its head. A lost response
    // and a retry must not append the same link twice: the chain is served
    // in timestamp order, and two identical links make a history a verifier
    // cannot walk. Everything above still ran — that is the point.
    if (atHead) return { applied: false };
    db.prepare(
      `INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature, recovery, guardian_signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      motebitId,
      record.old_public_key,
      record.new_public_key,
      record.timestamp,
      record.reason ?? null,
      record.old_key_signature ?? null,
      record.new_key_signature,
      record.recovery ? 1 : 0,
      record.guardian_signature ?? null,
    );
    return { applied: true };
  });
}
