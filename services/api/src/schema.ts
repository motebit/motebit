/**
 * Relay schema creation, migrations, and startup cleanup.
 * Extracted from index.ts — zero behavior changes.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { cleanupRevocationEvents } from "./federation.js";

/**
 * Create all relay-owned tables, apply schema migrations, and run startup cleanup.
 * Returns the `isTokenBlacklisted` and `isAgentRevoked` callback functions that
 * query tables created here.
 */
export function createRelaySchema(db: DatabaseDriver): {
  isTokenBlacklisted: (jti: string, motebitId: string) => boolean;
  isAgentRevoked: (motebitId: string) => boolean;
} {
  // Create agent discovery registry table
  db.exec(`
      CREATE TABLE IF NOT EXISTS agent_registry (
        motebit_id    TEXT PRIMARY KEY,
        public_key    TEXT NOT NULL,
        endpoint_url  TEXT NOT NULL,
        capabilities  TEXT NOT NULL DEFAULT '[]',
        metadata      TEXT,
        registered_at INTEGER NOT NULL,
        last_heartbeat INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      );
  `);

  // Migration: add x402 payment proof columns to relay_federation_settlements
  {
    const cols = db.prepare("PRAGMA table_info(relay_federation_settlements)").all() as Array<{
      name: string;
    }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("x402_tx_hash")) {
      db.exec("ALTER TABLE relay_federation_settlements ADD COLUMN x402_tx_hash TEXT");
    }
    if (!colNames.has("x402_network")) {
      db.exec("ALTER TABLE relay_federation_settlements ADD COLUMN x402_network TEXT");
    }
  }

  // Create market relay tables (service listings + latency stats for routing)
  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_service_listings (
        listing_id    TEXT PRIMARY KEY,
        motebit_id    TEXT NOT NULL,
        capabilities  TEXT NOT NULL DEFAULT '[]',
        pricing       TEXT NOT NULL DEFAULT '[]',
        sla_max_latency_ms INTEGER NOT NULL DEFAULT 5000,
        sla_availability REAL NOT NULL DEFAULT 0.99,
        description   TEXT NOT NULL DEFAULT '',
        pay_to_address TEXT,
        regulatory_risk REAL,
        updated_at    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_relay_listings_motebit ON relay_service_listings(motebit_id);

      CREATE TABLE IF NOT EXISTS relay_latency_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        motebit_id TEXT NOT NULL,
        remote_motebit_id TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_latency_pair ON relay_latency_stats(motebit_id, remote_motebit_id);

      CREATE TABLE IF NOT EXISTS relay_delegation_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_motebit_id TEXT NOT NULL,
        to_motebit_id TEXT NOT NULL,
        trust REAL NOT NULL DEFAULT 0.1,
        cost REAL NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL DEFAULT 5000,
        reliability REAL NOT NULL DEFAULT 0.5,
        regulatory_risk REAL NOT NULL DEFAULT 0,
        recorded_at INTEGER NOT NULL,
        receipt_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_delegation_edges_from ON relay_delegation_edges(from_motebit_id);
  `);

  // Settlement ledger — x402 handles payment, this is the relay's accounting record
  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_settlements (
        settlement_id TEXT PRIMARY KEY,
        allocation_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL DEFAULT '',
        motebit_id TEXT NOT NULL DEFAULT '',
        receipt_hash TEXT NOT NULL DEFAULT '',
        ledger_hash TEXT,
        amount_settled INTEGER NOT NULL,
        platform_fee INTEGER NOT NULL DEFAULT 0,
        platform_fee_rate REAL NOT NULL DEFAULT 0.05,
        status TEXT NOT NULL,
        settled_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_settlements_alloc ON relay_settlements(allocation_id);
      CREATE INDEX IF NOT EXISTS idx_relay_settlements_motebit ON relay_settlements(motebit_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_dedup ON relay_settlements(task_id, motebit_id);
  `);

  // Migration: add x402 payment proof columns (safe on existing DBs — ALTER TABLE IF NOT EXISTS not
  // supported by SQLite, so we check pragma table_info instead).
  {
    const cols = db.prepare("PRAGMA table_info(relay_settlements)").all() as Array<{
      name: string;
    }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("x402_tx_hash")) {
      db.exec("ALTER TABLE relay_settlements ADD COLUMN x402_tx_hash TEXT");
    }
    if (!colNames.has("x402_network")) {
      db.exec("ALTER TABLE relay_settlements ADD COLUMN x402_network TEXT");
    }
  }

  // Budget allocation tracking — prevents overdraft by recording locked funds at task submission
  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_allocations (
        allocation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        motebit_id TEXT NOT NULL,
        amount_locked INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USDC',
        status TEXT NOT NULL DEFAULT 'locked',
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        released_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_allocations_task ON relay_allocations(task_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_status ON relay_allocations(status) WHERE status = 'locked';
  `);

  // Collaborative plan proposal tables
  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_proposals (
        proposal_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        initiator_motebit_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        plan_snapshot TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_proposals_initiator ON relay_proposals(initiator_motebit_id);

      CREATE TABLE IF NOT EXISTS relay_proposal_participants (
        proposal_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        assigned_steps TEXT NOT NULL DEFAULT '[]',
        response TEXT,
        counter_steps TEXT,
        responded_at INTEGER,
        signature TEXT,
        PRIMARY KEY (proposal_id, motebit_id)
      );

      CREATE TABLE IF NOT EXISTS relay_collaborative_step_results (
        proposal_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_summary TEXT,
        receipt TEXT,
        completed_at INTEGER NOT NULL,
        PRIMARY KEY (proposal_id, step_id)
      );
  `);

  // Verifiable credential storage
  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_credentials (
        credential_id TEXT PRIMARY KEY,
        subject_motebit_id TEXT NOT NULL,
        issuer_did TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        credential_json TEXT NOT NULL,
        issued_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_creds_subject ON relay_credentials(subject_motebit_id);
  `);

  // Signed execution ledger storage (agents submit signed manifests)
  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_execution_ledgers (
        ledger_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        plan_id TEXT,
        manifest_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_ledgers_motebit ON relay_execution_ledgers(motebit_id);
      CREATE INDEX IF NOT EXISTS idx_relay_ledgers_goal ON relay_execution_ledgers(goal_id);
  `);

  // Key succession records (key rotation history)
  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_key_successions (
        id INTEGER PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        old_public_key TEXT NOT NULL,
        new_public_key TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        reason TEXT,
        old_key_signature TEXT,
        new_key_signature TEXT NOT NULL,
        recovery INTEGER DEFAULT 0,
        guardian_signature TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_relay_key_successions_motebit ON relay_key_successions(motebit_id);
  `);

  // Token blacklist for revocation (jti-based)
  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_token_blacklist (
        jti TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        revoked_at TEXT DEFAULT (datetime('now')),
        expires_at INTEGER NOT NULL
      );
  `);

  // Revoked credentials
  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_revoked_credentials (
        credential_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        revoked_at TEXT DEFAULT (datetime('now')),
        reason TEXT,
        revoked_by TEXT
      );
  `);

  // Migration: add revoked_by column if missing
  try {
    db.exec("ALTER TABLE relay_revoked_credentials ADD COLUMN revoked_by TEXT");
  } catch {
    /* column may already exist */
  }

  // Add revoked column to agent_registry (column-exists check pattern)
  try {
    db.exec("ALTER TABLE agent_registry ADD COLUMN revoked INTEGER DEFAULT 0");
  } catch {
    /* column may already exist */
  }

  // Add guardian_public_key column for enterprise custody (§3.3)
  try {
    db.exec("ALTER TABLE agent_registry ADD COLUMN guardian_public_key TEXT");
  } catch {
    /* column may already exist */
  }

  // Add federation_visible column — agents can opt out of cross-relay discovery (spec §13.4)
  try {
    db.exec("ALTER TABLE agent_registry ADD COLUMN federation_visible INTEGER DEFAULT 1");
  } catch {
    /* column may already exist */
  }

  // Startup cleanup: purge expired blacklist entries
  db.prepare("DELETE FROM relay_token_blacklist WHERE expires_at < ?").run(Date.now());

  // Startup cleanup: purge revocation events older than 7 days
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
