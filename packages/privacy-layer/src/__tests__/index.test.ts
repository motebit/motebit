import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemoryAuditLog, PrivacyLayer, type DeletionCertSigner } from "../index";
import {
  InMemoryMemoryStorage,
  MemoryGraph,
  type MemoryStorageAdapter,
} from "@motebit/memory-graph";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { SensitivityLevel, EventType } from "@motebit/sdk";
import type { MemoryNode, AuditRecord, MotebitIdentity, MotebitId } from "@motebit/sdk";
import { generateEd25519Keypair } from "@motebit/crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTEBIT_ID = "motebit-1";

let TEST_SIGNER: DeletionCertSigner;
beforeEach(async () => {
  const { privateKey } = await generateEd25519Keypair();
  TEST_SIGNER = { motebitId: MOTEBIT_ID as MotebitId, privateKey };
});

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
    pinned: false,
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
      TEST_SIGNER,
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
      expect(auditRecords.some((r) => r.action === "list_memories")).toBe(true);
    });

    it("returns empty when no memories exist", async () => {
      const memories = await privacyLayer.listMemories();
      expect(memories).toHaveLength(0);
    });
  });

  describe("deleteMemory", () => {
    it("creates a signed mutable_pruning deletion certificate", async () => {
      const node = await memoryGraph.formMemory(
        {
          content: "to delete",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0],
      );

      const cert = await privacyLayer.deleteMemory(node.node_id, "user_request");

      // Decision 1: discriminated union under `kind`.
      expect(cert.kind).toBe("mutable_pruning");
      // Discriminant narrowing for the rest of the assertions.
      if (cert.kind !== "mutable_pruning") return;
      expect(cert.target_id).toBe(node.node_id);
      expect(cert.reason).toBe("user_request");
      expect(cert.sensitivity).toBe(SensitivityLevel.None);
      expect(cert.deleted_at).toBeGreaterThan(0);
      // Decision 5: subject_signature present (signer was injected).
      expect(cert.subject_signature).toBeDefined();
      expect(cert.subject_signature?.suite).toBe("motebit-jcs-ed25519-b64-v1");
      expect(cert.subject_signature?.signature.length).toBeGreaterThan(0);
    });

    it("erases the memory — getNode returns null, never tombstoned", async () => {
      const node = await memoryGraph.formMemory(
        {
          content: "to delete",
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
        },
        [1, 0],
      );

      await privacyLayer.deleteMemory(node.node_id, "user_request");

      // Decision 7's negative proof: bytes unrecoverable, not soft-deleted.
      const loaded = await storage.getNode(node.node_id);
      expect(loaded).toBeNull();
    });

    it("issued cert verifies through verifyDeletionCertificate", async () => {
      const { verifyDeletionCertificate, generateEd25519Keypair } = await import("@motebit/crypto");
      // Build a fresh keypair, plug it as the signer, exercise the round-trip.
      const { publicKey, privateKey } = await generateEd25519Keypair();
      const localStorage = new InMemoryMemoryStorage();
      const localEvents = new EventStore(new InMemoryEventStore());
      const localAudit = new InMemoryAuditLog();
      const localGraph = new MemoryGraph(localStorage, localEvents, MOTEBIT_ID);
      const localLayer = new PrivacyLayer(
        localStorage,
        localGraph,
        localEvents,
        localAudit,
        MOTEBIT_ID,
        { motebitId: MOTEBIT_ID as MotebitId, privateKey },
      );

      const node = await localGraph.formMemory(
        { content: "verify me", confidence: 0.9, sensitivity: SensitivityLevel.Personal },
        [1, 0],
      );
      // Reason: self_enforcement — the subject's runtime drives policy and signs.
      // Sibling `retention_enforcement` would require an operator_signature
      // (operator-driven policy); decision 5's table.
      const cert = await localLayer.deleteMemory(node.node_id, "self_enforcement");

      const result = await verifyDeletionCertificate(cert, {
        resolveMotebitPublicKey: async (id: string) => (id === MOTEBIT_ID ? publicKey : null),
        resolveOperatorPublicKey: async () => null,
      });
      expect(result.valid).toBe(true);
      expect(result.steps.subject_signature_valid).toBe(true);
    });

    it("emits a DeleteRequested event before erasing the memory", async () => {
      const node = await memoryGraph.formMemory(
        { content: "audited", confidence: 0.9, sensitivity: SensitivityLevel.Personal },
        [1, 0],
      );
      await privacyLayer.deleteMemory(node.node_id, "user_request");

      const events = await eventStore.query({ motebit_id: MOTEBIT_ID });
      const deleteRequested = events.filter((e) => e.event_type === EventType.DeleteRequested);
      expect(deleteRequested).toHaveLength(1);
      const payload = deleteRequested[0]!.payload as Record<string, unknown>;
      expect(payload.target_type).toBe("memory");
      expect(payload.target_id).toBe(node.node_id);
      expect(payload.reason).toBe("user_request");
    });
  });

  describe("deleteConversation", () => {
    // Minimal in-memory ConversationStoreAdapter — covers exactly the
    // methods deleteConversation reads + writes. Avoids pulling
    // browser-persistence into the privacy-layer test surface.
    function makeConversationStore(): {
      adapter: import("@motebit/sdk").ConversationStoreAdapter;
      raw: {
        messages: Map<
          string,
          Array<{ messageId: string; sensitivity?: SensitivityLevel; createdAt: number }>
        >;
        conversations: Set<string>;
        erased: string[];
      };
    } {
      const messages = new Map<
        string,
        Array<{ messageId: string; sensitivity?: SensitivityLevel; createdAt: number }>
      >();
      const conversations = new Set<string>();
      const erased: string[] = [];
      const adapter: import("@motebit/sdk").ConversationStoreAdapter = {
        createConversation: () => {
          const id = crypto.randomUUID();
          conversations.add(id);
          messages.set(id, []);
          return id;
        },
        appendMessage: (conversationId, _motebitId, msg) => {
          const list = messages.get(conversationId) ?? [];
          list.push({
            messageId: crypto.randomUUID(),
            sensitivity: msg.sensitivity,
            createdAt: Date.now(),
          });
          messages.set(conversationId, list);
          conversations.add(conversationId);
        },
        loadMessages: (conversationId) => {
          const list = messages.get(conversationId) ?? [];
          return list.map((m) => ({
            messageId: m.messageId,
            conversationId,
            motebitId: MOTEBIT_ID,
            role: "user",
            content: "",
            toolCalls: null,
            toolCallId: null,
            createdAt: m.createdAt,
            tokenEstimate: 0,
            sensitivity: m.sensitivity,
          }));
        },
        getActiveConversation: () => null,
        updateSummary: () => undefined,
        updateTitle: () => undefined,
        listConversations: () => [],
        deleteConversation: (conversationId) => {
          conversations.delete(conversationId);
          messages.delete(conversationId);
        },
        eraseMessage: (messageId) => {
          erased.push(messageId);
        },
      };
      return { adapter, raw: { messages, conversations, erased } };
    }

    it("signs one consolidation_flush cert per message and erases each", async () => {
      const { adapter, raw } = makeConversationStore();
      const layer = new PrivacyLayer(
        storage,
        memoryGraph,
        eventStore,
        auditLog,
        MOTEBIT_ID,
        TEST_SIGNER,
        adapter,
      );
      const cid = adapter.createConversation(MOTEBIT_ID);
      adapter.appendMessage(cid, MOTEBIT_ID, { role: "user", content: "hi" });
      adapter.appendMessage(cid, MOTEBIT_ID, {
        role: "assistant",
        content: "hello",
        sensitivity: SensitivityLevel.Personal,
      });
      adapter.appendMessage(cid, MOTEBIT_ID, { role: "user", content: "bye" });

      const certs = await layer.deleteConversation(cid, "user_request");

      expect(certs).toHaveLength(3);
      for (const cert of certs) {
        expect(cert.kind).toBe("consolidation_flush");
        if (cert.kind !== "consolidation_flush") continue;
        expect(cert.reason).toBe("user_request");
        expect(cert.flushed_to).toBe("expire");
        expect(cert.subject_signature?.signature.length).toBeGreaterThan(0);
      }
      // All three messages erased.
      expect(raw.erased).toHaveLength(3);
      // Conversation row dropped.
      expect(raw.conversations.has(cid)).toBe(false);
    });

    it("emits a DeleteRequested event for the conversation and a delete_conversation audit", async () => {
      const { adapter } = makeConversationStore();
      const layer = new PrivacyLayer(
        storage,
        memoryGraph,
        eventStore,
        auditLog,
        MOTEBIT_ID,
        TEST_SIGNER,
        adapter,
      );
      const cid = adapter.createConversation(MOTEBIT_ID);
      adapter.appendMessage(cid, MOTEBIT_ID, { role: "user", content: "x" });
      await layer.deleteConversation(cid, "user_request");

      const events = await eventStore.query({ motebit_id: MOTEBIT_ID });
      const intent = events.filter(
        (e) =>
          e.event_type === EventType.DeleteRequested &&
          (e.payload as Record<string, unknown>).target_type === "conversation",
      );
      expect(intent).toHaveLength(1);

      const audits = await auditLog.query(MOTEBIT_ID);
      expect(audits.some((a) => a.action === "delete_conversation" && a.target_id === cid)).toBe(
        true,
      );
    });

    it("throws fail-closed when no conversation store is configured", async () => {
      // Layer without a conversation store — the choke-point still
      // refuses rather than silently no-op.
      const noStoreLayer = new PrivacyLayer(
        storage,
        memoryGraph,
        eventStore,
        auditLog,
        MOTEBIT_ID,
        TEST_SIGNER,
      );
      await expect(noStoreLayer.deleteConversation("c1", "user_request")).rejects.toThrow(
        /Privacy layer: access denied/,
      );
    });

    it("lazy-classifies pre-classification messages at SensitivityLevel.Personal", async () => {
      const { adapter } = makeConversationStore();
      const layer = new PrivacyLayer(
        storage,
        memoryGraph,
        eventStore,
        auditLog,
        MOTEBIT_ID,
        TEST_SIGNER,
        adapter,
      );
      const cid = adapter.createConversation(MOTEBIT_ID);
      // No `sensitivity` field — pre-decision-6b row.
      adapter.appendMessage(cid, MOTEBIT_ID, { role: "user", content: "legacy" });
      const [cert] = await layer.deleteConversation(cid, "user_request");
      if (cert?.kind !== "consolidation_flush") throw new Error("wrong cert kind");
      expect(cert.sensitivity).toBe(SensitivityLevel.Personal);
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
      expect(events.some((e) => e.event_type === EventType.ExportRequested)).toBe(true);
    });

    it("filters out sensitive memories by default", async () => {
      await memoryGraph.formMemory(
        { content: "public info", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0],
      );
      await memoryGraph.formMemory(
        { content: "personal note", confidence: 0.8, sensitivity: SensitivityLevel.Personal },
        [0, 1],
      );
      await memoryGraph.formMemory(
        { content: "medical record", confidence: 0.9, sensitivity: SensitivityLevel.Medical },
        [1, 1],
      );
      await memoryGraph.formMemory(
        { content: "bank details", confidence: 0.9, sensitivity: SensitivityLevel.Financial },
        [0.5, 0.5],
      );
      await memoryGraph.formMemory(
        { content: "secret key", confidence: 1.0, sensitivity: SensitivityLevel.Secret },
        [0.3, 0.7],
      );

      const manifest = await privacyLayer.exportAll(makeIdentity());

      // Only None and Personal should survive
      const contents = manifest.memories.map((m) => m.content);
      expect(contents).toContain("public info");
      expect(contents).toContain("personal note");
      expect(contents).not.toContain("medical record");
      expect(contents).not.toContain("bank details");
      expect(contents).not.toContain("secret key");
      expect(manifest.redacted_count).toBe(3);
    });

    it("includes all memories when includeAllSensitivity is true", async () => {
      await memoryGraph.formMemory(
        { content: "allowed", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0],
      );
      await memoryGraph.formMemory(
        { content: "secret stuff", confidence: 1.0, sensitivity: SensitivityLevel.Secret },
        [0, 1],
      );

      const manifest = await privacyLayer.exportAll(makeIdentity(), {
        includeAllSensitivity: true,
      });

      const contents = manifest.memories.map((m) => m.content);
      expect(contents).toContain("allowed");
      expect(contents).toContain("secret stuff");
      expect(manifest.redacted_count).toBe(0);
    });
  });

  describe("setSensitivity", () => {
    it("changes sensitivity level and creates audit trail", async () => {
      const node = await memoryGraph.formMemory(
        { content: "reclassify me", confidence: 0.9, sensitivity: SensitivityLevel.None },
        [1, 0],
      );

      await privacyLayer.setSensitivity(node.node_id, SensitivityLevel.Medical);

      const loaded = await storage.getNode(node.node_id);
      expect(loaded!.sensitivity).toBe(SensitivityLevel.Medical);

      const auditRecords = await auditLog.query(MOTEBIT_ID);
      const setRecord = auditRecords.find((r) => r.action === "set_sensitivity");
      expect(setRecord).toBeDefined();
      expect(setRecord!.details.old_level).toBe(SensitivityLevel.None);
      expect(setRecord!.details.new_level).toBe(SensitivityLevel.Medical);
    });

    it("throws for non-existent node", async () => {
      await expect(
        privacyLayer.setSensitivity("nonexistent", SensitivityLevel.Secret),
      ).rejects.toThrow("Privacy layer: access denied (fail-closed)");
    });
  });

  describe("inspectMemory", () => {
    it("returns memory and creates audit trail", async () => {
      const node = makeNode({ content: "inspectable" });
      await storage.saveNode(node);

      const result = await privacyLayer.inspectMemory(node.node_id);
      expect(result).not.toBeNull();
      expect(result!.content).toBe("inspectable");

      const auditRecords = await auditLog.query(MOTEBIT_ID);
      expect(auditRecords.some((r) => r.action === "inspect_memory")).toBe(true);
    });

    it("returns null for non-existent node", async () => {
      const result = await privacyLayer.inspectMemory("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("fail-closed behavior", () => {
    it("wraps errors in fail-closed message for listMemories", async () => {
      // Create a storage that throws
      const failingStorage: MemoryStorageAdapter = {
        queryNodes: vi.fn().mockRejectedValue(new Error("DB error")),
        getNode: vi.fn(),
        saveNode: vi.fn(),
        saveEdge: vi.fn(),
        getEdges: vi.fn(),
        tombstoneNode: vi.fn(),
        eraseNode: vi.fn(),
        pinNode: vi.fn(),
        getAllNodes: vi.fn(),
        getAllEdges: vi.fn(),
      };

      const failLayer = new PrivacyLayer(
        failingStorage,
        memoryGraph,
        eventStore,
        auditLog,
        MOTEBIT_ID,
        TEST_SIGNER,
      );

      await expect(failLayer.listMemories()).rejects.toThrow(
        "Privacy layer: access denied (fail-closed)",
      );
    });

    it("wraps errors in fail-closed message for inspectMemory", async () => {
      const failingStorage: MemoryStorageAdapter = {
        queryNodes: vi.fn(),
        getNode: vi.fn().mockRejectedValue(new Error("DB error")),
        saveNode: vi.fn(),
        saveEdge: vi.fn(),
        getEdges: vi.fn(),
        tombstoneNode: vi.fn(),
        eraseNode: vi.fn(),
        pinNode: vi.fn(),
        getAllNodes: vi.fn(),
        getAllEdges: vi.fn(),
      };

      const failLayer = new PrivacyLayer(
        failingStorage,
        memoryGraph,
        eventStore,
        auditLog,
        MOTEBIT_ID,
        TEST_SIGNER,
      );

      await expect(failLayer.inspectMemory("n1")).rejects.toThrow(
        "Privacy layer: access denied (fail-closed)",
      );
    });

    it("wraps errors in fail-closed message for setSensitivity", async () => {
      const failingStorage: MemoryStorageAdapter = {
        queryNodes: vi.fn(),
        getNode: vi.fn().mockRejectedValue(new Error("DB error")),
        saveNode: vi.fn(),
        saveEdge: vi.fn(),
        getEdges: vi.fn(),
        tombstoneNode: vi.fn(),
        eraseNode: vi.fn(),
        pinNode: vi.fn(),
        getAllNodes: vi.fn(),
        getAllEdges: vi.fn(),
      };

      const failLayer = new PrivacyLayer(
        failingStorage,
        memoryGraph,
        eventStore,
        auditLog,
        MOTEBIT_ID,
        TEST_SIGNER,
      );

      await expect(failLayer.setSensitivity("n1", SensitivityLevel.Secret)).rejects.toThrow(
        "Privacy layer: access denied (fail-closed)",
      );
    });

    it("wraps errors in fail-closed message for deleteMemory", async () => {
      // MemoryGraph.deleteMemory will throw when the node doesn't exist
      // in the underlying graph — the PrivacyLayer must catch and re-throw fail-closed
      const failGraph = new MemoryGraph(storage, eventStore, MOTEBIT_ID);
      vi.spyOn(failGraph, "deleteMemory").mockRejectedValue(new Error("node not found"));

      const failLayer = new PrivacyLayer(
        storage,
        failGraph,
        eventStore,
        auditLog,
        MOTEBIT_ID,
        TEST_SIGNER,
      );

      await expect(failLayer.deleteMemory("missing", "user")).rejects.toThrow(
        "Privacy layer: access denied (fail-closed)",
      );
    });

    it("wraps errors in fail-closed message for exportAll", async () => {
      const failGraph = new MemoryGraph(storage, eventStore, MOTEBIT_ID);
      vi.spyOn(failGraph, "exportAll").mockRejectedValue(new Error("export failed"));

      const failLayer = new PrivacyLayer(
        storage,
        failGraph,
        eventStore,
        auditLog,
        MOTEBIT_ID,
        TEST_SIGNER,
      );

      await expect(failLayer.exportAll(makeIdentity())).rejects.toThrow(
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

    it("returns fail-closed defaults for unknown sensitivity level", () => {
      const unknown = privacyLayer.getRetentionRules("unknown_level" as SensitivityLevel);
      expect(unknown.max_retention_days).toBe(0);
      expect(unknown.display_allowed).toBe(false);
    });
  });
});
