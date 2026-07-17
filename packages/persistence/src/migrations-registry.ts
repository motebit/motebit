/**
 * Schema-version registry for `@motebit/persistence`. One entry per
 * historical migration, applied through `@motebit/sqlite-migrations`'
 * `runMigrations` from `createMotebitDatabaseFromDriver`. Append-only:
 * append new entries with the next version number; never renumber, never
 * remove. Every entry's `statements` are passed through the runner's
 * `migrateExec` helper, which swallows the narrow set of "duplicate column"
 * / "already exists" errors that fire when a fresh-DB CREATE TABLE
 * baseline already declared the column an ALTER would add.
 *
 * Empty `statements: []` slots (versions 3, 4, 6, 7, 15, 19) are
 * placeholders preserved from the inline ladder; they advanced the version
 * counter without altering schema.
 */

import type { Migration } from "@motebit/sqlite-migrations";

export const PERSISTENCE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "events.device_id",
    statements: ["ALTER TABLE events ADD COLUMN device_id TEXT"],
  },
  {
    version: 2,
    description: "state_snapshots.version_clock",
    statements: ["ALTER TABLE state_snapshots ADD COLUMN version_clock INTEGER NOT NULL DEFAULT 0"],
  },
  { version: 3, description: "placeholder", statements: [] },
  { version: 4, description: "placeholder", statements: [] },
  {
    version: 5,
    description: "goals scheduling columns",
    statements: [
      "ALTER TABLE goals ADD COLUMN mode TEXT NOT NULL DEFAULT 'recurring'",
      "ALTER TABLE goals ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
      "ALTER TABLE goals ADD COLUMN parent_goal_id TEXT",
      "ALTER TABLE goals ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3",
      "ALTER TABLE goals ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0",
    ],
  },
  { version: 6, description: "placeholder", statements: [] },
  { version: 7, description: "placeholder", statements: [] },
  {
    version: 8,
    description: "memory_nodes.pinned",
    statements: ["ALTER TABLE memory_nodes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"],
  },
  {
    version: 9,
    description: "tool_audit_log.run_id + index",
    statements: [
      "ALTER TABLE tool_audit_log ADD COLUMN run_id TEXT",
      "CREATE INDEX IF NOT EXISTS idx_tool_audit_run ON tool_audit_log (run_id)",
    ],
  },
  {
    version: 10,
    description: "tool_audit_log.injection",
    statements: ["ALTER TABLE tool_audit_log ADD COLUMN injection TEXT"],
  },
  {
    version: 11,
    description: "goal_outcomes.tokens_used",
    statements: ["ALTER TABLE goal_outcomes ADD COLUMN tokens_used INTEGER"],
  },
  {
    version: 12,
    description: "goals.wall_clock_ms",
    statements: ["ALTER TABLE goals ADD COLUMN wall_clock_ms INTEGER"],
  },
  {
    version: 13,
    description: "goals.project_id + index",
    statements: [
      "ALTER TABLE goals ADD COLUMN project_id TEXT",
      "CREATE INDEX IF NOT EXISTS idx_goals_project ON goals (project_id)",
    ],
  },
  {
    version: 14,
    description: "memory consolidation columns",
    statements: [
      "ALTER TABLE memory_nodes ADD COLUMN memory_type TEXT DEFAULT 'semantic'",
      "ALTER TABLE memory_nodes ADD COLUMN valid_from INTEGER",
      "ALTER TABLE memory_nodes ADD COLUMN valid_until INTEGER",
    ],
  },
  { version: 15, description: "placeholder", statements: [] },
  {
    version: 16,
    description: "memory_nodes composite tomb_pin index",
    statements: [
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_mote_tomb_pin ON memory_nodes (motebit_id, tombstoned, pinned)",
    ],
  },
  {
    version: 17,
    description: "memory_nodes retrieve index (last_accessed DESC)",
    statements: [
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_retrieve ON memory_nodes (motebit_id, tombstoned, last_accessed DESC)",
    ],
  },
  {
    version: 18,
    description: "gradient_snapshots.retrieval_quality",
    statements: [
      "ALTER TABLE gradient_snapshots ADD COLUMN retrieval_quality REAL NOT NULL DEFAULT 0",
    ],
  },
  { version: 19, description: "placeholder", statements: [] },
  {
    version: 20,
    description: "gradient_snapshots interaction/tool efficiency",
    statements: [
      "ALTER TABLE gradient_snapshots ADD COLUMN interaction_efficiency REAL NOT NULL DEFAULT 0",
      "ALTER TABLE gradient_snapshots ADD COLUMN tool_efficiency REAL NOT NULL DEFAULT 0",
    ],
  },
  {
    version: 21,
    description: "agent_trust task counters",
    statements: [
      "ALTER TABLE agent_trust ADD COLUMN successful_tasks INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE agent_trust ADD COLUMN failed_tasks INTEGER NOT NULL DEFAULT 0",
    ],
  },
  {
    version: 22,
    description: "tool_audit_log.cost_units",
    statements: ["ALTER TABLE tool_audit_log ADD COLUMN cost_units INTEGER DEFAULT 0"],
  },
  {
    version: 23,
    description: "gradient_snapshots.curiosity_pressure",
    statements: [
      "ALTER TABLE gradient_snapshots ADD COLUMN curiosity_pressure REAL NOT NULL DEFAULT 0",
    ],
  },
  {
    version: 24,
    description: "plan_steps.required_capabilities",
    statements: ["ALTER TABLE plan_steps ADD COLUMN required_capabilities TEXT DEFAULT NULL"],
  },
  {
    version: 25,
    description: "plan_steps.delegation_task_id",
    statements: ["ALTER TABLE plan_steps ADD COLUMN delegation_task_id TEXT DEFAULT NULL"],
  },
  {
    version: 26,
    description: "plan_steps.updated_at + backfill + index",
    statements: [
      "ALTER TABLE plan_steps ADD COLUMN updated_at INTEGER DEFAULT 0",
      "UPDATE plan_steps SET updated_at = COALESCE(completed_at, started_at, (SELECT created_at FROM plans WHERE plans.plan_id = plan_steps.plan_id))",
      "CREATE INDEX IF NOT EXISTS idx_plan_steps_updated ON plan_steps(updated_at)",
    ],
  },
  {
    version: 27,
    description: "market tables: service_listings, budget_allocations, settlements, latency_stats",
    statements: [
      `CREATE TABLE IF NOT EXISTS service_listings (
        listing_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '[]',
        pricing TEXT NOT NULL DEFAULT '[]',
        sla_max_latency_ms INTEGER NOT NULL DEFAULT 5000,
        sla_availability REAL NOT NULL DEFAULT 0.99,
        description TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      )`,
      "CREATE INDEX IF NOT EXISTS idx_service_listings_motebit ON service_listings(motebit_id)",
      `CREATE TABLE IF NOT EXISTS budget_allocations (
        allocation_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        candidate_motebit_id TEXT NOT NULL,
        amount_locked REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'locked'
      )`,
      "CREATE INDEX IF NOT EXISTS idx_budget_allocations_goal ON budget_allocations(goal_id)",
      `CREATE TABLE IF NOT EXISTS settlements (
        settlement_id TEXT PRIMARY KEY,
        allocation_id TEXT NOT NULL,
        receipt_hash TEXT NOT NULL,
        ledger_hash TEXT,
        amount_settled REAL NOT NULL,
        platform_fee REAL NOT NULL DEFAULT 0,
        platform_fee_rate REAL NOT NULL DEFAULT 0.05,
        status TEXT NOT NULL,
        settled_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_settlements_allocation ON settlements(allocation_id)",
      `CREATE TABLE IF NOT EXISTS latency_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        motebit_id TEXT NOT NULL,
        remote_motebit_id TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        recorded_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_latency_stats_pair ON latency_stats(motebit_id, remote_motebit_id)",
    ],
  },
  {
    version: 28,
    description: "collaborative plan fields",
    statements: [
      "ALTER TABLE plan_steps ADD COLUMN assigned_motebit_id TEXT DEFAULT NULL",
      "ALTER TABLE plans ADD COLUMN proposal_id TEXT DEFAULT NULL",
      "ALTER TABLE plans ADD COLUMN collaborative INTEGER DEFAULT 0",
    ],
  },
  {
    version: 29,
    description: "issued_credentials table + indexes",
    statements: [
      `CREATE TABLE IF NOT EXISTS issued_credentials (
        credential_id TEXT PRIMARY KEY,
        subject_motebit_id TEXT NOT NULL,
        issuer_did TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        credential_json TEXT NOT NULL,
        issued_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_creds_subject ON issued_credentials(subject_motebit_id)",
      "CREATE INDEX IF NOT EXISTS idx_creds_type ON issued_credentials(credential_type)",
    ],
  },
  {
    version: 30,
    description: "approval_queue quorum columns",
    statements: [
      "ALTER TABLE approval_queue ADD COLUMN quorum_required INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE approval_queue ADD COLUMN quorum_approvers TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE approval_queue ADD COLUMN quorum_collected TEXT NOT NULL DEFAULT '[]'",
    ],
  },
  {
    version: 31,
    description: "goals declarative-routine metadata",
    statements: [
      "ALTER TABLE goals ADD COLUMN routine_id TEXT",
      "ALTER TABLE goals ADD COLUMN routine_source TEXT",
      "ALTER TABLE goals ADD COLUMN routine_hash TEXT",
      "CREATE INDEX IF NOT EXISTS idx_goals_routine ON goals (motebit_id, routine_id) WHERE routine_id IS NOT NULL",
    ],
  },
  {
    version: 32,
    description: "settlements self-attestation columns",
    statements: [
      "ALTER TABLE settlements ADD COLUMN issuer_relay_id TEXT",
      "ALTER TABLE settlements ADD COLUMN suite TEXT",
      "ALTER TABLE settlements ADD COLUMN signature TEXT",
    ],
  },
  {
    version: 33,
    description: "devices.hardware_attestation_credential",
    statements: ["ALTER TABLE devices ADD COLUMN hardware_attestation_credential TEXT"],
  },
  {
    version: 34,
    description: "conversation_messages.sensitivity + tool_audit_log.sensitivity",
    statements: [
      // Phase 5-ship — registers conversations + tool-audit under the
      // `consolidation_flush` retention shape per
      // docs/doctrine/retention-policy.md. Pre-phase-5 rows leave
      // sensitivity NULL and the flush phase lazy-classifies on read
      // per decision 6b. Sibling entries land in mobile (v19) and
      // desktop (v1) the same release.
      "ALTER TABLE conversation_messages ADD COLUMN sensitivity TEXT",
      "ALTER TABLE tool_audit_log ADD COLUMN sensitivity TEXT",
    ],
  },
  {
    version: 35,
    description: "audit_chain — durable hash-chained audit trail",
    statements: [
      // audit-chain-2 — first durable consumer of the
      // `audit-chain.ts` primitive. Pairs with the existing
      // tool_audit_log (in-memory mirror, capacity-FIFO) for sync
      // query semantics; the chain is the tamper-evident long
      // tail. Append-only — DELETEs would break the hash linkage.
      // See `audit_chain_signing_endgame` memory.
      `CREATE TABLE IF NOT EXISTS audit_chain (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        data TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE
      )`,
      "CREATE INDEX IF NOT EXISTS idx_audit_chain_entry ON audit_chain (entry_id)",
      "CREATE INDEX IF NOT EXISTS idx_audit_chain_timestamp ON audit_chain (timestamp)",
    ],
  },
  {
    version: 36,
    description: "goals.budget_tokens — v1 axis of multi-dimensional goal budget",
    statements: [
      // Per-goal token cap. The v1 axis of the multi-dimensional
      // bounded-commitment shape per docs/doctrine/panel-temporal-
      // registers.md §"Bounded commitment is multi-dimensional".
      // Tokens is the only doctrinally-clean axis available today
      // (universal across motebit-cloud / BYOK / on-device, where a
      // USD field would bake cloud-mode assumptions into the goal
      // record) and it captures the dominant cost slice (~80%+ of
      // most goals today). NULL = no cap on this axis. Spent rollup
      // is derived on read by summing goal_outcomes.tokens_used
      // (column added in v11) — single source of truth, no
      // double-bookkeeping. Future axes (voice_seconds, tool_calls,
      // wall_clock_ms, ...) land as additive sibling columns and
      // additive entries on the `GoalBudgetAxis` closed union;
      // adding one doesn't break the existing schema or helper API.
      // The runtime helper `checkGoalBudget` in @motebit/runtime
      // checks every provided axis and pauses the goal with
      // status='budget_exhausted' on first-exhausted-axis.
      "ALTER TABLE goals ADD COLUMN budget_tokens INTEGER",
    ],
  },
  {
    version: 37,
    description:
      "settlements.settlement_mode — lane discriminant (relay-custody vs p2p) on signed receipts",
    statements: [
      // SettlementRecord gained a required `settlement_mode` wire field.
      // Existing rows are reconstructed via rowToSettlement; COALESCE to
      // 'relay' there preserves backward-compat reads, but the column
      // exists so new writes can persist the lane explicitly. Doctrine:
      // docs/doctrine/settlement-rails.md § "Lanes for external readers".
      // Treasury reconciliation is NOT a settlement and has no row here.
      "ALTER TABLE settlements ADD COLUMN settlement_mode TEXT DEFAULT 'relay'",
    ],
  },
  {
    version: 38,
    description: "settlements.motebit_id — the payee named in the signed settlement receipt",
    statements: [
      // SettlementRecord gained a required `motebit_id` (payee) wire field so
      // a settlement receipt names who was paid in its signed body, not only
      // the relay-internal allocation_id. Nullable in the DB for backward-
      // compat reads: rowToSettlement surfaces legacy rows as "" so wire-schema
      // validation rejects them — the intended fail-closed signal. New writes
      // persist the payee explicitly.
      "ALTER TABLE settlements ADD COLUMN motebit_id TEXT",
    ],
  },
  {
    version: 39,
    description: "agent_trust.petname — first-person local nickname for a peer",
    statements: [
      // AgentTrustRecord gained an optional `petname`: a first-person, local-only
      // nickname for a peer (doctrine agents-as-first-person-trust-graph.md §3).
      // Never on the wire; additive nullable column, absent ⇒ no petname set.
      "ALTER TABLE agent_trust ADD COLUMN petname TEXT",
    ],
  },
  {
    version: 40,
    description: "memory_nodes.source + source_turn_id — memory provenance",
    statements: [
      // MemorySource provenance (docs/doctrine/memory-provenance.md):
      // who contributed a remembered fact. Additive nullable columns;
      // NULL ⇒ formed before provenance tracking, rendered as provenance
      // "unknown" — rowToNode maps through isMemorySource and never
      // fabricates a default (a fabricated source is a trust claim).
      // source_turn_id is local provenance only, never on the wire.
      "ALTER TABLE memory_nodes ADD COLUMN source TEXT",
      "ALTER TABLE memory_nodes ADD COLUMN source_turn_id TEXT",
    ],
  },
  {
    version: 41,
    description: "grant_spend_state — persistent blast-radius accumulator (money-execution Inc 3b)",
    statements: [
      // Per-grant cumulative-spend accumulator backing SqliteGrantSpendStore
      // (the persistent GrantSpendStore the money meter consumes). One row
      // per grant_id; window fields reset on roll, lifetime_spent_micro and
      // high_water_nonce never do (packages/policy grant-blast-radius.ts).
      // Persistence is load-bearing for the LIFETIME ceiling: an in-memory
      // accumulator re-arms the delegator's total bound on every restart.
      // Local private state — never crosses a wire (not interop law).
      `CREATE TABLE IF NOT EXISTS grant_spend_state (
        grant_id TEXT PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        window_spent_micro INTEGER NOT NULL,
        window_action_count INTEGER NOT NULL,
        per_counterparty_json TEXT NOT NULL DEFAULT '{}',
        lifetime_spent_micro INTEGER NOT NULL,
        high_water_nonce INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 42,
    description: "agent_trust.capability_stats — per-capability competence counts",
    statements: [
      // AgentTrustRecord gained an optional `capability_stats` map: per-capability
      // successful/failed counts so first-person routing scopes competence to the
      // capability being hired (docs/doctrine/first-person-worker-routing.md).
      // The pairwise trust_level (a relationship) stays capability-agnostic; only
      // the success/fail counts split by capability. Additive nullable JSON column
      // ({capability: {successful_tasks, failed_tasks}}); NULL ⇒ no per-capability
      // history yet. Local private state — never on the wire (the .strict()
      // TrustCredentialSubject carries only the aggregate counts).
      "ALTER TABLE agent_trust ADD COLUMN capability_stats TEXT",
    ],
  },
];
