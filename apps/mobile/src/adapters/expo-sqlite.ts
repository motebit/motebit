/**
 * Expo-SQLite adapter for MotebitRuntime storage.
 *
 * Wraps expo-sqlite into EventStoreAdapter, MemoryStorageAdapter,
 * IdentityStorage, AuditLogAdapter, and StateSnapshotAdapter.
 *
 * Uses the same schema as @motebit/persistence (better-sqlite3),
 * so data is wire-compatible across desktop and mobile.
 */
/* eslint-disable @typescript-eslint/require-await -- sync SQLite methods implementing async interfaces */

import * as SQLite from "expo-sqlite";
import { runMigrations, type SyncSqliteDriver } from "@motebit/sqlite-migrations";
import { MOBILE_MIGRATIONS } from "./expo-sqlite-migrations.js";
import type {
  EventLogEntry,
  EventType,
  MemoryNode,
  MemoryEdge,
  MotebitIdentity,
  AuditRecord,
  SensitivityLevel,
  RelationType,
  Plan,
  PlanStep,
  AgentTrustRecord,
  AgentServiceListing,
  BudgetAllocation,
  SettlementRecord,
  CapabilityPrice,
  AllocationId,
  SettlementId,
  ListingId,
  GoalId,
  MotebitId,
  StoredCredential,
  ToolAuditEntry,
  AuditStatsSince,
  PolicyDecision,
  CredentialStoreAdapter,
  ApprovalStoreAdapter,
  AuditLogSink,
} from "@motebit/sdk";
import { StepStatus, AgentTrustLevel } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import type { MemoryStorageAdapter, MemoryQuery } from "@motebit/memory-graph";
import { computeDecayedConfidence } from "@motebit/memory-graph";
import type { IdentityStorage } from "@motebit/core-identity";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import type {
  StateSnapshotAdapter,
  ConversationStoreAdapter,
  StorageAdapters,
  GradientStoreAdapter,
  GradientSnapshot,
  AgentTrustStoreAdapter,
} from "@motebit/runtime";
import type { SyncConversation, SyncConversationMessage } from "@motebit/sdk";
import type { ConversationSyncStoreAdapter } from "@motebit/sync-engine";
import type { PlanStoreAdapter } from "@motebit/planner";
import type { SkillStorageAdapter, StoredSkill, InstalledSkillIndexEntry } from "@motebit/skills";

// === Schema (identical to packages/persistence) ===

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  device_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  version_clock INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_mote_clock ON events (motebit_id, version_clock);

