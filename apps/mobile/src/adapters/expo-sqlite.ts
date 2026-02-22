/**
 * Expo-SQLite adapter for MotebitRuntime storage.
 *
 * Wraps expo-sqlite into EventStoreAdapter, MemoryStorageAdapter,
 * IdentityStorage, AuditLogAdapter, and StateSnapshotAdapter.
 *
 * Uses the same schema as @motebit/persistence (better-sqlite3),
 * so data is wire-compatible across desktop and mobile.
 */

import * as SQLite from "expo-sqlite";
import type { EventLogEntry, EventType, MemoryNode, MemoryEdge, MotebitIdentity, AuditRecord, SensitivityLevel, RelationType, Plan, PlanStep } from "@motebit/sdk";
import { StepStatus } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import type { MemoryStorageAdapter, MemoryQuery } from "@motebit/memory-graph";
import { computeDecayedConfidence } from "@motebit/memory-graph";
import type { IdentityStorage } from "@motebit/core-identity";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import type { StateSnapshotAdapter, ConversationStoreAdapter, StorageAdapters } from "@motebit/runtime";
import type { SyncConversation, SyncConversationMessage } from "@motebit/sdk";
import type { ConversationSyncStoreAdapter } from "@motebit/sync-engine";
import type { PlanStoreAdapter } from "@motebit/planner";

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
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_mote ON memory_nodes (motebit_id);

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
  token_estimate INTEGER NOT NULL DEFAULT 0
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
      [entry.event_id, entry.motebit_id, entry.device_id ?? null, entry.event_type, JSON.stringify(entry.payload), entry.version_clock, entry.timestamp, entry.tombstoned ? 1 : 0],
    );
  }

  async query(filter: EventFilter): Promise<EventLogEntry[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.motebit_id !== undefined) { conditions.push("motebit_id = ?"); params.push(filter.motebit_id); }
    if (filter.event_types !== undefined && filter.event_types.length > 0) {
      conditions.push(`event_type IN (${filter.event_types.map(() => "?").join(", ")})`);
      params.push(...filter.event_types);
    }
    if (filter.after_timestamp !== undefined) { conditions.push("timestamp > ?"); params.push(filter.after_timestamp); }
    if (filter.before_timestamp !== undefined) { conditions.push("timestamp < ?"); params.push(filter.before_timestamp); }
    if (filter.after_version_clock !== undefined) { conditions.push("version_clock > ?"); params.push(filter.after_version_clock); }

    let sql = "SELECT * FROM events";
    if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
    sql += " ORDER BY version_clock ASC";
    if (filter.limit !== undefined) { sql += " LIMIT ?"; params.push(filter.limit); }

    const rows = this.db.getAllSync(sql, params) as EventRow[];
    return rows.map(rowToEvent);
  }

  async getLatestClock(motebitId: string): Promise<number> {
    const row = this.db.getFirstSync(
      "SELECT MAX(version_clock) as max_clock FROM events WHERE motebit_id = ?",
      [motebitId],
    ) as { max_clock: number | null } | null;
    return row?.max_clock ?? 0;
  }

  async tombstone(eventId: string, motebitId: string): Promise<void> {
    this.db.runSync(
      "UPDATE events SET tombstoned = 1 WHERE event_id = ? AND motebit_id = ?",
      [eventId, motebitId],
    );
  }

  async compact(motebitId: string, beforeClock: number): Promise<number> {
    const before = this.db.getFirstSync(
      "SELECT COUNT(*) as cnt FROM events WHERE motebit_id = ? AND version_clock <= ?",
      [motebitId, beforeClock],
    ) as { cnt: number } | null;
    this.db.runSync(
      "DELETE FROM events WHERE motebit_id = ? AND version_clock <= ?",
      [motebitId, beforeClock],
    );
    return before?.cnt ?? 0;
  }

  async countEvents(motebitId: string): Promise<number> {
    const row = this.db.getFirstSync(
      "SELECT COUNT(*) as cnt FROM events WHERE motebit_id = ?",
      [motebitId],
    ) as { cnt: number } | null;
    return row?.cnt ?? 0;
  }
}

