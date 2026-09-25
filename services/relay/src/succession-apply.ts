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
 * HEAD, not "some earlier row with these two keys".
 *
 * A key never enters an identity's history twice (#775). A rotation back to
 * a key the identity has held (K1→K2, K2→K1) used to be recorded as a new
 * link; every roster consumer then refuses the chain as `duplicate_key`
 * (`spec/machine-roster-v1.md` §6) with no way back, and the rotate-back put
 * the holder on K1 again, which made an earlier guardian recovery K1→K2
 * re-presentable by anyone inside its freshness window — undoing it. So
 * `applySuccession` refuses, before writing anything, a record that is not
 * the head retry and either re-presents a link already recorded or
 * introduces a key the identity has held (`successionReuse`).
 */
import type { DatabaseDriver } from "@motebit/persistence";
import type { KeySuccessionRecord } from "@motebit/encryption";
import {
  chainHeadOf,
  holderKeyOf,
  identityKey,
  recordIdentityKey,
  registryKeyOf,
} from "./identity-keys.js";

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

/** Why a succession was refused as a reuse of the identity's key history. */
export type SuccessionReuse = "replays_recorded_link" | "reuses_key";

export const SUCCESSION_REUSE_MESSAGES: Readonly<Record<SuccessionReuse, string>> = {
  replays_recorded_link:
    "Succession link is already recorded for this identity and is not its latest link — a recorded link is never applied again",
  reuses_key:
    "Succession new_public_key is a key this identity has already held — a key never enters an identity's history twice",
};

/** Thrown by `applySuccession` for a record `successionReuse` refuses. Nothing was written. */
export class SuccessionRefused extends Error {
  constructor(readonly reason: SuccessionReuse) {
    super(SUCCESSION_REUSE_MESSAGES[reason]);
    this.name = "SuccessionRefused";
  }
}

/**
 * Would recording this link repeat the identity's key history? (#775,
 * `spec/identity-v1.md` §7.5 obligation 3.)
 *
 *  - The head link re-presented is a retry (`successionAtHead`), never a
 *    reuse: it changes nothing.
 *  - Any other link whose `(old, new)` pair is already recorded, at any
 *    position, is `replays_recorded_link`: a recorded link is never applied
 *    a second time (a guardian recovery re-presented after the identity
 *    moved on would otherwise drag the holder back).
 *  - A `new_public_key` equal to any key the recorded chain names (either
 *    side of any link), the holder's key or the registry key is
 *    `reuses_key`.
 *
 * Compared lowercase: spellings of one key are one key, and a history that
 * repeated a key under another spelling repeats it for every verifier that
 * decodes the hex. Device rows are not consulted — a paired device holds
 * its own key, which is not the identity's history.
 */
export function successionReuse(
  db: DatabaseDriver,
  motebitId: string,
  record: Pick<KeySuccessionRecord, "old_public_key" | "new_public_key">,
): SuccessionReuse | null {
  if (successionAtHead(db, motebitId, record)) return null;
  const links = db
    .prepare(
      "SELECT old_public_key, new_public_key FROM relay_key_successions WHERE motebit_id = ?",
    )
    .all(motebitId) as ChainHead[];
  const oldKey = record.old_public_key.toLowerCase();
  const newKey = record.new_public_key.toLowerCase();
  if (
    links.some(
      (l) => l.old_public_key.toLowerCase() === oldKey && l.new_public_key.toLowerCase() === newKey,
    )
  ) {
    return "replays_recorded_link";
  }
  const history = new Set<string>();
  for (const l of links) {
    history.add(l.old_public_key.toLowerCase());
    history.add(l.new_public_key.toLowerCase());
  }
  for (const k of [holderKeyOf(db, motebitId), registryKeyOf(db, motebitId)]) {
    if (k != null) history.add(k.toLowerCase());
  }
  return history.has(newKey) ? "reuses_key" : null;
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
  /** The one holder's key (`identity_keys`), when a door has recorded one. */
  holderKey: string | null;
  /** The registry key, when the row exists and holds one (`''` is not a key). */
  registryKey: string | null;
  /** The `new_public_key` of the newest recorded link, by insertion order. */
  chainHead: string | null;
  /**
   * What a rotation departs from (§5i, build 4): the holder when the identity
   * has proven one; otherwise EXACTLY main's answer — registry key, else chain
   * head. (What the relay SERVES is the holder alone — `identityKey`.)
   */
  held: string | null;
}

/**
 * The rungs are reported by name so a departure verdict can say which one
 * answered; `held` comes from the one authority, not from the rungs listed
 * beside it. A device row is not a rung here (§5a A4): a paired device holds
 * its own key, and a rotation must not depart from a key the identity never
 * held. The reader that answers "what key does the relay serve" is
 * `identityKeyFor`; this is "what key may a rotation depart from".
 */
