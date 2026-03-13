import { createRequire } from "node:module";
import type { DatabaseDriver, PreparedStatement } from "./driver.js";
export type { DatabaseDriver, PreparedStatement, RunResult } from "./driver.js";
export { SqlJsDriver } from "./sqljs-driver.js";
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
} from "@motebit/sdk";
import { PlanStatus, StepStatus, AgentTrustLevel } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import type { MemoryStorageAdapter, MemoryQuery } from "@motebit/memory-graph";
import { computeDecayedConfidence } from "@motebit/memory-graph";
import type { IdentityStorage, DeviceRegistration } from "@motebit/core-identity";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import type { ToolAuditEntry, PolicyDecision } from "@motebit/sdk";
import type { AuditLogSink, AuditStatsSince } from "@motebit/policy";

// === Schema ===

// Base table definitions — columns here must match the original v0 schema.
// Migration-added columns and their indexes live exclusively in runMigrations().
// On existing DBs, CREATE TABLE IF NOT EXISTS is a no-op, so only migrations
// can alter the table shape. On new DBs, migrations also run (userVersion=0)
// and add all columns + indexes incrementally.
const SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  version_clock INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0
);

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
  tombstoned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memory_edges (
  edge_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  weight REAL NOT NULL,
  confidence REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS identities (
  motebit_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  version_clock INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state_snapshots (
  motebit_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_audit_log (
  call_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  decision TEXT NOT NULL,
  result TEXT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  device_token TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  device_name TEXT
);

CREATE TABLE IF NOT EXISTS goals (
  goal_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  interval_ms INTEGER NOT NULL,
  last_run_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS goal_outcomes (
  outcome_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  motebit_id TEXT NOT NULL,
  ran_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  tool_calls_made INTEGER NOT NULL DEFAULT 0,
  memories_formed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS approval_queue (
  approval_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_preview TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  risk_level INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  denied_reason TEXT
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
  stats TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_trust (
  motebit_id TEXT NOT NULL,
  remote_motebit_id TEXT NOT NULL,
  trust_level TEXT NOT NULL DEFAULT 'unknown',
  public_key TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  PRIMARY KEY (motebit_id, remote_motebit_id)
);
`;

// Base indexes — only reference columns that exist in SCHEMA_TABLES above.
// Indexes on migration-added columns are created in their respective migrations.
const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_events_mote_clock ON events (motebit_id, version_clock);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_mote ON memory_nodes (motebit_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges (source_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges (target_id);
CREATE INDEX IF NOT EXISTS idx_identities_owner ON identities (owner_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_mote_ts ON audit_log (motebit_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_audit_turn ON tool_audit_log (turn_id);
CREATE INDEX IF NOT EXISTS idx_devices_motebit ON devices (motebit_id);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices (device_token);
CREATE INDEX IF NOT EXISTS idx_goals_motebit ON goals (motebit_id);
CREATE INDEX IF NOT EXISTS idx_goal_outcomes_goal ON goal_outcomes (goal_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_queue_motebit_status ON approval_queue (motebit_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_motebit ON conversations (motebit_id, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_messages ON conversation_messages (conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_plans_goal ON plans (goal_id);
CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps (plan_id, ordinal ASC);
CREATE INDEX IF NOT EXISTS idx_gradient_motebit_ts ON gradient_snapshots (motebit_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_agent_trust_motebit ON agent_trust (motebit_id);
`;

function initSchema(db: DatabaseDriver): void {
  db.exec(SCHEMA_TABLES);
  db.exec(SCHEMA_INDEXES);
}

// === SqliteEventStore ===

export class SqliteEventStore implements EventStoreAdapter {
  private stmtAppend: PreparedStatement;
  private stmtGetLatestClock: PreparedStatement;
  private stmtTombstone: PreparedStatement;

  constructor(private db: DatabaseDriver) {
    this.stmtAppend = db.prepare(
      `INSERT OR IGNORE INTO events (event_id, motebit_id, device_id, event_type, payload, version_clock, timestamp, tombstoned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetLatestClock = db.prepare(
      `SELECT MAX(version_clock) as max_clock FROM events WHERE motebit_id = ?`,
    );
    this.stmtTombstone = db.prepare(
      `UPDATE events SET tombstoned = 1 WHERE event_id = ? AND motebit_id = ?`,
    );
  }

  async append(entry: EventLogEntry): Promise<void> {
    this.stmtAppend.run(
      entry.event_id,
      entry.motebit_id,
      entry.device_id ?? null,
      entry.event_type,
      JSON.stringify(entry.payload),
      entry.version_clock,
      entry.timestamp,
      entry.tombstoned ? 1 : 0,
    );
  }

  async query(filter: EventFilter): Promise<EventLogEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.motebit_id !== undefined) {
      conditions.push("motebit_id = ?");
      params.push(filter.motebit_id);
    }
    if (filter.event_types !== undefined && filter.event_types.length > 0) {
      const placeholders = filter.event_types.map(() => "?").join(", ");
      conditions.push(`event_type IN (${placeholders})`);
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
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY version_clock ASC";
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(rowToEvent);
  }

  async getLatestClock(motebitId: string): Promise<number> {
    const row = this.stmtGetLatestClock.get(motebitId) as { max_clock: number | null };
    return row.max_clock ?? 0;
  }

  async tombstone(eventId: string, motebitId: string): Promise<void> {
    this.stmtTombstone.run(eventId, motebitId);
  }

  async compact(motebitId: string, beforeClock: number): Promise<number> {
    const info = this.db
      .prepare("DELETE FROM events WHERE motebit_id = ? AND version_clock <= ?")
      .run(motebitId, beforeClock);
    return info.changes;
  }

  async countEvents(motebitId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM events WHERE motebit_id = ?")
      .get(motebitId) as { cnt: number };
    return row.cnt;
  }
}

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

// === SqliteMemoryStorage ===

export class SqliteMemoryStorage implements MemoryStorageAdapter {
  private stmtSaveNode: PreparedStatement;
  private stmtGetNode: PreparedStatement;
  private stmtSaveEdge: PreparedStatement;
  private stmtGetEdges: PreparedStatement;
  private stmtTombstoneNode: PreparedStatement;
  private stmtGetAllNodes: PreparedStatement;
  private stmtPinNode: PreparedStatement;

  constructor(private db: DatabaseDriver) {
    this.stmtSaveNode = db.prepare(
      `INSERT OR REPLACE INTO memory_nodes
       (node_id, motebit_id, content, embedding, confidence, sensitivity, created_at, last_accessed, half_life, tombstoned, pinned, memory_type, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetNode = db.prepare(`SELECT * FROM memory_nodes WHERE node_id = ?`);
    this.stmtSaveEdge = db.prepare(
      `INSERT OR REPLACE INTO memory_edges
       (edge_id, source_id, target_id, relation_type, weight, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetEdges = db.prepare(
      `SELECT * FROM memory_edges WHERE source_id = ? OR target_id = ?`,
    );
    this.stmtTombstoneNode = db.prepare(`UPDATE memory_nodes SET tombstoned = 1 WHERE node_id = ?`);
    this.stmtGetAllNodes = db.prepare(`SELECT * FROM memory_nodes WHERE motebit_id = ?`);
    this.stmtPinNode = db.prepare(
      `UPDATE memory_nodes SET pinned = ? WHERE node_id = ? AND tombstoned = 0`,
    );
  }

  /** Whether app-level filters (min_confidence, sensitivity_filter) are needed */
  private needsAppFilter(query: MemoryQuery): boolean {
    return query.min_confidence !== undefined || query.sensitivity_filter !== undefined;
  }

  async saveNode(node: MemoryNode): Promise<void> {
    this.stmtSaveNode.run(
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
    );
  }

  async getNode(nodeId: string): Promise<MemoryNode | null> {
    const row = this.stmtGetNode.get(nodeId) as NodeRow | undefined;
    if (row === undefined) return null;
    return rowToNode(row);
  }

  async queryNodes(query: MemoryQuery): Promise<MemoryNode[]> {
    // Build SQL with conditions that can be pushed into the query
    const conditions: string[] = ["motebit_id = ?"];
    const params: unknown[] = [query.motebit_id];

    if (query.include_tombstoned !== true) {
      conditions.push("tombstoned = 0");
    }

    if (query.pinned !== undefined) {
      conditions.push("pinned = ?");
      params.push(query.pinned ? 1 : 0);
    }

    let sql = `SELECT * FROM memory_nodes WHERE ${conditions.join(" AND ")}`;

    // When limit is set, always ORDER BY last_accessed DESC and push a bounded LIMIT to SQL.
    // When app-level filters are needed, over-fetch with a generous cap so the filter
    // still has enough candidates after culling.
    if (query.limit !== undefined) {
      sql += " ORDER BY last_accessed DESC";
      if (this.needsAppFilter(query)) {
        sql += " LIMIT ?";
        params.push(Math.max(query.limit * 8, 200));
      } else {
        sql += " LIMIT ?";
        params.push(query.limit);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    let results = rows.map(rowToNode);

    // App-level filters: decay computation and sensitivity array
    if (query.min_confidence !== undefined) {
      const now = Date.now();
      const minConf = query.min_confidence;
      results = results.filter((n) => {
        const decayed = computeDecayedConfidence(n.confidence, n.half_life, now - n.created_at);
        return decayed >= minConf;
      });
    }

    if (query.sensitivity_filter !== undefined) {
      const allowed = query.sensitivity_filter;
      results = results.filter((n) => allowed.includes(n.sensitivity));
    }

    if (query.limit !== undefined) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async saveEdge(edge: MemoryEdge): Promise<void> {
    this.stmtSaveEdge.run(
      edge.edge_id,
      edge.source_id,
      edge.target_id,
      edge.relation_type,
      edge.weight,
      edge.confidence,
    );
  }

  async getEdges(nodeId: string): Promise<MemoryEdge[]> {
    const rows = this.stmtGetEdges.all(nodeId, nodeId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  async tombstoneNode(nodeId: string): Promise<void> {
    this.stmtTombstoneNode.run(nodeId);
  }

  async tombstoneNodeOwned(nodeId: string, motebitId: string): Promise<boolean> {
    const info = this.db
      .prepare(`UPDATE memory_nodes SET tombstoned = 1 WHERE node_id = ? AND motebit_id = ?`)
      .run(nodeId, motebitId);
    return info.changes > 0;
  }

  async getAllNodes(motebitId: string): Promise<MemoryNode[]> {
    const rows = this.stmtGetAllNodes.all(motebitId) as NodeRow[];
    return rows.map(rowToNode);
  }

  async getAllEdges(motebitId: string): Promise<MemoryEdge[]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.* FROM memory_edges e
         INNER JOIN memory_nodes n ON (e.source_id = n.node_id OR e.target_id = n.node_id)
         WHERE n.motebit_id = ?`,
      )
      .all(motebitId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  async pinNode(nodeId: string, pinned: boolean): Promise<void> {
    this.stmtPinNode.run(pinned ? 1 : 0, nodeId);
  }
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

interface EdgeRow {
  edge_id: string;
  source_id: string;
  target_id: string;
  relation_type: string;
  weight: number;
  confidence: number;
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

// === SqliteIdentityStorage ===

export class SqliteIdentityStorage implements IdentityStorage {
  private stmtSave: PreparedStatement;
  private stmtLoad: PreparedStatement;
  private stmtLoadByOwner: PreparedStatement;
  private stmtSaveDevice: PreparedStatement;
  private stmtLoadDevice: PreparedStatement;
  private stmtLoadDeviceByToken: PreparedStatement;
  private stmtListDevices: PreparedStatement;

  constructor(db: DatabaseDriver) {
    this.stmtSave = db.prepare(
      `INSERT OR REPLACE INTO identities (motebit_id, created_at, owner_id, version_clock)
       VALUES (?, ?, ?, ?)`,
    );
    this.stmtLoad = db.prepare(`SELECT * FROM identities WHERE motebit_id = ?`);
    this.stmtLoadByOwner = db.prepare(`SELECT * FROM identities WHERE owner_id = ? LIMIT 1`);
    this.stmtSaveDevice = db.prepare(
      `INSERT OR REPLACE INTO devices (device_id, motebit_id, device_token, public_key, registered_at, device_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stmtLoadDevice = db.prepare(`SELECT * FROM devices WHERE device_id = ?`);
    this.stmtLoadDeviceByToken = db.prepare(`SELECT * FROM devices WHERE device_token = ?`);
    this.stmtListDevices = db.prepare(`SELECT * FROM devices WHERE motebit_id = ?`);
  }

  async save(identity: MotebitIdentity): Promise<void> {
    this.stmtSave.run(
      identity.motebit_id,
      identity.created_at,
      identity.owner_id,
      identity.version_clock,
    );
  }

  async load(motebitId: string): Promise<MotebitIdentity | null> {
    const row = this.stmtLoad.get(motebitId) as IdentityRow | undefined;
    if (row === undefined) return null;
    return rowToIdentity(row);
  }

  async loadByOwner(ownerId: string): Promise<MotebitIdentity | null> {
    const row = this.stmtLoadByOwner.get(ownerId) as IdentityRow | undefined;
    if (row === undefined) return null;
    return rowToIdentity(row);
  }

  async saveDevice(device: DeviceRegistration): Promise<void> {
    this.stmtSaveDevice.run(
      device.device_id,
      device.motebit_id,
      device.device_token,
      device.public_key,
      device.registered_at,
      device.device_name ?? null,
    );
  }

  async loadDevice(deviceId: string): Promise<DeviceRegistration | null> {
    const row = this.stmtLoadDevice.get(deviceId) as DeviceRow | undefined;
    if (row === undefined) return null;
    return rowToDevice(row);
  }

  async loadDeviceByToken(token: string): Promise<DeviceRegistration | null> {
    const row = this.stmtLoadDeviceByToken.get(token) as DeviceRow | undefined;
    if (row === undefined) return null;
    return rowToDevice(row);
  }

  async listDevices(motebitId: string): Promise<DeviceRegistration[]> {
    const rows = this.stmtListDevices.all(motebitId) as DeviceRow[];
    return rows.map(rowToDevice);
  }
}

interface IdentityRow {
  motebit_id: string;
  created_at: number;
  owner_id: string;
  version_clock: number;
}

function rowToIdentity(row: IdentityRow): MotebitIdentity {
  return {
    motebit_id: row.motebit_id,
    created_at: row.created_at,
    owner_id: row.owner_id,
    version_clock: row.version_clock,
  };
}

interface DeviceRow {
  device_id: string;
  motebit_id: string;
  device_token: string;
  public_key: string;
  registered_at: number;
  device_name: string | null;
}

function rowToDevice(row: DeviceRow): DeviceRegistration {
  const device: DeviceRegistration = {
    device_id: row.device_id,
    motebit_id: row.motebit_id,
    device_token: row.device_token,
    public_key: row.public_key,
    registered_at: row.registered_at,
  };
  if (row.device_name !== null) {
    device.device_name = row.device_name;
  }
  return device;
}

// === SqliteAuditLog ===

export class SqliteAuditLog implements AuditLogAdapter {
  private stmtRecord: PreparedStatement;

  constructor(private db: DatabaseDriver) {
    this.stmtRecord = db.prepare(
      `INSERT INTO audit_log (audit_id, motebit_id, timestamp, action, target_type, target_id, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  async record(entry: AuditRecord): Promise<void> {
    this.stmtRecord.run(
      entry.audit_id,
      entry.motebit_id,
      entry.timestamp,
      entry.action,
      entry.target_type,
      entry.target_id,
      JSON.stringify(entry.details),
    );
  }

  async query(
    motebitId: string,
    options: { limit?: number; after?: number } = {},
  ): Promise<AuditRecord[]> {
    const conditions: string[] = ["motebit_id = ?"];
    const params: unknown[] = [motebitId];

    if (options.after !== undefined) {
      conditions.push("timestamp > ?");
      params.push(options.after);
    }

    // Match InMemoryAuditLog: return last N records (slice from end)
    const sql = `SELECT * FROM audit_log WHERE ${conditions.join(" AND ")} ORDER BY timestamp ASC`;

    const rows = this.db.prepare(sql).all(...params) as AuditRow[];
    let results = rows.map(rowToAudit);

    if (options.limit !== undefined) {
      results = results.slice(-options.limit);
    }

    return results;
  }
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

// === SqliteStateSnapshot ===

export class SqliteStateSnapshot {
  private stmtSave: PreparedStatement;
  private stmtLoad: PreparedStatement;
  private stmtLoadClock: PreparedStatement;

  constructor(db: DatabaseDriver) {
    this.stmtSave = db.prepare(
      `INSERT OR REPLACE INTO state_snapshots (motebit_id, state_json, updated_at, version_clock)
       VALUES (?, ?, ?, ?)`,
    );
    this.stmtLoad = db.prepare(`SELECT state_json FROM state_snapshots WHERE motebit_id = ?`);
    this.stmtLoadClock = db.prepare(
      `SELECT version_clock FROM state_snapshots WHERE motebit_id = ?`,
    );
  }

  saveState(motebitId: string, stateJson: string, versionClock?: number): void {
    this.stmtSave.run(motebitId, stateJson, Date.now(), versionClock ?? 0);
  }

  loadState(motebitId: string): string | null {
    const row = this.stmtLoad.get(motebitId) as { state_json: string } | undefined;
    if (row === undefined) return null;
    return row.state_json;
  }

  getSnapshotClock(motebitId: string): number {
    const row = this.stmtLoadClock.get(motebitId) as { version_clock: number } | undefined;
    return row?.version_clock ?? 0;
  }
}

// === SqliteToolAuditSink ===

interface ToolAuditRow {
  call_id: string;
  turn_id: string;
  run_id: string | null;
  tool: string;
  args: string;
  decision: string;
  result: string | null;
  injection: string | null;
  cost_units: number;
  timestamp: number;
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
  if (row.cost_units > 0) {
    entry.costUnits = row.cost_units;
  }
  return entry;
}

export class SqliteToolAuditSink implements AuditLogSink {
  private stmtAppend: PreparedStatement;
  private stmtQueryTurn: PreparedStatement;
  private stmtGetAll: PreparedStatement;
  private stmtStatsSince: PreparedStatement;

  constructor(db: DatabaseDriver) {
    this.stmtAppend = db.prepare(
      `INSERT OR REPLACE INTO tool_audit_log (call_id, turn_id, run_id, tool, args, decision, result, injection, cost_units, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtQueryTurn = db.prepare(
      `SELECT * FROM tool_audit_log WHERE turn_id = ? ORDER BY timestamp ASC`,
    );
    this.stmtGetAll = db.prepare(`SELECT * FROM tool_audit_log ORDER BY timestamp ASC`);
    this.stmtStatsSince = db.prepare(
      `SELECT
        COUNT(DISTINCT turn_id) as distinct_turns,
        COUNT(*) as total,
        SUM(CASE WHEN json_extract(decision, '$.allowed') = 0 THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN json_extract(result, '$.ok') = 1 THEN 1 ELSE 0 END) as succeeded,
        SUM(CASE WHEN json_extract(result, '$.ok') = 0 THEN 1 ELSE 0 END) as failed
       FROM tool_audit_log WHERE timestamp > ?`,
    );
  }

  append(entry: ToolAuditEntry): void {
    this.stmtAppend.run(
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
    );
  }

  query(turnId: string): ToolAuditEntry[] {
    const rows = this.stmtQueryTurn.all(turnId) as ToolAuditRow[];
    return rows.map(rowToToolAudit);
  }

  getAll(): ToolAuditEntry[] {
    const rows = this.stmtGetAll.all() as ToolAuditRow[];
    return rows.map(rowToToolAudit);
  }

  queryStatsSince(afterTimestamp: number): AuditStatsSince {
    const row = this.stmtStatsSince.get(afterTimestamp) as {
      distinct_turns: number;
      total: number;
      blocked: number;
      succeeded: number;
      failed: number;
    } | undefined;
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
}

// === Goal Store ===

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
  /** Max wall-clock time per run in ms. null = use scheduler default. */
  wall_clock_ms: number | null;
  /** Project ID for grouping related goals. Goals with same project_id share context. */
  project_id: string | null;
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
  wall_clock_ms: number | null;
  project_id: string | null;
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
    wall_clock_ms: row.wall_clock_ms ?? null,
    project_id: row.project_id ?? null,
  };
}

export class SqliteGoalStore {
  private stmtAdd: PreparedStatement;
  private stmtRemove: PreparedStatement;
  private stmtList: PreparedStatement;
  private stmtGet: PreparedStatement;
  private stmtUpdateLastRun: PreparedStatement;
  private stmtSetEnabled: PreparedStatement;
  private stmtSetStatus: PreparedStatement;
  private stmtIncrementFailures: PreparedStatement;
  private stmtResetFailures: PreparedStatement;
  private stmtListChildren: PreparedStatement;
  private stmtListByProject: PreparedStatement;

  constructor(db: DatabaseDriver) {
    this.stmtAdd = db.prepare(
      `INSERT OR REPLACE INTO goals (goal_id, motebit_id, prompt, interval_ms, last_run_at, enabled, created_at, mode, status, parent_goal_id, max_retries, consecutive_failures, wall_clock_ms, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtRemove = db.prepare(`DELETE FROM goals WHERE goal_id = ?`);
    this.stmtList = db.prepare(`SELECT * FROM goals WHERE motebit_id = ? ORDER BY created_at ASC`);
    this.stmtGet = db.prepare(`SELECT * FROM goals WHERE goal_id = ?`);
    this.stmtUpdateLastRun = db.prepare(`UPDATE goals SET last_run_at = ? WHERE goal_id = ?`);
    this.stmtSetEnabled = db.prepare(`UPDATE goals SET enabled = ?, status = ? WHERE goal_id = ?`);
    this.stmtSetStatus = db.prepare(`UPDATE goals SET status = ? WHERE goal_id = ?`);
    this.stmtIncrementFailures = db.prepare(
      `UPDATE goals SET consecutive_failures = consecutive_failures + 1 WHERE goal_id = ?`,
    );
    this.stmtResetFailures = db.prepare(
      `UPDATE goals SET consecutive_failures = 0 WHERE goal_id = ?`,
    );
    this.stmtListChildren = db.prepare(
      `SELECT * FROM goals WHERE parent_goal_id = ? ORDER BY created_at ASC`,
    );
    this.stmtListByProject = db.prepare(
      `SELECT * FROM goals WHERE project_id = ? AND motebit_id = ? ORDER BY created_at ASC`,
    );
  }

  add(goal: Goal): void {
    this.stmtAdd.run(
      goal.goal_id,
      goal.motebit_id,
      goal.prompt,
      goal.interval_ms,
      goal.last_run_at,
      goal.enabled ? 1 : 0,
      goal.created_at,
      goal.mode ?? "recurring",
      goal.status ?? "active",
      goal.parent_goal_id ?? null,
      goal.max_retries ?? 3,
      goal.consecutive_failures ?? 0,
      goal.wall_clock_ms ?? null,
      goal.project_id ?? null,
    );
  }

  remove(goalId: string): void {
    this.stmtRemove.run(goalId);
  }

  get(goalId: string): Goal | null {
    const row = this.stmtGet.get(goalId) as GoalRow | undefined;
    if (row === undefined) return null;
    return rowToGoal(row);
  }

  list(motebitId: string): Goal[] {
    const rows = this.stmtList.all(motebitId) as GoalRow[];
    return rows.map(rowToGoal);
  }

  listChildren(parentGoalId: string): Goal[] {
    const rows = this.stmtListChildren.all(parentGoalId) as GoalRow[];
    return rows.map(rowToGoal);
  }

  listByProject(projectId: string, motebitId: string): Goal[] {
    const rows = this.stmtListByProject.all(projectId, motebitId) as GoalRow[];
    return rows.map(rowToGoal);
  }

  updateLastRun(goalId: string, timestamp: number): void {
    this.stmtUpdateLastRun.run(timestamp, goalId);
  }

  setEnabled(goalId: string, enabled: boolean): void {
    this.stmtSetEnabled.run(enabled ? 1 : 0, enabled ? "active" : "paused", goalId);
  }

  setStatus(goalId: string, status: GoalStatus): void {
    this.stmtSetStatus.run(status, goalId);
  }

  incrementFailures(goalId: string): void {
    this.stmtIncrementFailures.run(goalId);
  }

  resetFailures(goalId: string): void {
    this.stmtResetFailures.run(goalId);
  }
}

// === Goal Outcome Store ===

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
  tokens_used?: number;
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
  tokens_used: number | null;
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
    ...(row.tokens_used != null ? { tokens_used: row.tokens_used } : {}),
  };
}

export class SqliteGoalOutcomeStore {
  private stmtAdd: PreparedStatement;
  private stmtListForGoal: PreparedStatement;
  private stmtListRecent: PreparedStatement;

  constructor(db: DatabaseDriver) {
    this.stmtAdd = db.prepare(
      `INSERT OR REPLACE INTO goal_outcomes
       (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message, tokens_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtListForGoal = db.prepare(
      `SELECT * FROM goal_outcomes WHERE goal_id = ? ORDER BY ran_at DESC LIMIT ?`,
    );
    this.stmtListRecent = db.prepare(
      `SELECT * FROM goal_outcomes WHERE motebit_id = ? ORDER BY ran_at DESC LIMIT ?`,
    );
  }

  add(outcome: GoalOutcome): void {
    this.stmtAdd.run(
      outcome.outcome_id,
      outcome.goal_id,
      outcome.motebit_id,
      outcome.ran_at,
      outcome.status,
      outcome.summary,
      outcome.tool_calls_made,
      outcome.memories_formed,
      outcome.error_message,
      outcome.tokens_used ?? null,
    );
  }

  listForGoal(goalId: string, limit = 10): GoalOutcome[] {
    const rows = this.stmtListForGoal.all(goalId, limit) as GoalOutcomeRow[];
    return rows.map(rowToGoalOutcome);
  }

  listRecent(motebitId: string, limit = 10): GoalOutcome[] {
    const rows = this.stmtListRecent.all(motebitId, limit) as GoalOutcomeRow[];
    return rows.map(rowToGoalOutcome);
  }
}

// === Approval Queue ===

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalItem {
  approval_id: string;
  motebit_id: string;
  goal_id: string;
  tool_name: string;
  args_preview: string;
  args_hash: string;
  risk_level: number;
  status: ApprovalStatus;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  denied_reason: string | null;
}

interface ApprovalRow {
  approval_id: string;
  motebit_id: string;
  goal_id: string;
  tool_name: string;
  args_preview: string;
  args_hash: string;
  risk_level: number;
  status: string;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  denied_reason: string | null;
}

function rowToApproval(row: ApprovalRow): ApprovalItem {
  return {
    approval_id: row.approval_id,
    motebit_id: row.motebit_id,
    goal_id: row.goal_id,
    tool_name: row.tool_name,
    args_preview: row.args_preview,
    args_hash: row.args_hash,
    risk_level: row.risk_level,
    status: row.status as ApprovalStatus,
    created_at: row.created_at,
    expires_at: row.expires_at,
    resolved_at: row.resolved_at,
    denied_reason: row.denied_reason,
  };
}

export class SqliteApprovalStore {
  private stmtAdd: PreparedStatement;
  private stmtGet: PreparedStatement;
  private stmtListPending: PreparedStatement;
  private stmtListAll: PreparedStatement;
  private stmtResolve: PreparedStatement;
  private stmtExpireStale: PreparedStatement;

  constructor(db: DatabaseDriver) {
    this.stmtAdd = db.prepare(
      `INSERT OR REPLACE INTO approval_queue
       (approval_id, motebit_id, goal_id, tool_name, args_preview, args_hash, risk_level, status, created_at, expires_at, resolved_at, denied_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGet = db.prepare(`SELECT * FROM approval_queue WHERE approval_id = ?`);
    this.stmtListPending = db.prepare(
      `SELECT * FROM approval_queue WHERE motebit_id = ? AND status = 'pending' ORDER BY created_at ASC`,
    );
    this.stmtListAll = db.prepare(
      `SELECT * FROM approval_queue WHERE motebit_id = ? ORDER BY created_at DESC LIMIT ?`,
    );
    this.stmtResolve = db.prepare(
      `UPDATE approval_queue SET status = ?, resolved_at = ?, denied_reason = ? WHERE approval_id = ?`,
    );
    this.stmtExpireStale = db.prepare(
      `UPDATE approval_queue SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at <= ?`,
    );
  }

  add(item: ApprovalItem): void {
    this.stmtAdd.run(
      item.approval_id,
      item.motebit_id,
      item.goal_id,
      item.tool_name,
      item.args_preview,
      item.args_hash,
      item.risk_level,
      item.status,
      item.created_at,
      item.expires_at,
      item.resolved_at,
      item.denied_reason,
    );
  }

  get(approvalId: string): ApprovalItem | null {
    const row = this.stmtGet.get(approvalId) as ApprovalRow | undefined;
    if (row === undefined) return null;
    return rowToApproval(row);
  }

  listPending(motebitId: string): ApprovalItem[] {
    const rows = this.stmtListPending.all(motebitId) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  listAll(motebitId: string, limit = 50): ApprovalItem[] {
    const rows = this.stmtListAll.all(motebitId, limit) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  resolve(approvalId: string, status: "approved" | "denied", deniedReason?: string): void {
    this.stmtResolve.run(status, Date.now(), deniedReason ?? null, approvalId);
  }

  expireStale(now: number): number {
    const info = this.stmtExpireStale.run(now, now);
    return info.changes;
  }
}

// === Conversation Store ===

export interface Conversation {
  conversationId: string;
  motebitId: string;
  startedAt: number;
  lastActiveAt: number;
  title: string | null;
  summary: string | null;
  messageCount: number;
}

export interface ConversationMessage {
  messageId: string;
  conversationId: string;
  motebitId: string;
  role: string;
  content: string;
  toolCalls: string | null;
  toolCallId: string | null;
  createdAt: number;
  tokenEstimate: number;
}

interface ConversationRow {
  conversation_id: string;
  motebit_id: string;
  started_at: number;
  last_active_at: number;
  title: string | null;
  summary: string | null;
  message_count: number;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    conversationId: row.conversation_id,
    motebitId: row.motebit_id,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    title: row.title,
    summary: row.summary,
    messageCount: row.message_count,
  };
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

function rowToConversationMessage(row: ConversationMessageRow): ConversationMessage {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    motebitId: row.motebit_id,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls,
    toolCallId: row.tool_call_id,
    createdAt: row.created_at,
    tokenEstimate: row.token_estimate,
  };
}

/** 4-hour window for session continuity. */
const ACTIVE_CONVERSATION_WINDOW_MS = 4 * 60 * 60 * 1000;

export class SqliteConversationStore {
  private stmtCreate: PreparedStatement;
  private stmtAppendMessage: PreparedStatement;
  private stmtUpdateActivity: PreparedStatement;
  private stmtLoadMessages: PreparedStatement;
  private stmtGetActive: PreparedStatement;
  private stmtUpdateSummary: PreparedStatement;
  private stmtListConversations: PreparedStatement;

  constructor(private db: DatabaseDriver) {
    this.stmtCreate = db.prepare(
      `INSERT INTO conversations (conversation_id, motebit_id, started_at, last_active_at, title, summary, message_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    );
    this.stmtAppendMessage = db.prepare(
      `INSERT INTO conversation_messages (message_id, conversation_id, motebit_id, role, content, tool_calls, tool_call_id, created_at, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtUpdateActivity = db.prepare(
      `UPDATE conversations SET last_active_at = ?, message_count = message_count + 1 WHERE conversation_id = ?`,
    );
    this.stmtLoadMessages = db.prepare(
      `SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC`,
    );
    this.stmtGetActive = db.prepare(
      `SELECT * FROM conversations WHERE motebit_id = ? AND last_active_at > ? ORDER BY last_active_at DESC LIMIT 1`,
    );
    this.stmtUpdateSummary = db.prepare(
      `UPDATE conversations SET summary = ? WHERE conversation_id = ?`,
    );
    this.stmtListConversations = db.prepare(
      `SELECT * FROM conversations WHERE motebit_id = ? ORDER BY last_active_at DESC LIMIT ?`,
    );
  }

  createConversation(motebitId: string): string {
    const conversationId = crypto.randomUUID();
    const now = Date.now();
    this.stmtCreate.run(conversationId, motebitId, now, now, null, null);
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
    },
  ): void {
    const messageId = crypto.randomUUID();
    const now = Date.now();
    const tokenEstimate = Math.ceil(msg.content.length / 4);
    this.stmtAppendMessage.run(
      messageId,
      conversationId,
      motebitId,
      msg.role,
      msg.content,
      msg.toolCalls ?? null,
      msg.toolCallId ?? null,
      now,
      tokenEstimate,
    );
    this.stmtUpdateActivity.run(now, conversationId);
  }

  loadMessages(conversationId: string, limit?: number): ConversationMessage[] {
    if (limit !== undefined) {
      const rows = this.db
        .prepare(
          `SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?`,
        )
        .all(conversationId, limit) as ConversationMessageRow[];
      return rows.map(rowToConversationMessage);
    }
    const rows = this.stmtLoadMessages.all(conversationId) as ConversationMessageRow[];
    return rows.map(rowToConversationMessage);
  }

  getActiveConversation(motebitId: string): Conversation | null {
    const cutoff = Date.now() - ACTIVE_CONVERSATION_WINDOW_MS;
    const row = this.stmtGetActive.get(motebitId, cutoff) as ConversationRow | undefined;
    if (row === undefined) return null;
    return rowToConversation(row);
  }

  updateSummary(conversationId: string, summary: string): void {
    this.stmtUpdateSummary.run(summary, conversationId);
  }

  updateTitle(conversationId: string, title: string): void {
    this.db
      .prepare(`UPDATE conversations SET title = ? WHERE conversation_id = ?`)
      .run(title, conversationId);
  }

  listConversations(motebitId: string, limit = 20): Conversation[] {
    const rows = this.stmtListConversations.all(motebitId, limit) as ConversationRow[];
    return rows.map(rowToConversation);
  }

  // === Sync-oriented methods ===

  /** Get conversations updated since a given timestamp. */
  getConversationsSince(motebitId: string, since: number): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversations WHERE motebit_id = ? AND last_active_at > ? ORDER BY last_active_at ASC`,
      )
      .all(motebitId, since) as ConversationRow[];
    return rows.map(rowToConversation);
  }

  /** Get messages for a conversation created since a given timestamp. */
  getMessagesSince(conversationId: string, since: number): ConversationMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at ASC`,
      )
      .all(conversationId, since) as ConversationMessageRow[];
    return rows.map(rowToConversationMessage);
  }

  /** Upsert a conversation from sync (last-writer-wins on metadata). */
  upsertConversation(conv: Conversation): void {
    this.db
      .prepare(
        `INSERT INTO conversations (conversation_id, motebit_id, started_at, last_active_at, title, summary, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         last_active_at = MAX(excluded.last_active_at, conversations.last_active_at),
         title = CASE WHEN excluded.last_active_at >= conversations.last_active_at THEN excluded.title ELSE conversations.title END,
         summary = CASE WHEN excluded.last_active_at >= conversations.last_active_at THEN excluded.summary ELSE conversations.summary END,
         message_count = MAX(excluded.message_count, conversations.message_count)`,
      )
      .run(
        conv.conversationId,
        conv.motebitId,
        conv.startedAt,
        conv.lastActiveAt,
        conv.title,
        conv.summary,
        conv.messageCount,
      );
  }

  /** Upsert a message from sync (append-only, ignore duplicates). */
  upsertMessage(msg: ConversationMessage): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_messages
       (message_id, conversation_id, motebit_id, role, content, tool_calls, tool_call_id, created_at, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.messageId,
        msg.conversationId,
        msg.motebitId,
        msg.role,
        msg.content,
        msg.toolCalls,
        msg.toolCallId,
        msg.createdAt,
        msg.tokenEstimate,
      );
  }

  /** Get a single conversation by ID. */
  getConversation(conversationId: string): Conversation | null {
    const row = this.db
      .prepare(`SELECT * FROM conversations WHERE conversation_id = ?`)
      .get(conversationId) as ConversationRow | undefined;
    if (row === undefined) return null;
    return rowToConversation(row);
  }
}

// === Plan Store ===

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

function rowToPlan(row: PlanRow): Plan {
  return {
    plan_id: row.plan_id,
    goal_id: row.goal_id,
    motebit_id: row.motebit_id,
    title: row.title,
    status: row.status as PlanStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    current_step_index: row.current_step_index,
    total_steps: row.total_steps,
  };
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
}

function rowToPlanStep(row: PlanStepRow): PlanStep {
  return {
    step_id: row.step_id,
    plan_id: row.plan_id,
    ordinal: row.ordinal,
    description: row.description,
    prompt: row.prompt,
    depends_on: JSON.parse(row.depends_on) as string[],
    optional: row.optional === 1,
    required_capabilities: row.required_capabilities != null
      ? JSON.parse(row.required_capabilities) as PlanStep["required_capabilities"]
      : undefined,
    delegation_task_id: row.delegation_task_id ?? undefined,
    status: row.status as StepStatus,
    result_summary: row.result_summary,
    error_message: row.error_message,
    tool_calls_made: row.tool_calls_made,
    started_at: row.started_at,
    completed_at: row.completed_at,
    retry_count: row.retry_count,
  };
}

export class SqlitePlanStore {
  private stmtSavePlan: PreparedStatement;
  private stmtGetPlan: PreparedStatement;
  private stmtGetPlanForGoal: PreparedStatement;
  private stmtListPlans: PreparedStatement;
  private stmtListActivePlans: PreparedStatement;
  private stmtSaveStep: PreparedStatement;
  private stmtGetStep: PreparedStatement;
  private stmtGetStepsForPlan: PreparedStatement;
  private stmtGetNextPending: PreparedStatement;

  constructor(db: DatabaseDriver) {
    this.stmtSavePlan = db.prepare(
      `INSERT OR REPLACE INTO plans (plan_id, goal_id, motebit_id, title, status, created_at, updated_at, current_step_index, total_steps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetPlan = db.prepare(`SELECT * FROM plans WHERE plan_id = ?`);
    this.stmtGetPlanForGoal = db.prepare(
      `SELECT * FROM plans WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1`,
    );
    this.stmtListPlans = db.prepare(
      `SELECT * FROM plans WHERE motebit_id = ? ORDER BY created_at DESC`,
    );
    this.stmtListActivePlans = db.prepare(
      `SELECT * FROM plans WHERE motebit_id = ? AND status = 'active' ORDER BY created_at DESC`,
    );
    this.stmtSaveStep = db.prepare(
      `INSERT OR REPLACE INTO plan_steps (step_id, plan_id, ordinal, description, prompt, depends_on, optional, status, result_summary, error_message, tool_calls_made, started_at, completed_at, retry_count, required_capabilities, delegation_task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetStep = db.prepare(`SELECT * FROM plan_steps WHERE step_id = ?`);
    this.stmtGetStepsForPlan = db.prepare(
      `SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY ordinal ASC`,
    );
    this.stmtGetNextPending = db.prepare(
      `SELECT * FROM plan_steps WHERE plan_id = ? AND status = 'pending' ORDER BY ordinal ASC LIMIT 1`,
    );
  }

  savePlan(plan: Plan): void {
    this.stmtSavePlan.run(
      plan.plan_id,
      plan.goal_id,
      plan.motebit_id,
      plan.title,
      plan.status,
      plan.created_at,
      plan.updated_at,
      plan.current_step_index,
      plan.total_steps,
    );
  }

  getPlan(planId: string): Plan | null {
    const row = this.stmtGetPlan.get(planId) as PlanRow | undefined;
    if (row === undefined) return null;
    return rowToPlan(row);
  }

  getPlanForGoal(goalId: string): Plan | null {
    const row = this.stmtGetPlanForGoal.get(goalId) as PlanRow | undefined;
    if (row === undefined) return null;
    return rowToPlan(row);
  }

  listPlans(motebitId: string): Plan[] {
    const rows = this.stmtListPlans.all(motebitId) as PlanRow[];
    return rows.map(rowToPlan);
  }

  listActivePlans(motebitId: string): Plan[] {
    const rows = this.stmtListActivePlans.all(motebitId) as PlanRow[];
    return rows.map(rowToPlan);
  }

  listAllPlans(motebitId: string): Plan[] {
    const rows = this.stmtListPlans.all(motebitId) as PlanRow[];
    return rows.map(rowToPlan);
  }

  updatePlan(planId: string, updates: Partial<Plan>): void {
    const existing = this.getPlan(planId);
    if (!existing) return;
    const merged = { ...existing, ...updates };
    this.stmtSavePlan.run(
      merged.plan_id,
      merged.goal_id,
      merged.motebit_id,
      merged.title,
      merged.status,
      merged.created_at,
      merged.updated_at,
      merged.current_step_index,
      merged.total_steps,
    );
  }

  saveStep(step: PlanStep): void {
    this.stmtSaveStep.run(
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
    );
  }

  getStep(stepId: string): PlanStep | null {
    const row = this.stmtGetStep.get(stepId) as PlanStepRow | undefined;
    if (row === undefined) return null;
    return rowToPlanStep(row);
  }

  getStepsForPlan(planId: string): PlanStep[] {
    const rows = this.stmtGetStepsForPlan.all(planId) as PlanStepRow[];
    return rows.map(rowToPlanStep);
  }

  updateStep(stepId: string, updates: Partial<PlanStep>): void {
    const existing = this.getStep(stepId);
    if (!existing) return;
    const merged = { ...existing, ...updates };
    this.stmtSaveStep.run(
      merged.step_id,
      merged.plan_id,
      merged.ordinal,
      merged.description,
      merged.prompt,
      JSON.stringify(merged.depends_on),
      merged.optional ? 1 : 0,
      merged.status,
      merged.result_summary,
      merged.error_message,
      merged.tool_calls_made,
      merged.started_at,
      merged.completed_at,
      merged.retry_count,
      merged.required_capabilities != null ? JSON.stringify(merged.required_capabilities) : null,
      merged.delegation_task_id ?? null,
    );
  }

  getNextPendingStep(planId: string): PlanStep | null {
    const row = this.stmtGetNextPending.get(planId) as PlanStepRow | undefined;
    if (row === undefined) return null;
    return rowToPlanStep(row);
  }
}

// === Gradient Store ===

export interface GradientSnapshotRow {
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

export interface GradientSnapshotData {
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
  stats: Record<string, unknown>;
}

function rowToGradientSnapshot(row: GradientSnapshotRow): GradientSnapshotData {
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
    stats: JSON.parse(row.stats) as Record<string, unknown>,
  };
}

export class SqliteGradientStore {
  private stmtSave: PreparedStatement;
  private stmtLatest: PreparedStatement;
  private stmtList: PreparedStatement;

  constructor(db: DatabaseDriver) {
    this.stmtSave = db.prepare(
      `INSERT OR REPLACE INTO gradient_snapshots
       (snapshot_id, motebit_id, timestamp, gradient, delta, knowledge_density, knowledge_density_raw, knowledge_quality, graph_connectivity, graph_connectivity_raw, temporal_stability, retrieval_quality, interaction_efficiency, tool_efficiency, curiosity_pressure, stats)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtLatest = db.prepare(
      `SELECT * FROM gradient_snapshots WHERE motebit_id = ? ORDER BY timestamp DESC LIMIT 1`,
    );
    this.stmtList = db.prepare(
      `SELECT * FROM gradient_snapshots WHERE motebit_id = ? ORDER BY timestamp DESC LIMIT ?`,
    );
  }

  save(snapshot: GradientSnapshotData): void {
    const snapshotId = crypto.randomUUID();
    this.stmtSave.run(
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
    );
  }

  latest(motebitId: string): GradientSnapshotData | null {
    const row = this.stmtLatest.get(motebitId) as GradientSnapshotRow | undefined;
    if (row === undefined) return null;
    return rowToGradientSnapshot(row);
  }

  list(motebitId: string, limit = 100): GradientSnapshotData[] {
    const rows = this.stmtList.all(motebitId, limit) as GradientSnapshotRow[];
    return rows.map(rowToGradientSnapshot);
  }
}

// === SqliteAgentTrustStore ===

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
  return {
    motebit_id: row.motebit_id,
    remote_motebit_id: row.remote_motebit_id,
    trust_level: row.trust_level as AgentTrustLevel,
    public_key: row.public_key ?? undefined,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    interaction_count: row.interaction_count,
    successful_tasks: row.successful_tasks ?? 0,
    failed_tasks: row.failed_tasks ?? 0,
    notes: row.notes ?? undefined,
  };
}

export class SqliteAgentTrustStore {
  private stmtGet: PreparedStatement;
  private stmtSet: PreparedStatement;
  private stmtList: PreparedStatement;
  private stmtUpdateLevel: PreparedStatement;

  constructor(db: DatabaseDriver) {
    this.stmtGet = db.prepare(
      `SELECT * FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?`,
    );
    this.stmtSet = db.prepare(
      `INSERT OR REPLACE INTO agent_trust
       (motebit_id, remote_motebit_id, trust_level, public_key, first_seen_at, last_seen_at, interaction_count, successful_tasks, failed_tasks, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtList = db.prepare(
      `SELECT * FROM agent_trust WHERE motebit_id = ? ORDER BY last_seen_at DESC`,
    );
    this.stmtUpdateLevel = db.prepare(
      `UPDATE agent_trust SET trust_level = ?, last_seen_at = ? WHERE motebit_id = ? AND remote_motebit_id = ?`,
    );
  }

  async getAgentTrust(
    motebitId: string,
    remoteMotebitId: string,
  ): Promise<AgentTrustRecord | null> {
    const row = this.stmtGet.get(motebitId, remoteMotebitId) as AgentTrustRow | undefined;
    if (row === undefined) return null;
    return rowToAgentTrust(row);
  }

  async setAgentTrust(record: AgentTrustRecord): Promise<void> {
    this.stmtSet.run(
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
    );
  }

  async listAgentTrust(motebitId: string): Promise<AgentTrustRecord[]> {
    const rows = this.stmtList.all(motebitId) as AgentTrustRow[];
    return rows.map(rowToAgentTrust);
  }

  async updateTrustLevel(
    motebitId: string,
    remoteMotebitId: string,
    level: AgentTrustLevel,
  ): Promise<void> {
    this.stmtUpdateLevel.run(level, Date.now(), motebitId, remoteMotebitId);
  }
}

// === Factory ===

export interface MotebitDatabase {
  db: DatabaseDriver;
  eventStore: SqliteEventStore;
  memoryStorage: SqliteMemoryStorage;
  identityStorage: SqliteIdentityStorage;
  auditLog: SqliteAuditLog;
  stateSnapshot: SqliteStateSnapshot;
  toolAuditSink: SqliteToolAuditSink;
  goalStore: SqliteGoalStore;
  goalOutcomeStore: SqliteGoalOutcomeStore;
  approvalStore: SqliteApprovalStore;
  conversationStore: SqliteConversationStore;
  planStore: SqlitePlanStore;
  gradientStore: SqliteGradientStore;
  agentTrustStore: SqliteAgentTrustStore;
  close(): void;
}

/**
 * Run an idempotent ALTER TABLE. Silences "duplicate column" / "already exists" errors
 * but re-throws anything unexpected (disk full, permission denied, corrupt DB).
 */
function migrateExec(driver: DatabaseDriver, sql: string): void {
  try {
    driver.exec(sql);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // SQLite returns "duplicate column name: X" or "table X already exists" / "index X already exists"
    if (/duplicate column|already exists/i.test(msg)) return;
    throw err;
  }
}

/** Run schema creation and migrations on a DatabaseDriver, return MotebitDatabase. */
export function createMotebitDatabaseFromDriver(driver: DatabaseDriver): MotebitDatabase {
  driver.pragma("journal_mode = WAL");
  driver.pragma("foreign_keys = ON");

  const userVersion = (driver.pragma("user_version") as { user_version: number }[])[0]!
    .user_version;

  initSchema(driver);

  if (userVersion < 1) {
    migrateExec(driver, "ALTER TABLE events ADD COLUMN device_id TEXT");
    driver.pragma("user_version = 1");
  }

  if (userVersion < 2) {
    migrateExec(driver, "ALTER TABLE state_snapshots ADD COLUMN version_clock INTEGER NOT NULL DEFAULT 0");
    driver.pragma("user_version = 2");
  }

  if (userVersion < 3) {
    driver.pragma("user_version = 3");
  }

  if (userVersion < 4) {
    driver.pragma("user_version = 4");
  }

  if (userVersion < 5) {
    migrateExec(driver, "ALTER TABLE goals ADD COLUMN mode TEXT NOT NULL DEFAULT 'recurring'");
    migrateExec(driver, "ALTER TABLE goals ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    migrateExec(driver, "ALTER TABLE goals ADD COLUMN parent_goal_id TEXT");
    migrateExec(driver, "ALTER TABLE goals ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3");
    migrateExec(driver, "ALTER TABLE goals ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
    driver.pragma("user_version = 5");
  }

  if (userVersion < 6) {
    driver.pragma("user_version = 6");
  }

  if (userVersion < 7) {
    driver.pragma("user_version = 7");
  }

  if (userVersion < 8) {
    migrateExec(driver, "ALTER TABLE memory_nodes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    driver.pragma("user_version = 8");
  }

  if (userVersion < 9) {
    migrateExec(driver, "ALTER TABLE tool_audit_log ADD COLUMN run_id TEXT");
    migrateExec(driver, "CREATE INDEX IF NOT EXISTS idx_tool_audit_run ON tool_audit_log (run_id)");
    driver.pragma("user_version = 9");
  }

  if (userVersion < 10) {
    migrateExec(driver, "ALTER TABLE tool_audit_log ADD COLUMN injection TEXT");
    driver.pragma("user_version = 10");
  }

  if (userVersion < 11) {
    migrateExec(driver, "ALTER TABLE goal_outcomes ADD COLUMN tokens_used INTEGER");
    driver.pragma("user_version = 11");
  }

  if (userVersion < 12) {
    migrateExec(driver, "ALTER TABLE goals ADD COLUMN wall_clock_ms INTEGER");
    driver.pragma("user_version = 12");
  }

  if (userVersion < 13) {
    migrateExec(driver, "ALTER TABLE goals ADD COLUMN project_id TEXT");
    driver.exec("CREATE INDEX IF NOT EXISTS idx_goals_project ON goals (project_id)");
    driver.pragma("user_version = 13");
  }

  if (userVersion < 14) {
    migrateExec(driver, "ALTER TABLE memory_nodes ADD COLUMN memory_type TEXT DEFAULT 'semantic'");
    migrateExec(driver, "ALTER TABLE memory_nodes ADD COLUMN valid_from INTEGER");
    migrateExec(driver, "ALTER TABLE memory_nodes ADD COLUMN valid_until INTEGER");
    driver.pragma("user_version = 14");
  }

  if (userVersion < 15) {
    driver.pragma("user_version = 15");
  }

  if (userVersion < 16) {
    driver.exec(
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_mote_tomb_pin ON memory_nodes (motebit_id, tombstoned, pinned)",
    );
    driver.pragma("user_version = 16");
  }

  if (userVersion < 17) {
    driver.exec(
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_retrieve ON memory_nodes (motebit_id, tombstoned, last_accessed DESC)",
    );
    driver.pragma("user_version = 17");
  }

  if (userVersion < 18) {
    migrateExec(driver, "ALTER TABLE gradient_snapshots ADD COLUMN retrieval_quality REAL NOT NULL DEFAULT 0");
    driver.pragma("user_version = 18");
  }

  if (userVersion < 19) {
    driver.pragma("user_version = 19");
  }

  if (userVersion < 20) {
    migrateExec(driver, "ALTER TABLE gradient_snapshots ADD COLUMN interaction_efficiency REAL NOT NULL DEFAULT 0");
    migrateExec(driver, "ALTER TABLE gradient_snapshots ADD COLUMN tool_efficiency REAL NOT NULL DEFAULT 0");
    driver.pragma("user_version = 20");
  }

  if (userVersion < 21) {
    migrateExec(driver, "ALTER TABLE agent_trust ADD COLUMN successful_tasks INTEGER NOT NULL DEFAULT 0");
    migrateExec(driver, "ALTER TABLE agent_trust ADD COLUMN failed_tasks INTEGER NOT NULL DEFAULT 0");
    driver.pragma("user_version = 21");
  }

  if (userVersion < 22) {
    migrateExec(driver, "ALTER TABLE tool_audit_log ADD COLUMN cost_units INTEGER DEFAULT 0");
    driver.pragma("user_version = 22");
  }

  if (userVersion < 23) {
    migrateExec(driver, "ALTER TABLE gradient_snapshots ADD COLUMN curiosity_pressure REAL NOT NULL DEFAULT 0");
    driver.pragma("user_version = 23");
  }

  if (userVersion < 24) {
    migrateExec(driver, "ALTER TABLE plan_steps ADD COLUMN required_capabilities TEXT DEFAULT NULL");
    driver.pragma("user_version = 24");
  }

  if (userVersion < 25) {
    migrateExec(driver, "ALTER TABLE plan_steps ADD COLUMN delegation_task_id TEXT DEFAULT NULL");
    driver.pragma("user_version = 25");
  }

  const eventStore = new SqliteEventStore(driver);
  const memoryStorage = new SqliteMemoryStorage(driver);
  const identityStorage = new SqliteIdentityStorage(driver);
  const auditLog = new SqliteAuditLog(driver);
  const stateSnapshot = new SqliteStateSnapshot(driver);
  const toolAuditSink = new SqliteToolAuditSink(driver);
  const goalStore = new SqliteGoalStore(driver);
  const goalOutcomeStore = new SqliteGoalOutcomeStore(driver);
  const approvalStore = new SqliteApprovalStore(driver);
  const conversationStore = new SqliteConversationStore(driver);
  const planStore = new SqlitePlanStore(driver);
  const gradientStore = new SqliteGradientStore(driver);
  const agentTrustStore = new SqliteAgentTrustStore(driver);

  return {
    db: driver,
    eventStore,
    memoryStorage,
    identityStorage,
    auditLog,
    stateSnapshot,
    toolAuditSink,
    goalStore,
    goalOutcomeStore,
    approvalStore,
    conversationStore,
    planStore,
    gradientStore,
    agentTrustStore,
    close() {
      driver.close();
    },
  };
}

/**
 * Thin wrapper that adapts better-sqlite3's Database to DatabaseDriver.
 * Uses createRequire so better-sqlite3 is loaded lazily (not at module load time).
 */
class BetterSqliteDriver implements DatabaseDriver {
  readonly driverName = "better-sqlite3";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private inner: any;

  constructor(dbPath: string) {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    this.inner = new Database(dbPath);
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    return this.inner.prepare(sql) as unknown as PreparedStatement;
  }

  pragma(sql: string): unknown {
    return this.inner.pragma(sql);
  }

  close(): void {
    this.inner.close();
  }
}

/**
 * Sync convenience factory — uses better-sqlite3.
 * Throws if better-sqlite3 is not installed.
 */
export function createMotebitDatabase(dbPath: string): MotebitDatabase {
  const driver = new BetterSqliteDriver(dbPath);
  return createMotebitDatabaseFromDriver(driver);
}

/**
 * Async factory with fallback.
 * Tries better-sqlite3 first; if unavailable, falls back to sql.js (WASM).
 */
export async function openMotebitDatabase(dbPath: string): Promise<MotebitDatabase> {
  try {
    return createMotebitDatabase(dbPath);
  } catch {
    // better-sqlite3 not available — fall back to sql.js
    const { SqlJsDriver } = await import("./sqljs-driver.js");
    const driver = await SqlJsDriver.open(dbPath);
    return createMotebitDatabaseFromDriver(driver);
  }
}
