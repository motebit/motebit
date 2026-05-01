/**
 * Schema-version registry for the mobile expo-sqlite adapter. Mirrors the
 * pattern in `packages/persistence/src/migrations-registry.ts` but keeps
 * its own version line — mobile and persistence have independently
 * evolved schemas with overlapping but non-identical tables, so they are
 * separate registries by design.
 *
 * Append-only. New schema changes append the next version with the same
 * SQL the persistence registry uses for the matching column, when the
 * tables align. Phase 5-ship's `sensitivity` column on
 * `conversation_messages` is the next entry to land here.
 */

import type { Migration } from "@motebit/sqlite-migrations";

export const MOBILE_MIGRATIONS: readonly Migration[] = [
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
  {
    version: 3,
    description: "conversations + conversation_messages tables",
    statements: [
      `CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        title TEXT,
        summary TEXT,
        message_count INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_motebit
        ON conversations (motebit_id, last_active_at DESC)`,
      `CREATE TABLE IF NOT EXISTS conversation_messages (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        created_at INTEGER NOT NULL,
        token_estimate INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_conv_messages
        ON conversation_messages (conversation_id, created_at ASC)`,
    ],
  },
  {
    version: 4,
    description: "goals + goal_outcomes tables",
    statements: [
      `CREATE TABLE IF NOT EXISTS goals (
        goal_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        last_run_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        mode TEXT NOT NULL DEFAULT 'recurring',
        status TEXT NOT NULL DEFAULT 'active',
        parent_goal_id TEXT,
        max_retries INTEGER NOT NULL DEFAULT 3,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
      )`,
      "CREATE INDEX IF NOT EXISTS idx_goals_motebit ON goals (motebit_id)",
      `CREATE TABLE IF NOT EXISTS goal_outcomes (
        outcome_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        ran_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        tool_calls_made INTEGER NOT NULL DEFAULT 0,
        memories_formed INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        FOREIGN KEY (goal_id) REFERENCES goals(goal_id)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_goal_outcomes_goal ON goal_outcomes (goal_id, ran_at DESC)",
    ],
  },
  {
    version: 5,
    description: "memory_nodes.pinned",
    statements: ["ALTER TABLE memory_nodes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"],
  },
  {
    version: 6,
    description: "plans + plan_steps tables",
    statements: [
      `CREATE TABLE IF NOT EXISTS plans (
        plan_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        current_step_index INTEGER NOT NULL DEFAULT 0,
        total_steps INTEGER NOT NULL DEFAULT 0
      )`,
      "CREATE INDEX IF NOT EXISTS idx_plans_goal ON plans (goal_id)",
      `CREATE TABLE IF NOT EXISTS plan_steps (
        step_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        description TEXT NOT NULL,
        prompt TEXT NOT NULL,
        depends_on TEXT NOT NULL DEFAULT '[]',
        optional INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        result_summary TEXT,
        error_message TEXT,
        tool_calls_made INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        completed_at INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps (plan_id, ordinal ASC)",
    ],
  },
  {
    version: 7,
    description: "memory consolidation columns",
    statements: [
      "ALTER TABLE memory_nodes ADD COLUMN memory_type TEXT DEFAULT 'semantic'",
      "ALTER TABLE memory_nodes ADD COLUMN valid_from INTEGER",
      "ALTER TABLE memory_nodes ADD COLUMN valid_until INTEGER",
    ],
  },
  {
    version: 8,
    description: "gradient_snapshots table",
    statements: [
      `CREATE TABLE IF NOT EXISTS gradient_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        gradient REAL NOT NULL,
        delta REAL NOT NULL,
        knowledge_density REAL NOT NULL,
        knowledge_density_raw REAL NOT NULL,
        knowledge_quality REAL NOT NULL,
        graph_connectivity REAL NOT NULL,
        graph_connectivity_raw REAL NOT NULL,
        temporal_stability REAL NOT NULL,
        stats TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_gradient_motebit_ts ON gradient_snapshots (motebit_id, timestamp DESC)",
    ],
  },
  {
    version: 9,
    description: "memory_nodes composite tomb_pin index",
    statements: [
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_mote_tomb_pin ON memory_nodes (motebit_id, tombstoned, pinned)",
    ],
  },
  {
    version: 10,
    description: "memory_nodes retrieve index (last_accessed DESC)",
    statements: [
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_retrieve ON memory_nodes (motebit_id, tombstoned, last_accessed DESC)",
    ],
  },
  {
    version: 11,
    description: "gradient_snapshots.retrieval_quality",
    statements: [
      "ALTER TABLE gradient_snapshots ADD COLUMN retrieval_quality REAL NOT NULL DEFAULT 0",
    ],
  },
  {
    version: 12,
    description: "gradient_snapshots interaction/tool efficiency",
    statements: [
      "ALTER TABLE gradient_snapshots ADD COLUMN interaction_efficiency REAL NOT NULL DEFAULT 0",
      "ALTER TABLE gradient_snapshots ADD COLUMN tool_efficiency REAL NOT NULL DEFAULT 0",
    ],
  },
  {
    version: 13,
    description: "agent_trust table",
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_trust (
        motebit_id TEXT NOT NULL,
        remote_motebit_id TEXT NOT NULL,
        trust_level TEXT NOT NULL DEFAULT 'unknown',
        public_key TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        interaction_count INTEGER NOT NULL DEFAULT 0,
        successful_tasks INTEGER NOT NULL DEFAULT 0,
        failed_tasks INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        PRIMARY KEY (motebit_id, remote_motebit_id)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_agent_trust_motebit ON agent_trust (motebit_id)",
    ],
  },
  {
    version: 14,
    description: "gradient_snapshots.curiosity_pressure",
    statements: [
      "ALTER TABLE gradient_snapshots ADD COLUMN curiosity_pressure REAL NOT NULL DEFAULT 0",
    ],
  },
  {
    version: 15,
    description: "plan_steps capability + delegation + updated_at",
    statements: [
      "ALTER TABLE plan_steps ADD COLUMN required_capabilities TEXT DEFAULT NULL",
      "ALTER TABLE plan_steps ADD COLUMN delegation_task_id TEXT DEFAULT NULL",
      "ALTER TABLE plan_steps ADD COLUMN updated_at INTEGER DEFAULT 0",
      "UPDATE plan_steps SET updated_at = COALESCE(completed_at, started_at, (SELECT created_at FROM plans WHERE plans.plan_id = plan_steps.plan_id)) WHERE updated_at = 0",
      "CREATE INDEX IF NOT EXISTS idx_plan_steps_updated ON plan_steps(updated_at)",
    ],
  },
  {
    version: 16,
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
    version: 17,
    description: "collaborative plan fields",
    statements: [
      "ALTER TABLE plan_steps ADD COLUMN assigned_motebit_id TEXT DEFAULT NULL",
      "ALTER TABLE plans ADD COLUMN proposal_id TEXT DEFAULT NULL",
      "ALTER TABLE plans ADD COLUMN collaborative INTEGER DEFAULT 0",
    ],
  },
  {
    version: 18,
    description: "issued_credentials + approvals + tool_audit",
    statements: [
      `CREATE TABLE IF NOT EXISTS issued_credentials (
        credential_id TEXT PRIMARY KEY,
        subject_motebit_id TEXT NOT NULL,
        issuer_did TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        credential_json TEXT NOT NULL,
        issued_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_credentials_subject ON issued_credentials(subject_motebit_id)",
      "CREATE INDEX IF NOT EXISTS idx_credentials_type ON issued_credentials(credential_type)",
      `CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        required INTEGER NOT NULL DEFAULT 1,
        approvers TEXT NOT NULL DEFAULT '[]',
        collected TEXT NOT NULL DEFAULT '[]'
      )`,
      `CREATE TABLE IF NOT EXISTS tool_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL,
        run_id TEXT,
        call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        args TEXT NOT NULL,
        decision TEXT NOT NULL,
        result TEXT,
        injection TEXT,
        cost_units REAL,
        timestamp INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_tool_audit_turn ON tool_audit(turn_id)",
      "CREATE INDEX IF NOT EXISTS idx_tool_audit_run ON tool_audit(run_id)",
      "CREATE INDEX IF NOT EXISTS idx_tool_audit_ts ON tool_audit(timestamp)",
    ],
  },
];
