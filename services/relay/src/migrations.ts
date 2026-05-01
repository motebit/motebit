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
// Append-only. Never edit a shipped migration — always add a new one below.
// Each entry is one dated schema change; the list IS the history.
// See `docs/doctrine/migration-cleanup.md` for why the chain stays this way.
//
// v13 and v14 carry PRAGMA-guarded ALTERs where other ALTER-heavy migrations
// don't — one-time defensive hardening; the inline comment at each site has
// the specifics.

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
  {
    version: 5,
    name: "add_refund_log",
    up: (db) => {
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
        CREATE INDEX IF NOT EXISTS idx_refund_log_task ON relay_refund_log(task_id);
      `);
    },
  },
  {
    version: 6,
    name: "add_push_tokens",
    up: (db) => {
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
        CREATE INDEX IF NOT EXISTS idx_push_tokens_motebit ON relay_push_tokens(motebit_id);
      `);
    },
  },
  {
    version: 7,
    name: "add_key_transfer_columns",
    up: (db) => {
      // Guard: columns already exist on fresh installs (createPairingTables includes them).
      const cols = (
        db.prepare("PRAGMA table_info(pairing_sessions)").all() as { name: string }[]
      ).map((c) => c.name);
      if (!cols.includes("claiming_x25519_pubkey")) {
        db.exec("ALTER TABLE pairing_sessions ADD COLUMN claiming_x25519_pubkey TEXT");
      }
      if (!cols.includes("key_transfer_payload")) {
        db.exec("ALTER TABLE pairing_sessions ADD COLUMN key_transfer_payload TEXT");
      }
    },
  },
  {
    version: 8,
    name: "add_p2p_settlement_columns",
    up: (db) => {
      // Agent settlement capabilities (explicit, not inferred from identity key)
      const agentCols = (
        db.prepare("PRAGMA table_info(agent_registry)").all() as { name: string }[]
      ).map((c) => c.name);
      if (!agentCols.includes("settlement_address")) {
        db.exec("ALTER TABLE agent_registry ADD COLUMN settlement_address TEXT");
      }
      if (!agentCols.includes("settlement_modes")) {
        db.exec("ALTER TABLE agent_registry ADD COLUMN settlement_modes TEXT DEFAULT 'relay'");
      }

      // Settlement mode tracking on relay_settlements
      const settleCols = (
        db.prepare("PRAGMA table_info(relay_settlements)").all() as { name: string }[]
      ).map((c) => c.name);
      if (!settleCols.includes("settlement_mode")) {
        db.exec("ALTER TABLE relay_settlements ADD COLUMN settlement_mode TEXT DEFAULT 'relay'");
      }
      if (!settleCols.includes("p2p_tx_hash")) {
        db.exec("ALTER TABLE relay_settlements ADD COLUMN p2p_tx_hash TEXT");
      }
      if (!settleCols.includes("payment_verification_status")) {
        db.exec(
          "ALTER TABLE relay_settlements ADD COLUMN payment_verification_status TEXT DEFAULT 'verified'",
        );
      }
      if (!settleCols.includes("payment_verified_at")) {
        db.exec("ALTER TABLE relay_settlements ADD COLUMN payment_verified_at INTEGER");
      }
      if (!settleCols.includes("payment_verification_error")) {
        db.exec("ALTER TABLE relay_settlements ADD COLUMN payment_verification_error TEXT");
      }
      if (!settleCols.includes("delegator_id")) {
        db.exec("ALTER TABLE relay_settlements ADD COLUMN delegator_id TEXT");
      }

      // Uniqueness: one settlement per (task_id, settlement_mode)
      try {
        db.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_task_mode ON relay_settlements(task_id, settlement_mode)",
        );
      } catch {
        /* index may already exist */
      }
    },
  },
  {
    version: 9,
    name: "add_sweep_threshold",
    up: (db) => {
      const agentCols = (
        db.prepare("PRAGMA table_info(agent_registry)").all() as { name: string }[]
      ).map((c) => c.name);
      if (!agentCols.includes("sweep_threshold")) {
        db.exec("ALTER TABLE agent_registry ADD COLUMN sweep_threshold INTEGER");
      }
    },
  },
  {
    version: 10,
    name: "add_relay_receipts",
    up: (db) => {
      // Durable archive of the full signed ExecutionReceipt tree.
      // relay_settlements keeps only receipt_hash; this table keeps the
      // byte-identical canonical JSON so an auditor can reconstruct the
      // chain and re-verify signatures without relay contact.
      // See spec/execution-ledger-v1.md §11.1 Storage and
      // docs/doctrine/operator-transparency.md "Operational".
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
      db.exec("CREATE INDEX IF NOT EXISTS idx_relay_receipts_task ON relay_receipts(task_id);");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_receipts_parent ON relay_receipts(parent_task_id, depth);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_receipts_origin ON relay_receipts(invocation_origin);",
      );
    },
  },
  {
    version: 11,
    name: "add_pending_withdrawals",
    up: (db) => {
      // Aggregation ledger for sweep-driven withdrawals. The sweep
      // enqueues here instead of firing immediately; a batch worker
      // groups by rail, applies the per-rail shouldBatchSettle policy,
      // and fires serially (or via withdrawBatch on a BatchableGuestRail).
      // See spec/settlement-v1.md §11.2 and packages/market settlement.ts.
      //
      // State machine: pending → firing → fired | failed; cancelled is
      // reserved for operator intervention. Debit on the virtual account
      // happens at enqueue time, mirroring the pre-aggregation sweep
      // invariant — the money is held the moment it's claimed for sweep.
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
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_pending_withdrawals_rail_status ON relay_pending_withdrawals(rail, status, enqueued_at);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_pending_withdrawals_motebit ON relay_pending_withdrawals(motebit_id, status);",
      );
    },
  },
  {
    version: 12,
    name: "pending_withdrawals_idempotency_unique",
    up: (db) => {
      // Mirror idx_relay_withdrawals_idempotency: a partial UNIQUE INDEX
      // keyed by (motebit_id, idempotency_key) where the key is set. The
      // `debitAndEnqueuePending` primitive's replay semantics rest on a
      // SELECT pre-check inside the same synchronous call; the index is
      // belt-and-suspenders against multi-writer races and enforces the
      // documented contract at the storage layer.
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_withdrawals_idempotency ON relay_pending_withdrawals (motebit_id, idempotency_key) WHERE idempotency_key IS NOT NULL;",
      );
    },
  },
  {
    version: 13,
    name: "settlements_signature_columns",
    up: (db) => {
      // Self-attesting settlements (audit follow-up #1).
      // SettlementRecord wire format now MUST be signed by the issuing relay
      // (delegation-v1.md §6.4 foundation law). Adds the three required
      // columns to relay_settlements; nullable for backward-compat with rows
      // written before this migration. Going forward, every INSERT into
      // relay_settlements MUST populate signature/suite/issuer_relay_id —
      // the audit-emission path filters out NULL-signature legacy rows.
      //
      // PRAGMA-guarded from landing because a transient schema state could
      // have the columns already; net-zero on pre-squash DBs.
      const cols = (
        db.prepare("PRAGMA table_info(relay_settlements)").all() as { name: string }[]
      ).map((c) => c.name);
      if (!cols.includes("issuer_relay_id")) {
        db.exec("ALTER TABLE relay_settlements ADD COLUMN issuer_relay_id TEXT;");
      }
      if (!cols.includes("suite")) {
        db.exec("ALTER TABLE relay_settlements ADD COLUMN suite TEXT;");
      }
      if (!cols.includes("signature")) {
        db.exec("ALTER TABLE relay_settlements ADD COLUMN signature TEXT;");
      }
    },
  },
  {
    version: 14,
    name: "agent_settlement_anchor_batches",
    up: (db) => {
      // Per-agent settlement Merkle anchoring (the "ceiling" alongside the
      // signing "floor" landed in v13). Federation settlements already get
      // batched + anchored onchain (relay-federation-v1.md §7.6); this
      // brings per-agent settlements to feature parity so a worker can
      // verify they were paid the right amount WITHOUT contacting the
      // relay — just by holding the SettlementRecord, the inclusion
      // proof, and pointing at the chain transaction.
      //
      // Mirrors relay_anchor_batches (federation) but as a separate table
      // because the audiences differ: federation = inter-relay peer audit;
      // agent settlement = worker audit of relay-as-counterparty.
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
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_anchor_batches_status ON relay_agent_anchor_batches(status) WHERE status != 'confirmed';",
      );
      // PRAGMA-guarded from landing — same reason as v13 above.
      const cols = (
        db.prepare("PRAGMA table_info(relay_settlements)").all() as { name: string }[]
      ).map((c) => c.name);
      if (!cols.includes("anchor_batch_id")) {
        db.exec("ALTER TABLE relay_settlements ADD COLUMN anchor_batch_id TEXT;");
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_settlements_unanchored ON relay_settlements(settled_at, settlement_id) WHERE anchor_batch_id IS NULL AND signature IS NOT NULL;",
      );
    },
  },
  {
    version: 15,
    name: "credentials_anchor_batch_id",
    up: (db) => {
      // credential-anchor-v1.md §7 — relay_credentials.anchor_batch_id is the
      // per-credential pointer into relay_credential_anchor_batches. The
      // column was originally added via an idempotent ALTER TABLE inside
      // createCredentialAnchoringTables(), but that helper runs BEFORE the
      // migration that creates relay_credentials (createFederationTables
      // precedes createRelaySchema in createSyncRelay so pairing/federation
      // tables exist for later migrations). Result: the ALTER TABLE silently
      // failed on fresh DBs, and the credential anchor-proof endpoint was
      // non-functional end-to-end. Surfaced by the HTTP integration test
      // added alongside the doctrinal auth-allowlist fix (services/relay
      // CLAUDE.md rule 6).
      //
      // Guarded with PRAGMA because DBs that somehow DID pick up the column
      // via the old path (unlikely but possible) would trip a duplicate-
      // column error.
      const cols = db.prepare("PRAGMA table_info(relay_credentials)").all() as {
        name: string;
      }[];
      if (!cols.some((c) => c.name === "anchor_batch_id")) {
        db.exec("ALTER TABLE relay_credentials ADD COLUMN anchor_batch_id TEXT;");
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_credentials_unanchored ON relay_credentials(issued_at, credential_id) WHERE anchor_batch_id IS NULL;",
      );
    },
  },
  {
    version: 16,
    name: "phase_4b3_horizon_certs_and_disputes",
    up: (db) => {
      // Phase 4b-3 — federation co-witness solicitation lands two relay-side
      // tables. Both ship in one migration unit because they're feature-coupled:
      // disputes reference certs (cert_signature is the cross-table pointer),
      // both are required for the witness-omission accountability layer to
      // function, both roll back together on failure. Splitting into v16+v17
      // would only matter if there were a deployment scenario where the
      // operator wants one without the other — there isn't (per session-3
      // commit-4 design call).
      //
      // No existing-table modifications. The five operational ledgers
      // (relay_execution_ledgers, relay_settlements,
      // relay_credential_anchor_batches, relay_revocation_events,
      // relay_disputes) already carry the timestamp columns the truncate
      // adapters in services/relay/src/horizon.ts key off (created_at,
      // settled_at, anchored_at, timestamp, COALESCE(final_at, expired_at)).
      //
      // See docs/doctrine/retention-policy.md decision 5 (cert terminality)
      // and the 4b-3 sub-notes (Path A quorum, 24h dispute window, mandatory
      // federation_graph_anchor from 4b-3+).
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_horizon_certs (
          cert_signature TEXT PRIMARY KEY,
          store_id TEXT NOT NULL,
          horizon_ts INTEGER NOT NULL,
          issued_at INTEGER NOT NULL,
          witness_count INTEGER NOT NULL,
          cert_json TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_horizon_certs_store ON relay_horizon_certs(store_id, horizon_ts DESC);",
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_witness_omission_disputes (
          dispute_id TEXT PRIMARY KEY,
          cert_issuer TEXT NOT NULL,
          cert_signature TEXT NOT NULL,
          disputant_motebit_id TEXT NOT NULL,
          filed_at INTEGER NOT NULL,
          dispute_json TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'opened',
          verified_at INTEGER,
          rejection_reason TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_witness_omission_disputes_cert ON relay_witness_omission_disputes(cert_signature);",
      );
    },
  },
  {
    version: 17,
    name: "phase_6_2_dispute_votes",
    up: (db) => {
      // Phase 6.2 — federation dispute orchestration vote ledger.
      //
      // Each row is a signed `AdjudicatorVote` (spec/dispute-v1.md §6.4)
      // received from a peer relay during federation adjudication of a
      // dispute the local relay is a party to (filer or respondent —
      // §6.5 forbids self-adjudication, so the local relay routes
      // resolution to peers and persists each peer's vote here).
      //
      // Composite PK on (dispute_id, round, peer_id) supports §8.3
      // appeal: round=2 is the second vote round triggered by an appeal,
      // and aggregation queries MUST filter `WHERE round = current_round`
      // so a flipped-vote peer in round 2 cannot pull a round-2 majority
      // back toward round-1's outcome. Round=1 votes stay in the table
      // for audit but are excluded from round-2 aggregation.
      //
      // suite + signature columns persist the wire-form of each vote so
      // anyone can re-verify the signed `AdjudicatorVote` independently
      // (the bytes inside `relay_dispute_resolutions.adjudicator_votes`
      // JSON are derived from these rows, not the other way around).
      //
      // Adjunct to `relay_disputes` — no separate retention manifest
      // entry, mirroring the `relay_horizon_certs` +
      // `relay_witness_omission_disputes` pattern from migration 16.
      // The primary operational ledger (`relay_disputes`) carries the
      // retention shape; adjunct audit-on-receipt tables follow it.
      //
      // See spec/dispute-v1.md §6.2 + §6.4 + §8.3 and
      // memory/section_6_2_orchestrator_async_deferral.md (v1 sync
      // fan-out trade-off).
      db.exec(`
        CREATE TABLE IF NOT EXISTS relay_dispute_votes (
          dispute_id TEXT NOT NULL,
          round INTEGER NOT NULL DEFAULT 1,
          peer_id TEXT NOT NULL,
          vote TEXT NOT NULL CHECK (vote IN ('upheld', 'overturned', 'split')),
          rationale TEXT NOT NULL,
          suite TEXT NOT NULL,
          signature TEXT NOT NULL,
          received_at INTEGER NOT NULL,
          PRIMARY KEY (dispute_id, round, peer_id)
        );
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_relay_dispute_votes_lookup ON relay_dispute_votes(dispute_id, round);",
      );
    },
  },
  {
    version: 18,
    name: "phase_6_2_dispute_body_json",
    up: (db) => {
      // Phase 6.2 — store the original signed `DisputeRequest` body so
      // the §6.2 federation orchestrator can hand it to peers verbatim.
      //
      // Why: spec/relay-federation-v1.md §16.2 promises that the
      // VoteRequest carries the "original signed dispute artifact" so
      // peers can independently re-verify the filer's signature on the
      // dispute. Three independent peers verifying the original filer's
      // signature is a stronger trust shape than three peers trusting
      // the leader's word about what the dispute says — the property
      // §6.2 federation adjudication exists to provide.
      //
      // The pre-§6.2 filing handler verified the signature at filing
      // time and discarded it (only unpacked fields were persisted).
      // This migration adds `body_json` as NOT NULL with empty-string
      // default. Filing handler now stores `JSON.stringify(req)`
      // (mirroring the `relay_horizon_certs.cert_json` convention from
      // migration 16). Orchestrator reads + parses on fan-out; defensive
      // empty-string check covers the unreachable legacy case (verified
      // 2026-05-01: stg + stg-b both have 0 disputes pre-migration).
      //
      // Defensive shape (PRAGMA-checked, mirrors migration 3): the
      // `relay_disputes` table is created by `createDisputeTables` in
      // disputes.ts (NOT a migration), so on fresh installs migrations
      // run before the table exists. Skip the ALTER if the table is
      // absent (createDisputeTables now declares the column inline) or
      // if the column already exists (re-run idempotency). Existing
      // deploys with the table but without the column get the ALTER.
      //
      // See spec/dispute-v1.md §7.2 + §16.2,
      // memory/feedback_data_model_audit_for_spec_fields.md (lesson
      // captured: spec fields naming "original signed X" need a
      // data-model audit before spec approval).
      const tableRows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_disputes'")
        .all() as Array<{ name: string }>;
      if (tableRows.length === 0) return;
      const cols = db.prepare("PRAGMA table_info(relay_disputes)").all() as Array<{
        name: string;
      }>;
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("body_json")) {
        db.exec(`ALTER TABLE relay_disputes ADD COLUMN body_json TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
];
