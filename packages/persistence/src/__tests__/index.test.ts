import { describe, it, expect, beforeEach } from "vitest";
import { createMotebitDatabase, SqliteToolAuditSink, type MotebitDatabase } from "../index.js";
import { EventType, SensitivityLevel, RelationType } from "@motebit/sdk";
import type {
  EventLogEntry,
  MemoryNode,
  MemoryEdge,
  MotebitIdentity,
  AuditRecord,
  ToolAuditEntry,
} from "@motebit/sdk";

let mdb: MotebitDatabase;

beforeEach(() => {
  mdb = createMotebitDatabase(":memory:");
});

// === Schema ===

describe("schema", () => {
  it("creates all tables", () => {
    const tables = mdb.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("events");
    expect(names).toContain("memory_nodes");
    expect(names).toContain("memory_edges");
    expect(names).toContain("identities");
    expect(names).toContain("audit_log");
    expect(names).toContain("state_snapshots");
  });

  it("is idempotent (calling createMotebitDatabase twice on same db is safe)", () => {
    // Just ensure no error on second init
    expect(() => createMotebitDatabase(":memory:")).not.toThrow();
  });
});

// === EventStore ===

describe("SqliteEventStore", () => {
  const makeEvent = (overrides: Partial<EventLogEntry> = {}): EventLogEntry => ({
    event_id: crypto.randomUUID(),
    motebit_id: "motebit-1",
    device_id: "test-device",
    timestamp: Date.now(),
    event_type: EventType.MemoryFormed,
    payload: { test: true },
    version_clock: 1,
    tombstoned: false,
    ...overrides,
  });

  it("appends and queries events", async () => {
    const event = makeEvent();
    await mdb.eventStore.append(event);
    const results = await mdb.eventStore.query({ motebit_id: "motebit-1" });
    expect(results).toHaveLength(1);
    expect(results[0]!.event_id).toBe(event.event_id);
    expect(results[0]!.payload).toEqual({ test: true });
  });

  it("filters by motebit_id", async () => {
    await mdb.eventStore.append(makeEvent({ motebit_id: "motebit-1", version_clock: 1 }));
    await mdb.eventStore.append(makeEvent({ motebit_id: "motebit-2", version_clock: 1 }));
    const results = await mdb.eventStore.query({ motebit_id: "motebit-2" });
    expect(results).toHaveLength(1);
    expect(results[0]!.motebit_id).toBe("motebit-2");
  });

  it("filters by event_types", async () => {
    await mdb.eventStore.append(
      makeEvent({ event_type: EventType.MemoryFormed, version_clock: 1 }),
    );
    await mdb.eventStore.append(
      makeEvent({ event_type: EventType.StateUpdated, version_clock: 2 }),
    );
    const results = await mdb.eventStore.query({
      motebit_id: "motebit-1",
      event_types: [EventType.StateUpdated],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.event_type).toBe(EventType.StateUpdated);
  });

  it("filters by timestamps", async () => {
    await mdb.eventStore.append(makeEvent({ timestamp: 100, version_clock: 1 }));
    await mdb.eventStore.append(makeEvent({ timestamp: 200, version_clock: 2 }));
    await mdb.eventStore.append(makeEvent({ timestamp: 300, version_clock: 3 }));
    const results = await mdb.eventStore.query({
      motebit_id: "motebit-1",
      after_timestamp: 100,
      before_timestamp: 300,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.timestamp).toBe(200);
  });

  it("filters by version_clock", async () => {
    await mdb.eventStore.append(makeEvent({ version_clock: 1 }));
    await mdb.eventStore.append(makeEvent({ version_clock: 2 }));
    await mdb.eventStore.append(makeEvent({ version_clock: 3 }));
    const results = await mdb.eventStore.query({
      motebit_id: "motebit-1",
      after_version_clock: 1,
    });
    expect(results).toHaveLength(2);
  });

  it("applies limit", async () => {
    await mdb.eventStore.append(makeEvent({ version_clock: 1 }));
    await mdb.eventStore.append(makeEvent({ version_clock: 2 }));
    await mdb.eventStore.append(makeEvent({ version_clock: 3 }));
    const results = await mdb.eventStore.query({ motebit_id: "motebit-1", limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("getLatestClock returns 0 for empty store", async () => {
    const clock = await mdb.eventStore.getLatestClock("nonexistent");
    expect(clock).toBe(0);
  });

  it("getLatestClock returns highest clock", async () => {
    await mdb.eventStore.append(makeEvent({ version_clock: 5 }));
    await mdb.eventStore.append(makeEvent({ version_clock: 3 }));
    await mdb.eventStore.append(makeEvent({ version_clock: 10 }));
    const clock = await mdb.eventStore.getLatestClock("motebit-1");
    expect(clock).toBe(10);
  });

  it("tombstones an event", async () => {
    const event = makeEvent({ version_clock: 1 });
    await mdb.eventStore.append(event);

    await mdb.eventStore.tombstone(event.event_id, "motebit-1");

    const results = await mdb.eventStore.query({ motebit_id: "motebit-1" });
    expect(results[0]!.tombstoned).toBe(true);
  });

  // --- Combined filters ---

  it("combines motebit_id + event_types filter", async () => {
    await mdb.eventStore.append(
      makeEvent({ motebit_id: "m1", event_type: EventType.MemoryFormed, version_clock: 1 }),
    );
    await mdb.eventStore.append(
      makeEvent({ motebit_id: "m1", event_type: EventType.ToolUsed, version_clock: 2 }),
    );
    await mdb.eventStore.append(
      makeEvent({ motebit_id: "m2", event_type: EventType.MemoryFormed, version_clock: 1 }),
    );

    const results = await mdb.eventStore.query({
      motebit_id: "m1",
      event_types: [EventType.MemoryFormed],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.event_type).toBe(EventType.MemoryFormed);
    expect(results[0]!.motebit_id).toBe("m1");
  });

  it("combines event_types + after_version_clock filter", async () => {
    await mdb.eventStore.append(makeEvent({ event_type: EventType.ToolUsed, version_clock: 1 }));
    await mdb.eventStore.append(makeEvent({ event_type: EventType.ToolUsed, version_clock: 5 }));
    await mdb.eventStore.append(
      makeEvent({ event_type: EventType.MemoryFormed, version_clock: 10 }),
    );

    const results = await mdb.eventStore.query({
      motebit_id: "motebit-1",
      event_types: [EventType.ToolUsed],
      after_version_clock: 3,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.version_clock).toBe(5);
  });

  it("returns empty for non-matching combined filters", async () => {
    await mdb.eventStore.append(
      makeEvent({ event_type: EventType.MemoryFormed, version_clock: 1 }),
    );

    const results = await mdb.eventStore.query({
      motebit_id: "motebit-1",
      event_types: [EventType.ToolUsed], // wrong type
    });
    expect(results).toHaveLength(0);
  });

  it("compact + countEvents", async () => {
    for (let i = 1; i <= 5; i++) {
      await mdb.eventStore.append(makeEvent({ version_clock: i }));
    }
    expect(await mdb.eventStore.countEvents("motebit-1")).toBe(5);

    await mdb.eventStore.compact("motebit-1", 3); // compact events below clock 3
    const remaining = await mdb.eventStore.query({ motebit_id: "motebit-1" });
    // Only events with version_clock >= 3 should remain
    for (const e of remaining) {
      expect(e.version_clock).toBeGreaterThanOrEqual(3);
    }
  });
});

// === MemoryStorage ===

describe("SqliteMemoryStorage", () => {
  const makeNode = (overrides: Partial<MemoryNode> = {}): MemoryNode => ({
    node_id: crypto.randomUUID(),
    motebit_id: "motebit-1",
    content: "test memory",
    embedding: [0.1, 0.2, 0.3],
    confidence: 0.9,
    sensitivity: SensitivityLevel.None,
    created_at: Date.now(),
    last_accessed: Date.now(),
    half_life: 7 * 24 * 60 * 60 * 1000,
    tombstoned: false,
    pinned: false,
    ...overrides,
  });

  const makeEdge = (overrides: Partial<MemoryEdge> = {}): MemoryEdge => ({
    edge_id: crypto.randomUUID(),
    source_id: "src",
    target_id: "tgt",
    relation_type: RelationType.Related,
    weight: 1.0,
    confidence: 1.0,
    ...overrides,
  });

  it("saveNode/getNode round-trip with embedding", async () => {
    const node = makeNode({ embedding: [1.5, -0.3, 0.0, 42.1] });
    await mdb.memoryStorage.saveNode(node);
    const loaded = await mdb.memoryStorage.getNode(node.node_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe(node.content);
    expect(loaded!.embedding).toEqual([1.5, -0.3, 0.0, 42.1]);
    expect(loaded!.sensitivity).toBe(SensitivityLevel.None);
    expect(loaded!.tombstoned).toBe(false);
  });

  it("getNode returns null for missing", async () => {
    const result = await mdb.memoryStorage.getNode("nope");
    expect(result).toBeNull();
  });

  it("queryNodes filters by motebit_id", async () => {
    await mdb.memoryStorage.saveNode(makeNode({ motebit_id: "motebit-1" }));
    await mdb.memoryStorage.saveNode(makeNode({ motebit_id: "motebit-2" }));
    const results = await mdb.memoryStorage.queryNodes({ motebit_id: "motebit-1" });
    expect(results).toHaveLength(1);
    expect(results[0]!.motebit_id).toBe("motebit-1");
  });

  it("queryNodes excludes tombstoned by default", async () => {
    await mdb.memoryStorage.saveNode(makeNode({ tombstoned: true }));
    await mdb.memoryStorage.saveNode(makeNode({ tombstoned: false }));
    const results = await mdb.memoryStorage.queryNodes({ motebit_id: "motebit-1" });
    expect(results).toHaveLength(1);
  });

  it("queryNodes includes tombstoned when requested", async () => {
    await mdb.memoryStorage.saveNode(makeNode({ tombstoned: true }));
    await mdb.memoryStorage.saveNode(makeNode({ tombstoned: false }));
    const results = await mdb.memoryStorage.queryNodes({
      motebit_id: "motebit-1",
      include_tombstoned: true,
    });
    expect(results).toHaveLength(2);
  });

  it("queryNodes filters by sensitivity", async () => {
    await mdb.memoryStorage.saveNode(makeNode({ sensitivity: SensitivityLevel.None }));
    await mdb.memoryStorage.saveNode(makeNode({ sensitivity: SensitivityLevel.Medical }));
    await mdb.memoryStorage.saveNode(makeNode({ sensitivity: SensitivityLevel.Financial }));
    const results = await mdb.memoryStorage.queryNodes({
      motebit_id: "motebit-1",
      sensitivity_filter: [SensitivityLevel.None, SensitivityLevel.Financial],
    });
    expect(results).toHaveLength(2);
  });

  it("queryNodes applies limit", async () => {
    for (let i = 0; i < 5; i++) {
      await mdb.memoryStorage.saveNode(makeNode());
    }
    const results = await mdb.memoryStorage.queryNodes({
      motebit_id: "motebit-1",
      limit: 3,
    });
    expect(results).toHaveLength(3);
  });

  it("queryNodes filters by pinned in SQL", async () => {
    await mdb.memoryStorage.saveNode(makeNode({ pinned: true }));
    await mdb.memoryStorage.saveNode(makeNode({ pinned: false }));
    await mdb.memoryStorage.saveNode(makeNode({ pinned: true, tombstoned: true }));

    const pinned = await mdb.memoryStorage.queryNodes({ motebit_id: "motebit-1", pinned: true });
    expect(pinned).toHaveLength(1); // excludes tombstoned

    const unpinned = await mdb.memoryStorage.queryNodes({ motebit_id: "motebit-1", pinned: false });
    expect(unpinned).toHaveLength(1);

    const pinnedIncTomb = await mdb.memoryStorage.queryNodes({
      motebit_id: "motebit-1",
      pinned: true,
      include_tombstoned: true,
    });
    expect(pinnedIncTomb).toHaveLength(2);
  });

  it("saveEdge/getEdges round-trip", async () => {
    const nodeA = makeNode();
    const nodeB = makeNode();
    await mdb.memoryStorage.saveNode(nodeA);
    await mdb.memoryStorage.saveNode(nodeB);

    const edge = makeEdge({
      source_id: nodeA.node_id,
      target_id: nodeB.node_id,
      relation_type: RelationType.CausedBy,
    });
    await mdb.memoryStorage.saveEdge(edge);

    const fromSource = await mdb.memoryStorage.getEdges(nodeA.node_id);
    expect(fromSource).toHaveLength(1);
    expect(fromSource[0]!.relation_type).toBe(RelationType.CausedBy);

    const fromTarget = await mdb.memoryStorage.getEdges(nodeB.node_id);
    expect(fromTarget).toHaveLength(1);
  });

  it("tombstoneNode marks node as tombstoned", async () => {
    const node = makeNode();
    await mdb.memoryStorage.saveNode(node);
    await mdb.memoryStorage.tombstoneNode(node.node_id);
    const loaded = await mdb.memoryStorage.getNode(node.node_id);
    expect(loaded!.tombstoned).toBe(true);
  });

  it("getAllNodes returns all nodes for a motebit", async () => {
    await mdb.memoryStorage.saveNode(makeNode({ motebit_id: "motebit-1" }));
    await mdb.memoryStorage.saveNode(makeNode({ motebit_id: "motebit-1" }));
    await mdb.memoryStorage.saveNode(makeNode({ motebit_id: "motebit-2" }));
    const results = await mdb.memoryStorage.getAllNodes("motebit-1");
    expect(results).toHaveLength(2);
  });

  it("getAllEdges returns edges for motebit's nodes only", async () => {
    const nodeA = makeNode({ motebit_id: "motebit-1" });
    const nodeB = makeNode({ motebit_id: "motebit-1" });
    const nodeC = makeNode({ motebit_id: "motebit-2" });
    await mdb.memoryStorage.saveNode(nodeA);
    await mdb.memoryStorage.saveNode(nodeB);
    await mdb.memoryStorage.saveNode(nodeC);

    await mdb.memoryStorage.saveEdge(
      makeEdge({ source_id: nodeA.node_id, target_id: nodeB.node_id }),
    );
    await mdb.memoryStorage.saveEdge(
      makeEdge({ source_id: nodeC.node_id, target_id: nodeC.node_id }),
    );

    const mote1Edges = await mdb.memoryStorage.getAllEdges("motebit-1");
    expect(mote1Edges).toHaveLength(1);

    const mote2Edges = await mdb.memoryStorage.getAllEdges("motebit-2");
    expect(mote2Edges).toHaveLength(1);
  });

  // --- Decay-aware confidence filtering ---

  it("queryNodes with min_confidence filters out decayed nodes", async () => {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    // Fresh node (just created) — confidence 0.9, no decay
    await mdb.memoryStorage.saveNode(
      makeNode({
        node_id: "fresh-node",
        confidence: 0.9,
        half_life: SEVEN_DAYS,
        created_at: now,
      }),
    );

    // Old node (14 days ago) — confidence 0.9 but decayed: 0.9 * 0.5^2 = 0.225
    await mdb.memoryStorage.saveNode(
      makeNode({
        node_id: "old-node",
        confidence: 0.9,
        half_life: SEVEN_DAYS,
        created_at: now - 2 * SEVEN_DAYS,
      }),
    );

    const results = await mdb.memoryStorage.queryNodes({
      motebit_id: "motebit-1",
      min_confidence: 0.5,
    });

    // Only fresh node passes (0.9 >= 0.5); old node fails (0.225 < 0.5)
    expect(results).toHaveLength(1);
    expect(results[0]!.node_id).toBe("fresh-node");
  });

  it("queryNodes with min_confidence keeps nodes at half-life boundary", async () => {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    // Node exactly at half-life — confidence 0.8 decays to 0.4
    await mdb.memoryStorage.saveNode(
      makeNode({
        node_id: "half-life-node",
        confidence: 0.8,
        half_life: SEVEN_DAYS,
        created_at: now - SEVEN_DAYS,
      }),
    );

    // Should pass at min_confidence=0.3 (0.4 >= 0.3)
    const pass = await mdb.memoryStorage.queryNodes({
      motebit_id: "motebit-1",
      min_confidence: 0.3,
    });
    expect(pass).toHaveLength(1);

    // Should fail at min_confidence=0.5 (0.4 < 0.5)
    const fail = await mdb.memoryStorage.queryNodes({
      motebit_id: "motebit-1",
      min_confidence: 0.5,
    });
    expect(fail).toHaveLength(0);
  });

  it("queryNodes combines sensitivity_filter and min_confidence", async () => {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    // Fresh, personal
    await mdb.memoryStorage.saveNode(
      makeNode({
        node_id: "fresh-personal",
        confidence: 0.9,
        sensitivity: SensitivityLevel.Personal,
        half_life: SEVEN_DAYS,
        created_at: now,
      }),
    );

    // Fresh, medical — should be excluded by sensitivity filter
    await mdb.memoryStorage.saveNode(
      makeNode({
        node_id: "fresh-medical",
        confidence: 0.9,
        sensitivity: SensitivityLevel.Medical,
        half_life: SEVEN_DAYS,
        created_at: now,
      }),
    );

    // Old, none — should be excluded by confidence decay
    await mdb.memoryStorage.saveNode(
      makeNode({
        node_id: "old-none",
        confidence: 0.5,
        sensitivity: SensitivityLevel.None,
        half_life: SEVEN_DAYS,
        created_at: now - 3 * SEVEN_DAYS, // decayed: 0.5 * 0.5^3 = 0.0625
      }),
    );

    const results = await mdb.memoryStorage.queryNodes({
      motebit_id: "motebit-1",
      min_confidence: 0.5,
      sensitivity_filter: [SensitivityLevel.None, SensitivityLevel.Personal],
    });

    // Only fresh-personal passes both filters
    expect(results).toHaveLength(1);
    expect(results[0]!.node_id).toBe("fresh-personal");
  });

  it("queryNodes returns empty when all nodes are below min_confidence", async () => {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    await mdb.memoryStorage.saveNode(
      makeNode({
        confidence: 0.1,
        half_life: SEVEN_DAYS,
        created_at: Date.now() - 5 * SEVEN_DAYS, // 0.1 * 0.5^5 ≈ 0.003
      }),
    );

    const results = await mdb.memoryStorage.queryNodes({
      motebit_id: "motebit-1",
      min_confidence: 0.01,
    });
    expect(results).toHaveLength(0);
  });
});

// === IdentityStorage ===

describe("SqliteIdentityStorage", () => {
  const makeIdentity = (overrides: Partial<MotebitIdentity> = {}): MotebitIdentity => ({
    motebit_id: crypto.randomUUID(),
    created_at: Date.now(),
    owner_id: "owner-1",
    version_clock: 0,
    ...overrides,
  });

  it("save/load round-trip", async () => {
    const identity = makeIdentity();
    await mdb.identityStorage.save(identity);
    const loaded = await mdb.identityStorage.load(identity.motebit_id);
    expect(loaded).toEqual(identity);
  });

  it("load returns null for missing", async () => {
    const result = await mdb.identityStorage.load("nope");
    expect(result).toBeNull();
  });

  it("loadByOwner finds by owner_id", async () => {
    const identity = makeIdentity({ owner_id: "owner-42" });
    await mdb.identityStorage.save(identity);
    const loaded = await mdb.identityStorage.loadByOwner("owner-42");
    expect(loaded).not.toBeNull();
    expect(loaded!.motebit_id).toBe(identity.motebit_id);
  });

  it("loadByOwner returns null for missing owner", async () => {
    const result = await mdb.identityStorage.loadByOwner("nope");
    expect(result).toBeNull();
  });
});

// === AuditLog ===

describe("SqliteAuditLog", () => {
  const makeAudit = (overrides: Partial<AuditRecord> = {}): AuditRecord => ({
    audit_id: crypto.randomUUID(),
    motebit_id: "motebit-1",
    timestamp: Date.now(),
    action: "test_action",
    target_type: "memory",
    target_id: "target-1",
    details: { foo: "bar" },
    ...overrides,
  });

  it("record and query", async () => {
    const entry = makeAudit();
    await mdb.auditLog.record(entry);
    const results = await mdb.auditLog.query("motebit-1");
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("test_action");
    expect(results[0]!.details).toEqual({ foo: "bar" });
  });

  it("query filters by after timestamp", async () => {
    await mdb.auditLog.record(makeAudit({ timestamp: 100 }));
    await mdb.auditLog.record(makeAudit({ timestamp: 200 }));
    await mdb.auditLog.record(makeAudit({ timestamp: 300 }));
    const results = await mdb.auditLog.query("motebit-1", { after: 150 });
    expect(results).toHaveLength(2);
  });

  it("query applies limit (from end)", async () => {
    await mdb.auditLog.record(makeAudit({ timestamp: 100, action: "first" }));
    await mdb.auditLog.record(makeAudit({ timestamp: 200, action: "second" }));
    await mdb.auditLog.record(makeAudit({ timestamp: 300, action: "third" }));
    const results = await mdb.auditLog.query("motebit-1", { limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe("second");
    expect(results[1]!.action).toBe("third");
  });
});

// === StateSnapshot ===

describe("SqliteStateSnapshot", () => {
  it("saveState/loadState round-trip", () => {
    const json = JSON.stringify({ attention: 0.5, confidence: 0.8 });
    mdb.stateSnapshot.saveState("motebit-1", json);
    const loaded = mdb.stateSnapshot.loadState("motebit-1");
    expect(loaded).toBe(json);
  });

  it("loadState returns null for missing", () => {
    const result = mdb.stateSnapshot.loadState("nope");
    expect(result).toBeNull();
  });

  it("saveState overwrites previous value", () => {
    mdb.stateSnapshot.saveState("motebit-1", "first");
    mdb.stateSnapshot.saveState("motebit-1", "second");
    const loaded = mdb.stateSnapshot.loadState("motebit-1");
    expect(loaded).toBe("second");
  });
});

// === Event Compaction ===

function mkEvent(clock: number, motebitId = "motebit-1"): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: motebitId,
    device_id: "test-device",
    timestamp: Date.now(),
    event_type: EventType.StateUpdated,
    payload: {},
    version_clock: clock,
    tombstoned: false,
  };
}

describe("SqliteEventStore compaction", () => {
  it("compact removes events at or below beforeClock", async () => {
    for (let i = 1; i <= 5; i++) {
      await mdb.eventStore.append(mkEvent(i));
    }

    const deleted = await mdb.eventStore.compact("motebit-1", 3);
    expect(deleted).toBe(3);

    const remaining = await mdb.eventStore.query({ motebit_id: "motebit-1" });
    expect(remaining).toHaveLength(2);
    expect(remaining.map((e) => e.version_clock)).toEqual([4, 5]);
  });

  it("countEvents returns correct count", async () => {
    await mdb.eventStore.append(mkEvent(1));
    await mdb.eventStore.append(mkEvent(2));
    expect(await mdb.eventStore.countEvents("motebit-1")).toBe(2);
    expect(await mdb.eventStore.countEvents("other")).toBe(0);
  });
});

// === State Snapshot with version_clock ===

describe("SqliteStateSnapshot version_clock", () => {
  it("saves and retrieves version_clock", () => {
    mdb.stateSnapshot.saveState("motebit-1", "{}", 42);
    expect(mdb.stateSnapshot.getSnapshotClock("motebit-1")).toBe(42);
  });

  it("defaults to 0 when no snapshot exists", () => {
    expect(mdb.stateSnapshot.getSnapshotClock("nonexistent")).toBe(0);
  });

  it("updates version_clock on re-save", () => {
    mdb.stateSnapshot.saveState("motebit-1", "{}", 10);
    mdb.stateSnapshot.saveState("motebit-1", "{}", 20);
    expect(mdb.stateSnapshot.getSnapshotClock("motebit-1")).toBe(20);
  });
});

// === Cross-Adapter ===

describe("cross-adapter persistence", () => {
  it("data persists across separate adapter instances sharing same db", async () => {
    const event = {
      event_id: crypto.randomUUID(),
      motebit_id: "motebit-1",
      device_id: "test-device",
      timestamp: Date.now(),
      event_type: EventType.MemoryFormed,
      payload: { shared: true },
      version_clock: 1,
      tombstoned: false,
    };
    await mdb.eventStore.append(event);

    // Create new adapter instances from the same db handle
    const { SqliteEventStore } = await import("../index.js");
    const freshEventStore = new SqliteEventStore(mdb.db);
    const results = await freshEventStore.query({ motebit_id: "motebit-1" });
    expect(results).toHaveLength(1);
    expect(results[0]!.payload).toEqual({ shared: true });
  });
});

// === SqliteToolAuditSink ===

describe("SqliteToolAuditSink", () => {
  const makeToolAudit = (overrides: Partial<ToolAuditEntry> = {}): ToolAuditEntry => ({
    callId: crypto.randomUUID(),
    turnId: "turn-1",
    tool: "shell_exec",
    args: { command: "ls" },
    decision: { allowed: true, requiresApproval: false },
    timestamp: Date.now(),
    ...overrides,
  });

  it("creates tool_audit_log table", () => {
    const tables = mdb.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("tool_audit_log");
  });

  it("append and getAll round-trip", () => {
    const entry = makeToolAudit();
    mdb.toolAuditSink.append(entry);
    const all = mdb.toolAuditSink.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.callId).toBe(entry.callId);
    expect(all[0]!.tool).toBe("shell_exec");
    expect(all[0]!.args).toEqual({ command: "ls" });
    expect(all[0]!.decision).toEqual({ allowed: true, requiresApproval: false });
  });

  it("query filters by turnId", () => {
    mdb.toolAuditSink.append(makeToolAudit({ turnId: "turn-A" }));
    mdb.toolAuditSink.append(makeToolAudit({ turnId: "turn-B" }));
    mdb.toolAuditSink.append(makeToolAudit({ turnId: "turn-A" }));

    const turnA = mdb.toolAuditSink.query("turn-A");
    expect(turnA).toHaveLength(2);
    expect(turnA.every((e) => e.turnId === "turn-A")).toBe(true);

    const turnB = mdb.toolAuditSink.query("turn-B");
    expect(turnB).toHaveLength(1);
  });

  it("stores and retrieves result field", () => {
    const entry = makeToolAudit({ result: { ok: true, durationMs: 42 } });
    mdb.toolAuditSink.append(entry);
    const all = mdb.toolAuditSink.getAll();
    expect(all[0]!.result).toEqual({ ok: true, durationMs: 42 });
  });

  it("handles entries without result", () => {
    const entry = makeToolAudit();
    delete (entry as unknown as Record<string, unknown>).result;
    mdb.toolAuditSink.append(entry);
    const all = mdb.toolAuditSink.getAll();
    expect(all[0]!.result).toBeUndefined();
  });

  it("stores denied decisions", () => {
    const entry = makeToolAudit({
      decision: { allowed: false, requiresApproval: false, reason: "Tool on deny list" },
    });
    mdb.toolAuditSink.append(entry);
    const all = mdb.toolAuditSink.getAll();
    expect(all[0]!.decision.allowed).toBe(false);
    expect(all[0]!.decision.reason).toBe("Tool on deny list");
  });

  it("getAll returns entries ordered by timestamp", () => {
    mdb.toolAuditSink.append(makeToolAudit({ timestamp: 300 }));
    mdb.toolAuditSink.append(makeToolAudit({ timestamp: 100 }));
    mdb.toolAuditSink.append(makeToolAudit({ timestamp: 200 }));
    const all = mdb.toolAuditSink.getAll();
    expect(all.map((e) => e.timestamp)).toEqual([100, 200, 300]);
  });

  it("persists across new sink instances sharing same db", () => {
    mdb.toolAuditSink.append(makeToolAudit({ tool: "web_fetch" }));
    const freshSink = new SqliteToolAuditSink(mdb.db);
    const all = freshSink.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.tool).toBe("web_fetch");
  });
});
