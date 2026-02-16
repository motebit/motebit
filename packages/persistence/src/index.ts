import Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import type {
  EventLogEntry,
  EventType,
  MemoryNode,
  MemoryEdge,
  MoteIdentity,
  AuditRecord,
  SensitivityLevel,
  RelationType,
} from "@mote/sdk";
import type { EventStoreAdapter, EventFilter } from "@mote/event-log";
import type {
  MemoryStorageAdapter,
  MemoryQuery,
} from "@mote/memory-graph";
import { computeDecayedConfidence } from "@mote/memory-graph";
import type { IdentityStorage } from "@mote/core-identity";
import type { AuditLogAdapter } from "@mote/privacy-layer";

// === Schema ===

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  mote_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  version_clock INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_mote_clock ON events (mote_id, version_clock);

CREATE TABLE IF NOT EXISTS memory_nodes (
  node_id TEXT PRIMARY KEY,
  mote_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding TEXT NOT NULL,
  confidence REAL NOT NULL,
  sensitivity TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  half_life REAL NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_mote ON memory_nodes (mote_id);

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
  mote_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  version_clock INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identities_owner ON identities (owner_id);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  mote_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_mote_ts ON audit_log (mote_id, timestamp);

CREATE TABLE IF NOT EXISTS state_snapshots (
  mote_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
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
      `INSERT INTO events (event_id, mote_id, event_type, payload, version_clock, timestamp, tombstoned)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetLatestClock = db.prepare(
      `SELECT MAX(version_clock) as max_clock FROM events WHERE mote_id = ?`,
    );
    this.stmtTombstone = db.prepare(
      `UPDATE events SET tombstoned = 1 WHERE event_id = ? AND mote_id = ?`,
    );
  }

  async append(entry: EventLogEntry): Promise<void> {
    this.stmtAppend.run(
      entry.event_id,
      entry.mote_id,
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

    if (filter.mote_id !== undefined) {
      conditions.push("mote_id = ?");
      params.push(filter.mote_id);
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

  async getLatestClock(moteId: string): Promise<number> {
    const row = this.stmtGetLatestClock.get(moteId) as { max_clock: number | null };
    return row.max_clock ?? 0;
  }

  async tombstone(eventId: string, moteId: string): Promise<void> {
    this.stmtTombstone.run(eventId, moteId);
  }
}

interface EventRow {
  event_id: string;
  mote_id: string;
  event_type: string;
  payload: string;
  version_clock: number;
  timestamp: number;
  tombstoned: number;
}

function rowToEvent(row: EventRow): EventLogEntry {
  return {
    event_id: row.event_id,
    mote_id: row.mote_id,
    event_type: row.event_type as EventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    version_clock: row.version_clock,
    timestamp: row.timestamp,
    tombstoned: row.tombstoned === 1,
  };
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
       (node_id, mote_id, content, embedding, confidence, sensitivity, created_at, last_accessed, half_life, tombstoned)
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
      `SELECT * FROM memory_nodes WHERE mote_id = ?`,
    );
  }

  async saveNode(node: MemoryNode): Promise<void> {
    this.stmtSaveNode.run(
      node.node_id,
      node.mote_id,
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
    // Fetch all nodes for mote, then apply app-level filtering
    // (matches InMemoryMemoryStorage behavior for decay + sensitivity)
    const rows = this.stmtGetAllNodes.all(query.mote_id) as NodeRow[];
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

  async getAllNodes(moteId: string): Promise<MemoryNode[]> {
    const rows = this.stmtGetAllNodes.all(moteId) as NodeRow[];
    return rows.map(rowToNode);
  }

  async getAllEdges(moteId: string): Promise<MemoryEdge[]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.* FROM memory_edges e
         INNER JOIN memory_nodes n ON (e.source_id = n.node_id OR e.target_id = n.node_id)
         WHERE n.mote_id = ?`,
      )
      .all(moteId) as EdgeRow[];
    return rows.map(rowToEdge);
  }
}