CREATE TABLE IF NOT EXISTS memory_nodes (
  node_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding TEXT NOT NULL,
  confidence REAL NOT NULL,
  sensitivity TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  half_life REAL NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  memory_type TEXT DEFAULT 'semantic',
  valid_from INTEGER,
  valid_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_mote ON memory_nodes (motebit_id);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_mote_tomb_pin ON memory_nodes (motebit_id, tombstoned, pinned);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_retrieve ON memory_nodes (motebit_id, tombstoned, last_accessed DESC);

CREATE TABLE IF NOT EXISTS memory_edges (
  edge_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  weight REAL NOT NULL,
  confidence REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges (source_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges (target_id);

CREATE TABLE IF NOT EXISTS identities (
  motebit_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  version_clock INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identities_owner ON identities (owner_id);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_mote_ts ON audit_log (motebit_id, timestamp);

CREATE TABLE IF NOT EXISTS state_snapshots (
  motebit_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  version_clock INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  title TEXT,
  summary TEXT,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conversations_motebit
  ON conversations (motebit_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  motebit_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  created_at INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  -- Sensitivity tier classified at write time. NULL on pre-phase-5 rows;
  -- the consolidation-cycle flush phase lazy-classifies on read per
  -- docs/doctrine/retention-policy.md §"Decision 6b". Mobile migration
  -- v19 adds the column to existing installs.
  sensitivity TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_messages
  ON conversation_messages (conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  motebit_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  current_step_index INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_plans_goal ON plans (goal_id);

CREATE TABLE IF NOT EXISTS plan_steps (
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
);
CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps (plan_id, ordinal ASC);

CREATE TABLE IF NOT EXISTS gradient_snapshots (
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
  retrieval_quality REAL NOT NULL DEFAULT 0,
  interaction_efficiency REAL NOT NULL DEFAULT 0,
  tool_efficiency REAL NOT NULL DEFAULT 0,
  curiosity_pressure REAL NOT NULL DEFAULT 0,
  stats TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gradient_motebit_ts ON gradient_snapshots (motebit_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS agent_trust (
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
);
CREATE INDEX IF NOT EXISTS idx_agent_trust_motebit ON agent_trust (motebit_id);
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  inserted_at INTEGER NOT NULL,
  index_json TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  body BLOB NOT NULL,
  files_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_inserted ON skills (inserted_at);
`;

// === Row Types ===

interface EventRow {
  event_id: string;
  motebit_id: string;
  device_id: string | null;
  event_type: string;
  payload: string;
  version_clock: number;
  timestamp: number;
  tombstoned: number;
}

interface NodeRow {
  node_id: string;
  motebit_id: string;
  content: string;
  embedding: string;
  confidence: number;
  sensitivity: string;
  created_at: number;
  last_accessed: number;
  half_life: number;
  tombstoned: number;
  pinned: number;
  memory_type: string | null;
  valid_from: number | null;
  valid_until: number | null;
}

interface EdgeRow {
  edge_id: string;
  source_id: string;
  target_id: string;
  relation_type: string;
  weight: number;
  confidence: number;
}

interface IdentityRow {
  motebit_id: string;
  created_at: number;
  owner_id: string;
  version_clock: number;
}

interface AuditRow {
  audit_id: string;
  motebit_id: string;
  timestamp: number;
  action: string;
  target_type: string;
  target_id: string;
  details: string;
}

// === Row → Domain Mappers ===

function rowToEvent(row: EventRow): EventLogEntry {
  const entry: EventLogEntry = {
    event_id: row.event_id,
    motebit_id: row.motebit_id,
    event_type: row.event_type as EventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    version_clock: row.version_clock,
    timestamp: row.timestamp,
    tombstoned: row.tombstoned === 1,
  };
  if (row.device_id !== null) {
    entry.device_id = row.device_id;
  }
  return entry;
}

function rowToNode(row: NodeRow): MemoryNode {
  return {
    node_id: row.node_id,
    motebit_id: row.motebit_id,
    content: row.content,
    embedding: JSON.parse(row.embedding) as number[],
    confidence: row.confidence,
    sensitivity: row.sensitivity as SensitivityLevel,
    created_at: row.created_at,
    last_accessed: row.last_accessed,
    half_life: row.half_life,
    tombstoned: row.tombstoned === 1,
    pinned: row.pinned === 1,
    memory_type: (row.memory_type as MemoryNode["memory_type"]) ?? undefined,
    valid_from: row.valid_from ?? undefined,
    valid_until: row.valid_until,
  };
}

function rowToEdge(row: EdgeRow): MemoryEdge {
  return {
    edge_id: row.edge_id,
    source_id: row.source_id,
    target_id: row.target_id,
    relation_type: row.relation_type as RelationType,
    weight: row.weight,
    confidence: row.confidence,
  };
}

function rowToIdentity(row: IdentityRow): MotebitIdentity {
  return {
    motebit_id: row.motebit_id,
    created_at: row.created_at,
    owner_id: row.owner_id,
    version_clock: row.version_clock,
  };
}

function rowToAudit(row: AuditRow): AuditRecord {
  return {
    audit_id: row.audit_id,
    motebit_id: row.motebit_id,
    timestamp: row.timestamp,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    details: JSON.parse(row.details) as Record<string, unknown>,
  };
}

// === EventStore Adapter ===

export class ExpoSqliteEventStore implements EventStoreAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async append(entry: EventLogEntry): Promise<void> {
    this.db.runSync(
      `INSERT OR IGNORE INTO events (event_id, motebit_id, device_id, event_type, payload, version_clock, timestamp, tombstoned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.event_id,
        entry.motebit_id,
        entry.device_id ?? null,
        entry.event_type,
        JSON.stringify(entry.payload),
        entry.version_clock,
        entry.timestamp,
        entry.tombstoned ? 1 : 0,
      ],
    );
  }

  async query(filter: EventFilter): Promise<EventLogEntry[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.motebit_id !== undefined) {
      conditions.push("motebit_id = ?");
      params.push(filter.motebit_id);
    }
    if (filter.event_types !== undefined && filter.event_types.length > 0) {
      conditions.push(`event_type IN (${filter.event_types.map(() => "?").join(", ")})`);
      params.push(...filter.event_types);
    }
    if (filter.after_timestamp !== undefined) {
      conditions.push("timestamp > ?");
      params.push(filter.after_timestamp);
    }
    if (filter.before_timestamp !== undefined) {
      conditions.push("timestamp < ?");
      params.push(filter.before_timestamp);
    }
    if (filter.after_version_clock !== undefined) {
      conditions.push("version_clock > ?");
      params.push(filter.after_version_clock);
    }

    let sql = "SELECT * FROM events";
    if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
    sql += " ORDER BY version_clock ASC";
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }

    const rows = this.db.getAllSync<EventRow>(sql, params);
    return rows.map(rowToEvent);
  }

  async getLatestClock(motebitId: string): Promise<number> {
    const row = this.db.getFirstSync<{ max_clock: number | null }>(
      "SELECT MAX(version_clock) as max_clock FROM events WHERE motebit_id = ?",
      [motebitId],
    );
    return row?.max_clock ?? 0;
  }

  async tombstone(eventId: string, motebitId: string): Promise<void> {
    this.db.runSync("UPDATE events SET tombstoned = 1 WHERE event_id = ? AND motebit_id = ?", [
      eventId,
      motebitId,
    ]);
  }

  async compact(motebitId: string, beforeClock: number): Promise<number> {
    const before = this.db.getFirstSync<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM events WHERE motebit_id = ? AND version_clock <= ?",
      [motebitId, beforeClock],
    );
    this.db.runSync("DELETE FROM events WHERE motebit_id = ? AND version_clock <= ?", [
      motebitId,
      beforeClock,
    ]);
    return before?.cnt ?? 0;
  }

  async truncateBeforeHorizon(motebitId: string, horizonTs: number): Promise<number> {
    // `append_only_horizon` whole-prefix truncation. Strict less-than
    // per the cert's "entries BEFORE horizon" claim. expo-sqlite's
    // runSync doesn't return changes count directly; pre-count then delete.
    const before = this.db.getFirstSync<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM events WHERE motebit_id = ? AND timestamp < ?",
      [motebitId, horizonTs],
    );
    this.db.runSync("DELETE FROM events WHERE motebit_id = ? AND timestamp < ?", [
      motebitId,
      horizonTs,
    ]);
    return before?.cnt ?? 0;
  }

  async countEvents(motebitId: string): Promise<number> {
    const row = this.db.getFirstSync<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM events WHERE motebit_id = ?",
      [motebitId],
    );
    return row?.cnt ?? 0;
  }
}

// === MemoryStorage Adapter ===

export class ExpoSqliteMemoryStorage implements MemoryStorageAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async saveNode(node: MemoryNode): Promise<void> {
    this.db.runSync(
      `INSERT OR REPLACE INTO memory_nodes
       (node_id, motebit_id, content, embedding, confidence, sensitivity, created_at, last_accessed, half_life, tombstoned, pinned, memory_type, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        node.node_id,
        node.motebit_id,
        node.content,
        JSON.stringify(node.embedding),
        node.confidence,
        node.sensitivity,
        node.created_at,
        node.last_accessed,
        node.half_life,
        node.tombstoned ? 1 : 0,
        node.pinned ? 1 : 0,
        node.memory_type ?? "semantic",
        node.valid_from ?? null,
        node.valid_until ?? null,
      ],
    );
  }

  async getNode(nodeId: string): Promise<MemoryNode | null> {
    const row = this.db.getFirstSync<NodeRow>("SELECT * FROM memory_nodes WHERE node_id = ?", [
      nodeId,
    ]);
    return row ? rowToNode(row) : null;
  }

  async queryNodes(query: MemoryQuery): Promise<MemoryNode[]> {
    // Push tombstoned + pinned into SQL to avoid full-table scan + JSON.parse of embeddings
    const conditions: string[] = ["motebit_id = ?"];
    const params: (string | number)[] = [query.motebit_id];

    if (query.include_tombstoned !== true) {
      conditions.push("tombstoned = 0");
    }

    if (query.pinned !== undefined) {
      conditions.push("pinned = ?");
      params.push(query.pinned ? 1 : 0);
    }

    const needsAppFilter =
      query.min_confidence !== undefined || query.sensitivity_filter !== undefined;
    let sql = `SELECT * FROM memory_nodes WHERE ${conditions.join(" AND ")}`;

    if (query.limit !== undefined) {
      sql += " ORDER BY last_accessed DESC";
      if (needsAppFilter) {
        sql += " LIMIT ?";
        params.push(Math.max(query.limit * 8, 200));
      } else {
        sql += " LIMIT ?";
        params.push(query.limit);
      }
    }

    const rows = this.db.getAllSync<NodeRow>(sql, params);
    let results = rows.map(rowToNode);

    if (query.min_confidence !== undefined) {
      const now = Date.now();
      const minConf = query.min_confidence;
      results = results.filter(
        (n) => computeDecayedConfidence(n.confidence, n.half_life, now - n.created_at) >= minConf,
      );
    }

    if (query.sensitivity_filter !== undefined) {
      const allowed = query.sensitivity_filter;
      results = results.filter((n) => allowed.includes(n.sensitivity));
    }

    if (query.limit !== undefined) results = results.slice(0, query.limit);
    return results;
  }

  async saveEdge(edge: MemoryEdge): Promise<void> {
    this.db.runSync(
      `INSERT OR REPLACE INTO memory_edges (edge_id, source_id, target_id, relation_type, weight, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        edge.edge_id,
        edge.source_id,
        edge.target_id,
        edge.relation_type,
        edge.weight,
        edge.confidence,
      ],
    );
  }

  async getEdges(nodeId: string): Promise<MemoryEdge[]> {
    const rows = this.db.getAllSync<EdgeRow>(
      "SELECT * FROM memory_edges WHERE source_id = ? OR target_id = ?",
      [nodeId, nodeId],
    );
    return rows.map(rowToEdge);
  }

  async tombstoneNode(nodeId: string): Promise<void> {
    this.db.runSync("UPDATE memory_nodes SET tombstoned = 1 WHERE node_id = ?", [nodeId]);
  }

  async eraseNode(nodeId: string): Promise<void> {
    // Erase semantics for `mutable_pruning` certs (decision 7) — bytes
    // unrecoverable, edge cascade. expo-sqlite supports synchronous
    // transactions via withExclusiveTransactionAsync; runSync ordering
    // is sufficient for the two-statement cascade since both rows live
    // in the same DB connection.
    this.db.runSync("DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?", [
      nodeId,
      nodeId,
    ]);
    this.db.runSync("DELETE FROM memory_nodes WHERE node_id = ?", [nodeId]);
  }

  async pinNode(nodeId: string, pinned: boolean): Promise<void> {
    this.db.runSync("UPDATE memory_nodes SET pinned = ? WHERE node_id = ? AND tombstoned = 0", [
      pinned ? 1 : 0,
      nodeId,
    ]);
  }

  async getAllNodes(motebitId: string): Promise<MemoryNode[]> {
    const rows = this.db.getAllSync<NodeRow>("SELECT * FROM memory_nodes WHERE motebit_id = ?", [
      motebitId,
    ]);
    return rows.map(rowToNode);
  }

  async getAllEdges(motebitId: string): Promise<MemoryEdge[]> {
    const rows = this.db.getAllSync<EdgeRow>(
      `SELECT DISTINCT e.* FROM memory_edges e
       INNER JOIN memory_nodes n ON (e.source_id = n.node_id OR e.target_id = n.node_id)
       WHERE n.motebit_id = ?`,
      [motebitId],
    );
    return rows.map(rowToEdge);
  }
}

// === IdentityStorage Adapter ===

export class ExpoSqliteIdentityStorage implements IdentityStorage {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async save(identity: MotebitIdentity): Promise<void> {
    this.db.runSync(
      `INSERT OR REPLACE INTO identities (motebit_id, created_at, owner_id, version_clock)
       VALUES (?, ?, ?, ?)`,
      [identity.motebit_id, identity.created_at, identity.owner_id, identity.version_clock],
    );
  }

  async load(motebitId: string): Promise<MotebitIdentity | null> {
    const row = this.db.getFirstSync<IdentityRow>("SELECT * FROM identities WHERE motebit_id = ?", [
      motebitId,
    ]);
    return row ? rowToIdentity(row) : null;
  }

  async loadByOwner(ownerId: string): Promise<MotebitIdentity | null> {
    const row = this.db.getFirstSync<IdentityRow>(
      "SELECT * FROM identities WHERE owner_id = ? LIMIT 1",
      [ownerId],
    );
    return row ? rowToIdentity(row) : null;
  }
}

// === AuditLog Adapter ===

