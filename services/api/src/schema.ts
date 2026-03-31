/**
 * Relay schema creation, migrations, and startup cleanup.
 * Extracted from index.ts — now delegates to the migration framework.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { cleanupRevocationEvents } from "./federation.js";
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

  // Purge revocation events older than 7 days
  cleanupRevocationEvents(db);

  // --- Revocation callback helpers ---

  function isTokenBlacklisted(jti: string, _motebitId: string): boolean {
    const row = db.prepare("SELECT 1 FROM relay_token_blacklist WHERE jti = ?").get(jti) as
      | Record<string, unknown>
      | undefined;
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
