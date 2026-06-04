import { describe, it, expect } from "vitest";
import {
  shortMotebitId,
  agentDisplayLabel,
  trustAuraClass,
  createAgentsController,
  economicForPeer,
  formatPeerEconomics,
  type AgentsFetchAdapter,
  type AgentEconomicSummary,
  type AgentPeerEconomics,
} from "../agents/controller.js";

const UUID = "019d6828-969e-7e9b-baa2-481ece0f80c2";

function makeAdapter(over: Partial<AgentsFetchAdapter> = {}): AgentsFetchAdapter {
  return {
    syncUrl: null,
    motebitId: "me",
    listTrustedAgents: async () => [],
    discoverAgents: async () => [],
    ...over,
  };
}

describe("shortMotebitId", () => {
  it("shortens a motebit_id to head…tail", () => {
    expect(shortMotebitId(UUID)).toBe("019d6828…0f80c2");
  });

  it("honors custom head/tail widths", () => {
    expect(shortMotebitId(UUID, 4, 4)).toBe("019d…80c2");
  });

  it("returns short strings unchanged (no … when it wouldn't shorten)", () => {
    expect(shortMotebitId("abc")).toBe("abc");
    expect(shortMotebitId("0123456789")).toBe("0123456789"); // 10 ≤ 8+6+1
  });
});

describe("agentDisplayLabel", () => {
  it("prefers a petname when set (Known tab)", () => {
    expect(agentDisplayLabel({ remote_motebit_id: UUID, petname: "Scout" })).toBe("Scout");
  });

  it("falls back to the short id when no petname (Known)", () => {
    expect(agentDisplayLabel({ remote_motebit_id: UUID })).toBe(shortMotebitId(UUID));
  });

  it("uses motebit_id for discovered agents (no petname there)", () => {
    expect(agentDisplayLabel({ motebit_id: UUID })).toBe(shortMotebitId(UUID));
  });

  it("treats an empty petname as unset", () => {
    expect(agentDisplayLabel({ remote_motebit_id: UUID, petname: "" })).toBe(shortMotebitId(UUID));
  });

  it("returns an empty string when no id is present (defensive)", () => {
    expect(agentDisplayLabel({})).toBe("");
  });
});

describe("trustAuraClass", () => {
  it("earns no aura below verified (honest: no glow without earned trust)", () => {
    expect(trustAuraClass("first_contact")).toBe("");
    expect(trustAuraClass("unknown")).toBe("");
    expect(trustAuraClass("")).toBe("");
  });

  it("maps verified/trusted to ring/glow tokens", () => {
    expect(trustAuraClass("verified")).toBe("agent-trust-verified");
    expect(trustAuraClass("trusted")).toBe("agent-trust-trusted");
  });

  it("maps blocked to a (muted) token, not an alarm", () => {
    expect(trustAuraClass("blocked")).toBe("agent-trust-blocked");
  });
});

describe("createAgentsController — setPetname (first-person, local)", () => {
  it("writes the trimmed petname via the adapter, then refreshes Known", async () => {
    const calls: Array<[string, string | undefined]> = [];
    let listed = 0;
    const ctrl = createAgentsController(
      makeAdapter({
        listTrustedAgents: async () => {
          listed++;
          return [];
        },
        setPetname: async (id, pn) => {
          calls.push([id, pn]);
        },
      }),
    );
    await ctrl.setPetname("remote-1", "  Scout  ");
    expect(calls).toEqual([["remote-1", "Scout"]]); // trimmed
    expect(listed).toBeGreaterThan(0); // refreshed after write
    ctrl.dispose();
  });

  it("clears the petname when given empty/whitespace", async () => {
    const seen: Array<string | undefined> = [];
    const ctrl = createAgentsController(
      makeAdapter({
        setPetname: async (_id, pn) => {
          seen.push(pn);
        },
      }),
    );
    await ctrl.setPetname("remote-1", "   ");
    expect(seen).toEqual([undefined]); // empty ⇒ clear
    ctrl.dispose();
  });

  it("no-ops when the adapter does not support setPetname", async () => {
    const ctrl = createAgentsController(makeAdapter()); // no setPetname method
    await expect(ctrl.setPetname("remote-1", "Scout")).resolves.toBeUndefined();
    ctrl.dispose();
  });
});

const PEER: AgentPeerEconomics = {
  peer_id: "peer-1",
  earned_micro: 3_000_000,
  paid_micro: 500_000,
  net_micro: 2_500_000,
  fee_micro: 25_000,
  settled_count: 3,
  p2p_count: 2,
  first_at: 100,
  last_at: 300,
};

const SUMMARY: AgentEconomicSummary = {
  motebit_id: "me",
  peers: [PEER],
  unattributed: { earned_micro: 0, fee_micro: 0, settled_count: 0 },
};

describe("formatPeerEconomics", () => {
  it("renders net positive dollars + plural settlement count", () => {
    expect(formatPeerEconomics(PEER)).toBe("net +$2.50 · 3 settlements");
  });

  it("renders net negative (net payer) with a singular count", () => {
    expect(formatPeerEconomics({ ...PEER, net_micro: -500_000, settled_count: 1 })).toBe(
      "net -$0.50 · 1 settlement",
    );
  });

  it("is honest-empty (null) with no settled history — never a fabricated $0", () => {
    expect(formatPeerEconomics(undefined)).toBeNull();
    expect(formatPeerEconomics({ ...PEER, settled_count: 0 })).toBeNull();
  });
});

describe("economicForPeer", () => {
  it("returns the peer slice by id, undefined when absent or summary null", () => {
    expect(economicForPeer(SUMMARY, "peer-1")).toBe(PEER);
    expect(economicForPeer(SUMMARY, "nobody")).toBeUndefined();
    expect(economicForPeer(null, "peer-1")).toBeUndefined();
  });
});

describe("createAgentsController — refreshEconomic", () => {
  it("patches the fetched summary into state", async () => {
    const ctrl = createAgentsController(
      makeAdapter({ listSettlementSummary: async () => SUMMARY }),
    );
    await ctrl.refreshEconomic();
    expect(ctrl.getState().economic).toEqual(SUMMARY);
    ctrl.dispose();
  });

  it("no-ops when the adapter does not support it (state stays null)", async () => {
    const ctrl = createAgentsController(makeAdapter());
    await ctrl.refreshEconomic();
    expect(ctrl.getState().economic).toBeNull();
    ctrl.dispose();
  });

  it("fails soft — a fetch/verification error leaves prior state intact, no error banner", async () => {
    const ctrl = createAgentsController(
      makeAdapter({
        listSettlementSummary: async () => {
          throw new Error("relay unreachable");
        },
      }),
    );
    await ctrl.refreshEconomic();
    expect(ctrl.getState().economic).toBeNull();
    expect(ctrl.getState().error).toBeNull(); // additive, not load-bearing
    ctrl.dispose();
  });
});