// === MemoryStorage Adapter ===

export class ExpoSqliteMemoryStorage implements MemoryStorageAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async saveNode(node: MemoryNode): Promise<void> {
    this.db.runSync(
      `INSERT OR REPLACE INTO memory_nodes
       (node_id, motebit_id, content, embedding, confidence, sensitivity, created_at, last_accessed, half_life, tombstoned, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [node.node_id, node.motebit_id, node.content, JSON.stringify(node.embedding), node.confidence, node.sensitivity, node.created_at, node.last_accessed, node.half_life, node.tombstoned ? 1 : 0, node.pinned ? 1 : 0],
    );
  }

  async getNode(nodeId: string): Promise<MemoryNode | null> {
    const row = this.db.getFirstSync("SELECT * FROM memory_nodes WHERE node_id = ?", [nodeId]) as NodeRow | null;
    return row ? rowToNode(row) : null;
  }

  async queryNodes(query: MemoryQuery): Promise<MemoryNode[]> {
    const rows = this.db.getAllSync("SELECT * FROM memory_nodes WHERE motebit_id = ?", [query.motebit_id]) as NodeRow[];
    let results = rows.map(rowToNode);

    if (query.include_tombstoned !== true) results = results.filter((n) => !n.tombstoned);

    if (query.min_confidence !== undefined) {
      const now = Date.now();
      const minConf = query.min_confidence;
      results = results.filter((n) => computeDecayedConfidence(n.confidence, n.half_life, now - n.created_at) >= minConf);
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
      [edge.edge_id, edge.source_id, edge.target_id, edge.relation_type, edge.weight, edge.confidence],
    );
  }

  async getEdges(nodeId: string): Promise<MemoryEdge[]> {
    const rows = this.db.getAllSync(
      "SELECT * FROM memory_edges WHERE source_id = ? OR target_id = ?",
      [nodeId, nodeId],
    ) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  async tombstoneNode(nodeId: string): Promise<void> {
    this.db.runSync("UPDATE memory_nodes SET tombstoned = 1 WHERE node_id = ?", [nodeId]);
  }

  async pinNode(nodeId: string, pinned: boolean): Promise<void> {
    this.db.runSync("UPDATE memory_nodes SET pinned = ? WHERE node_id = ? AND tombstoned = 0", [pinned ? 1 : 0, nodeId]);
  }

  async getAllNodes(motebitId: string): Promise<MemoryNode[]> {
    const rows = this.db.getAllSync("SELECT * FROM memory_nodes WHERE motebit_id = ?", [motebitId]) as NodeRow[];
    return rows.map(rowToNode);
  }

  async getAllEdges(motebitId: string): Promise<MemoryEdge[]> {
    const rows = this.db.getAllSync(
      `SELECT DISTINCT e.* FROM memory_edges e
       INNER JOIN memory_nodes n ON (e.source_id = n.node_id OR e.target_id = n.node_id)
       WHERE n.motebit_id = ?`,
      [motebitId],
    ) as EdgeRow[];
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
    const row = this.db.getFirstSync("SELECT * FROM identities WHERE motebit_id = ?", [motebitId]) as IdentityRow | null;
    return row ? rowToIdentity(row) : null;
  }

  async loadByOwner(ownerId: string): Promise<MotebitIdentity | null> {
    const row = this.db.getFirstSync("SELECT * FROM identities WHERE owner_id = ? LIMIT 1", [ownerId]) as IdentityRow | null;
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
      [entry.audit_id, entry.motebit_id, entry.timestamp, entry.action, entry.target_type, entry.target_id, JSON.stringify(entry.details)],
    );
  }

  async query(motebitId: string, options: { limit?: number; after?: number } = {}): Promise<AuditRecord[]> {
    const conditions: string[] = ["motebit_id = ?"];
    const params: (string | number)[] = [motebitId];

    if (options.after !== undefined) { conditions.push("timestamp > ?"); params.push(options.after); }

    const sql = `SELECT * FROM audit_log WHERE ${conditions.join(" AND ")} ORDER BY timestamp ASC`;
    const rows = this.db.getAllSync(sql, params) as AuditRow[];
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
    const row = this.db.getFirstSync(
      "SELECT state_json FROM state_snapshots WHERE motebit_id = ?",
      [motebitId],
    ) as { state_json: string } | null;
    return row?.state_json ?? null;
  }

  getSnapshotClock(motebitId: string): number {
    const row = this.db.getFirstSync(
      "SELECT version_clock FROM state_snapshots WHERE motebit_id = ?",
      [motebitId],
    ) as { version_clock: number } | null;
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

  appendMessage(conversationId: string, motebitId: string, msg: {
    role: string;
    content: string;
    toolCalls?: string;
    toolCallId?: string;
  }): void {
    const messageId = crypto.randomUUID();
    const now = Date.now();
    const tokenEstimate = Math.ceil(msg.content.length / 4);
    this.db.runSync(
      `INSERT INTO conversation_messages (message_id, conversation_id, motebit_id, role, content, tool_calls, tool_call_id, created_at, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [messageId, conversationId, motebitId, msg.role, msg.content, msg.toolCalls ?? null, msg.toolCallId ?? null, now, tokenEstimate],
    );
    this.db.runSync(
      "UPDATE conversations SET last_active_at = ?, message_count = message_count + 1 WHERE conversation_id = ?",
      [now, conversationId],
    );
  }

