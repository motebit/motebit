import { describe, it, expect, vi } from "vitest";
import {
  createTrustController,
  isDeletionAction,
  type TrustFetchAdapter,
  type TrustState,
} from "../controller.js";

// ── Adapter fixtures ──────────────────────────────────────────────────

function makeAdapter(overrides: Partial<TrustFetchAdapter> = {}): TrustFetchAdapter {
  return {
    getMemoryNodes: async () => [],
    getConversations: () => [],
    getRecentReceipts: () => [],
    getAuditRecords: async () => [],
    getTrustedAgents: async () => [],
    ...overrides,
  };
}

// ── isDeletionAction predicate ────────────────────────────────────────

describe("isDeletionAction — the deletion-class discriminator", () => {
  it("counts `delete_memory` as a deletion", () => {
    expect(isDeletionAction("delete_memory")).toBe(true);
  });

  it("counts `delete_conversation` as a deletion", () => {
    expect(isDeletionAction("delete_conversation")).toBe(true);
  });

  it("counts `flush_record` (consolidation cycle) as a deletion", () => {
    expect(isDeletionAction("flush_record")).toBe(true);
  });

  it("counts any future `delete_<x>` action as a deletion (forward-compatible)", () => {
    expect(isDeletionAction("delete_credential")).toBe(true);
    expect(isDeletionAction("delete_skill")).toBe(true);
  });

  it("does NOT count non-deletion audit actions", () => {
    expect(isDeletionAction("set_sensitivity")).toBe(false);
    expect(isDeletionAction("skill_trust_grant")).toBe(false);
    expect(isDeletionAction("export_all")).toBe(false);
  });

  it("does NOT count partial-match strings (`deletion_event` doesn't start with `delete_`)", () => {
    expect(isDeletionAction("deletion_event")).toBe(false);
  });
});

// ── State shape ───────────────────────────────────────────────────────

describe("createTrustController — initial state", () => {
  it("starts with zero counts and empty maps before first refresh", () => {
    const ctrl = createTrustController(makeAdapter());
    const state = ctrl.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.fetchedAt).toBe(0);
    expect(state.memoryCount).toBe(0);
    expect(state.conversationCount).toBe(0);
    expect(state.receiptCount).toBe(0);
    expect(state.deletionCount).toBe(0);
    expect(state.peerCount).toBe(0);
    expect(state.memorySensitivity.size).toBe(0);
    expect(state.recentReceiptToolNames).toEqual([]);
    expect(state.deletionActions.size).toBe(0);
    expect(state.peerTrustLevels.size).toBe(0);
    expect(state.cookies).toBeNull();
  });
});

// ── Refresh: empty-everything ─────────────────────────────────────────

describe("createTrustController — empty refresh", () => {
  it("zero accumulation produces all-zero counts + fetchedAt set", async () => {
    const ctrl = createTrustController(makeAdapter());
    await ctrl.refresh();
    const state = ctrl.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.fetchedAt).toBeGreaterThan(0);
    expect(state.memoryCount).toBe(0);
    expect(state.conversationCount).toBe(0);
    expect(state.receiptCount).toBe(0);
    expect(state.deletionCount).toBe(0);
    expect(state.peerCount).toBe(0);
  });
});

// ── Refresh: full aggregation ─────────────────────────────────────────