export class ExpoSqliteAuditLog implements AuditLogAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async record(entry: AuditRecord): Promise<void> {
    this.db.runSync(
      `INSERT INTO audit_log (audit_id, motebit_id, timestamp, action, target_type, target_id, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.audit_id,
        entry.motebit_id,
        entry.timestamp,
        entry.action,
        entry.target_type,
        entry.target_id,
        JSON.stringify(entry.details),
      ],
    );
  }

  async query(
    motebitId: string,
    options: { limit?: number; after?: number } = {},
  ): Promise<AuditRecord[]> {
    const conditions: string[] = ["motebit_id = ?"];
    const params: (string | number)[] = [motebitId];

    if (options.after !== undefined) {
      conditions.push("timestamp > ?");
      params.push(options.after);
    }

    const sql = `SELECT * FROM audit_log WHERE ${conditions.join(" AND ")} ORDER BY timestamp ASC`;
    const rows = this.db.getAllSync<AuditRow>(sql, params);
    let results = rows.map(rowToAudit);

    if (options.limit !== undefined) results = results.slice(-options.limit);
    return results;
  }
}

// === StateSnapshot Adapter ===

export class ExpoSqliteStateSnapshot implements StateSnapshotAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  saveState(motebitId: string, stateJson: string, versionClock?: number): void {
    this.db.runSync(
      `INSERT OR REPLACE INTO state_snapshots (motebit_id, state_json, updated_at, version_clock) VALUES (?, ?, ?, ?)`,
      [motebitId, stateJson, Date.now(), versionClock ?? 0],
    );
  }

  loadState(motebitId: string): string | null {
    const row = this.db.getFirstSync<{ state_json: string }>(
      "SELECT state_json FROM state_snapshots WHERE motebit_id = ?",
      [motebitId],
    );
    return row?.state_json ?? null;
  }

  getSnapshotClock(motebitId: string): number {
    const row = this.db.getFirstSync<{ version_clock: number }>(
      "SELECT version_clock FROM state_snapshots WHERE motebit_id = ?",
      [motebitId],
    );
    return row?.version_clock ?? 0;
  }
}

// === ConversationStore Adapter ===

/** Active conversation window — 4 hours (matches packages/persistence). */
const ACTIVE_CONVERSATION_WINDOW_MS = 4 * 60 * 60 * 1000;

interface ConversationRow {
  conversation_id: string;
  motebit_id: string;
  started_at: number;
  last_active_at: number;
  title: string | null;
  summary: string | null;
  message_count: number;
}

interface ConversationMessageRow {
  message_id: string;
  conversation_id: string;
  motebit_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: number;
  token_estimate: number;
  sensitivity: string | null;
}

export class ExpoSqliteConversationStore implements ConversationStoreAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  createConversation(motebitId: string): string {
    const conversationId = crypto.randomUUID();
    const now = Date.now();
    this.db.runSync(
      `INSERT INTO conversations (conversation_id, motebit_id, started_at, last_active_at, title, summary, message_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [conversationId, motebitId, now, now, null, null],
    );
    return conversationId;
  }

  appendMessage(
    conversationId: string,
    motebitId: string,
    msg: {
      role: string;
      content: string;
      toolCalls?: string;
      toolCallId?: string;
      sensitivity?: SensitivityLevel;
    },
  ): void {
    const messageId = crypto.randomUUID();
    const now = Date.now();
    const tokenEstimate = Math.ceil(msg.content.length / 4);
    this.db.runSync(
      `INSERT INTO conversation_messages (message_id, conversation_id, motebit_id, role, content, tool_calls, tool_call_id, created_at, token_estimate, sensitivity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        messageId,
        conversationId,
        motebitId,
        msg.role,
        msg.content,
        msg.toolCalls ?? null,
        msg.toolCallId ?? null,
        now,
        tokenEstimate,
        msg.sensitivity ?? null,
      ],
    );
    this.db.runSync(
      "UPDATE conversations SET last_active_at = ?, message_count = message_count + 1 WHERE conversation_id = ?",
      [now, conversationId],
    );
  }

  loadMessages(
    conversationId: string,
    limit?: number,
  ): Array<{
    messageId: string;
    conversationId: string;
    motebitId: string;
    role: string;
    content: string;
    toolCalls: string | null;
    toolCallId: string | null;
    createdAt: number;
    tokenEstimate: number;
    sensitivity?: SensitivityLevel;
  }> {
    let sql =
      "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC";
    const params: (string | number)[] = [conversationId];
    if (limit !== undefined) {
      sql += " LIMIT ?";
      params.push(limit);
    }
    const rows = this.db.getAllSync<ConversationMessageRow>(sql, params);
    return rows.map((r) => {
      const out: {
        messageId: string;
        conversationId: string;
        motebitId: string;
        role: string;
        content: string;
        toolCalls: string | null;
        toolCallId: string | null;
        createdAt: number;
        tokenEstimate: number;
        sensitivity?: SensitivityLevel;
      } = {
        messageId: r.message_id,
        conversationId: r.conversation_id,
        motebitId: r.motebit_id,
        role: r.role,
        content: r.content,
        toolCalls: r.tool_calls,
        toolCallId: r.tool_call_id,
        createdAt: r.created_at,
        tokenEstimate: r.token_estimate,
      };
      if (r.sensitivity !== null) {
        out.sensitivity = r.sensitivity as SensitivityLevel;
      }
      return out;
    });
  }

  getActiveConversation(motebitId: string): {
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    summary: string | null;
  } | null {
    const cutoff = Date.now() - ACTIVE_CONVERSATION_WINDOW_MS;
    const row = this.db.getFirstSync<ConversationRow>(
      "SELECT * FROM conversations WHERE motebit_id = ? AND last_active_at > ? ORDER BY last_active_at DESC LIMIT 1",
      [motebitId, cutoff],
    );
    if (!row) return null;
    return {
      conversationId: row.conversation_id,
      startedAt: row.started_at,
      lastActiveAt: row.last_active_at,
      summary: row.summary,
    };
  }

  updateSummary(conversationId: string, summary: string): void {
    this.db.runSync("UPDATE conversations SET summary = ? WHERE conversation_id = ?", [
      summary,
      conversationId,
    ]);
  }

  updateTitle(conversationId: string, title: string): void {
    this.db.runSync("UPDATE conversations SET title = ? WHERE conversation_id = ?", [
      title,
      conversationId,
    ]);
  }

  getMessageCount(conversationId: string): number {
    const row = this.db.getFirstSync<{ message_count: number }>(
      "SELECT message_count FROM conversations WHERE conversation_id = ?",
      [conversationId],
    );
    return row?.message_count ?? 0;
  }

  listConversations(
    motebitId: string,
    limit = 20,
  ): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> {
    const rows = this.db.getAllSync<ConversationRow>(
      "SELECT * FROM conversations WHERE motebit_id = ? ORDER BY last_active_at DESC LIMIT ?",
      [motebitId, limit],
    );
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      startedAt: r.started_at,
      lastActiveAt: r.last_active_at,
      title: r.title,
      messageCount: r.message_count,
    }));
  }

  deleteConversation(conversationId: string): void {
    this.db.runSync("DELETE FROM conversation_messages WHERE conversation_id = ?", [
      conversationId,
    ]);
    this.db.runSync("DELETE FROM conversations WHERE conversation_id = ?", [conversationId]);
  }

  // === consolidation_flush retention shape ===
  // Phase 5-ship — docs/doctrine/retention-policy.md §"Consolidation flush".

  enumerateForFlush(
    motebitId: string,
    beforeCreatedAt: number,
  ): Array<{
    messageId: string;
    conversationId: string;
    role: string;
    content: string;
    createdAt: number;
    sensitivity?: SensitivityLevel;
  }> {
    const rows = this.db.getAllSync<{
      message_id: string;
      conversation_id: string;
      role: string;
      content: string;
      created_at: number;
      sensitivity: string | null;
    }>(
      `SELECT message_id, conversation_id, role, content, created_at, sensitivity
       FROM conversation_messages
       WHERE motebit_id = ? AND created_at < ?
       ORDER BY created_at ASC`,
      [motebitId, beforeCreatedAt],
    );
    return rows.map((r) => {
      const out: {
        messageId: string;
        conversationId: string;
        role: string;
        content: string;
        createdAt: number;
        sensitivity?: SensitivityLevel;
      } = {
        messageId: r.message_id,
        conversationId: r.conversation_id,
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
      };
      if (r.sensitivity !== null) {
        out.sensitivity = r.sensitivity as SensitivityLevel;
      }
      return out;
    });
  }

  eraseMessage(messageId: string): void {
    this.db.runSync("DELETE FROM conversation_messages WHERE message_id = ?", [messageId]);
  }
}

// === Goal Types ===

export type GoalMode = "recurring" | "once";
export type GoalStatus = "active" | "completed" | "failed" | "paused";

export interface Goal {
  goal_id: string;
  motebit_id: string;
  prompt: string;
  interval_ms: number;
  last_run_at: number | null;
  enabled: boolean;
  created_at: number;
  mode: GoalMode;
  status: GoalStatus;
  parent_goal_id: string | null;
  max_retries: number;
  consecutive_failures: number;
}

export interface GoalOutcome {
  outcome_id: string;
  goal_id: string;
  motebit_id: string;
  ran_at: number;
  status: "completed" | "failed" | "suspended";
  summary: string | null;
  tool_calls_made: number;
  memories_formed: number;
  error_message: string | null;
}

interface GoalRow {
  goal_id: string;
  motebit_id: string;
  prompt: string;
  interval_ms: number;
  last_run_at: number | null;
  enabled: number;
  created_at: number;
  mode: string;
  status: string;
  parent_goal_id: string | null;
  max_retries: number;
  consecutive_failures: number;
}

interface GoalOutcomeRow {
  outcome_id: string;
  goal_id: string;
  motebit_id: string;
  ran_at: number;
  status: string;
  summary: string | null;
  tool_calls_made: number;
  memories_formed: number;
  error_message: string | null;
}

function rowToGoal(row: GoalRow): Goal {
  return {
    goal_id: row.goal_id,
    motebit_id: row.motebit_id,
    prompt: row.prompt,
    interval_ms: row.interval_ms,
    last_run_at: row.last_run_at,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    mode: (row.mode ?? "recurring") as GoalMode,
    status: (row.status ?? "active") as GoalStatus,
    parent_goal_id: row.parent_goal_id,
    max_retries: row.max_retries ?? 3,
    consecutive_failures: row.consecutive_failures ?? 0,
  };
}

function rowToGoalOutcome(row: GoalOutcomeRow): GoalOutcome {
  return {
    outcome_id: row.outcome_id,
    goal_id: row.goal_id,
    motebit_id: row.motebit_id,
    ran_at: row.ran_at,
    status: row.status as GoalOutcome["status"],
    summary: row.summary,
    tool_calls_made: row.tool_calls_made,
    memories_formed: row.memories_formed,
    error_message: row.error_message,
  };
}

// === GoalStore ===

export class ExpoGoalStore {
  constructor(private db: SQLite.SQLiteDatabase) {}

  listActiveGoals(motebitId: string): Goal[] {
    const rows = this.db.getAllSync<GoalRow>(
      "SELECT * FROM goals WHERE motebit_id = ? AND enabled = 1 AND status = 'active' ORDER BY created_at ASC",
      [motebitId],
    );
    return rows.map(rowToGoal);
  }

  listGoals(motebitId: string): Goal[] {
    const rows = this.db.getAllSync<GoalRow>(
      "SELECT * FROM goals WHERE motebit_id = ? ORDER BY created_at ASC",
      [motebitId],
    );
    return rows.map(rowToGoal);
  }

  getRecentOutcomes(goalId: string, limit: number): GoalOutcome[] {
    const rows = this.db.getAllSync<GoalOutcomeRow>(
      "SELECT * FROM goal_outcomes WHERE goal_id = ? ORDER BY ran_at DESC LIMIT ?",
      [goalId, limit],
    );
    return rows.map(rowToGoalOutcome);
  }

  updateLastRun(goalId: string, timestamp: number): void {
    this.db.runSync("UPDATE goals SET last_run_at = ? WHERE goal_id = ?", [timestamp, goalId]);
  }

  insertOutcome(outcome: GoalOutcome): void {
    this.db.runSync(
      `INSERT OR REPLACE INTO goal_outcomes
       (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outcome.outcome_id,
        outcome.goal_id,
        outcome.motebit_id,
        outcome.ran_at,
        outcome.status,
        outcome.summary,
        outcome.tool_calls_made,
        outcome.memories_formed,
        outcome.error_message,
      ],
    );
  }

