/**
 * identity-revocation — the record that an identity revoked ITSELF, kept for
 * every identity this relay can authenticate (#787).
 *
 * `/revoke` used to record the revocation only as `agent_registry.revoked = 1`.
 * An identity with no registry row — one that only ever called
 * `/devices/register-self`, which writes the `identities` and `devices` rows
 * the token verifier reads — got an UPDATE of zero rows and a 200
 * `{revoked: true}`, and kept authenticating. A security action answered
 * success while doing nothing.
 *
 * The registry cannot hold this fact: a registry row is the DISCOVERY record,
 * and not every identity the relay authenticates has one (rule 22 — the row
 * holds discoverability and key state; neither is "may this identity act").
 * So the sovereign's revocation has its own table, keyed by `motebit_id`,
 * written by `/revoke` for every identity the relay knows, and read by
 * `isAgentRevoked` (schema.ts) beside the registry mark — the verifier on
 * every authenticated request, HTTP and WebSocket.
 *
 * Every record takes effect at once (`isAgentRevoked` honours it — no false
 * success). Whether it is TERMINAL depends on authority the relay can verify
 * (#794). `register-self` is first-come for an id the relay holds no key for,
 * so a stranger can hold a device row under someone else's id; a revocation
 * made under that row's key must not end the real owner forever. So each
 * record carries `authoritative` (`revokerIsAuthoritative`):
 *
 *  - AUTHORITATIVE — the operator (master token acting for the id), or a token
 *    that verified under the identity's PROVEN key: the holder when there is
 *    one (`identity_keys`; a rotated-away genesis key is not it), else a key
 *    the id sovereign-binds to (`verifySovereignBinding`), else the registry
 *    key. Terminal: never cleared, and accept-migration, `/agents/register`
 *    and restore-listing refuse the identity.
 *  - LIFTABLE — any other key (a first-come device row). Lifted
 *    (`liftRevocation`, the one DELETE, `authoritative = 0` in the statement)
 *    by accept-migration after it verified the sovereign binding — the owner
 *    proved the key — or by the operator's restore-listing.
 *
 * A later authoritative `/revoke` upgrades a liftable record; nothing
 * downgrades one. The registry mark stays the carrier of the two REVERSIBLE
 * registry revocations — the operator's moderation hold (revoke-listing ↔
 * restore-listing) and migration departure (undone only by the identity
 * arriving back, accept-migration).
 */

import { verifySovereignBinding } from "@motebit/crypto";
import type { DatabaseDriver } from "@motebit/persistence";
import { holderKeyOf } from "./identity-keys.js";

/**
 * Does the relay know this identity at all — does any table it authenticates
 * from, or serves an identity from, name it? The registry (service-mode
 * verification fallback), a device row (device-mode verification), the
 * `identities` row register-self and pairing create, or the key holder
 * (#703). An identity in none of them cannot present a verifiable token here,
 * so there is nothing to revoke: `/revoke` answers 404 rather than recording
 * a revocation for an id the relay has never seen.
 */
