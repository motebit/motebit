import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { TauriEventStore, TauriMemoryStorage, type InvokeFn } from "../tauri-storage";

// Schema matching main.rs SCHEMA constant
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
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
`;

/**
 * Build a mock InvokeFn backed by an in-memory better-sqlite3 database.
 * This executes the same SQL the Tauri Rust backend would, letting us
 * test the TypeScript adapters without a real Tauri runtime.
 */
function createMockInvoke(db: Database.Database): InvokeFn {
  return async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (cmd === "db_query") {
      const sql = args!.sql as string;
      const params = (args!.params as unknown[]) ?? [];
      const stmt = db.prepare(sql);
      const rows = stmt.all(...params);
      return rows as T;
    }
    if (cmd === "db_execute") {
      const sql = args!.sql as string;
      const params = (args!.params as unknown[]) ?? [];
      const stmt = db.prepare(sql);
      const result = stmt.run(...params);
      return result.changes as T;
    }
    throw new Error(`Unknown command: ${cmd}`);
  };
}

// ---------------------------------------------------------------------------
// TauriEventStore
// ---------------------------------------------------------------------------

describe("TauriEventStore", () => {
  let db: Database.Database;
  let store: TauriEventStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SCHEMA);
    store = new TauriEventStore(createMockInvoke(db));
  });

  it("append + query round-trip", async () => {
    await store.append({
      event_id: "e1",
      motebit_id: "m1",
      event_type: "memory_formed" as never,
      payload: { foo: "bar" },
      version_clock: 1,
      timestamp: 1000,
      tombstoned: false,
    });

    const results = await store.query({ motebit_id: "m1" });
    expect(results).toHaveLength(1);
    expect(results[0]!.event_id).toBe("e1");
    expect(results[0]!.payload).toEqual({ foo: "bar" });
    expect(results[0]!.tombstoned).toBe(false);
  });

  it("getLatestClock returns 0 when empty", async () => {
    const clock = await store.getLatestClock("m1");
    expect(clock).toBe(0);
  });

  it("getLatestClock returns max clock", async () => {
    await store.append({
      event_id: "e1",
      motebit_id: "m1",
      event_type: "memory_formed" as never,
      payload: {},
      version_clock: 5,
      timestamp: 1000,
      tombstoned: false,
    });
    await store.append({
      event_id: "e2",
      motebit_id: "m1",
      event_type: "memory_formed" as never,
      payload: {},
      version_clock: 10,
      timestamp: 2000,
      tombstoned: false,
    });

    const clock = await store.getLatestClock("m1");
    expect(clock).toBe(10);
  });

  it("tombstone marks event", async () => {
    await store.append({
      event_id: "e1",
      motebit_id: "m1",
      event_type: "memory_formed" as never,
      payload: {},
      version_clock: 1,
      timestamp: 1000,
      tombstoned: false,
    });

    await store.tombstone("e1", "m1");

    const results = await store.query({ motebit_id: "m1" });
    expect(results[0]!.tombstoned).toBe(true);
  });

  it("query filters by event_types", async () => {
    await store.append({
      event_id: "e1",
      motebit_id: "m1",
      event_type: "memory_formed" as never,
      payload: {},
      version_clock: 1,
      timestamp: 1000,
      tombstoned: false,
    });
    await store.append({
      event_id: "e2",
      motebit_id: "m1",
      event_type: "memory_accessed" as never,
      payload: {},
      version_clock: 2,
      timestamp: 2000,
      tombstoned: false,
    });

    const results = await store.query({
      motebit_id: "m1",
      event_types: ["memory_formed" as never],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.event_id).toBe("e1");
  });

  it("query respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await store.append({
        event_id: `e${i}`,
        motebit_id: "m1",
        event_type: "memory_formed" as never,
        payload: {},
        version_clock: i + 1,
        timestamp: 1000 + i,
        tombstoned: false,
      });
    }

    const results = await store.query({ motebit_id: "m1", limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("duplicate event_id is ignored (INSERT OR IGNORE)", async () => {
    const entry = {
      event_id: "e1",
      motebit_id: "m1",
      event_type: "memory_formed" as never,
      payload: { v: 1 },
      version_clock: 1,
      timestamp: 1000,
      tombstoned: false,
    };
    await store.append(entry);
    await store.append({ ...entry, payload: { v: 2 } });

    const results = await store.query({ motebit_id: "m1" });
    expect(results).toHaveLength(1);
    expect(results[0]!.payload).toEqual({ v: 1 });
  });
});

// ---------------------------------------------------------------------------
// TauriMemoryStorage
// ---------------------------------------------------------------------------

describe("TauriMemoryStorage", () => {
  let db: Database.Database;
  let storage: TauriMemoryStorage;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SCHEMA);
    storage = new TauriMemoryStorage(createMockInvoke(db));
  });

  const makeNode = (overrides: Partial<{
    node_id: string;
    motebit_id: string;
    content: string;
    confidence: number;
    sensitivity: string;
    tombstoned: boolean;
    half_life: number;
  }> = {}) => ({
    node_id: overrides.node_id ?? "n1",
    motebit_id: overrides.motebit_id ?? "m1",
    content: overrides.content ?? "test memory",
    embedding: [0.1, 0.2, 0.3],
    confidence: overrides.confidence ?? 0.9,
    sensitivity: (overrides.sensitivity ?? "normal") as never,
    created_at: Date.now(),
    last_accessed: Date.now(),
    half_life: overrides.half_life ?? 604800000,
    tombstoned: overrides.tombstoned ?? false,
  });

  it("saveNode + getNode round-trip", async () => {
    const node = makeNode();
    await storage.saveNode(node);

    const loaded = await storage.getNode("n1");
    expect(loaded).not.toBeNull();
    expect(loaded!.node_id).toBe("n1");
    expect(loaded!.content).toBe("test memory");
    expect(loaded!.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(loaded!.tombstoned).toBe(false);
  });

  it("getNode returns null for missing node", async () => {
    const loaded = await storage.getNode("nonexistent");
    expect(loaded).toBeNull();
  });

  it("queryNodes excludes tombstoned by default", async () => {
    await storage.saveNode(makeNode({ node_id: "n1", tombstoned: false }));
    await storage.saveNode(makeNode({ node_id: "n2", tombstoned: true }));

    const results = await storage.queryNodes({ motebit_id: "m1" });
    expect(results).toHaveLength(1);
    expect(results[0]!.node_id).toBe("n1");
  });

  it("queryNodes includes tombstoned when requested", async () => {
    await storage.saveNode(makeNode({ node_id: "n1", tombstoned: false }));
    await storage.saveNode(makeNode({ node_id: "n2", tombstoned: true }));

    const results = await storage.queryNodes({ motebit_id: "m1", include_tombstoned: true });
    expect(results).toHaveLength(2);
  });

  it("tombstoneNode marks as tombstoned", async () => {
    await storage.saveNode(makeNode({ node_id: "n1" }));
    await storage.tombstoneNode("n1");

    const loaded = await storage.getNode("n1");
    expect(loaded!.tombstoned).toBe(true);
  });

  it("saveEdge + getEdges round-trip", async () => {
    await storage.saveNode(makeNode({ node_id: "n1" }));
    await storage.saveNode(makeNode({ node_id: "n2" }));

    await storage.saveEdge({
      edge_id: "edge1",
      source_id: "n1",
      target_id: "n2",
      relation_type: "related_to" as never,
      weight: 1.0,
      confidence: 0.8,
    });

    const fromSource = await storage.getEdges("n1");
    expect(fromSource).toHaveLength(1);
    expect(fromSource[0]!.edge_id).toBe("edge1");

    const fromTarget = await storage.getEdges("n2");
    expect(fromTarget).toHaveLength(1);
  });

  it("getAllNodes returns all nodes for motebit", async () => {
    await storage.saveNode(makeNode({ node_id: "n1", motebit_id: "m1" }));
    await storage.saveNode(makeNode({ node_id: "n2", motebit_id: "m1" }));
    await storage.saveNode(makeNode({ node_id: "n3", motebit_id: "m2" }));

    const nodes = await storage.getAllNodes("m1");
    expect(nodes).toHaveLength(2);
  });

  it("getAllEdges returns edges for motebit's nodes", async () => {
    await storage.saveNode(makeNode({ node_id: "n1", motebit_id: "m1" }));
    await storage.saveNode(makeNode({ node_id: "n2", motebit_id: "m1" }));
    await storage.saveNode(makeNode({ node_id: "n3", motebit_id: "m2" }));

    await storage.saveEdge({
      edge_id: "edge1",
      source_id: "n1",
      target_id: "n2",
      relation_type: "related_to" as never,
      weight: 1.0,
      confidence: 0.8,
    });
    await storage.saveEdge({
      edge_id: "edge2",
      source_id: "n3",
      target_id: "n3",
      relation_type: "related_to" as never,
      weight: 1.0,
      confidence: 0.8,
    });

    const edges = await storage.getAllEdges("m1");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.edge_id).toBe("edge1");
  });

  it("queryNodes respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await storage.saveNode(makeNode({ node_id: `n${i}` }));
    }

    const results = await storage.queryNodes({ motebit_id: "m1", limit: 2 });
    expect(results).toHaveLength(2);
  });
});
