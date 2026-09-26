/**
 * Relay schema creation, migrations, and startup cleanup.
 * Extracted from index.ts — now delegates to the migration framework.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { runMigrations, relayMigrations } from "./migrations.js";

/**
 * Create all relay-owned tables, apply schema migrations, and run startup cleanup.
 * Returns the `isTokenBlacklisted` and `isAgentRevoked` callback functions that
 * query tables created here.
 */
export function createRelaySchema(db: DatabaseDriver): {
  isTokenBlacklisted: (jti: string, motebitId: string) => boolean;
  isAgentRevoked: (motebitId: string) => boolean;
} {
  // --- Run ordered, tracked migrations ---
  runMigrations(db, relayMigrations);

  // --- Startup cleanup ---

  // Purge expired blacklist entries
  db.prepare("DELETE FROM relay_token_blacklist WHERE expires_at < ?").run(Date.now());

  // Revocation events: phase 4b-3 promotes the cleanup from a sync
  // startup purge to a signed `append_only_horizon` cert via
  // `advanceRevocationHorizon` in horizon.ts. Scheduled by
  // `startRevocationHorizonLoop` in index.ts (1h default cadence) —
  // not startup-bound, since the signed horizon advance fans out to
  // federation peers and shouldn't burn retry budget on a cold start
  // when peers may not have heartbeated yet.

  // --- Revocation callback helpers ---

  // Scoped to the identity (#776 review A, migration v44): a revocation is an
  // act by an identity over its OWN tokens, so another identity's row for the
  // same jti never denies this one. Callers pass the token's verified `mid`.
  function isTokenBlacklisted(jti: string, motebitId: string): boolean {
    const row = db
      .prepare("SELECT 1 FROM relay_token_blacklist WHERE motebit_id = ? AND jti = ?")
      .get(motebitId, jti) as Record<string, unknown> | undefined;
    return row !== undefined;
  }
  function isAgentRevoked(motebitId: string): boolean {
    const row = db
      .prepare("SELECT revoked FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { revoked: number } | undefined;
    return row?.revoked === 1;
  }

  return { isTokenBlacklisted, isAgentRevoked };
}