  loadMessages(conversationId: string, limit?: number): Array<{
    messageId: string;
    conversationId: string;
    motebitId: string;
    role: string;
    content: string;
    toolCalls: string | null;
    toolCallId: string | null;
    createdAt: number;
    tokenEstimate: number;
  }> {
    let sql = "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC";
    const params: (string | number)[] = [conversationId];
    if (limit !== undefined) {
      sql += " LIMIT ?";
      params.push(limit);
    }
    const rows = this.db.getAllSync(sql, params) as ConversationMessageRow[];
    return rows.map((r) => ({
      messageId: r.message_id,
      conversationId: r.conversation_id,
      motebitId: r.motebit_id,
      role: r.role,
      content: r.content,
      toolCalls: r.tool_calls,
      toolCallId: r.tool_call_id,
      createdAt: r.created_at,
      tokenEstimate: r.token_estimate,
    }));
  }

  getActiveConversation(motebitId: string): {
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    summary: string | null;
  } | null {
    const cutoff = Date.now() - ACTIVE_CONVERSATION_WINDOW_MS;
    const row = this.db.getFirstSync(
      "SELECT * FROM conversations WHERE motebit_id = ? AND last_active_at > ? ORDER BY last_active_at DESC LIMIT 1",
      [motebitId, cutoff],
    ) as ConversationRow | null;
    if (!row) return null;
    return {
      conversationId: row.conversation_id,
      startedAt: row.started_at,
      lastActiveAt: row.last_active_at,
      summary: row.summary,
    };
  }

  updateSummary(conversationId: string, summary: string): void {
    this.db.runSync(
      "UPDATE conversations SET summary = ? WHERE conversation_id = ?",
      [summary, conversationId],
    );
  }

  updateTitle(conversationId: string, title: string): void {
    this.db.runSync(
      "UPDATE conversations SET title = ? WHERE conversation_id = ?",
      [title, conversationId],
    );
  }

  getMessageCount(conversationId: string): number {
    const row = this.db.getFirstSync(
      "SELECT message_count FROM conversations WHERE conversation_id = ?",
      [conversationId],
    ) as { message_count: number } | null;
    return row?.message_count ?? 0;
  }

