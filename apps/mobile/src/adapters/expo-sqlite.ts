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
import type { EventLogEntry, EventType, MemoryNode, MemoryEdge, MotebitIdentity, AuditRecord, SensitivityLevel, RelationType } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import type { MemoryStorageAdapter, MemoryQuery } from "@motebit/memory-graph";
import { computeDecayedConfidence } from "@motebit/memory-graph";
import type { IdentityStorage } from "@motebit/core-identity";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import type { StateSnapshotAdapter, StorageAdapters } from "@motebit/runtime";

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
  updated_at INTEGER NOT NULL
);
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
}

// === MemoryStorage Adapter ===

export class ExpoSqliteMemoryStorage implements MemoryStorageAdapter {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async saveNode(node: MemoryNode): Promise<void> {
    this.db.runSync(
      `INSERT OR REPLACE INTO memory_nodes
       (node_id, motebit_id, content, embedding, confidence, sensitivity, created_at, last_accessed, half_life, tombstoned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [node.node_id, node.motebit_id, node.content, JSON.stringify(node.embedding), node.confidence, node.sensitivity, node.created_at, node.last_accessed, node.half_life, node.tombstoned ? 1 : 0],
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

  saveState(motebitId: string, stateJson: string): void {
    this.db.runSync(
      `INSERT OR REPLACE INTO state_snapshots (motebit_id, state_json, updated_at) VALUES (?, ?, ?)`,
      [motebitId, stateJson, Date.now()],
    );
  }

  loadState(motebitId: string): string | null {
    const row = this.db.getFirstSync(
      "SELECT state_json FROM state_snapshots WHERE motebit_id = ?",
      [motebitId],
    ) as { state_json: string } | null;
    return row?.state_json ?? null;
  }
}

// === Factory ===

export function createExpoStorage(dbName = "motebit.db"): StorageAdapters {
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

  return {
    eventStore: new ExpoSqliteEventStore(db),
    memoryStorage: new ExpoSqliteMemoryStorage(db),
    identityStorage: new ExpoSqliteIdentityStorage(db),
    auditLog: new ExpoSqliteAuditLog(db),
    stateSnapshot: new ExpoSqliteStateSnapshot(db),
  };
}