  setStatus(goalId: string, status: GoalStatus): void {
    this.db.runSync("UPDATE goals SET status = ? WHERE goal_id = ?", [status, goalId]);
  }

  incrementFailures(goalId: string): void {
    this.db.runSync(
      "UPDATE goals SET consecutive_failures = consecutive_failures + 1 WHERE goal_id = ?",
      [goalId],
    );
    // Auto-pause if max_retries reached
    const row = this.db.getFirstSync<{ consecutive_failures: number; max_retries: number }>(
      "SELECT consecutive_failures, max_retries FROM goals WHERE goal_id = ?",
      [goalId],
    );
    if (row && row.consecutive_failures >= row.max_retries) {
      this.db.runSync("UPDATE goals SET status = 'paused' WHERE goal_id = ?", [goalId]);
    }
  }

  resetFailures(goalId: string): void {
    this.db.runSync("UPDATE goals SET consecutive_failures = 0 WHERE goal_id = ?", [goalId]);
  }

  addGoal(
    motebitId: string,
    prompt: string,
    intervalMs: number,
    mode: GoalMode = "recurring",
  ): string {
    const goalId = crypto.randomUUID();
    const now = Date.now();
    this.db.runSync(
      `INSERT INTO goals (goal_id, motebit_id, prompt, interval_ms, last_run_at, enabled, created_at, mode, status, parent_goal_id, max_retries, consecutive_failures)
       VALUES (?, ?, ?, ?, NULL, 1, ?, ?, 'active', NULL, 3, 0)`,
      [goalId, motebitId, prompt, intervalMs, now, mode],
    );
    return goalId;
  }

  removeGoal(goalId: string): void {
    this.db.runSync("DELETE FROM goals WHERE goal_id = ?", [goalId]);
  }

  toggleGoal(goalId: string, enabled: boolean): void {
    this.db.runSync("UPDATE goals SET enabled = ?, status = ? WHERE goal_id = ?", [
      enabled ? 1 : 0,
      enabled ? "active" : "paused",
      goalId,
    ]);
  }
}

// === PlanStore ===

interface PlanRow {
  plan_id: string;
  goal_id: string;
  motebit_id: string;
  title: string;
  status: string;
  created_at: number;
  updated_at: number;
  current_step_index: number;
  total_steps: number;
  proposal_id: string | null;
  collaborative: number;
}

interface PlanStepRow {
  step_id: string;
  plan_id: string;
  ordinal: number;
  description: string;
  prompt: string;
  depends_on: string;
  optional: number;
  status: string;
  result_summary: string | null;
  error_message: string | null;
  tool_calls_made: number;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
  required_capabilities: string | null;
  delegation_task_id: string | null;
  assigned_motebit_id: string | null;
  updated_at: number;
}

function rowToPlan(row: PlanRow): Plan {
  return {
    plan_id: row.plan_id,
    goal_id: row.goal_id,
    motebit_id: row.motebit_id,
    title: row.title,
    status: row.status as Plan["status"],
    created_at: row.created_at,
    updated_at: row.updated_at,
    current_step_index: row.current_step_index,
    total_steps: row.total_steps,
    proposal_id: row.proposal_id ?? undefined,
    collaborative: row.collaborative === 1,
  };
}

function rowToPlanStep(row: PlanStepRow): PlanStep {
  let dependsOn: string[] = [];
  try {
    dependsOn = JSON.parse(row.depends_on) as string[];
  } catch {
    /* empty */
  }
  return {
    step_id: row.step_id,
    plan_id: row.plan_id,
    ordinal: row.ordinal,
    description: row.description,
    prompt: row.prompt,
    depends_on: dependsOn,
    optional: row.optional === 1,
    status: row.status as PlanStep["status"],
    required_capabilities:
      row.required_capabilities != null
        ? (JSON.parse(row.required_capabilities) as PlanStep["required_capabilities"])
        : undefined,
    delegation_task_id: row.delegation_task_id ?? undefined,
    assigned_motebit_id: row.assigned_motebit_id ?? undefined,
    result_summary: row.result_summary,
    error_message: row.error_message,
    tool_calls_made: row.tool_calls_made,
    started_at: row.started_at,
    completed_at: row.completed_at,
    retry_count: row.retry_count,
    updated_at: row.updated_at,
  };
}