describe("createTrustController — full aggregation", () => {
  it("counts memories + conversations + receipts + deletions + peers", async () => {
    const ctrl = createTrustController(
      makeAdapter({
        getMemoryNodes: async () => [
          { node_id: "n1", sensitivity: "personal" },
          { node_id: "n2", sensitivity: "personal" },
          { node_id: "n3", sensitivity: "financial" },
        ],
        getConversations: () => [{ id: "c1" }, { id: "c2" }],
        getRecentReceipts: () => [{ tool_name: "click_element" }, { tool_name: "navigate" }],
        getAuditRecords: async () => [
          { action: "delete_memory" },
          { action: "delete_memory" },
          { action: "delete_conversation" },
          { action: "set_sensitivity" }, // non-deletion, excluded
        ],
        getTrustedAgents: async () => [
          { remote_motebit_id: "did:a", trust_level: "verified" },
          { remote_motebit_id: "did:b", trust_level: "discovered" },
        ],
      }),
    );
    await ctrl.refresh();
    const state = ctrl.getState();
    expect(state.memoryCount).toBe(3);
    expect(state.conversationCount).toBe(2);
    expect(state.receiptCount).toBe(2);
    expect(state.deletionCount).toBe(3);
    expect(state.peerCount).toBe(2);
  });

  it("surfaces sensitivity distribution as a tier-keyed map", async () => {
    const ctrl = createTrustController(
      makeAdapter({
        getMemoryNodes: async () => [
          { node_id: "n1", sensitivity: "personal" },
          { node_id: "n2", sensitivity: "personal" },
          { node_id: "n3", sensitivity: "financial" },
        ],
      }),
    );
    await ctrl.refresh();
    const state = ctrl.getState();
    expect(state.memorySensitivity.get("personal")).toBe(2);
    expect(state.memorySensitivity.get("financial")).toBe(1);
  });

  it("missing `sensitivity` collapses to `'none'` (default tier)", async () => {
    const ctrl = createTrustController(
      makeAdapter({
        getMemoryNodes: async () => [
          { node_id: "n1" }, // undefined sensitivity
          { node_id: "n2", sensitivity: null },
          { node_id: "n3", sensitivity: "" },
        ],
      }),
    );
    await ctrl.refresh();
    expect(ctrl.getState().memorySensitivity.get("none")).toBe(3);
  });

  it("recent receipt window defaults to 5 (oldest-first within slice)", async () => {
    const receipts = Array.from({ length: 8 }, (_, i) => ({ tool_name: `tool_${i}` }));
    const ctrl = createTrustController(makeAdapter({ getRecentReceipts: () => receipts }));
    await ctrl.refresh();
    // slice(-5) of [tool_0..tool_7] → tool_3..tool_7
    expect(ctrl.getState().recentReceiptToolNames).toEqual([
      "tool_3",
      "tool_4",
      "tool_5",
      "tool_6",
      "tool_7",
    ]);
  });

  it("recent receipt window can be overridden via options", async () => {
    const receipts = Array.from({ length: 8 }, (_, i) => ({ tool_name: `tool_${i}` }));
    const ctrl = createTrustController(makeAdapter({ getRecentReceipts: () => receipts }), {
      recentReceiptsWindow: 3,
    });
    await ctrl.refresh();
    expect(ctrl.getState().recentReceiptToolNames).toEqual(["tool_5", "tool_6", "tool_7"]);
  });

  it("groups deletion actions by action name", async () => {
    const ctrl = createTrustController(
      makeAdapter({
        getAuditRecords: async () => [
          { action: "delete_memory" },
          { action: "delete_memory" },
          { action: "delete_memory" },
          { action: "delete_conversation" },
          { action: "flush_record" },
          { action: "set_sensitivity" }, // excluded — not a deletion
        ],
      }),
    );
    await ctrl.refresh();
    const actions = ctrl.getState().deletionActions;
    expect(actions.get("delete_memory")).toBe(3);
    expect(actions.get("delete_conversation")).toBe(1);
    expect(actions.get("flush_record")).toBe(1);
    expect(actions.has("set_sensitivity")).toBe(false);
  });

  it("groups peers by trust_level with `'unknown'` collapse for missing level", async () => {
    const ctrl = createTrustController(
      makeAdapter({
        getTrustedAgents: async () => [
          { remote_motebit_id: "did:a", trust_level: "verified" },
          { remote_motebit_id: "did:b", trust_level: "verified" },
          { remote_motebit_id: "did:c", trust_level: "discovered" },
          { remote_motebit_id: "did:d" }, // no trust_level → "unknown"
        ],
      }),
    );
    await ctrl.refresh();
    const levels = ctrl.getState().peerTrustLevels;
    expect(levels.get("verified")).toBe(2);
    expect(levels.get("discovered")).toBe(1);
    expect(levels.get("unknown")).toBe(1);
  });
});

