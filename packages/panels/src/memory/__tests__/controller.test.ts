/**
 * MemoryController unit tests. Covers:
 *
 *  - refresh() fetches through adapter and writes to state
 *  - loading + error surfaces preserve previous-good state
 *  - filteredView: tombstone, valid_until, sensitivity, search, sort
 *  - setSearch / setAuditFlags / clearAuditFlags
 *  - deleteMemory returns the certificate + optimistic remove + state.lastDeletionCert
 *  - pinMemory mutates the in-memory list immediately
 *  - dispose blocks further emissions
 *  - filterMemoriesView pure export with every filter combination
 */
import { describe, it, expect, vi } from "vitest";
import {
  createMemoryController,
  filterMemoriesView,
  type DeletionCertificate,
  type MemoryFetchAdapter,
  type MemoryNode,
} from "../controller.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeNode(overrides: Partial<MemoryNode> & { node_id: string }): MemoryNode {
  return {
    content: "placeholder",
    confidence: 0.8,
    sensitivity: "none",
    created_at: 1_700_000_000_000,
    last_accessed: 1_700_000_000_000,
    half_life: 7 * 86_400_000,
    tombstoned: false,
    pinned: false,
    ...overrides,
  };
}

const cert: DeletionCertificate = {
  target_id: "node-x",
  tombstone_hash: "abc123deadbeef",
  timestamp: 1_700_000_500_000,
};

// ── Mock adapter ──────────────────────────────────────────────────────

