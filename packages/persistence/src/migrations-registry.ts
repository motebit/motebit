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
];