  listConversations(motebitId: string, limit = 20): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> {
    const rows = this.db.getAllSync(
      "SELECT * FROM conversations WHERE motebit_id = ? ORDER BY last_active_at DESC LIMIT ?",
      [motebitId, limit],
    ) as ConversationRow[];
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      startedAt: r.started_at,
      lastActiveAt: r.last_active_at,
      title: r.title,
      messageCount: r.message_count,
    }));
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
    const rows = this.db.getAllSync(
      "SELECT * FROM goals WHERE motebit_id = ? AND enabled = 1 AND status = 'active' ORDER BY created_at ASC",
      [motebitId],
    ) as GoalRow[];
    return rows.map(rowToGoal);
  }

  listGoals(motebitId: string): Goal[] {
    const rows = this.db.getAllSync(
      "SELECT * FROM goals WHERE motebit_id = ? ORDER BY created_at ASC",
      [motebitId],
    ) as GoalRow[];
    return rows.map(rowToGoal);
  }

  getRecentOutcomes(goalId: string, limit: number): GoalOutcome[] {
    const rows = this.db.getAllSync(
      "SELECT * FROM goal_outcomes WHERE goal_id = ? ORDER BY ran_at DESC LIMIT ?",
      [goalId, limit],
    ) as GoalOutcomeRow[];
    return rows.map(rowToGoalOutcome);
  }

  updateLastRun(goalId: string, timestamp: number): void {
    this.db.runSync(
      "UPDATE goals SET last_run_at = ? WHERE goal_id = ?",
      [timestamp, goalId],
    );
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
    this.db.runSync(
      "UPDATE goals SET status = ? WHERE goal_id = ?",
      [status, goalId],
    );
  }

  incrementFailures(goalId: string): void {
    this.db.runSync(
      "UPDATE goals SET consecutive_failures = consecutive_failures + 1 WHERE goal_id = ?",
      [goalId],
    );
    // Auto-pause if max_retries reached
    const row = this.db.getFirstSync(
      "SELECT consecutive_failures, max_retries FROM goals WHERE goal_id = ?",
      [goalId],
    ) as { consecutive_failures: number; max_retries: number } | null;
    if (row && row.consecutive_failures >= row.max_retries) {
      this.db.runSync(
        "UPDATE goals SET status = 'paused' WHERE goal_id = ?",
        [goalId],
      );
    }
  }

  resetFailures(goalId: string): void {
    this.db.runSync(
      "UPDATE goals SET consecutive_failures = 0 WHERE goal_id = ?",
      [goalId],
    );
  }

  addGoal(motebitId: string, prompt: string, intervalMs: number, mode: GoalMode = "recurring"): string {
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
    this.db.runSync(
      "UPDATE goals SET enabled = ?, status = ? WHERE goal_id = ?",
      [enabled ? 1 : 0, enabled ? "active" : "paused", goalId],
    );
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
  };
}

function rowToPlanStep(row: PlanStepRow): PlanStep {
  let dependsOn: string[] = [];
  try { dependsOn = JSON.parse(row.depends_on) as string[]; } catch { /* empty */ }
  return {
    step_id: row.step_id,
    plan_id: row.plan_id,
    ordinal: row.ordinal,
    description: row.description,
    prompt: row.prompt,
    depends_on: dependsOn,
    optional: row.optional === 1,
    status: row.status as PlanStep["status"],
    result_summary: row.result_summary,
    error_message: row.error_message,
    tool_calls_made: row.tool_calls_made,
    started_at: row.started_at,
    completed_at: row.completed_at,
    retry_count: row.retry_count,
  };
}