export class ExpoPlanStore implements PlanStoreAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  savePlan(plan: Plan): void {
    this.db.runSync(
      `INSERT OR REPLACE INTO plans (plan_id, goal_id, motebit_id, title, status, created_at, updated_at, current_step_index, total_steps, proposal_id, collaborative)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        plan.plan_id,
        plan.goal_id,
        plan.motebit_id,
        plan.title,
        plan.status,
        plan.created_at,
        plan.updated_at,
        plan.current_step_index,
        plan.total_steps,
        plan.proposal_id ?? null,
        plan.collaborative ? 1 : 0,
      ],
    );
  }

  getPlan(planId: string): Plan | null {
    const row = this.db.getFirstSync<PlanRow>("SELECT * FROM plans WHERE plan_id = ?", [planId]);
    return row ? rowToPlan(row) : null;
  }

  getPlanForGoal(goalId: string): Plan | null {
    const row = this.db.getFirstSync<PlanRow>(
      "SELECT * FROM plans WHERE goal_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      [goalId],
    );
    return row ? rowToPlan(row) : null;
  }

  updatePlan(planId: string, updates: Partial<Plan>): void {
    const fields: string[] = [];
    const values: SQLite.SQLiteBindValue[] = [];
    if (updates.title !== undefined) {
      fields.push("title = ?");
      values.push(updates.title);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.updated_at !== undefined) {
      fields.push("updated_at = ?");
      values.push(updates.updated_at);
    }
    if (updates.current_step_index !== undefined) {
      fields.push("current_step_index = ?");
      values.push(updates.current_step_index);
    }
    if (updates.total_steps !== undefined) {
      fields.push("total_steps = ?");
      values.push(updates.total_steps);
    }
    if (updates.proposal_id !== undefined) {
      fields.push("proposal_id = ?");
      values.push(updates.proposal_id ?? null);
    }
    if (updates.collaborative !== undefined) {
      fields.push("collaborative = ?");
      values.push(updates.collaborative ? 1 : 0);
    }
    if (fields.length === 0) return;
    values.push(planId);
    this.db.runSync(`UPDATE plans SET ${fields.join(", ")} WHERE plan_id = ?`, values);
  }

  saveStep(step: PlanStep): void {
    this.db.runSync(
      `INSERT OR REPLACE INTO plan_steps (step_id, plan_id, ordinal, description, prompt, depends_on, optional, status, result_summary, error_message, tool_calls_made, started_at, completed_at, retry_count, required_capabilities, delegation_task_id, assigned_motebit_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        step.step_id,
        step.plan_id,
        step.ordinal,
        step.description,
        step.prompt,
        JSON.stringify(step.depends_on),
        step.optional ? 1 : 0,
        step.status,
        step.result_summary,
        step.error_message,
        step.tool_calls_made,
        step.started_at,
        step.completed_at,
        step.retry_count,
        step.required_capabilities != null ? JSON.stringify(step.required_capabilities) : null,
        step.delegation_task_id ?? null,
        step.assigned_motebit_id ?? null,
        step.updated_at,
      ],
    );
  }

  getStep(stepId: string): PlanStep | null {
    const row = this.db.getFirstSync<PlanStepRow>("SELECT * FROM plan_steps WHERE step_id = ?", [
      stepId,
    ]);
    return row ? rowToPlanStep(row) : null;
  }

  getStepsForPlan(planId: string): PlanStep[] {
    const rows = this.db.getAllSync<PlanStepRow>(
      "SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY ordinal ASC",
      [planId],
    );
    return rows.map(rowToPlanStep);
  }

  updateStep(stepId: string, updates: Partial<PlanStep>): void {
    const fields: string[] = [];
    const values: SQLite.SQLiteBindValue[] = [];
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.result_summary !== undefined) {
      fields.push("result_summary = ?");
      values.push(updates.result_summary);
    }
    if (updates.error_message !== undefined) {
      fields.push("error_message = ?");
      values.push(updates.error_message);
    }
    if (updates.tool_calls_made !== undefined) {
      fields.push("tool_calls_made = ?");
      values.push(updates.tool_calls_made);
    }
    if (updates.started_at !== undefined) {
      fields.push("started_at = ?");
      values.push(updates.started_at);
    }
    if (updates.completed_at !== undefined) {
      fields.push("completed_at = ?");
      values.push(updates.completed_at);
    }
    if (updates.retry_count !== undefined) {
      fields.push("retry_count = ?");
      values.push(updates.retry_count);
    }
    if (updates.required_capabilities !== undefined) {
      fields.push("required_capabilities = ?");
      values.push(
        updates.required_capabilities != null
          ? JSON.stringify(updates.required_capabilities)
          : null,
      );
    }
    if (updates.delegation_task_id !== undefined) {
      fields.push("delegation_task_id = ?");
      values.push(updates.delegation_task_id ?? null);
    }
    if (updates.assigned_motebit_id !== undefined) {
      fields.push("assigned_motebit_id = ?");
      values.push(updates.assigned_motebit_id ?? null);
    }
    if (updates.updated_at !== undefined) {
      fields.push("updated_at = ?");
      values.push(updates.updated_at);
    }
    if (fields.length === 0) return;
    values.push(stepId);
    this.db.runSync(`UPDATE plan_steps SET ${fields.join(", ")} WHERE step_id = ?`, values);
  }

  getNextPendingStep(planId: string): PlanStep | null {
    const row = this.db.getFirstSync<PlanStepRow>(
      "SELECT * FROM plan_steps WHERE plan_id = ? AND status = ? ORDER BY ordinal ASC LIMIT 1",
      [planId, StepStatus.Pending],
    );
    return row ? rowToPlanStep(row) : null;
  }

  listAllPlans(motebitId: string): Plan[] {
    const rows = this.db.getAllSync<PlanRow>(
      "SELECT * FROM plans WHERE motebit_id = ? ORDER BY created_at DESC",
      [motebitId],
    );
    return rows.map(rowToPlan);
  }

  listStepsSince(motebitId: string, since: number): PlanStep[] {
    const rows = this.db.getAllSync<PlanStepRow>(
      `SELECT ps.* FROM plan_steps ps JOIN plans p ON ps.plan_id = p.plan_id WHERE p.motebit_id = ? AND ps.updated_at > ?`,
      [motebitId, since],
    );
    return rows.map(rowToPlanStep);
  }
}

// === ConversationSync Adapter (for SyncEngine) ===

export class ExpoSqliteConversationSyncStore implements ConversationSyncStoreAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  getConversationsSince(motebitId: string, since: number): SyncConversation[] {
    const rows = this.db.getAllSync<ConversationRow>(
      "SELECT * FROM conversations WHERE motebit_id = ? AND last_active_at > ? ORDER BY last_active_at ASC",
      [motebitId, since],
    );
    return rows.map((r) => ({
      conversation_id: r.conversation_id,
      motebit_id: r.motebit_id,
      started_at: r.started_at,
      last_active_at: r.last_active_at,
      title: r.title,
      summary: r.summary,
      message_count: r.message_count,
    }));
  }

  getMessagesSince(conversationId: string, since: number): SyncConversationMessage[] {
    const rows = this.db.getAllSync<ConversationMessageRow>(
      "SELECT * FROM conversation_messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at ASC",
      [conversationId, since],
    );
    return rows.map((r) => ({
      message_id: r.message_id,
      conversation_id: r.conversation_id,
      motebit_id: r.motebit_id,
      role: r.role,
      content: r.content,
      tool_calls: r.tool_calls,
      tool_call_id: r.tool_call_id,
      created_at: r.created_at,
      token_estimate: r.token_estimate,
    }));
  }

  upsertConversation(conv: SyncConversation): void {
    const existing = this.db.getFirstSync<{ last_active_at: number }>(
      "SELECT last_active_at FROM conversations WHERE conversation_id = ?",
      [conv.conversation_id],
    );

    if (!existing) {
      this.db.runSync(
        `INSERT INTO conversations (conversation_id, motebit_id, started_at, last_active_at, title, summary, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          conv.conversation_id,
          conv.motebit_id,
          conv.started_at,
          conv.last_active_at,
          conv.title,
          conv.summary,
          conv.message_count,
        ],
      );
    } else if (conv.last_active_at >= existing.last_active_at) {
      this.db.runSync(
        `UPDATE conversations SET last_active_at = ?, title = ?, summary = ?, message_count = MAX(message_count, ?)
         WHERE conversation_id = ?`,
        [conv.last_active_at, conv.title, conv.summary, conv.message_count, conv.conversation_id],
      );
    }
  }

  upsertMessage(msg: SyncConversationMessage): void {
    this.db.runSync(
      `INSERT OR IGNORE INTO conversation_messages
       (message_id, conversation_id, motebit_id, role, content, tool_calls, tool_call_id, created_at, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.message_id,
        msg.conversation_id,
        msg.motebit_id,
        msg.role,
        msg.content,
        msg.tool_calls,
        msg.tool_call_id,
        msg.created_at,
        msg.token_estimate,
      ],
    );
  }
}

// === GradientStore Adapter ===

interface GradientRow {
  snapshot_id: string;
  motebit_id: string;
  timestamp: number;
  gradient: number;
  delta: number;
  knowledge_density: number;
  knowledge_density_raw: number;
  knowledge_quality: number;
  graph_connectivity: number;
  graph_connectivity_raw: number;
  temporal_stability: number;
  retrieval_quality: number;
  interaction_efficiency: number;
  tool_efficiency: number;
  curiosity_pressure: number;
  stats: string;
}

function rowToGradientSnapshot(row: GradientRow): GradientSnapshot {
  return {
    motebit_id: row.motebit_id,
    timestamp: row.timestamp,
    gradient: row.gradient,
    delta: row.delta,
    knowledge_density: row.knowledge_density,
    knowledge_density_raw: row.knowledge_density_raw,
    knowledge_quality: row.knowledge_quality,
    graph_connectivity: row.graph_connectivity,
    graph_connectivity_raw: row.graph_connectivity_raw,
    temporal_stability: row.temporal_stability,
    retrieval_quality: row.retrieval_quality,
    interaction_efficiency: row.interaction_efficiency,
    tool_efficiency: row.tool_efficiency,
    curiosity_pressure: row.curiosity_pressure ?? 0,
    stats: JSON.parse(row.stats) as GradientSnapshot["stats"],
  };
}

export class ExpoGradientStore implements GradientStoreAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  save(snapshot: GradientSnapshot): void {
    const snapshotId = `gs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.db.runSync(
      `INSERT OR REPLACE INTO gradient_snapshots (snapshot_id, motebit_id, timestamp, gradient, delta, knowledge_density, knowledge_density_raw, knowledge_quality, graph_connectivity, graph_connectivity_raw, temporal_stability, retrieval_quality, interaction_efficiency, tool_efficiency, curiosity_pressure, stats)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshotId,
        snapshot.motebit_id,
        snapshot.timestamp,
        snapshot.gradient,
        snapshot.delta,
        snapshot.knowledge_density,
        snapshot.knowledge_density_raw,
        snapshot.knowledge_quality,
        snapshot.graph_connectivity,
        snapshot.graph_connectivity_raw,
        snapshot.temporal_stability,
        snapshot.retrieval_quality,
        snapshot.interaction_efficiency,
        snapshot.tool_efficiency,
        snapshot.curiosity_pressure,
        JSON.stringify(snapshot.stats),
      ],
    );
  }

  latest(motebitId: string): GradientSnapshot | null {
    const row = this.db.getFirstSync<GradientRow>(
      "SELECT * FROM gradient_snapshots WHERE motebit_id = ? ORDER BY timestamp DESC LIMIT 1",
      [motebitId],
    );
    return row ? rowToGradientSnapshot(row) : null;
  }

  list(motebitId: string, limit = 100): GradientSnapshot[] {
    const rows = this.db.getAllSync<GradientRow>(
      "SELECT * FROM gradient_snapshots WHERE motebit_id = ? ORDER BY timestamp DESC LIMIT ?",
      [motebitId, limit],
    );
    return rows.map(rowToGradientSnapshot);
  }
}

