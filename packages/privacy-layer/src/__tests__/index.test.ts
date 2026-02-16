import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  InMemoryAuditLog,
  PrivacyLayer,
} from "../index";
import { InMemoryMemoryStorage, MemoryGraph } from "@motebit/memory-graph";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { SensitivityLevel } from "@motebit/sdk";
import type { MemoryNode, AuditRecord, MotebitIdentity } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTEBIT_ID = "motebit-1";

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    node_id: crypto.randomUUID(),
    motebit_id: MOTEBIT_ID,
    content: "test memory",
    embedding: [0.1, 0.2],
    confidence: 0.9,
    sensitivity: SensitivityLevel.None,
    created_at: Date.now(),
    last_accessed: Date.now(),
    half_life: 7 * 24 * 60 * 60 * 1000,
    tombstoned: false,
    ...overrides,
  };
}

function makeIdentity(): MotebitIdentity {
  return {
    motebit_id: MOTEBIT_ID,
    created_at: Date.now(),
    owner_id: "owner-1",
    version_clock: 5,
  };
}

// ---------------------------------------------------------------------------
// InMemoryAuditLog
// ---------------------------------------------------------------------------

describe("InMemoryAuditLog", () => {
  let auditLog: InMemoryAuditLog;

  beforeEach(() => {
    auditLog = new InMemoryAuditLog();
  });

  it("records and queries audit entries", async () => {
    const entry: AuditRecord = {
      audit_id: "a1",
      motebit_id: MOTEBIT_ID,
      timestamp: 1000,
      action: "test_action",
      target_type: "memory",
      target_id: "n1",
      details: { key: "val" },
    };
    await auditLog.record(entry);
    const results = await auditLog.query(MOTEBIT_ID);
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("test_action");
  });

  it("filters by motebit_id", async () => {
    await auditLog.record({
      audit_id: "a1",
      motebit_id: "m1",
      timestamp: 1000,
      action: "act",
      target_type: "t",
      target_id: "x",
      details: {},
    });
    await auditLog.record({
      audit_id: "a2",
      motebit_id: "m2",
      timestamp: 1000,
      action: "act",
      target_type: "t",
      target_id: "x",
      details: {},
    });
    const results = await auditLog.query("m1");
    expect(results).toHaveLength(1);
  });

  it("filters by after timestamp", async () => {
    await auditLog.record({
      audit_id: "a1",
      motebit_id: MOTEBIT_ID,
      timestamp: 100,
      action: "early",
      target_type: "t",
      target_id: "x",
      details: {},
    });
    await auditLog.record({
      audit_id: "a2",
      motebit_id: MOTEBIT_ID,
      timestamp: 200,
      action: "late",
      target_type: "t",
      target_id: "x",
      details: {},
    });
    const results = await auditLog.query(MOTEBIT_ID, { after: 150 });
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("late");
  });

  it("respects limit (returns last N entries)", async () => {
    for (let i = 0; i < 5; i++) {
      await auditLog.record({
        audit_id: `a${i}`,
        motebit_id: MOTEBIT_ID,
        timestamp: i * 100,
        action: `action-${i}`,
        target_type: "t",
        target_id: "x",
        details: {},
      });
    }
    const results = await auditLog.query(MOTEBIT_ID, { limit: 2 });
    expect(results).toHaveLength(2);
    // Should be the last 2 entries
    expect(results[0]!.action).toBe("action-3");
    expect(results[1]!.action).toBe("action-4");
  });
});

// ---------------------------------------------------------------------------
// PrivacyLayer
// ---------------------------------------------------------------------------