export class ExpoPlanStore implements PlanStoreAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  savePlan(plan: Plan): void {
    this.db.runSync(
      `INSERT OR REPLACE INTO plans (plan_id, goal_id, motebit_id, title, status, created_at, updated_at, current_step_index, total_steps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [plan.plan_id, plan.goal_id, plan.motebit_id, plan.title, plan.status, plan.created_at, plan.updated_at, plan.current_step_index, plan.total_steps],
    );
  }

  getPlan(planId: string): Plan | null {
    const row = this.db.getFirstSync("SELECT * FROM plans WHERE plan_id = ?", [planId]) as PlanRow | null;
    return row ? rowToPlan(row) : null;
  }

  getPlanForGoal(goalId: string): Plan | null {
    const row = this.db.getFirstSync(
      "SELECT * FROM plans WHERE goal_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      [goalId],
    ) as PlanRow | null;
    return row ? rowToPlan(row) : null;
  }

  updatePlan(planId: string, updates: Partial<Plan>): void {
    const fields: string[] = [];
    const values: SQLite.SQLiteBindValue[] = [];
    if (updates.title !== undefined) { fields.push("title = ?"); values.push(updates.title); }
    if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
    if (updates.updated_at !== undefined) { fields.push("updated_at = ?"); values.push(updates.updated_at); }
    if (updates.current_step_index !== undefined) { fields.push("current_step_index = ?"); values.push(updates.current_step_index); }
    if (updates.total_steps !== undefined) { fields.push("total_steps = ?"); values.push(updates.total_steps); }
    if (fields.length === 0) return;
    values.push(planId);
    this.db.runSync(`UPDATE plans SET ${fields.join(", ")} WHERE plan_id = ?`, values);
  }

  saveStep(step: PlanStep): void {
    this.db.runSync(
      `INSERT OR REPLACE INTO plan_steps (step_id, plan_id, ordinal, description, prompt, depends_on, optional, status, result_summary, error_message, tool_calls_made, started_at, completed_at, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [step.step_id, step.plan_id, step.ordinal, step.description, step.prompt, JSON.stringify(step.depends_on), step.optional ? 1 : 0, step.status, step.result_summary, step.error_message, step.tool_calls_made, step.started_at, step.completed_at, step.retry_count],
    );
  }

  getStep(stepId: string): PlanStep | null {
    const row = this.db.getFirstSync("SELECT * FROM plan_steps WHERE step_id = ?", [stepId]) as PlanStepRow | null;
    return row ? rowToPlanStep(row) : null;
  }

  getStepsForPlan(planId: string): PlanStep[] {
    const rows = this.db.getAllSync("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY ordinal ASC", [planId]) as PlanStepRow[];
    return rows.map(rowToPlanStep);
  }

  updateStep(stepId: string, updates: Partial<PlanStep>): void {
    const fields: string[] = [];
    const values: SQLite.SQLiteBindValue[] = [];
    if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
    if (updates.result_summary !== undefined) { fields.push("result_summary = ?"); values.push(updates.result_summary); }
    if (updates.error_message !== undefined) { fields.push("error_message = ?"); values.push(updates.error_message); }
    if (updates.tool_calls_made !== undefined) { fields.push("tool_calls_made = ?"); values.push(updates.tool_calls_made); }
    if (updates.started_at !== undefined) { fields.push("started_at = ?"); values.push(updates.started_at); }
    if (updates.completed_at !== undefined) { fields.push("completed_at = ?"); values.push(updates.completed_at); }
    if (updates.retry_count !== undefined) { fields.push("retry_count = ?"); values.push(updates.retry_count); }
    if (fields.length === 0) return;
    values.push(stepId);
    this.db.runSync(`UPDATE plan_steps SET ${fields.join(", ")} WHERE step_id = ?`, values);
  }

  getNextPendingStep(planId: string): PlanStep | null {
    const row = this.db.getFirstSync(
      "SELECT * FROM plan_steps WHERE plan_id = ? AND status = ? ORDER BY ordinal ASC LIMIT 1",
      [planId, StepStatus.Pending],
    ) as PlanStepRow | null;
    return row ? rowToPlanStep(row) : null;
  }
}

// === ConversationSync Adapter (for SyncEngine) ===

export class ExpoSqliteConversationSyncStore implements ConversationSyncStoreAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  getConversationsSince(motebitId: string, since: number): SyncConversation[] {
    const rows = this.db.getAllSync(
      "SELECT * FROM conversations WHERE motebit_id = ? AND last_active_at > ? ORDER BY last_active_at ASC",
      [motebitId, since],
    ) as ConversationRow[];
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
    const rows = this.db.getAllSync(
      "SELECT * FROM conversation_messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at ASC",
      [conversationId, since],
    ) as ConversationMessageRow[];
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
    const existing = this.db.getFirstSync(
      "SELECT last_active_at FROM conversations WHERE conversation_id = ?",
      [conv.conversation_id],
    ) as { last_active_at: number } | null;