// === ExpoAgentTrustStore ===

interface AgentTrustRow {
  motebit_id: string;
  remote_motebit_id: string;
  trust_level: string;
  public_key: string | null;
  first_seen_at: number;
  last_seen_at: number;
  interaction_count: number;
  successful_tasks: number;
  failed_tasks: number;
  notes: string | null;
}

function rowToAgentTrust(row: AgentTrustRow): AgentTrustRecord {
  const record: AgentTrustRecord = {
    motebit_id: row.motebit_id,
    remote_motebit_id: row.remote_motebit_id,
    trust_level: row.trust_level as AgentTrustLevel,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    interaction_count: row.interaction_count,
    successful_tasks: row.successful_tasks,
    failed_tasks: row.failed_tasks,
  };
  if (row.public_key !== null) record.public_key = row.public_key;
  if (row.notes !== null) record.notes = row.notes;
  return record;
}

export class ExpoAgentTrustStore implements AgentTrustStoreAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async getAgentTrust(
    motebitId: string,
    remoteMotebitId: string,
  ): Promise<AgentTrustRecord | null> {
    const row = this.db.getFirstSync<AgentTrustRow>(
      "SELECT * FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?",
      [motebitId, remoteMotebitId],
    );
    return row ? rowToAgentTrust(row) : null;
  }

  async setAgentTrust(record: AgentTrustRecord): Promise<void> {
    this.db.runSync(
      `INSERT OR REPLACE INTO agent_trust
       (motebit_id, remote_motebit_id, trust_level, public_key, first_seen_at, last_seen_at, interaction_count, successful_tasks, failed_tasks, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.motebit_id,
        record.remote_motebit_id,
        record.trust_level,
        record.public_key ?? null,
        record.first_seen_at,
        record.last_seen_at,
        record.interaction_count,
        record.successful_tasks ?? 0,
        record.failed_tasks ?? 0,
        record.notes ?? null,
      ],
    );
  }

  async listAgentTrust(motebitId: string): Promise<AgentTrustRecord[]> {
    const rows = this.db.getAllSync<AgentTrustRow>(
      "SELECT * FROM agent_trust WHERE motebit_id = ? ORDER BY last_seen_at DESC",
      [motebitId],
    );
    return rows.map(rowToAgentTrust);
  }

  async updateTrustLevel(
    motebitId: string,
    remoteMotebitId: string,
    level: AgentTrustLevel,
  ): Promise<void> {
    this.db.runSync(
      "UPDATE agent_trust SET trust_level = ?, last_seen_at = ? WHERE motebit_id = ? AND remote_motebit_id = ?",
      [level, Date.now(), motebitId, remoteMotebitId],
    );
  }
}

// === ServiceListingStore ===

interface ServiceListingRow {
  listing_id: string;
  motebit_id: string;
  capabilities: string;
  pricing: string;
  sla_max_latency_ms: number;
  sla_availability: number;
  description: string;
  updated_at: number;
}

function rowToServiceListing(row: ServiceListingRow): AgentServiceListing {
  return {
    listing_id: row.listing_id as ListingId,
    motebit_id: row.motebit_id as MotebitId,
    capabilities: JSON.parse(row.capabilities) as string[],
    pricing: JSON.parse(row.pricing) as CapabilityPrice[],
    sla: { max_latency_ms: row.sla_max_latency_ms, availability_guarantee: row.sla_availability },
    description: row.description,
    updated_at: row.updated_at,
  };
}

export class ExpoServiceListingStore {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async get(motebitId: string): Promise<AgentServiceListing | null> {
    const row = this.db.getFirstSync<ServiceListingRow>(
      "SELECT * FROM service_listings WHERE motebit_id = ?",
      [motebitId],
    );
    return row ? rowToServiceListing(row) : null;
  }

  async set(listing: AgentServiceListing): Promise<void> {
    this.db.runSync(
      `INSERT OR REPLACE INTO service_listings
       (listing_id, motebit_id, capabilities, pricing, sla_max_latency_ms, sla_availability, description, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        listing.listing_id,
        listing.motebit_id,
        JSON.stringify(listing.capabilities),
        JSON.stringify(listing.pricing),
        listing.sla.max_latency_ms,
        listing.sla.availability_guarantee,
        listing.description,
        listing.updated_at,
      ],
    );
  }

  async list(): Promise<AgentServiceListing[]> {
    const rows = this.db.getAllSync<ServiceListingRow>(
      "SELECT * FROM service_listings ORDER BY updated_at DESC",
    );
    return rows.map(rowToServiceListing);
  }

  async delete(listingId: string): Promise<void> {
    this.db.runSync("DELETE FROM service_listings WHERE listing_id = ?", [listingId]);
  }
}

// === BudgetAllocationStore ===

interface BudgetAllocationRow {
  allocation_id: string;
  goal_id: string;
  candidate_motebit_id: string;
  amount_locked: number;
  currency: string;
  created_at: number;
  status: string;
}

function rowToBudgetAllocation(row: BudgetAllocationRow): BudgetAllocation {
  return {
    allocation_id: row.allocation_id as AllocationId,
    goal_id: row.goal_id as GoalId,
    candidate_motebit_id: row.candidate_motebit_id as MotebitId,
    amount_locked: row.amount_locked,
    currency: row.currency,
    created_at: row.created_at,
    status: row.status as BudgetAllocation["status"],
  };
}

export class ExpoBudgetAllocationStore {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async get(allocationId: string): Promise<BudgetAllocation | null> {
    const row = this.db.getFirstSync<BudgetAllocationRow>(
      "SELECT * FROM budget_allocations WHERE allocation_id = ?",
      [allocationId],
    );
    return row ? rowToBudgetAllocation(row) : null;
  }

  async create(allocation: BudgetAllocation): Promise<void> {
    this.db.runSync(
      `INSERT INTO budget_allocations
       (allocation_id, goal_id, candidate_motebit_id, amount_locked, currency, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        allocation.allocation_id,
        allocation.goal_id,
        allocation.candidate_motebit_id,
        allocation.amount_locked,
        allocation.currency,
        allocation.created_at,
        allocation.status,
      ],
    );
  }

  async updateStatus(allocationId: string, status: string): Promise<void> {
    this.db.runSync("UPDATE budget_allocations SET status = ? WHERE allocation_id = ?", [
      status,
      allocationId,
    ]);
  }

  async listByGoal(goalId: string): Promise<BudgetAllocation[]> {
    const rows = this.db.getAllSync<BudgetAllocationRow>(
      "SELECT * FROM budget_allocations WHERE goal_id = ? ORDER BY created_at DESC",
      [goalId],
    );
    return rows.map(rowToBudgetAllocation);
  }
}

// === SettlementStore ===

interface SettlementRow {
  settlement_id: string;
  allocation_id: string;
  receipt_hash: string;
  ledger_hash: string | null;
  amount_settled: number;
  platform_fee: number;
  platform_fee_rate: number;
  status: string;
  settled_at: number;
  // Self-attestation columns added by audit-#1 schema migration. Nullable
  // for backward-compat with rows persisted before SettlementRecord became
  // signed; legacy NULLs surface as empty strings — wire-schema validation
  // downstream rejects them, the intended fail-closed signal.
  issuer_relay_id: string | null;
  suite: string | null;
  signature: string | null;
}

function rowToSettlement(row: SettlementRow): SettlementRecord {
  return {
    settlement_id: row.settlement_id as SettlementId,
    allocation_id: row.allocation_id as AllocationId,
    receipt_hash: row.receipt_hash,
    ledger_hash: row.ledger_hash,
    amount_settled: row.amount_settled,
    platform_fee: row.platform_fee,
    platform_fee_rate: row.platform_fee_rate,
    status: row.status as SettlementRecord["status"],
    settled_at: row.settled_at,
    issuer_relay_id: row.issuer_relay_id ?? "",
    suite: (row.suite as SettlementRecord["suite"] | null) ?? "motebit-jcs-ed25519-b64-v1",
    signature: row.signature ?? "",
  };
}

export class ExpoSettlementStore {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async get(settlementId: string): Promise<SettlementRecord | null> {
    const row = this.db.getFirstSync<SettlementRow>(
      "SELECT * FROM settlements WHERE settlement_id = ?",
      [settlementId],
    );
    return row ? rowToSettlement(row) : null;
  }

  async create(settlement: SettlementRecord): Promise<void> {
    this.db.runSync(
      `INSERT INTO settlements
       (settlement_id, allocation_id, receipt_hash, ledger_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at, issuer_relay_id, suite, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        settlement.settlement_id,
        settlement.allocation_id,
        settlement.receipt_hash,
        settlement.ledger_hash,
        settlement.amount_settled,
        settlement.platform_fee,
        settlement.platform_fee_rate,
        settlement.status,
        settlement.settled_at,
        settlement.issuer_relay_id,
        settlement.suite,
        settlement.signature,
      ],
    );
  }