export function keyOnFile(db: DatabaseDriver, motebitId: string): KeyOnFile {
  return {
    holderKey: holderKeyOf(db, motebitId),
    registryKey: registryKeyOf(db, motebitId),
    chainHead: chainHeadOf(db, motebitId),
    held:
      identityKey(db, motebitId)?.publicKey ??
      registryKeyOf(db, motebitId) ??
      chainHeadOf(db, motebitId),
  };
}

export type Departure =
  | { admissible: true; rung: "holder" | "registry" | "chain" | "device" }
  | {
      admissible: false;
      reason: "not_from_current_key" | "not_from_chain_head" | "no_key_on_file";
    };

/**
 * May a succession departing from `key` be recorded for this identity?
 *
 * Build 4 (§5i): the HOLDER when the identity has proven one — exactly, in its
 * stored spelling (DA1). Otherwise EXACTLY main's rule: the registry key, else
 * the recorded chain head, else a device row holding exactly `key` (#736).
 * Build 3 made the holder the only departure authority and stranded states
 * main supports (#753 C1: chain-only identities; C2: operator identities with
 * a device row); for an identity with no holder this is main's rule by
 * construction, so no rotation or recovery main allows can be refused. What
 * the relay SERVES stays the holder alone (`identityKey`) — that half is what
 * closed G1's actual harm, an unproven key served and anchored.
 */
export function departureFrom(db: DatabaseDriver, motebitId: string, key: string): Departure {
  const held = holderKeyOf(db, motebitId);
  if (held !== null) {
    return held === key
      ? { admissible: true, rung: "holder" }
      : { admissible: false, reason: "not_from_current_key" };
  }
  // ── main's rule, byte-for-byte (origin/main succession-apply.ts) ──
  const registryKey = registryKeyOf(db, motebitId);
  if (registryKey !== null) {
    return registryKey === key
      ? { admissible: true, rung: "registry" }
      : { admissible: false, reason: "not_from_current_key" };
  }
  const chainHead = chainHeadOf(db, motebitId);
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

/**
 * What a rotation retires beyond the stored rows: every open connection the
 * retired key admitted (`closeSocketsAuthenticatedUnder` in `websocket.ts`,
 * bound over the relay's `connections` in `index.ts`). A port, because this
 * module holds no sockets — and a REQUIRED argument of `applySuccession`, so
 * no door can apply a succession without saying what it closes (#767).
 */
export type RetireKeyConnections = (motebitId: string, retiredKey: string) => void;

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
 * admissible (freshness, key on file). This function applies it — except a
 * record that would repeat the identity's key history, which it refuses by
 * throwing `SuccessionRefused` before writing anything (#775). Every door
 * maps that to its own recorded refusal.
 *
 * After the rows commit, the retired key's open connections are closed
 * (`retireConnections`): rewriting the rows stops the key admitting a NEW
 * socket, and without the close a socket it had already admitted kept
 * syncing — and kept a roster liveness row beside a superseded line — until
 * it happened to drop (#767). It runs on a retry too (idempotent: nothing
 * the key admitted is left to close), and after the transaction, never
 * inside it: a rollback must not have closed anything.
 */
export function applySuccession(
  db: DatabaseDriver,
  motebitId: string,
  record: KeySuccessionRecord,
  retireConnections: RetireKeyConnections,
): SuccessionApplied {
  const result = db.transaction((): SuccessionApplied => {
    // Refused before any write, inside the transaction, so no door — and no
    // interleaving of two doors — can record a key twice (#775).
    const reuse = successionReuse(db, motebitId, record);
    if (reuse !== null) throw new SuccessionRefused(reuse);
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
    //
    // Matched case-insensitively (DB4): retiring WIDER is fail-safe — a row
    // that entered under another spelling of the retired key (main's guard
    // case-folded) must not keep authenticating after the rotation.
    db.prepare(
      "UPDATE devices SET public_key = ?, hardware_attestation_credential = NULL WHERE motebit_id = ? AND lower(public_key) = lower(?)",
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
              OR lower(json_extract(key_transfer_payload, '$.identity_pubkey_check')) = lower(?))`,
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
    // The holder moves ONLY for E-link (§5f): a link departing from the key it
    // HOLDS. Never into an empty slot — an identity with no holder departed by
    // main's rule (registry, chain head or a device row), none of which is
    // evidence that the new key is the identity's; and never from any other
    // key, so a re-presented old link cannot drag a holder that has moved on.
    // The registry above keeps main's behaviour exactly.
    const holder = holderKeyOf(db, motebitId);
    if (holder !== null && holder === record.old_public_key) {
      recordIdentityKey(db, {
        motebitId,
        publicKey: record.new_public_key,
        source: "succession",
        now: Date.now(),
      });
    }

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
  // A link from a key to itself (in any spelling) retires nothing.
  if (record.old_public_key.toLowerCase() !== record.new_public_key.toLowerCase()) {
    retireConnections(motebitId, record.old_public_key);
  }
  return result;
}