function createAdapter(overrides?: {
  memories?: MemoryNode[];
  listThrows?: Error;
  deleteCert?: DeletionCertificate | null;
  deleteThrows?: Error;
  pinThrows?: Error;
  /** Defaults to raw confidence — tests can override to verify decay is called. */
  decay?: (node: MemoryNode) => number;
}): {
  adapter: MemoryFetchAdapter;
  calls: {
    list: number;
    delete: Array<string>;
    pin: Array<{ nodeId: string; pinned: boolean }>;
    decay: number;
  };
} {
  const calls = {
    list: 0,
    delete: [] as string[],
    pin: [] as Array<{ nodeId: string; pinned: boolean }>,
    decay: 0,
  };

  const adapter: MemoryFetchAdapter = {
    async listMemories() {
      calls.list++;
      if (overrides?.listThrows) throw overrides.listThrows;
      return overrides?.memories ?? [];
    },
    async deleteMemory(nodeId) {
      calls.delete.push(nodeId);
      if (overrides?.deleteThrows) throw overrides.deleteThrows;
      return overrides?.deleteCert ?? null;
    },
    async pinMemory(nodeId, pinned) {
      calls.pin.push({ nodeId, pinned });
      if (overrides?.pinThrows) throw overrides.pinThrows;
    },
    getDecayedConfidence(node) {
      calls.decay++;
      if (overrides?.decay) return overrides.decay(node);
      return node.confidence;
    },
  };

  return { adapter, calls };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("MemoryController — initial state", () => {
  it("starts empty, not loading, no audit flags", () => {
    const { adapter } = createAdapter();
    const ctrl = createMemoryController(adapter);
    const s = ctrl.getState();
    expect(s.memories).toEqual([]);
    expect(s.search).toBe("");
    expect(s.auditFlags.size).toBe(0);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    expect(s.lastDeletionCert).toBeNull();
  });
});

describe("MemoryController — refresh()", () => {
  it("fetches through the adapter and populates state", async () => {
    const nodes = [makeNode({ node_id: "a" }), makeNode({ node_id: "b" })];
    const { adapter, calls } = createAdapter({ memories: nodes });
    const ctrl = createMemoryController(adapter);
    await ctrl.refresh();
    expect(calls.list).toBe(1);
    expect(ctrl.getState().memories).toEqual(nodes);
    expect(ctrl.getState().loading).toBe(false);
    expect(ctrl.getState().error).toBeNull();
  });

  it("sets loading=true then false around the fetch", async () => {
    const { adapter } = createAdapter({ memories: [] });
    const ctrl = createMemoryController(adapter);
    const seen: boolean[] = [];
    ctrl.subscribe((s) => seen.push(s.loading));
    await ctrl.refresh();
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it("surfaces error and leaves previous-good memories intact", async () => {
    let callCount = 0;
    const adapter: MemoryFetchAdapter = {
      async listMemories() {
        callCount++;
        if (callCount === 1) return [makeNode({ node_id: "alive" })];
        throw new Error("runtime gone");
      },
      async deleteMemory() {
        return null;
      },
      async pinMemory() {},
      getDecayedConfidence: (n) => n.confidence,
    };
    const ctrl = createMemoryController(adapter);
    await ctrl.refresh();
    expect(ctrl.getState().memories).toHaveLength(1);
    await ctrl.refresh();
    expect(ctrl.getState().error).toBe("runtime gone");
    expect(ctrl.getState().memories).toHaveLength(1); // preserved
  });
});

describe("MemoryController — filteredView()", () => {
  const now = 1_700_000_000_000;

  it("excludes tombstoned + expired nodes", () => {
    const live = makeNode({ node_id: "live", created_at: now });
    const tombstoned = makeNode({
      node_id: "gone",
      tombstoned: true,
      created_at: now,
    });
    const expired = makeNode({
      node_id: "expired",
      valid_until: now - 1,
      created_at: now,
    });
    const view = filterMemoriesView([live, tombstoned, expired], {
      search: "",
      auditFlags: new Map(),
      now,
    });
    expect(view.map((n) => n.node_id)).toEqual(["live"]);
  });

  it("keeps nodes whose valid_until is in the future", () => {
    const future = makeNode({
      node_id: "future",
      valid_until: now + 60_000,
      created_at: now - 10,
    });
    const view = filterMemoriesView([future], {
      search: "",
      auditFlags: new Map(),
      now,
    });
    expect(view).toHaveLength(1);
  });

  it("applies sensitivity filter when provided", () => {
    const personal = makeNode({
      node_id: "p",
      sensitivity: "personal",
      content: "pers",
    });
    const medical = makeNode({
      node_id: "m",
      sensitivity: "medical",
      content: "med",
    });
    const view = filterMemoriesView([personal, medical], {
      search: "",
      auditFlags: new Map(),
      sensitivityFilter: ["none", "personal"],
    });
    expect(view.map((n) => n.node_id)).toEqual(["p"]);
  });

  it("skips sensitivity filter when not provided (shows all)", () => {
    const medical = makeNode({
      node_id: "m",
      sensitivity: "medical",
      content: "secret thing",
    });
    const view = filterMemoriesView([medical], {
      search: "",
      auditFlags: new Map(),
    });
    expect(view).toHaveLength(1);
  });

  it("applies case-insensitive search on content", () => {
    const a = makeNode({ node_id: "a", content: "TensorFlow is neat" });
    const b = makeNode({ node_id: "b", content: "react is fine" });
    const view = filterMemoriesView([a, b], {
      search: "tensor",
      auditFlags: new Map(),
    });
    expect(view.map((n) => n.node_id)).toEqual(["a"]);
  });

  it("sorts pinned first, then by created_at descending", () => {
    const pinnedOld = makeNode({
      node_id: "pin-old",
      pinned: true,
      created_at: 100,
    });
    const pinnedNew = makeNode({
      node_id: "pin-new",
      pinned: true,
      created_at: 200,
    });
    const unpinnedNew = makeNode({
      node_id: "up-new",
      pinned: false,
      created_at: 300,
    });
    const unpinnedOld = makeNode({
      node_id: "up-old",
      pinned: false,
      created_at: 50,
    });
    const view = filterMemoriesView([pinnedOld, unpinnedOld, pinnedNew, unpinnedNew], {
      search: "",
      auditFlags: new Map(),
    });
    expect(view.map((n) => n.node_id)).toEqual(["pin-new", "pin-old", "up-new", "up-old"]);
  });

  it("surfaces audit-flagged memories first within each pin-bucket", () => {
    const flagged = makeNode({ node_id: "flagged", pinned: false, created_at: 100 });
    const unflagged = makeNode({
      node_id: "unflagged",
      pinned: false,
      created_at: 200,
    });
    const view = filterMemoriesView([flagged, unflagged], {
      search: "",
      auditFlags: new Map([["flagged", "phantom"]]),
    });
    // flagged wins even though unflagged is newer, because audit sort
    // promotes flagged within the bucket.
    expect(view.map((n) => n.node_id)).toEqual(["flagged", "unflagged"]);
  });
});

describe("MemoryController — setSearch / audit flags", () => {
  it("setSearch is no-op when unchanged", () => {
    const { adapter } = createAdapter();
    const ctrl = createMemoryController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    ctrl.setSearch("");
    expect(listener).not.toHaveBeenCalled();
    ctrl.setSearch("tens");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setAuditFlags replaces the map; clearAuditFlags clears it", () => {
    const { adapter } = createAdapter();
    const ctrl = createMemoryController(adapter);
    ctrl.setAuditFlags(new Map([["a", "phantom"]]));
    expect(ctrl.getState().auditFlags.size).toBe(1);
    ctrl.clearAuditFlags();
    expect(ctrl.getState().auditFlags.size).toBe(0);
  });

  it("clearAuditFlags is no-op when already empty", () => {
    const { adapter } = createAdapter();
    const ctrl = createMemoryController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    ctrl.clearAuditFlags();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("MemoryController — deleteMemory()", () => {
  it("returns certificate + optimistically removes from state + stores lastDeletionCert", async () => {
    const alive = makeNode({ node_id: "alive" });
    const dying = makeNode({ node_id: "dying" });
    const { adapter, calls } = createAdapter({
      memories: [alive, dying],
      deleteCert: cert,
    });
    const ctrl = createMemoryController(adapter);
    await ctrl.refresh();
    const result = await ctrl.deleteMemory("dying");
    expect(result).toEqual(cert);
    expect(ctrl.getState().memories.map((m) => m.node_id)).toEqual(["alive"]);
    expect(ctrl.getState().lastDeletionCert).toEqual(cert);
    expect(calls.delete).toEqual(["dying"]);
  });

  it("returns null and surfaces error on failure", async () => {
    const { adapter } = createAdapter({ deleteThrows: new Error("db locked") });
    const ctrl = createMemoryController(adapter);
    const result = await ctrl.deleteMemory("x");
    expect(result).toBeNull();
    expect(ctrl.getState().error).toBe("db locked");
  });
});

describe("MemoryController — pinMemory()", () => {
  it("updates in-memory list so pin reordering renders immediately", async () => {
    const a = makeNode({ node_id: "a", pinned: false });
    const { adapter } = createAdapter({ memories: [a] });
    const ctrl = createMemoryController(adapter);
    await ctrl.refresh();
    await ctrl.pinMemory("a", true);
    expect(ctrl.getState().memories[0]?.pinned).toBe(true);
  });

  it("surfaces error on adapter failure, leaves state unchanged", async () => {
    const { adapter } = createAdapter({
      memories: [makeNode({ node_id: "a", pinned: false })],
      pinThrows: new Error("forbidden"),
    });
    const ctrl = createMemoryController(adapter);
    await ctrl.refresh();
    await ctrl.pinMemory("a", true);
    expect(ctrl.getState().error).toBe("forbidden");
    expect(ctrl.getState().memories[0]?.pinned).toBe(false);
  });
});

describe("MemoryController — getDecayedConfidence passthrough", () => {
  it("delegates to the adapter", () => {
    const { adapter, calls } = createAdapter({ decay: (n) => n.confidence * 0.5 });
    const ctrl = createMemoryController(adapter);
    const node = makeNode({ node_id: "x", confidence: 0.8 });
    const result = ctrl.getDecayedConfidence(node);
    expect(result).toBe(0.4);
    expect(calls.decay).toBe(1);
  });
});

describe("MemoryController — subscribe / dispose", () => {
  it("notifies subscribers", async () => {
    const { adapter } = createAdapter({ memories: [makeNode({ node_id: "a" })] });
    const ctrl = createMemoryController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    await ctrl.refresh();
    expect(listener).toHaveBeenCalled();
  });

  it("dispose blocks further emissions", async () => {
    const { adapter } = createAdapter({ memories: [makeNode({ node_id: "a" })] });
    const ctrl = createMemoryController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    ctrl.dispose();
    await ctrl.refresh();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("filterMemoriesView pure export", () => {
  it("is stable across repeated calls (no memoization surprises)", () => {
    const n = makeNode({ node_id: "a" });
    const r1 = filterMemoriesView([n], { search: "", auditFlags: new Map() });
    const r2 = filterMemoriesView([n], { search: "", auditFlags: new Map() });
    expect(r1).not.toBe(r2); // fresh array each call
    expect(r1).toEqual(r2);
  });
});