  async listByAllocation(allocationId: string): Promise<SettlementRecord[]> {
    const rows = this.db.getAllSync<SettlementRow>(
      "SELECT * FROM settlements WHERE allocation_id = ? ORDER BY settled_at DESC",
      [allocationId],
    );
    return rows.map(rowToSettlement);
  }
}

// === LatencyStatsStore ===

interface LatencyStatRow {
  id: number;
  motebit_id: string;
  remote_motebit_id: string;
  latency_ms: number;
  recorded_at: number;
}

export class ExpoLatencyStatsStore {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async record(motebitId: string, remoteMotebitId: string, latencyMs: number): Promise<void> {
    this.db.runSync(
      "INSERT INTO latency_stats (motebit_id, remote_motebit_id, latency_ms, recorded_at) VALUES (?, ?, ?, ?)",
      [motebitId, remoteMotebitId, latencyMs, Date.now()],
    );
  }

  async getStats(
    motebitId: string,
    remoteMotebitId: string,
    limit = 100,
  ): Promise<{ avg_ms: number; p95_ms: number; sample_count: number }> {
    const rows = this.db.getAllSync<LatencyStatRow>(
      "SELECT latency_ms FROM latency_stats WHERE motebit_id = ? AND remote_motebit_id = ? ORDER BY recorded_at DESC LIMIT ?",
      [motebitId, remoteMotebitId, limit],
    );
    if (rows.length === 0) return { avg_ms: 0, p95_ms: 0, sample_count: 0 };

    const values = rows.map((r) => r.latency_ms);
    const avg_ms = values.reduce((a, b) => a + b, 0) / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const p95Index = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
    const p95_ms = sorted[p95Index]!;

    return { avg_ms, p95_ms, sample_count: values.length };
  }
}

// === CredentialStore ===

export class ExpoCredentialStore implements CredentialStoreAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  save(credential: StoredCredential): void {
    this.db.runSync(
      `INSERT OR REPLACE INTO issued_credentials
       (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        credential.credential_id,
        credential.subject_motebit_id,
        credential.issuer_did,
        credential.credential_type,
        credential.credential_json,
        credential.issued_at,
      ],
    );
  }

  listBySubject(subjectMotebitId: string, limit = 100): StoredCredential[] {
    const rows = this.db.getAllSync<StoredCredential>(
      "SELECT * FROM issued_credentials WHERE subject_motebit_id = ? ORDER BY issued_at DESC LIMIT ?",
      [subjectMotebitId, limit],
    );
    return rows;
  }

  list(motebitId: string, type?: string, limit = 100): StoredCredential[] {
    const pattern = `%${motebitId}%`;
    if (type) {
      return this.db.getAllSync<StoredCredential>(
        "SELECT * FROM issued_credentials WHERE (issuer_did LIKE ? OR subject_motebit_id LIKE ?) AND credential_type = ? ORDER BY issued_at DESC LIMIT ?",
        [pattern, pattern, type, limit],
      );
    }
    return this.db.getAllSync<StoredCredential>(
      "SELECT * FROM issued_credentials WHERE issuer_did LIKE ? OR subject_motebit_id LIKE ? ORDER BY issued_at DESC LIMIT ?",
      [pattern, pattern, limit],
    );
  }
}

// === ApprovalStore ===

export class ExpoApprovalStore implements ApprovalStoreAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  collectApproval(approvalId: string, approverId: string): { met: boolean; collected: string[] } {
    const row = this.db.getFirstSync<{
      required: number;
      collected: string;
    }>("SELECT required, collected FROM approvals WHERE approval_id = ?", [approvalId]);
    if (!row) return { met: false, collected: [] };

    let collected: string[];
    try {
      collected = JSON.parse(row.collected) as string[];
    } catch {
      collected = [];
    }

    // Deduplicate — only add if not already collected
    if (!collected.includes(approverId)) {
      collected.push(approverId);
    }

    const met = collected.length >= row.required;

    this.db.runSync("UPDATE approvals SET collected = ? WHERE approval_id = ?", [
      JSON.stringify(collected),
      approvalId,
    ]);

    return { met, collected: [...collected] };
  }

  setQuorum(approvalId: string, required: number, approvers: string[]): void {
    // Preserve collected from existing row if present
    const existing = this.db.getFirstSync<{ collected: string }>(
      "SELECT collected FROM approvals WHERE approval_id = ?",
      [approvalId],
    );
    const collected = existing?.collected ?? "[]";

    this.db.runSync(
      "INSERT OR REPLACE INTO approvals (approval_id, required, approvers, collected) VALUES (?, ?, ?, ?)",
      [approvalId, required, JSON.stringify(approvers), collected],
    );
  }
}

// === ToolAuditSink ===

interface ToolAuditRow {
  id: number;
  turn_id: string;
  run_id: string | null;
  call_id: string;
  tool: string;
  args: string;
  decision: string;
  result: string | null;
  injection: string | null;
  cost_units: number | null;
  timestamp: number;
  sensitivity: string | null;
}

function rowToToolAudit(row: ToolAuditRow): ToolAuditEntry {
  const entry: ToolAuditEntry = {
    callId: row.call_id,
    turnId: row.turn_id,
    tool: row.tool,
    args: JSON.parse(row.args) as Record<string, unknown>,
    decision: JSON.parse(row.decision) as PolicyDecision,
    result: row.result
      ? (JSON.parse(row.result) as { ok: boolean; durationMs: number })
      : undefined,
    timestamp: row.timestamp,
  };
  if (row.run_id !== null) {
    entry.runId = row.run_id;
  }
  if (row.injection !== null) {
    entry.injection = JSON.parse(row.injection) as ToolAuditEntry["injection"];
  }
  if (row.cost_units != null && row.cost_units > 0) {
    entry.costUnits = row.cost_units;
  }
  if (row.sensitivity !== null) {
    entry.sensitivity = row.sensitivity as SensitivityLevel;
  }
  return entry;
}

export class ExpoToolAuditSink implements AuditLogSink {
  constructor(private db: SQLite.SQLiteDatabase) {}

  append(entry: ToolAuditEntry): void {
    this.db.runSync(
      `INSERT INTO tool_audit (call_id, turn_id, run_id, tool, args, decision, result, injection, cost_units, timestamp, sensitivity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.callId,
        entry.turnId,
        entry.runId ?? null,
        entry.tool,
        JSON.stringify(entry.args),
        JSON.stringify(entry.decision),
        entry.result ? JSON.stringify(entry.result) : null,
        entry.injection ? JSON.stringify(entry.injection) : null,
        entry.costUnits ?? 0,
        entry.timestamp,
        entry.sensitivity ?? null,
      ],
    );
  }

  enumerateForFlush(beforeTimestamp: number): ToolAuditEntry[] {
    const rows = this.db.getAllSync<ToolAuditRow>(
      "SELECT * FROM tool_audit WHERE timestamp < ? ORDER BY timestamp ASC",
      [beforeTimestamp],
    );
    return rows.map(rowToToolAudit);
  }

  erase(callId: string): void {
    this.db.runSync("DELETE FROM tool_audit WHERE call_id = ?", [callId]);
  }

  query(turnId: string): ToolAuditEntry[] {
    const rows = this.db.getAllSync<ToolAuditRow>(
      "SELECT * FROM tool_audit WHERE turn_id = ? ORDER BY timestamp ASC",
      [turnId],
    );
    return rows.map(rowToToolAudit);
  }

  getAll(): ToolAuditEntry[] {
    const rows = this.db.getAllSync<ToolAuditRow>(
      "SELECT * FROM tool_audit ORDER BY timestamp ASC",
    );
    return rows.map(rowToToolAudit);
  }

  queryStatsSince(afterTimestamp: number): AuditStatsSince {
    const row = this.db.getFirstSync<{
      distinct_turns: number;
      total: number;
      blocked: number;
      succeeded: number;
      failed: number;
    }>(
      `SELECT
        COUNT(DISTINCT turn_id) as distinct_turns,
        COUNT(*) as total,
        SUM(CASE WHEN json_extract(decision, '$.allowed') = 0 THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN json_extract(result, '$.ok') = 1 THEN 1 ELSE 0 END) as succeeded,
        SUM(CASE WHEN json_extract(result, '$.ok') = 0 THEN 1 ELSE 0 END) as failed
       FROM tool_audit WHERE timestamp > ?`,
      [afterTimestamp],
    );
    if (!row) {
      return { distinctTurns: 0, totalToolCalls: 0, succeeded: 0, blocked: 0, failed: 0 };
    }
    return {
      distinctTurns: row.distinct_turns ?? 0,
      totalToolCalls: row.total ?? 0,
      succeeded: row.succeeded ?? 0,
      blocked: row.blocked ?? 0,
      failed: row.failed ?? 0,
    };
  }

  queryByRunId(runId: string): ToolAuditEntry[] {
    const rows = this.db.getAllSync<ToolAuditRow>(
      "SELECT * FROM tool_audit WHERE run_id = ? ORDER BY timestamp ASC",
      [runId],
    );
    return rows.map(rowToToolAudit);
  }
}