interface NodeRow {
  node_id: string;
  mote_id: string;
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
    mote_id: row.mote_id,
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
      `INSERT OR REPLACE INTO identities (mote_id, created_at, owner_id, version_clock)
       VALUES (?, ?, ?, ?)`,
    );
    this.stmtLoad = db.prepare(
      `SELECT * FROM identities WHERE mote_id = ?`,
    );
    this.stmtLoadByOwner = db.prepare(
      `SELECT * FROM identities WHERE owner_id = ? LIMIT 1`,
    );
  }

  async save(identity: MoteIdentity): Promise<void> {
    this.stmtSave.run(
      identity.mote_id,
      identity.created_at,
      identity.owner_id,
      identity.version_clock,
    );
  }

  async load(moteId: string): Promise<MoteIdentity | null> {
    const row = this.stmtLoad.get(moteId) as IdentityRow | undefined;
    if (row === undefined) return null;
    return rowToIdentity(row);
  }

  async loadByOwner(ownerId: string): Promise<MoteIdentity | null> {
    const row = this.stmtLoadByOwner.get(ownerId) as IdentityRow | undefined;
    if (row === undefined) return null;
    return rowToIdentity(row);
  }
}

interface IdentityRow {
  mote_id: string;
  created_at: number;
  owner_id: string;
  version_clock: number;
}

function rowToIdentity(row: IdentityRow): MoteIdentity {
  return {
    mote_id: row.mote_id,
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
      `INSERT INTO audit_log (audit_id, mote_id, timestamp, action, target_type, target_id, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  async record(entry: AuditRecord): Promise<void> {
    this.stmtRecord.run(
      entry.audit_id,
      entry.mote_id,
      entry.timestamp,
      entry.action,
      entry.target_type,
      entry.target_id,
      JSON.stringify(entry.details),
    );
  }

  async query(
    moteId: string,
    options: { limit?: number; after?: number } = {},
  ): Promise<AuditRecord[]> {
    const conditions: string[] = ["mote_id = ?"];
    const params: unknown[] = [moteId];

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
  mote_id: string;
  timestamp: number;
  action: string;
  target_type: string;
  target_id: string;
  details: string;
}

function rowToAudit(row: AuditRow): AuditRecord {
  return {
    audit_id: row.audit_id,
    mote_id: row.mote_id,
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

  constructor(db: Database.Database) {
    this.stmtSave = db.prepare(
      `INSERT OR REPLACE INTO state_snapshots (mote_id, state_json, updated_at)
       VALUES (?, ?, ?)`,
    );
    this.stmtLoad = db.prepare(
      `SELECT state_json FROM state_snapshots WHERE mote_id = ?`,
    );
  }

  saveState(moteId: string, stateJson: string): void {
    this.stmtSave.run(moteId, stateJson, Date.now());
  }

  loadState(moteId: string): string | null {
    const row = this.stmtLoad.get(moteId) as { state_json: string } | undefined;
    if (row === undefined) return null;
    return row.state_json;
  }
}

// === Factory ===

export interface MoteDatabase {
  db: Database.Database;
  eventStore: SqliteEventStore;
  memoryStorage: SqliteMemoryStorage;
  identityStorage: SqliteIdentityStorage;
  auditLog: SqliteAuditLog;
  stateSnapshot: SqliteStateSnapshot;
  close(): void;
}

export function createMoteDatabase(dbPath: string): MoteDatabase {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);

  const eventStore = new SqliteEventStore(db);
  const memoryStorage = new SqliteMemoryStorage(db);
  const identityStorage = new SqliteIdentityStorage(db);
  const auditLog = new SqliteAuditLog(db);
  const stateSnapshot = new SqliteStateSnapshot(db);

  return {
    db,
    eventStore,
    memoryStorage,
    identityStorage,
    auditLog,
    stateSnapshot,
    close() {
      db.close();
    },
  };
}