    if (!existing) {
      this.db.runSync(
        `INSERT INTO conversations (conversation_id, motebit_id, started_at, last_active_at, title, summary, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [conv.conversation_id, conv.motebit_id, conv.started_at, conv.last_active_at, conv.title, conv.summary, conv.message_count],
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
      [msg.message_id, msg.conversation_id, msg.motebit_id, msg.role, msg.content, msg.tool_calls, msg.tool_call_id, msg.created_at, msg.token_estimate],
    );
  }
}

// === Factory ===

export interface ExpoStorageResult extends StorageAdapters {
  goalStore: ExpoGoalStore;
  planStore: ExpoPlanStore;
  conversationSyncStore: ExpoSqliteConversationSyncStore;
}

export function createExpoStorage(dbName = "motebit.db"): ExpoStorageResult {
  const db = SQLite.openDatabaseSync(dbName);
  db.execSync("PRAGMA journal_mode = WAL");
  db.execSync("PRAGMA foreign_keys = ON");

  const versionRow = db.getFirstSync("PRAGMA user_version") as { user_version: number } | null;
  const userVersion = versionRow?.user_version ?? 0;

  db.execSync(SCHEMA);

  if (userVersion < 1) {
    try {
      db.execSync("ALTER TABLE events ADD COLUMN device_id TEXT");
    } catch (_) {
      // Column may already exist on new DBs that have it in CREATE TABLE
    }
    db.execSync("PRAGMA user_version = 1");
  }

  if (userVersion < 2) {
    try {
      db.execSync("ALTER TABLE state_snapshots ADD COLUMN version_clock INTEGER NOT NULL DEFAULT 0");
    } catch (_) {
      // Column may already exist on new DBs
    }
    db.execSync("PRAGMA user_version = 2");
  }

  // Migration 3: conversation tables (added in schema above, but need migration for existing DBs)
  if (userVersion < 3) {
    try {
      db.execSync(`
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
          token_estimate INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_conv_messages
          ON conversation_messages (conversation_id, created_at ASC);
      `);
    } catch (_) {
      // Tables may already exist on new DBs that have them in the main SCHEMA
    }
    db.execSync("PRAGMA user_version = 3");
  }

  // Migration 4: goals and goal_outcomes tables
  if (userVersion < 4) {
    try {
      db.execSync(`
        CREATE TABLE IF NOT EXISTS goals (
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
        );
        CREATE INDEX IF NOT EXISTS idx_goals_motebit ON goals (motebit_id);

        CREATE TABLE IF NOT EXISTS goal_outcomes (
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
        );
        CREATE INDEX IF NOT EXISTS idx_goal_outcomes_goal ON goal_outcomes (goal_id, ran_at DESC);
      `);
    } catch (_) {
      // Tables may already exist on new DBs
    }
    db.execSync("PRAGMA user_version = 4");
  }

  if (userVersion < 5) {
    try {
      db.execSync("ALTER TABLE memory_nodes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    } catch (_) {
      // Column already exists on new DBs
    }
    db.execSync("PRAGMA user_version = 5");
  }

  // Migration 6: plan tables
  if (userVersion < 6) {
    try {
      db.execSync(`
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
      `);
    } catch (_) {
      // Tables may already exist on new DBs
    }
    db.execSync("PRAGMA user_version = 6");
  }

  return {
    eventStore: new ExpoSqliteEventStore(db),
    memoryStorage: new ExpoSqliteMemoryStorage(db),
    identityStorage: new ExpoSqliteIdentityStorage(db),
    auditLog: new ExpoSqliteAuditLog(db),
    stateSnapshot: new ExpoSqliteStateSnapshot(db),
    conversationStore: new ExpoSqliteConversationStore(db),
    goalStore: new ExpoGoalStore(db),
    planStore: new ExpoPlanStore(db),
    conversationSyncStore: new ExpoSqliteConversationSyncStore(db),
  };
}