// ===========================================================================
// Skills — installed procedural-knowledge bundles per spec/skills-v1.md.
// ===========================================================================

interface SkillRow {
  name: string;
  inserted_at: number;
  index_json: string;
  manifest_json: string;
  envelope_json: string;
  body: Uint8Array;
  files_json: string;
}

/**
 * Expo-SQLite-backed `SkillStorageAdapter`. Mirrors the IDB-backed
 * adapter on web (`packages/browser-persistence/src/idb-skills.ts`) and
 * the Node-fs adapter on desktop sidecar (`@motebit/skills/fs`). Same
 * wire shape (`StoredSkill`), different storage namespace.
 *
 * Body bytes are stored in a native BLOB column; per-file payloads are
 * base64-encoded inside `files_json` so the JSON column carries the
 * full `Record<string, Uint8Array>` map without needing a sibling
 * blob-per-file table. Insertion order is preserved via `inserted_at`
 * for `list()` stability — matches the fs adapter's
 * `installed.json` array semantics and the IDB adapter's `insertedAt`
 * field.
 *
 * Privilege boundary: this adapter runs in the same React Native
 * runtime as the panel UI. No sidecar isolation analogue exists in
 * Expo. See `packages/skills/CLAUDE.md` rule 5 for the per-surface
 * isolation contract.
 */
export class ExpoSqliteSkillStorageAdapter implements SkillStorageAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async list(): Promise<InstalledSkillIndexEntry[]> {
    const rows = this.db.getAllSync<{ index_json: string; inserted_at: number }>(
      "SELECT index_json, inserted_at FROM skills ORDER BY inserted_at ASC",
    );
    return rows.map((r) => JSON.parse(r.index_json) as InstalledSkillIndexEntry);
  }

  async read(name: string): Promise<StoredSkill | null> {
    const row = this.db.getFirstSync<SkillRow>("SELECT * FROM skills WHERE name = ?", [name]);
    if (!row) return null;
    return {
      index: JSON.parse(row.index_json) as InstalledSkillIndexEntry,
      manifest: JSON.parse(row.manifest_json) as StoredSkill["manifest"],
      envelope: JSON.parse(row.envelope_json) as StoredSkill["envelope"],
      body: new Uint8Array(row.body),
      files: filesFromJson(row.files_json),
    };
  }

  async write(skill: StoredSkill): Promise<void> {
    // Preserve original inserted_at on overwrite so list ordering is
    // stable when a caller --force-reinstalls. Same semantics as the
    // fs adapter (installed.json array position) and the IDB adapter.
    const existing = this.db.getFirstSync<{ inserted_at: number }>(
      "SELECT inserted_at FROM skills WHERE name = ?",
      [skill.index.name],
    );
    const insertedAt = existing?.inserted_at ?? Date.now();
    this.db.runSync(
      `INSERT OR REPLACE INTO skills
        (name, inserted_at, index_json, manifest_json, envelope_json, body, files_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        skill.index.name,
        insertedAt,
        JSON.stringify(skill.index),
        JSON.stringify(skill.manifest),
        JSON.stringify(skill.envelope),
        skill.body,
        filesToJson(skill.files),
      ],
    );
  }

  async remove(name: string): Promise<void> {
    this.db.runSync("DELETE FROM skills WHERE name = ?", [name]);
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.patchIndex(name, (idx) => ({ ...idx, enabled }));
  }

  async setTrusted(name: string, trusted: boolean): Promise<void> {
    await this.patchIndex(name, (idx) => ({ ...idx, trusted }));
  }

  /** Read-modify-write of just the index_json column — leaves the bytes
   *  (body, envelope, manifest, files) untouched on enable/trust toggles.
   *  Single transaction; no partial state. */
  private async patchIndex(
    name: string,
    update: (existing: InstalledSkillIndexEntry) => InstalledSkillIndexEntry,
  ): Promise<void> {
    const row = this.db.getFirstSync<{ index_json: string }>(
      "SELECT index_json FROM skills WHERE name = ?",
      [name],
    );
    if (!row) return;
    const next = update(JSON.parse(row.index_json) as InstalledSkillIndexEntry);
    this.db.runSync("UPDATE skills SET index_json = ? WHERE name = ?", [
      JSON.stringify(next),
      name,
    ]);
  }
}

function filesToJson(files: Record<string, Uint8Array>): string {
  const out: Record<string, string> = {};
  for (const [key, bytes] of Object.entries(files)) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    out[key] = btoa(bin);
  }
  return JSON.stringify(out);
}

function filesFromJson(json: string): Record<string, Uint8Array> {
  const parsed = JSON.parse(json) as Record<string, string>;
  const out: Record<string, Uint8Array> = {};
  for (const [key, b64] of Object.entries(parsed)) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    out[key] = bytes;
  }
  return out;
}

// === Factory ===

export interface ExpoStorageResult extends StorageAdapters {
  goalStore: ExpoGoalStore;
  planStore: ExpoPlanStore;
  gradientStore: ExpoGradientStore;
  agentTrustStore: ExpoAgentTrustStore;
  conversationSyncStore: ExpoSqliteConversationSyncStore;
  serviceListingStore: ExpoServiceListingStore;
  budgetAllocationStore: ExpoBudgetAllocationStore;
  settlementStore: ExpoSettlementStore;
  latencyStatsStore: ExpoLatencyStatsStore;
  credentialStore: ExpoCredentialStore;
  approvalStore: ExpoApprovalStore;
  toolAuditSink: ExpoToolAuditSink;
  /**
   * Skill storage — owns the SQLite-backed persistence the mobile
   * `SkillRegistry` reads/writes through. Not part of the canonical
   * `StorageAdapters` shape because skills aren't a Ring-2 privacy
   * substrate; the registry is constructed from this in `mobile-app.ts`
   * and exposed via `MobileApp.getSkillRegistry()` for the panel.
   */
  skillStorage: ExpoSqliteSkillStorageAdapter;
}

/**
 * Adapt expo-sqlite's `SQLiteDatabase` (sync API) into the minimal driver
 * shape `@motebit/sqlite-migrations`' runner consumes. Mobile doesn't use
 * a typed transaction primitive elsewhere, so the runner's transaction
 * boundary maps to BEGIN/COMMIT strings — same effect, smaller surface.
 */
function expoSqliteDriver(db: SQLite.SQLiteDatabase): SyncSqliteDriver {
  return {
    exec(sql: string): void {
      db.execSync(sql);
    },
    pragma(sql: string): unknown {
      const trimmed = sql.trim();
      if (/^user_version$/i.test(trimmed)) {
        const row = db.getFirstSync<{ user_version: number }>("PRAGMA user_version");
        return [{ user_version: row?.user_version ?? 0 }];
      }
      db.execSync(`PRAGMA ${trimmed}`);
      return [];
    },
    transaction<T>(fn: () => T): T {
      db.execSync("BEGIN");
      try {
        const result = fn();
        db.execSync("COMMIT");
        return result;
      } catch (err) {
        db.execSync("ROLLBACK");
        throw err;
      }
    },
  };
}

export function createExpoStorage(dbName = "motebit.db"): ExpoStorageResult {
  const db = SQLite.openDatabaseSync(dbName);
  db.execSync("PRAGMA journal_mode = WAL");
  db.execSync("PRAGMA foreign_keys = ON");
  db.execSync(SCHEMA);

  runMigrations(expoSqliteDriver(db), MOBILE_MIGRATIONS);

  return {
    eventStore: new ExpoSqliteEventStore(db),
    memoryStorage: new ExpoSqliteMemoryStorage(db),
    identityStorage: new ExpoSqliteIdentityStorage(db),
    auditLog: new ExpoSqliteAuditLog(db),
    stateSnapshot: new ExpoSqliteStateSnapshot(db),
    conversationStore: new ExpoSqliteConversationStore(db),
    goalStore: new ExpoGoalStore(db),
    planStore: new ExpoPlanStore(db),
    gradientStore: new ExpoGradientStore(db),
    agentTrustStore: new ExpoAgentTrustStore(db),
    conversationSyncStore: new ExpoSqliteConversationSyncStore(db),
    serviceListingStore: new ExpoServiceListingStore(db),
    budgetAllocationStore: new ExpoBudgetAllocationStore(db),
    settlementStore: new ExpoSettlementStore(db),
    latencyStatsStore: new ExpoLatencyStatsStore(db),
    credentialStore: new ExpoCredentialStore(db),
    approvalStore: new ExpoApprovalStore(db),
    toolAuditSink: new ExpoToolAuditSink(db),
    skillStorage: new ExpoSqliteSkillStorageAdapter(db),
  };
}