// ── Web-only sixth dimension: cookies ─────────────────────────────────

describe("createTrustController — cookies dimension (web-only)", () => {
  it("cookies stays null when the adapter has no getPersistedCookies method", async () => {
    const ctrl = createTrustController(makeAdapter()); // no cookies accessor
    await ctrl.refresh();
    expect(ctrl.getState().cookies).toBeNull();
  });

  it("surfaces count + sorted distinct domains when adapter provides cookies", async () => {
    const ctrl = createTrustController(
      makeAdapter({
        getPersistedCookies: async () => [
          { domain: ".google.com" },
          { domain: ".google.com" },
          { domain: ".github.com" },
          { domain: "motebit.com" },
        ],
      }),
    );
    await ctrl.refresh();
    const cookies = ctrl.getState().cookies;
    expect(cookies).not.toBeNull();
    expect(cookies!.count).toBe(4);
    // Leading dot stripped, sorted ascending, distinct.
    expect(cookies!.domains).toEqual(["github.com", "google.com", "motebit.com"]);
  });

  it("empty cookie jar still produces a summary (count: 0)", async () => {
    const ctrl = createTrustController(makeAdapter({ getPersistedCookies: async () => [] }));
    await ctrl.refresh();
    expect(ctrl.getState().cookies).toEqual({ count: 0, domains: [] });
  });
});

// ── Subscribe / dispose ───────────────────────────────────────────────

describe("createTrustController — subscribe / dispose", () => {
  it("subscribe emits the current state immediately", () => {
    const ctrl = createTrustController(makeAdapter());
    const listener = vi.fn();
    ctrl.subscribe(listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).toMatchObject({ loading: false, memoryCount: 0 });
  });

  it("subscribe fires on refresh", async () => {
    const ctrl = createTrustController(makeAdapter());
    const listener = vi.fn();
    ctrl.subscribe(listener);
    listener.mockClear();
    await ctrl.refresh();
    // loading: true, then loading: false with the projection
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
    const final = listener.mock.calls[listener.mock.calls.length - 1]![0] as TrustState;
    expect(final.loading).toBe(false);
    expect(final.fetchedAt).toBeGreaterThan(0);
  });

  it("unsubscribe stops emitting", async () => {
    const ctrl = createTrustController(makeAdapter());
    const listener = vi.fn();
    const off = ctrl.subscribe(listener);
    listener.mockClear();
    off();
    await ctrl.refresh();
    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose stops all listeners + prevents future refresh emissions", async () => {
    const ctrl = createTrustController(makeAdapter());
    const listener = vi.fn();
    ctrl.subscribe(listener);
    listener.mockClear();
    ctrl.dispose();
    await ctrl.refresh();
    expect(listener).not.toHaveBeenCalled();
  });
});

// ── Error path ────────────────────────────────────────────────────────

describe("createTrustController — fail-soft on adapter error", () => {
  it("any adapter throw lands as `error` state with prior state preserved", async () => {
    const ctrl = createTrustController(
      makeAdapter({
        getMemoryNodes: async () => {
          throw new Error("storage unavailable");
        },
      }),
    );
    await ctrl.refresh();
    const state = ctrl.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toContain("storage unavailable");
    expect(state.fetchedAt).toBe(0); // never reached successful projection
  });

  it("retries cleanly after an error path resolves", async () => {
    let throwOnce = true;
    const ctrl = createTrustController(
      makeAdapter({
        getMemoryNodes: async () => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error("transient");
          }
          return [{ node_id: "n1", sensitivity: "none" }];
        },
      }),
    );
    await ctrl.refresh();
    expect(ctrl.getState().error).not.toBeNull();
    await ctrl.refresh();
    const state = ctrl.getState();
    expect(state.error).toBeNull();
    expect(state.memoryCount).toBe(1);
  });
});
