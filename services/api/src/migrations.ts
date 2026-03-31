/**
 * Lightweight database migration framework for the Motebit relay.
 *
 * Standard pattern: ordered, idempotent, tracked migrations.
 * Each migration runs in a transaction — failure rolls back that migration only.
 * Never modify an existing migration — always add new ones.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "migrations" });

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseDriver) => void;
}

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS relay_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
`;

/** Get current schema version (0 if no migrations have run). */
export function getSchemaVersion(db: DatabaseDriver): number {
  db.exec(MIGRATIONS_TABLE);
  const row = db.prepare("SELECT MAX(version) as version FROM relay_schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

/**
 * Run all pending migrations in order. Idempotent.
 *
 * - Creates the tracking table if it doesn't exist
 * - Skips migrations already applied (version <= current)
 * - Each migration runs in a transaction (rollback on failure)
 * - Inserts tracking record after each successful migration
 */
export function runMigrations(db: DatabaseDriver, migrations: Migration[]): void {
  db.exec(MIGRATIONS_TABLE);

  const current = getSchemaVersion(db);

  // Sort by version to guarantee order
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  // Validate no duplicate versions
  const seen = new Set<number>();
  for (const m of sorted) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version: ${m.version}`);
    }
    seen.add(m.version);
  }

  for (const migration of sorted) {
    if (migration.version <= current) continue;

    logger.info("migration.start", { version: migration.version, name: migration.name });

    db.exec("BEGIN");
    try {
      migration.up(db);

      db.prepare(
        "INSERT INTO relay_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, Date.now());

      db.exec("COMMIT");

      logger.info("migration.complete", { version: migration.version, name: migration.name });
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

// ── Relay Migrations ──────────────────────────────────────────────────────

export const relayMigrations: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: (db) => {
      // Agent discovery registry
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

      // Market relay tables
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

        CREATE TABLE IF NOT EXISTS relay_latency_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          motebit_id TEXT NOT NULL,
          remote_motebit_id TEXT NOT NULL,
          latency_ms REAL NOT NULL,
          recorded_at INTEGER NOT NULL
        );

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
      `);

      // Settlement ledger
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
      `);

      // Budget allocations
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
      `);

      // Collaborative plan proposals
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

      // Verifiable credentials
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_credentials (
          credential_id TEXT PRIMARY KEY,
          subject_motebit_id TEXT NOT NULL,
          issuer_did TEXT NOT NULL,
          credential_type TEXT NOT NULL,
          credential_json TEXT NOT NULL,
          issued_at INTEGER NOT NULL
        );
      `);

      // Execution ledgers
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
      `);

      // Key succession
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
      `);

      // Token blacklist
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
    },
  },

  {
    version: 2,
    name: "add_indexes",
    up: (db) => {
      // Service listings
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_listings_motebit ON relay_service_listings(motebit_id);",
      );

      // Latency stats
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_latency_pair ON relay_latency_stats(motebit_id, remote_motebit_id);",
      );

      // Delegation edges
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_delegation_edges_from ON relay_delegation_edges(from_motebit_id);",
      );

      // Settlements
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_settlements_alloc ON relay_settlements(allocation_id);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_settlements_motebit ON relay_settlements(motebit_id);",
      );
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_dedup ON relay_settlements(task_id, motebit_id);",
      );

      // Allocations
      db.exec("CREATE INDEX IF NOT EXISTS idx_allocations_task ON relay_allocations(task_id);");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_allocations_status ON relay_allocations(status) WHERE status = 'locked';",
      );

      // Proposals
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_proposals_initiator ON relay_proposals(initiator_motebit_id);",
      );

      // Credentials
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_creds_subject ON relay_credentials(subject_motebit_id);",
      );

      // Execution ledgers
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_ledgers_motebit ON relay_execution_ledgers(motebit_id);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_ledgers_goal ON relay_execution_ledgers(goal_id);",
      );

      // Key successions
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_key_successions_motebit ON relay_key_successions(motebit_id);",
      );
    },
  },

  {
    version: 3,
    name: "add_column_migrations",
    up: (db) => {
      // x402 payment proof columns on relay_federation_settlements
      const fedCols = db.prepare("PRAGMA table_info(relay_federation_settlements)").all() as Array<{
        name: string;
      }>;
      const fedColNames = new Set(fedCols.map((c) => c.name));
      if (!fedColNames.has("x402_tx_hash")) {
        db.exec("ALTER TABLE relay_federation_settlements ADD COLUMN x402_tx_hash TEXT");
      }
      if (!fedColNames.has("x402_network")) {
        db.exec("ALTER TABLE relay_federation_settlements ADD COLUMN x402_network TEXT");
      }

      // x402 payment proof columns on relay_settlements
      const settleCols = db.prepare("PRAGMA table_info(relay_settlements)").all() as Array<{
        name: string;
      }>;
      const settleColNames = new Set(settleCols.map((c) => c.name));
      if (!settleColNames.has("x402_tx_hash")) {
        db.exec("ALTER TABLE relay_settlements ADD COLUMN x402_tx_hash TEXT");
      }
      if (!settleColNames.has("x402_network")) {
        db.exec("ALTER TABLE relay_settlements ADD COLUMN x402_network TEXT");
      }

      // agent_registry column additions
      const agentCols = db.prepare("PRAGMA table_info(agent_registry)").all() as Array<{
        name: string;
      }>;
      const agentColNames = new Set(agentCols.map((c) => c.name));
      if (!agentColNames.has("revoked")) {
        db.exec("ALTER TABLE agent_registry ADD COLUMN revoked INTEGER DEFAULT 0");
      }
      if (!agentColNames.has("guardian_public_key")) {
        db.exec("ALTER TABLE agent_registry ADD COLUMN guardian_public_key TEXT");
      }
      if (!agentColNames.has("federation_visible")) {
        db.exec("ALTER TABLE agent_registry ADD COLUMN federation_visible INTEGER DEFAULT 1");
      }

      // revoked_by on revoked credentials
      const revokedCols = db
        .prepare("PRAGMA table_info(relay_revoked_credentials)")
        .all() as Array<{
        name: string;
      }>;
      const revokedColNames = new Set(revokedCols.map((c) => c.name));
      if (!revokedColNames.has("revoked_by")) {
        db.exec("ALTER TABLE relay_revoked_credentials ADD COLUMN revoked_by TEXT");
      }
    },
  },

  {
    version: 4,
    name: "add_relay_config",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
];
