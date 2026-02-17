import Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import type {
  EventLogEntry,
  EventType,
  MemoryNode,
  MemoryEdge,
  MotebitIdentity,
  AuditRecord,
  SensitivityLevel,
  RelationType,
} from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import type {
  MemoryStorageAdapter,
  MemoryQuery,
} from "@motebit/memory-graph";
import { computeDecayedConfidence } from "@motebit/memory-graph";
import type { IdentityStorage } from "@motebit/core-identity";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import type { ToolAuditEntry, PolicyDecision } from "@motebit/sdk";
import type { AuditLogSink } from "@motebit/policy";

// === Schema ===

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
  tombstoned INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS tool_audit_log (
  call_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  decision TEXT NOT NULL,
  result TEXT,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_audit_turn ON tool_audit_log (turn_id);
`;

function initSchema(db: Database.Database): void {
  db.exec(SCHEMA);
}

// === SqliteEventStore ===

export class SqliteEventStore implements EventStoreAdapter {
  private stmtAppend: Statement;
  private stmtGetLatestClock: Statement;
  private stmtTombstone: Statement;

  constructor(private db: Database.Database) {
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
    const info = this.db.prepare(
      "DELETE FROM events WHERE motebit_id = ? AND version_clock <= ?",
    ).run(motebitId, beforeClock);
    return info.changes;
  }

  async countEvents(motebitId: string): Promise<number> {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM events WHERE motebit_id = ?",
    ).get(motebitId) as { cnt: number };
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
  private stmtSaveNode: Statement;
  private stmtGetNode: Statement;
  private stmtSaveEdge: Statement;
  private stmtGetEdges: Statement;
  private stmtTombstoneNode: Statement;
  private stmtGetAllNodes: Statement;

  constructor(private db: Database.Database) {
    this.stmtSaveNode = db.prepare(
      `INSERT OR REPLACE INTO memory_nodes
       (node_id, motebit_id, content, embedding, confidence, sensitivity, created_at, last_accessed, half_life, tombstoned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetNode = db.prepare(
      `SELECT * FROM memory_nodes WHERE node_id = ?`,
    );
    this.stmtSaveEdge = db.prepare(
      `INSERT OR REPLACE INTO memory_edges
       (edge_id, source_id, target_id, relation_type, weight, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetEdges = db.prepare(
      `SELECT * FROM memory_edges WHERE source_id = ? OR target_id = ?`,
    );
    this.stmtTombstoneNode = db.prepare(
      `UPDATE memory_nodes SET tombstoned = 1 WHERE node_id = ?`,
    );
    this.stmtGetAllNodes = db.prepare(
      `SELECT * FROM memory_nodes WHERE motebit_id = ?`,
    );
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
    );
  }

  async getNode(nodeId: string): Promise<MemoryNode | null> {
    const row = this.stmtGetNode.get(nodeId) as NodeRow | undefined;
    if (row === undefined) return null;
    return rowToNode(row);
  }

  async queryNodes(query: MemoryQuery): Promise<MemoryNode[]> {
    // Fetch all nodes for motebit, then apply app-level filtering
    // (matches InMemoryMemoryStorage behavior for decay + sensitivity)
    const rows = this.stmtGetAllNodes.all(query.motebit_id) as NodeRow[];
    let results = rows.map(rowToNode);

    if (query.include_tombstoned !== true) {
      results = results.filter((n) => !n.tombstoned);
    }

    if (query.min_confidence !== undefined) {
      const now = Date.now();
      const minConf = query.min_confidence;
      results = results.filter((n) => {
        const decayed = computeDecayedConfidence(
          n.confidence,
          n.half_life,
          now - n.created_at,
        );
        return decayed >= minConf;
      });
    }

    if (query.sensitivity_filter !== undefined) {
      const allowed = query.sensitivity_filter;
      results = results.filter((n) =>
        allowed.includes(n.sensitivity),
      );
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
  private stmtSave: Statement;
  private stmtLoad: Statement;
  private stmtLoadByOwner: Statement;

  constructor(db: Database.Database) {
    this.stmtSave = db.prepare(
      `INSERT OR REPLACE INTO identities (motebit_id, created_at, owner_id, version_clock)
       VALUES (?, ?, ?, ?)`,
    );
    this.stmtLoad = db.prepare(
      `SELECT * FROM identities WHERE motebit_id = ?`,
    );
    this.stmtLoadByOwner = db.prepare(
      `SELECT * FROM identities WHERE owner_id = ? LIMIT 1`,
    );
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

// === SqliteAuditLog ===

export class SqliteAuditLog implements AuditLogAdapter {
  private stmtRecord: Statement;

  constructor(private db: Database.Database) {
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
    let sql = `SELECT * FROM audit_log WHERE ${conditions.join(" AND ")} ORDER BY timestamp ASC`;

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
  private stmtSave: Statement;
  private stmtLoad: Statement;
  private stmtLoadClock: Statement;

  constructor(db: Database.Database) {
    this.stmtSave = db.prepare(
      `INSERT OR REPLACE INTO state_snapshots (motebit_id, state_json, updated_at, version_clock)
       VALUES (?, ?, ?, ?)`,
    );
    this.stmtLoad = db.prepare(
      `SELECT state_json FROM state_snapshots WHERE motebit_id = ?`,
    );
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
  tool: string;
  args: string;
  decision: string;
  result: string | null;
  timestamp: number;
}

function rowToToolAudit(row: ToolAuditRow): ToolAuditEntry {
  return {
    callId: row.call_id,
    turnId: row.turn_id,
    tool: row.tool,
    args: JSON.parse(row.args) as Record<string, unknown>,
    decision: JSON.parse(row.decision) as PolicyDecision,
    result: row.result ? (JSON.parse(row.result) as { ok: boolean; durationMs: number }) : undefined,
    timestamp: row.timestamp,
  };
}

export class SqliteToolAuditSink implements AuditLogSink {
  private stmtAppend: Statement;
  private stmtQueryTurn: Statement;
  private stmtGetAll: Statement;

  constructor(db: Database.Database) {
    this.stmtAppend = db.prepare(
      `INSERT OR REPLACE INTO tool_audit_log (call_id, turn_id, tool, args, decision, result, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtQueryTurn = db.prepare(
      `SELECT * FROM tool_audit_log WHERE turn_id = ? ORDER BY timestamp ASC`,
    );
    this.stmtGetAll = db.prepare(
      `SELECT * FROM tool_audit_log ORDER BY timestamp ASC`,
    );
  }

  append(entry: ToolAuditEntry): void {
    this.stmtAppend.run(
      entry.callId,
      entry.turnId,
      entry.tool,
      JSON.stringify(entry.args),
      JSON.stringify(entry.decision),
      entry.result ? JSON.stringify(entry.result) : null,
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
}

// === Factory ===

export interface MotebitDatabase {
  db: Database.Database;
  eventStore: SqliteEventStore;
  memoryStorage: SqliteMemoryStorage;
  identityStorage: SqliteIdentityStorage;
  auditLog: SqliteAuditLog;
  stateSnapshot: SqliteStateSnapshot;
  toolAuditSink: SqliteToolAuditSink;
  close(): void;
}

export function createMotebitDatabase(dbPath: string): MotebitDatabase {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const userVersion = (db.pragma("user_version") as { user_version: number }[])[0]!.user_version;

  initSchema(db);

  if (userVersion < 1) {
    try {
      db.exec("ALTER TABLE events ADD COLUMN device_id TEXT");
    } catch (_) {
      // Column may already exist on new DBs that have it in CREATE TABLE
    }
    db.pragma("user_version = 1");
  }

  if (userVersion < 2) {
    try {
      db.exec("ALTER TABLE state_snapshots ADD COLUMN version_clock INTEGER NOT NULL DEFAULT 0");
    } catch (_) {
      // Column may already exist on new DBs
    }
    db.pragma("user_version = 2");
  }

  const eventStore = new SqliteEventStore(db);
  const memoryStorage = new SqliteMemoryStorage(db);
  const identityStorage = new SqliteIdentityStorage(db);
  const auditLog = new SqliteAuditLog(db);
  const stateSnapshot = new SqliteStateSnapshot(db);
  const toolAuditSink = new SqliteToolAuditSink(db);

  return {
    db,
    eventStore,
    memoryStorage,
    identityStorage,
    auditLog,
    stateSnapshot,
    toolAuditSink,
    close() {
      db.close();
    },
  };
}
