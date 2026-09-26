/**
 * identity-revocation — the record that an identity was revoked through
 * `/revoke`, kept for every identity this relay can authenticate (#787).
 *
 * `/revoke` used to record the revocation only as `agent_registry.revoked = 1`.
 * An identity with no registry row — one that only ever called
 * `/devices/register-self`, which writes the `identities` and `devices` rows
 * the token verifier reads — got an UPDATE of zero rows and a 200
 * `{revoked: true}`, and kept authenticating. A security action answered
 * success while doing nothing.
 *
 * The registry cannot hold this fact: a registry row is the DISCOVERY record,
 * and not every identity the relay authenticates has one (rule 22). So the
 * revocation has its own table, keyed by `motebit_id`, written by `/revoke`
 * for every identity the relay knows, and read by `isAgentRevoked`
 * (schema.ts) beside the registry mark — the verifier on every authenticated
 * request, HTTP and WebSocket.
 *
 * NO RECORD IS TERMINAL. Two builds that made some records terminal were
 * withdrawn (#794, #796), for one reason: terminality derived from a KEY is
 * unsound on a relay that has not seen the identity's whole key chain.
 * `register-self` is first-come for an id with no key on file, and a key the
 * id commits to may be a genesis key the owner already rotated away from
 * elsewhere, so the key a `/revoke` token verified under proves nothing
 * permanent. A terminal record under such a key locks the real owner out
 * forever. Every record therefore takes effect at once and is LIFTED
 * (`liftRevocation`, the one DELETE) by exactly two doors:
 *
 *  - a verified migration arrival (accept-migration, after its sovereign
 *    binding verifies — the owner proved the key), and
 *  - the operator's restore-listing (with or without a registry row).
 *
 * The master-token `/agents/register` refuses a revoked identity (409) and
 * never lifts as a side effect. `revoked_under` keeps who revoked (the key the
 * token verified under, or `operator`) for the operator deciding a restore.
 */

import type { DatabaseDriver } from "@motebit/persistence";

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

/**
 * Record the identity's revocation. A repeated `/revoke` keeps the FIRST
 * recording (time and revoker). Returns true — a row now exists — so the
 * caller answers from what was recorded, never from what was attempted.
 */
export function recordIdentityRevocation(
  db: DatabaseDriver,
  motebitId: string,
  now: number,
  revokedUnder: string,
): boolean {
  db.prepare(
    "INSERT OR IGNORE INTO relay_identity_revocations (motebit_id, revoked_at, revoked_under) VALUES (?, ?, ?)",
  ).run(motebitId, now, revokedUnder);
  return hasRevocationRecord(db, motebitId);
}

/** Is there a revocation record for this identity? */
export function hasRevocationRecord(db: DatabaseDriver, motebitId: string): boolean {
  return (
    db.prepare("SELECT 1 FROM relay_identity_revocations WHERE motebit_id = ?").get(motebitId) !==
    undefined
  );
}

/**
 * Lift the identity's revocation record. Called only by accept-migration after
 * the sovereign binding verified, and by the operator's restore-listing.
 */
export function liftRevocation(db: DatabaseDriver, motebitId: string): void {
  db.prepare("DELETE FROM relay_identity_revocations WHERE motebit_id = ?").run(motebitId);
}

/**
 * The verifier's question — may this identity's tokens be accepted? No when a
 * revocation record exists (every identity) or its registry row carries the
 * revoked mark (the operator's hold, a migration departure, and — for a
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
 * the identity's own act (its signed migration request), reversed only by the
 * identity arriving again (accept-migration), never by the operator (#788).
 * Derived from `relay_migrations` + `relay_accepted_migrations`; writes nothing.
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
