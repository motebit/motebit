/**
 * registry-delist — the ONE writer that takes an identity OFF THE SHELF
 * without forgetting who it is (#703, docs/proposals/identity-key-state-v1.md §4).
 *
 * `agent_registry` holds two facts with two lifetimes. Discoverability —
 * endpoint, capabilities, the heartbeat lease — rightly leaves when the
 * agent departs or falls silent. Identity key state — the current key, the
 * guardian, the settlement configuration — must leave only by revocation.
 * Until 2026-09-24 the shorter lifetime won: `DELETE /agents/deregister`
 * and the 90-day janitor both DELETEd the row, and the CLI daemon
 * deregisters on every shutdown, so a routine restart discarded the
 * guardian and produced the "relay holds no key" state that #701 needed.
 *
 * Delisting sets `delisted_at` and clears the discovery fields; every key
 * and settlement column stays. "On the shelf" is then exactly
 * `delisted_at IS NULL` — the one predicate every discoverability reader
 * carries (`ON_SHELF`), so revocation and departure and silence all leave
 * the shelf the same way and a future reader cannot forget one of them.
 *
 * Four doors call this: deregister (voluntary departure), the janitor
 * (lease lapsed), `/revoke` and migration departure (both also set
 * `revoked = 1`, which delisting never undoes — re-registration clears
 * `delisted_at` only for a row that is not revoked).
 */

import type { DatabaseDriver } from "@motebit/persistence";

/**
 * The shelf predicate. Append to any query whose question is "who is
 * discoverable / for hire / serving" — never to one whose question is
 * "what is this identity's key", which must keep answering for a delisted
 * row (`identity-transparency.ts`, signature verification, guardian
 * recovery).
 */
export const ON_SHELF = " AND delisted_at IS NULL";

/** The SET clause shared by every delisting writer. Binds one `now`. */
const DELIST_SET = "delisted_at = COALESCE(delisted_at, ?), endpoint_url = '', capabilities = '[]'";

/** Voluntary departure from discovery. Keys, guardian and settlement stay. */
export function delistRegistration(db: DatabaseDriver, motebitId: string, now: number): void {
  db.prepare(`UPDATE agent_registry SET ${DELIST_SET} WHERE motebit_id = ?`).run(now, motebitId);
}

/**
 * The janitor's move: every row whose 90-day lease has lapsed is delisted,
 * never deleted. Returns how many rows changed, for the operator log.
 */
export function delistExpired(db: DatabaseDriver, now: number): number {
  const result = db
    .prepare(`UPDATE agent_registry SET ${DELIST_SET} WHERE expires_at < ? AND delisted_at IS NULL`)
    .run(now, now) as { changes?: number };
  return result.changes ?? 0;
}

// The two REVOCATION doors (`/revoke` in key-rotation.ts, migration
// departure in migration.ts) write `revoked = 1` together with this same
// clause, but spell it out in their own statement text on purpose:
// `check-identity-authority-writers` reads statement text, and an
// authority write assembled from an imported constant is one the gate
// cannot see. Keep the three spellings identical when this clause changes.