describe("PrivacyLayer", () => {
  let storage: InMemoryMemoryStorage;
  let eventStore: EventStore;
  let auditLog: InMemoryAuditLog;
  let memoryGraph: MemoryGraph;
  let privacyLayer: PrivacyLayer;

  beforeEach(() => {
    storage = new InMemoryMemoryStorage();
    eventStore = new EventStore(new InMemoryEventStore());
    auditLog = new InMemoryAuditLog();
    memoryGraph = new MemoryGraph(storage, eventStore, MOTEBIT_ID);
    privacyLayer = new PrivacyLayer(
      storage,
      memoryGraph,
      eventStore,
      auditLog,
      MOTEBIT_ID,
    );
  });

  describe("listMemories", () => {
    it("returns memories and creates an audit trail", async () => {
      const node = makeNode();
      await storage.saveNode(node);

      const memories = await privacyLayer.listMemories();
      expect(memories).toHaveLength(1);
      expect(memories[0]!.content).toBe("test memory");

      // Verify audit trail
      const auditRecords = await auditLog.query(MOTEBIT_ID);
      expect(auditRecords.length).toBeGreaterThanOrEqual(1);
      expect(
        auditRecords.some((r) => r.action === "list_memories"),
      ).toBe(true);
    });

    it("returns empty when no memories exist", async () => {
      const memories = await privacyLayer.listMemories();
      expect(memories).toHaveLength(0);
    });
  });

  describe("deleteMemory", () => {
    it("creates a deletion certificate", async () => {
      const node = await memoryGraph.formMemory(
        {
          content: "to delete",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0],
      );

      const cert = await privacyLayer.deleteMemory(
        node.node_id,
        "user-1",
      );

      expect(cert.target_id).toBe(node.node_id);
      expect(cert.target_type).toBe("memory");
      expect(cert.deleted_by).toBe("user-1");
      expect(cert.tombstone_hash).toBeTruthy();
      expect(cert.tombstone_hash.length).toBe(64);
    });

    it("tombstones the memory", async () => {
      const node = await memoryGraph.formMemory(
        {
          content: "to delete",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0],
      );

      await privacyLayer.deleteMemory(node.node_id, "user-1");

      const loaded = await storage.getNode(node.node_id);
      expect(loaded!.tombstoned).toBe(true);
    });
  });

  describe("exportAll", () => {
    it("includes all data in the manifest", async () => {
      await memoryGraph.formMemory(
        {
          content: "exportable",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0],
      );

      const manifest = await privacyLayer.exportAll(makeIdentity());

      expect(manifest.motebit_id).toBe(MOTEBIT_ID);
      expect(manifest.identity.motebit_id).toBe(MOTEBIT_ID);
      expect(manifest.memories.length).toBeGreaterThanOrEqual(1);
      expect(manifest.events.length).toBeGreaterThanOrEqual(1);
      expect(manifest.audit_log.length).toBeGreaterThanOrEqual(1);
      expect(manifest.exported_at).toBeGreaterThan(0);
    });

    it("logs an ExportRequested event", async () => {
      await privacyLayer.exportAll(makeIdentity());

      const events = await eventStore.query({ motebit_id: MOTEBIT_ID });
      expect(
        events.some((e) => e.event_type === "export_requested"),
      ).toBe(true);
    });
  });

  describe("fail-closed behavior", () => {
    it("wraps errors in fail-closed message for listMemories", async () => {
      // Create a storage that throws
      const failingStorage: any = {
        queryNodes: vi.fn().mockRejectedValue(new Error("DB error")),
        getNode: vi.fn(),
        saveNode: vi.fn(),
        saveEdge: vi.fn(),
        getEdges: vi.fn(),
        tombstoneNode: vi.fn(),
        getAllNodes: vi.fn(),
        getAllEdges: vi.fn(),
      };

      const failLayer = new PrivacyLayer(
        failingStorage,
        memoryGraph,
        eventStore,
        auditLog,
        MOTEBIT_ID,
      );

      await expect(failLayer.listMemories()).rejects.toThrow(
        "Privacy layer: access denied (fail-closed)",
      );
    });

    it("wraps errors in fail-closed message for inspectMemory", async () => {
      const failingStorage: any = {
        queryNodes: vi.fn(),
        getNode: vi.fn().mockRejectedValue(new Error("DB error")),
        saveNode: vi.fn(),
        saveEdge: vi.fn(),
        getEdges: vi.fn(),
        tombstoneNode: vi.fn(),
        getAllNodes: vi.fn(),
        getAllEdges: vi.fn(),
      };

      const failLayer = new PrivacyLayer(
        failingStorage,
        memoryGraph,
        eventStore,
        auditLog,
        MOTEBIT_ID,
      );

      await expect(failLayer.inspectMemory("n1")).rejects.toThrow(
        "Privacy layer: access denied (fail-closed)",
      );
    });
  });

  describe("getRetentionRules", () => {
    it("returns correct rules for sensitivity levels", () => {
      const none = privacyLayer.getRetentionRules(SensitivityLevel.None);
      expect(none.max_retention_days).toBe(Infinity);
      expect(none.display_allowed).toBe(true);

      const personal = privacyLayer.getRetentionRules(SensitivityLevel.Personal);
      expect(personal.max_retention_days).toBe(365);
      expect(personal.display_allowed).toBe(true);

      const medical = privacyLayer.getRetentionRules(SensitivityLevel.Medical);
      expect(medical.max_retention_days).toBe(90);
      expect(medical.display_allowed).toBe(false);

      const financial = privacyLayer.getRetentionRules(SensitivityLevel.Financial);
      expect(financial.max_retention_days).toBe(90);
      expect(financial.display_allowed).toBe(false);

      const secret = privacyLayer.getRetentionRules(SensitivityLevel.Secret);
      expect(secret.max_retention_days).toBe(30);
      expect(secret.display_allowed).toBe(false);
    });
  });
});
