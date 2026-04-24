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
//
// Squashed to a single `v1_initial` on 2026-04-24 as part of the 1.0 release.
// Before the squash, this file held 15 ordered migrations (v1 through v15)
// spanning 2026-03 through 2026-04. The production relay at motebit.com
// applied them in sequence; its `relay_schema_migrations` table still
// records the historical chain. Fresh installs from 1.0 forward get
// `v1_initial` in one step — same final schema, 1/15 the ceremony.
//
// The pre-squash migrations are preserved verbatim as a test fixture at
// `__tests__/fixtures/migrations-v1-through-v15.ts`, and the equivalence
// between the two paths is enforced permanently by
// `__tests__/migrations-squash-equivalence.test.ts`. Reshaping this file
// without keeping the fixture-vs-live equivalence would drift fresh
// installs away from motebit.com's schema — the test fails first.
//
// Per the migration-cleanup doctrine (`docs/doctrine/migration-cleanup.md`):
// relay DB migrations were a "1 holder you control" case — motebit.com was
// the only production relay when 1.0 shipped, so verifying max(version)=15
// once was sufficient audit to collapse the chain. Adding a new schema
// change lands as `v16`, `v17`, … appended below — never edit `v1_initial`.

export const relayMigrations: Migration[] = [
  {
    version: 1,
    name: "v1_initial",
    up: (db) => {
      // ── Migration-owned tables ─────────────────────────────────────
      //
      // Column order is the order SQLite produces after the historical
      // chain runs — original v1 columns first, then ALTERs appended by
      // v3 / v8 / v9 / v13 / v14 / v15 in their historical application
      // order. The equivalence test enforces this per-ordinal-position.

      // agent_registry — v1 base + v3 {revoked, guardian_public_key,
      // federation_visible} + v8 {settlement_address, settlement_modes}
      // + v9 {sweep_threshold}
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_registry (
          motebit_id    TEXT PRIMARY KEY,
          public_key    TEXT NOT NULL,
          endpoint_url  TEXT NOT NULL,
          capabilities  TEXT NOT NULL DEFAULT '[]',
          metadata      TEXT,
          registered_at INTEGER NOT NULL,
          last_heartbeat INTEGER NOT NULL,
          expires_at    INTEGER NOT NULL,
          revoked INTEGER DEFAULT 0,
          guardian_public_key TEXT,
          federation_visible INTEGER DEFAULT 1,
          settlement_address TEXT,
          settlement_modes TEXT DEFAULT 'relay',
          sweep_threshold INTEGER
        );
      `);

      // relay_service_listings — v1 only
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
      `);

      // relay_latency_stats — v1 only
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_latency_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          motebit_id TEXT NOT NULL,
          remote_motebit_id TEXT NOT NULL,
          latency_ms REAL NOT NULL,
          recorded_at INTEGER NOT NULL
        );
      `);

      // relay_delegation_edges — v1 only
      db.exec(`
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

      // relay_settlements — v1 base + v3 {x402_tx_hash, x402_network}
      // + v8 {settlement_mode, p2p_tx_hash, payment_verification_status,
      //       payment_verified_at, payment_verification_error, delegator_id}
      // + v13 {issuer_relay_id, suite, signature} + v14 {anchor_batch_id}
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
          settled_at INTEGER NOT NULL,
          x402_tx_hash TEXT,
          x402_network TEXT,
          settlement_mode TEXT DEFAULT 'relay',
          p2p_tx_hash TEXT,
          payment_verification_status TEXT DEFAULT 'verified',
          payment_verified_at INTEGER,
          payment_verification_error TEXT,
          delegator_id TEXT,
          issuer_relay_id TEXT,
          suite TEXT,
          signature TEXT,
          anchor_batch_id TEXT
        );
      `);

      // relay_allocations — v1 only
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

      // relay_proposals — v1 only
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
      `);

      // relay_proposal_participants — v1 only
      db.exec(`
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
      `);

      // relay_collaborative_step_results — v1 only
      db.exec(`
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

      // relay_credentials — v1 base + v15 {anchor_batch_id}
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_credentials (
          credential_id TEXT PRIMARY KEY,
          subject_motebit_id TEXT NOT NULL,
          issuer_did TEXT NOT NULL,
          credential_type TEXT NOT NULL,
          credential_json TEXT NOT NULL,
          issued_at INTEGER NOT NULL,
          anchor_batch_id TEXT
        );
      `);

      // relay_execution_ledgers — v1 only
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

      // relay_key_successions — v1 only
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

      // relay_token_blacklist — v1 only
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_token_blacklist (
          jti TEXT PRIMARY KEY,
          motebit_id TEXT NOT NULL,
          revoked_at TEXT DEFAULT (datetime('now')),
          expires_at INTEGER NOT NULL
        );
      `);

      // relay_revoked_credentials — v1 base (already includes revoked_by;
      // v3's ALTER was a no-op on fresh DBs because v1's CREATE TABLE
      // already declared the column)
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_revoked_credentials (
          credential_id TEXT PRIMARY KEY,
          motebit_id TEXT NOT NULL,
          revoked_at TEXT DEFAULT (datetime('now')),
          reason TEXT,
          revoked_by TEXT
        );
      `);

      // relay_config (v4)
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      // relay_refund_log (v5) — refund audit (retry-driven, completed-state default)
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_refund_log (
          refund_id TEXT PRIMARY KEY,
          retry_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          allocation_id TEXT NOT NULL,
          delegator_id TEXT NOT NULL,
          amount INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'completed',
          error TEXT,
          created_at INTEGER NOT NULL
        );
      `);

      // relay_push_tokens (v6) — composite primary key (motebit_id, device_id)
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_push_tokens (
          motebit_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          push_token TEXT NOT NULL,
          platform TEXT NOT NULL,
          registered_at INTEGER NOT NULL,
          expires_at INTEGER,
          PRIMARY KEY (motebit_id, device_id)
        );
      `);

      // relay_receipts (v10) — byte-identical append-only receipt archive.
      // Per services/api CLAUDE.md rule 11: receipt_json must equal
      // canonicalJson(receipt) at write time; the column is read-only
      // output for auditors re-verifying signatures offline.
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_receipts (
          motebit_id        TEXT NOT NULL,
          task_id           TEXT NOT NULL,
          parent_task_id    TEXT,
          depth             INTEGER NOT NULL DEFAULT 0,
          status            TEXT NOT NULL,
          suite             TEXT NOT NULL,
          public_key        TEXT NOT NULL,
          signature         TEXT NOT NULL,
          invocation_origin TEXT,
          receipt_json      TEXT NOT NULL,
          received_at       INTEGER NOT NULL,
          PRIMARY KEY (motebit_id, task_id)
        );
      `);

      // relay_pending_withdrawals (v11) — aggregation ledger for sweep-driven
      // withdrawals. Debit happens at enqueue time (CLAUDE.md rule 12).
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_pending_withdrawals (
          pending_id      TEXT PRIMARY KEY,
          motebit_id      TEXT NOT NULL,
          amount_micro    INTEGER NOT NULL,
          destination     TEXT NOT NULL,
          rail            TEXT NOT NULL,
          source          TEXT NOT NULL,
          enqueued_at     INTEGER NOT NULL,
          status          TEXT NOT NULL,
          last_attempt_at INTEGER,
          last_error      TEXT,
          withdrawal_id   TEXT,
          idempotency_key TEXT
        );
      `);

      // relay_agent_anchor_batches (v14) — per-agent Merkle settlement
      // anchoring (the "ceiling" alongside the per-row signing "floor").
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_agent_anchor_batches (
          batch_id          TEXT PRIMARY KEY,
          relay_id          TEXT NOT NULL,
          merkle_root       TEXT NOT NULL,
          leaf_count        INTEGER NOT NULL,
          first_settled_at  INTEGER NOT NULL,
          last_settled_at   INTEGER NOT NULL,
          signature         TEXT NOT NULL,
          tx_hash           TEXT,
          network           TEXT,
          anchored_at       INTEGER,
          status            TEXT NOT NULL DEFAULT 'signed',
          created_at        INTEGER NOT NULL
        );
      `);

      // ── Indexes (v2, v5, v6, v8, v10, v11, v12, v14, v15) ──────────
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_listings_motebit ON relay_service_listings(motebit_id);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_latency_pair ON relay_latency_stats(motebit_id, remote_motebit_id);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_delegation_edges_from ON relay_delegation_edges(from_motebit_id);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_settlements_alloc ON relay_settlements(allocation_id);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_settlements_motebit ON relay_settlements(motebit_id);",
      );
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_dedup ON relay_settlements(task_id, motebit_id);",
      );
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_task_mode ON relay_settlements(task_id, settlement_mode);",
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_allocations_task ON relay_allocations(task_id);");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_allocations_status ON relay_allocations(status) WHERE status = 'locked';",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_proposals_initiator ON relay_proposals(initiator_motebit_id);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_creds_subject ON relay_credentials(subject_motebit_id);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_ledgers_motebit ON relay_execution_ledgers(motebit_id);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_ledgers_goal ON relay_execution_ledgers(goal_id);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_key_successions_motebit ON relay_key_successions(motebit_id);",
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_refund_log_task ON relay_refund_log(task_id);");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_push_tokens_motebit ON relay_push_tokens(motebit_id);",
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_relay_receipts_task ON relay_receipts(task_id);");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_receipts_parent ON relay_receipts(parent_task_id, depth);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_receipts_origin ON relay_receipts(invocation_origin);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_pending_withdrawals_rail_status ON relay_pending_withdrawals(rail, status, enqueued_at);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_pending_withdrawals_motebit ON relay_pending_withdrawals(motebit_id, status);",
      );
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_withdrawals_idempotency ON relay_pending_withdrawals (motebit_id, idempotency_key) WHERE idempotency_key IS NOT NULL;",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_anchor_batches_status ON relay_agent_anchor_batches(status) WHERE status != 'confirmed';",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_settlements_unanchored ON relay_settlements(settled_at, settlement_id) WHERE anchor_batch_id IS NULL AND signature IS NOT NULL;",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_credentials_unanchored ON relay_credentials(issued_at, credential_id) WHERE anchor_batch_id IS NULL;",
      );

      // DO NOT REMOVE — load-bearing on `relay_federation_settlements`.
      // `createFederationTables` and `createPairingTables` run before
      // `runMigrations` in `createSyncRelay`; historical v3 and v7 added
      // columns to tables those helpers already created. The pairing
      // ALTERs are no-ops on the current helper (which declares the
      // columns) and kept as belt-and-suspenders; the federation ALTERs
      // are the load-bearing pair — delete them and fresh installs lose
      // `x402_tx_hash` / `x402_network`. The squash-equivalence test
      // catches the drift — trust the red, don't delete the block.
      const fedCols = (
        db.prepare("PRAGMA table_info(relay_federation_settlements)").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      if (!fedCols.includes("x402_tx_hash")) {
        db.exec("ALTER TABLE relay_federation_settlements ADD COLUMN x402_tx_hash TEXT");
      }
      if (!fedCols.includes("x402_network")) {
        db.exec("ALTER TABLE relay_federation_settlements ADD COLUMN x402_network TEXT");
      }

      const pairCols = (
        db.prepare("PRAGMA table_info(pairing_sessions)").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      if (!pairCols.includes("claiming_x25519_pubkey")) {
        db.exec("ALTER TABLE pairing_sessions ADD COLUMN claiming_x25519_pubkey TEXT");
      }
      if (!pairCols.includes("key_transfer_payload")) {
        db.exec("ALTER TABLE pairing_sessions ADD COLUMN key_transfer_payload TEXT");
      }
    },
  },
];
