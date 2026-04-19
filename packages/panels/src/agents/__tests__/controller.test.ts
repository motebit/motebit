/**
 * AgentsController unit tests. Covers:
 *
 *  - Known + discover refresh orchestration
 *  - Loading flag transitions
 *  - Error surfacing (state.error preserves previous-good state)
 *  - Sort + capability filter derived view (all five sort modes)
 *  - Subscribe / dispose semantics
 *  - collectCapabilities helper
 *  - applySortFilter pure-function export
 */
import { describe, it, expect, vi } from "vitest";
import {
  createAgentsController,
  applySortFilter,
  collectCapabilities,
  type AgentRecord,
  type AgentsFetchAdapter,
  type DiscoveredAgent,
  type SortKey,
} from "../controller.js";

// ── Mock adapter ──────────────────────────────────────────────────────

function createAdapter(overrides?: {
  syncUrl?: string | null;
  motebitId?: string | null;
  known?: AgentRecord[];
  discovered?: DiscoveredAgent[];
  listThrows?: Error;
  discoverThrows?: Error;
}): {
  adapter: AgentsFetchAdapter;
  listCalls: number;
  discoverCalls: number;
} {
  let listCalls = 0;
  let discoverCalls = 0;

  const adapter: AgentsFetchAdapter = {
    syncUrl: "syncUrl" in (overrides ?? {}) ? overrides!.syncUrl! : "https://relay.test",
    motebitId: "motebitId" in (overrides ?? {}) ? overrides!.motebitId! : "mb_test",
    async listTrustedAgents(): Promise<AgentRecord[]> {
      listCalls++;
      if (overrides?.listThrows) throw overrides.listThrows;
      return overrides?.known ?? [];
    },
    async discoverAgents(): Promise<DiscoveredAgent[]> {
      discoverCalls++;
      if (overrides?.discoverThrows) throw overrides.discoverThrows;
      return overrides?.discovered ?? [];
    },
  };

  return {
    adapter,
    get listCalls() {
      return listCalls;
    },
    get discoverCalls() {
      return discoverCalls;
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────

const knownOlder: AgentRecord = {
  remote_motebit_id: "mb_known_older",
  trust_level: "verified",
  first_seen_at: 1_700_000_000_000,
  last_seen_at: 1_700_000_100_000,
  interaction_count: 5,
  successful_tasks: 4,
  failed_tasks: 1,
};

const knownNewer: AgentRecord = {
  remote_motebit_id: "mb_known_newer",
  trust_level: "trusted",
  first_seen_at: 1_700_000_200_000,
  last_seen_at: 1_700_000_300_000,
  interaction_count: 10,
  successful_tasks: 10,
  failed_tasks: 0,
};

const discoveredA: DiscoveredAgent = {
  motebit_id: "mb_a",
  capabilities: ["web_search", "summarize"],
  trust_level: "trusted",
  interaction_count: 100,
  pricing: [
    { capability: "web_search", unit_cost: 0.05, currency: "USD", per: "search" },
    { capability: "summarize", unit_cost: 0.01, currency: "USD", per: "call" },
  ],
  last_seen_at: 1_700_000_000_000,
  freshness: "awake",
};

const discoveredB: DiscoveredAgent = {
  motebit_id: "mb_b",
  capabilities: ["code_review"],
  trust_level: "first_contact",
  interaction_count: 2,
  pricing: [{ capability: "code_review", unit_cost: 0.5, currency: "USD", per: "review" }],
  last_seen_at: 1_700_000_100_000,
  freshness: "recently_seen",
};

const discoveredC: DiscoveredAgent = {
  motebit_id: "mb_c",
  capabilities: ["web_search"],
  trust_level: "unknown",
  interaction_count: 0,
  pricing: null, // unpriced
  last_seen_at: 1_700_000_200_000,
  freshness: "dormant",
};

// ── Tests ─────────────────────────────────────────────────────────────

describe("AgentsController — initial state", () => {
  it("starts on known tab, empty lists, not loading", () => {
    const { adapter } = createAdapter();
    const ctrl = createAgentsController(adapter);
    const s = ctrl.getState();
    expect(s.activeTab).toBe("known");
    expect(s.known).toEqual([]);
    expect(s.discovered).toEqual([]);
    expect(s.sort).toBe("recent");
    expect(s.capabilityFilter).toBe("");
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });
});

describe("AgentsController — refreshKnown()", () => {
  it("populates known list sorted newest-first", async () => {
    const { adapter } = createAdapter({
      known: [knownOlder, knownNewer],
    });
    const ctrl = createAgentsController(adapter);
    await ctrl.refreshKnown();
    const s = ctrl.getState();
    expect(s.known).toHaveLength(2);
    expect(s.known[0]?.remote_motebit_id).toBe("mb_known_newer");
    expect(s.known[1]?.remote_motebit_id).toBe("mb_known_older");
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("sets loading=true during refresh", async () => {
    const { adapter } = createAdapter({ known: [knownOlder] });
    const ctrl = createAgentsController(adapter);
    const seen: boolean[] = [];
    ctrl.subscribe((s) => seen.push(s.loading));
    await ctrl.refreshKnown();
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it("surfaces listTrustedAgents error into state", async () => {
    const { adapter } = createAdapter({ listThrows: new Error("db offline") });
    const ctrl = createAgentsController(adapter);
    await ctrl.refreshKnown();
    expect(ctrl.getState().error).toBe("db offline");
    expect(ctrl.getState().loading).toBe(false);
  });

  it("preserves previous-good state on error", async () => {
    let calls = 0;
    const adapter: AgentsFetchAdapter = {
      syncUrl: "https://relay.test",
      motebitId: "mb_test",
      async listTrustedAgents() {
        calls++;
        if (calls === 1) return [knownNewer];
        throw new Error("transient");
      },
      async discoverAgents() {
        return [];
      },
    };
    const ctrl = createAgentsController(adapter);
    await ctrl.refreshKnown();
    expect(ctrl.getState().known).toHaveLength(1);
    await ctrl.refreshKnown();
    // Error recorded but known list still contains the previous-good data.
    expect(ctrl.getState().error).toBe("transient");
    expect(ctrl.getState().known).toHaveLength(1);
  });
});

describe("AgentsController — refreshDiscover()", () => {
  it("populates discovered list in adapter order", async () => {
    const { adapter } = createAdapter({
      discovered: [discoveredA, discoveredB, discoveredC],
    });
    const ctrl = createAgentsController(adapter);
    await ctrl.refreshDiscover();
    expect(ctrl.getState().discovered).toHaveLength(3);
    expect(ctrl.getState().discovered[0]?.motebit_id).toBe("mb_a");
  });

  it("surfaces discoverAgents error into state", async () => {
    const { adapter } = createAdapter({ discoverThrows: new Error("relay 503") });
    const ctrl = createAgentsController(adapter);
    await ctrl.refreshDiscover();
    expect(ctrl.getState().error).toBe("relay 503");
  });
});

describe("AgentsController — tab + sort + filter", () => {
  it("setActiveTab is no-op when already active", () => {
    const { adapter } = createAdapter();
    const ctrl = createAgentsController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    ctrl.setActiveTab("known"); // initial
    expect(listener).not.toHaveBeenCalled();
    ctrl.setActiveTab("discover");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setSort updates state and notifies", () => {
    const { adapter } = createAdapter();
    const ctrl = createAgentsController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    ctrl.setSort("price-asc");
    expect(ctrl.getState().sort).toBe("price-asc");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setCapabilityFilter updates state", () => {
    const { adapter } = createAdapter();
    const ctrl = createAgentsController(adapter);
    ctrl.setCapabilityFilter("web_search");
    expect(ctrl.getState().capabilityFilter).toBe("web_search");
  });
});

describe("AgentsController — discoveredView()", () => {
  it("applies recent sort by default", async () => {
    const { adapter } = createAdapter({
      discovered: [discoveredA, discoveredB, discoveredC],
    });
    const ctrl = createAgentsController(adapter);
    await ctrl.refreshDiscover();
    const view = ctrl.discoveredView();
    // last_seen_at descending: C (200k) > B (100k) > A (0k)
    expect(view.map((a) => a.motebit_id)).toEqual(["mb_c", "mb_b", "mb_a"]);
  });

  it("applies capability filter", async () => {
    const { adapter } = createAdapter({
      discovered: [discoveredA, discoveredB, discoveredC],
    });
    const ctrl = createAgentsController(adapter);
    await ctrl.refreshDiscover();
    ctrl.setCapabilityFilter("web_search");
    const view = ctrl.discoveredView();
    // only A and C have web_search; C newer
    expect(view.map((a) => a.motebit_id)).toEqual(["mb_c", "mb_a"]);
  });

  it("applies price-asc sort with unpriced last", async () => {
    const { adapter } = createAdapter({
      discovered: [discoveredA, discoveredB, discoveredC],
    });
    const ctrl = createAgentsController(adapter);
    await ctrl.refreshDiscover();
    ctrl.setSort("price-asc");
    const view = ctrl.discoveredView();
    // A min=0.01 < B min=0.5 < C unpriced
    expect(view.map((a) => a.motebit_id)).toEqual(["mb_a", "mb_b", "mb_c"]);
  });

  it("applies price-desc sort with unpriced still last", async () => {
    const { adapter } = createAdapter({
      discovered: [discoveredA, discoveredB, discoveredC],
    });
    const ctrl = createAgentsController(adapter);
    await ctrl.refreshDiscover();
    ctrl.setSort("price-desc");
    const view = ctrl.discoveredView();
    // B max=0.5 > A max=0.05 > C unpriced (always last)
    expect(view.map((a) => a.motebit_id)).toEqual(["mb_b", "mb_a", "mb_c"]);
  });

  it("applies trust sort (highest first)", async () => {
    const { adapter } = createAdapter({
      discovered: [discoveredA, discoveredB, discoveredC],
    });
    const ctrl = createAgentsController(adapter);
    await ctrl.refreshDiscover();
    ctrl.setSort("trust");
    const view = ctrl.discoveredView();
    // trusted(A, 3) > first_contact(B, 1) > unknown(C, 0)
    expect(view.map((a) => a.motebit_id)).toEqual(["mb_a", "mb_b", "mb_c"]);
  });

  it("applies interactions sort (highest first)", async () => {
    const { adapter } = createAdapter({
      discovered: [discoveredA, discoveredB, discoveredC],
    });
    const ctrl = createAgentsController(adapter);
    await ctrl.refreshDiscover();
    ctrl.setSort("interactions");
    const view = ctrl.discoveredView();
    // A=100 > B=2 > C=0
    expect(view.map((a) => a.motebit_id)).toEqual(["mb_a", "mb_b", "mb_c"]);
  });
});

describe("AgentsController — subscribe / dispose", () => {
  it("notifies subscribers on state change", async () => {
    const { adapter } = createAdapter({ known: [knownOlder] });
    const ctrl = createAgentsController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    await ctrl.refreshKnown();
    expect(listener).toHaveBeenCalled();
  });

  it("unsubscribe stops notifications", async () => {
    const { adapter } = createAdapter({ known: [knownOlder] });
    const ctrl = createAgentsController(adapter);
    const listener = vi.fn();
    const off = ctrl.subscribe(listener);
    off();
    await ctrl.refreshKnown();
    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose stops all notifications and blocks further patches", async () => {
    const { adapter } = createAdapter({ known: [knownOlder] });
    const ctrl = createAgentsController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    ctrl.dispose();
    await ctrl.refreshKnown();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("collectCapabilities helper", () => {
  it("returns unique capabilities sorted alphabetically", () => {
    const caps = collectCapabilities([discoveredA, discoveredB, discoveredC]);
    expect(caps).toEqual(["code_review", "summarize", "web_search"]);
  });

  it("returns empty list when no agents", () => {
    expect(collectCapabilities([])).toEqual([]);
  });
});

describe("applySortFilter export", () => {
  const sortModes: SortKey[] = ["recent", "price-asc", "price-desc", "trust", "interactions"];

  for (const sort of sortModes) {
    it(`returns a fresh array for sort=${sort}`, () => {
      const input = [discoveredA, discoveredB, discoveredC];
      const result = applySortFilter(input, sort, "");
      expect(result).not.toBe(input);
      expect(result).toHaveLength(3);
    });
  }

  it("filters to matching capability before sorting", () => {
    const view = applySortFilter([discoveredA, discoveredB, discoveredC], "recent", "code_review");
    expect(view).toHaveLength(1);
    expect(view[0]?.motebit_id).toBe("mb_b");
  });
});