export function isKnownIdentity(db: DatabaseDriver, motebitId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM agent_registry WHERE motebit_id = ?
         UNION ALL SELECT 1 FROM devices WHERE motebit_id = ?
         UNION ALL SELECT 1 FROM identities WHERE motebit_id = ?
         UNION ALL SELECT 1 FROM identity_keys WHERE motebit_id = ?
         LIMIT 1`,
      )
      .get(motebitId, motebitId, motebitId, motebitId) !== undefined
  );
}

/** Who revoked: the operator (master token), or the key a token verified under. */
export type Revoker = { kind: "operator" } | { kind: "key"; publicKey: string };

/**
 * Did the revoker prove it speaks for the identity? The operator: yes (an
 * operator act, like every master-token door). A key: yes only when it is the
 * identity's PROVEN key — the holder when one exists (exactly that; a genesis
 * key the identity rotated away from is not it), else a key the id is the
 * sovereign commitment to. NOT the registry key: a device token can write it
 * through /agents/register for an id with no key on file, so after a
 * first-come register-self squat (#707) it proves nothing (#794 decisive
 * review). A first-come device key proves nothing either.
 */
export async function revokerIsAuthoritative(
  db: DatabaseDriver,
  motebitId: string,
  revoker: Revoker,
): Promise<boolean> {
  if (revoker.kind === "operator") return true;
  const key = revoker.publicKey.toLowerCase();
  const holder = holderKeyOf(db, motebitId);
  if (holder !== null) return holder.toLowerCase() === key;
  return verifySovereignBinding(motebitId, key);
}

/**
 * Record the identity's revocation. A repeated `/revoke` keeps the FIRST
 * recording time; an authoritative one upgrades a liftable record, and nothing
 * downgrades. Returns true — a row now exists — so the caller answers from
 * what was recorded, never from what was attempted.
 */
export function recordIdentityRevocation(
  db: DatabaseDriver,
  motebitId: string,
  now: number,
  authoritative: boolean,
  revokedUnder: string,
): boolean {
  db.prepare(
    `INSERT INTO relay_identity_revocations (motebit_id, revoked_at, authoritative, revoked_under)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(motebit_id) DO UPDATE SET authoritative = 1, revoked_under = excluded.revoked_under
       WHERE excluded.authoritative = 1 AND relay_identity_revocations.authoritative = 0`,
  ).run(motebitId, now, authoritative ? 1 : 0, revokedUnder);
  return revocationStanding(db, motebitId) !== "none";
}

/** The identity's own revocation: none, TERMINAL (authoritative), or LIFTABLE. */
export function revocationStanding(
  db: DatabaseDriver,
  motebitId: string,
): "none" | "terminal" | "liftable" {
  const row = db
    .prepare("SELECT authoritative FROM relay_identity_revocations WHERE motebit_id = ?")
    .get(motebitId) as { authoritative: number } | undefined;
  if (row === undefined) return "none";
  return row.authoritative === 1 ? "terminal" : "liftable";
}

/**
 * Lift a LIFTABLE revocation — called only by accept-migration after the
 * sovereign binding verified, and by the operator's restore-listing. The
 * statement itself cannot touch a terminal record (`authoritative = 0`).
 */
export function liftRevocation(db: DatabaseDriver, motebitId: string): void {
  db.prepare(
    "DELETE FROM relay_identity_revocations WHERE motebit_id = ? AND authoritative = 0",
  ).run(motebitId);
}

/**
 * The verifier's question — may this identity's tokens be accepted? No when
 * it revoked itself (this table, every identity) or its registry row carries
 * the revoked mark (the operator's hold, a migration departure, and — for a
 * registered identity — the same `/revoke`).
 */
export function isIdentityRevoked(db: DatabaseDriver, motebitId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM relay_identity_revocations WHERE motebit_id = ?
         UNION ALL SELECT 1 FROM agent_registry WHERE motebit_id = ? AND revoked = 1
         LIMIT 1`,
      )
      .get(motebitId, motebitId) !== undefined
  );
}

/**
 * Is a migration departure from this relay still in effect — the identity's
 * latest departure is later than its latest arrival back here? A departure is
 * the identity's act, reversed only by the identity arriving again
 * (accept-migration), never by the operator (#788).
 */
export function isDepartureInEffect(db: DatabaseDriver, motebitId: string): boolean {
  const row = db
    .prepare(
      `SELECT
         (SELECT MAX(departed_at) FROM relay_migrations WHERE motebit_id = ? AND state = 'departed') AS departed_at,
         (SELECT MAX(accepted_at) FROM relay_accepted_migrations WHERE motebit_id = ?) AS accepted_at`,
    )
    .get(motebitId, motebitId) as { departed_at: number | null; accepted_at: number | null };
  if (row.departed_at == null) return false;
  return row.accepted_at == null || row.departed_at > row.accepted_at;
}
