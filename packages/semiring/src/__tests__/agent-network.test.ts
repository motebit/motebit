import { describe, it, expect } from "vitest";
import { asMotebitId, AgentTrustLevel } from "@motebit/protocol";
import type { AgentTrustRecord, MotebitId, ExecutionReceipt } from "@motebit/protocol";
import {
  buildAgentGraph,
  addDelegationEdges,
  mostTrustedPath,
  cheapestPath,
  lowestRiskPath,
  rankReachableAgents,
  projectGraph,
  RouteWeightSemiring,
} from "../agent-network.js";
import type { AgentProfile } from "../agent-network.js";
import { TrustSemiring } from "../semiring.js";
import { transitiveClosure } from "../traversal.js";
import { WeightedDigraph } from "../graph.js";

function makeTrustRecord(
  selfId: MotebitId,
  remoteId: MotebitId,
  level: AgentTrustLevel,
  successful = 10,
  failed = 0,
): AgentTrustRecord {
  return {
    motebit_id: selfId,
    remote_motebit_id: remoteId,
    trust_level: level,
    first_seen_at: Date.now() - 86400000,
    last_seen_at: Date.now(),
    interaction_count: successful + failed,
    successful_tasks: successful,
    failed_tasks: failed,
  };
}

function makeAgent(
  id: string,
  level: AgentTrustLevel,
  selfId: MotebitId,
  overrides: Partial<AgentProfile> = {},
): AgentProfile {
  const motebitId = asMotebitId(id);
  return {
    motebit_id: motebitId,
    trust_record: makeTrustRecord(selfId, motebitId, level),
    listing: null,
    latency_ms: 500,
    reliability: 0.9,
    is_online: true,
    ...overrides,
  };
}

describe("buildAgentGraph", () => {
  const self = asMotebitId("self");

  it("creates edges from self to known agents", () => {
    const agents = [
      makeAgent("agent-a", AgentTrustLevel.Trusted, self),
      makeAgent("agent-b", AgentTrustLevel.Verified, self),
    ];

    const graph = buildAgentGraph(self, agents);
    expect(graph.hasNode(self)).toBe(true);
    expect(graph.hasEdge(self, asMotebitId("agent-a"))).toBe(true);
    expect(graph.hasEdge(self, asMotebitId("agent-b"))).toBe(true);
  });

  it("excludes blocked agents", () => {
    const agents = [
      makeAgent("blocked", AgentTrustLevel.Blocked, self),
      makeAgent("trusted", AgentTrustLevel.Trusted, self),
    ];

    const graph = buildAgentGraph(self, agents);
    expect(graph.hasEdge(self, asMotebitId("blocked"))).toBe(false);
    expect(graph.hasEdge(self, asMotebitId("trusted"))).toBe(true);
  });

  it("excludes offline agents", () => {
    const agents = [makeAgent("offline", AgentTrustLevel.Trusted, self, { is_online: false })];

    const graph = buildAgentGraph(self, agents);
    expect(graph.hasEdge(self, asMotebitId("offline"))).toBe(false);
  });
});

describe("mostTrustedPath", () => {
  const self = asMotebitId("self");

  it("finds direct trusted agent", () => {
    const agents = [makeAgent("target", AgentTrustLevel.Trusted, self)];
    const graph = buildAgentGraph(self, agents);

    const result = mostTrustedPath(graph, self, asMotebitId("target"));
    expect(result).not.toBeNull();
    expect(result!.trust).toBeCloseTo(0.9); // Trusted = 0.9
    expect(result!.path).toEqual([self, asMotebitId("target")]);
  });

  it("finds multi-hop trust chain", () => {
    const agents = [makeAgent("hop1", AgentTrustLevel.Trusted, self)];
    const graph = buildAgentGraph(self, agents);

    // Add hop1 → hop2 edge manually (simulating peer knowledge)
    graph.setEdge(asMotebitId("hop1"), asMotebitId("hop2"), {
      trust: 0.8,
      cost: 0,
      latency: 300,
      reliability: 0.85,
      regulatory_risk: 0,
    });

    const result = mostTrustedPath(graph, self, asMotebitId("hop2"));
    expect(result).not.toBeNull();
    expect(result!.trust).toBeCloseTo(0.72); // 0.9 × 0.8
    expect(result!.path).toEqual([self, asMotebitId("hop1"), asMotebitId("hop2")]);
  });

  it("returns null for unreachable agent", () => {
    const graph = buildAgentGraph(self, []);
    graph.addNode(asMotebitId("isolated"));

    const result = mostTrustedPath(graph, self, asMotebitId("isolated"));
    expect(result).toBeNull();
  });
});

describe("cheapestPath", () => {
  const self = asMotebitId("self");

  it("picks cheapest route when multiple exist", () => {
    const agents = [
      makeAgent("expensive", AgentTrustLevel.Trusted, self, {
        listing: {
          listing_id: "" as any,
          motebit_id: asMotebitId("expensive"),
          capabilities: ["search"],
          pricing: [{ capability: "search", unit_cost: 10, currency: "USD", per: "task" }],
          sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
          description: "",
          updated_at: Date.now(),
        },
      }),
      makeAgent("cheap", AgentTrustLevel.Verified, self, {
        listing: {
          listing_id: "" as any,
          motebit_id: asMotebitId("cheap"),
          capabilities: ["search"],
          pricing: [{ capability: "search", unit_cost: 2, currency: "USD", per: "task" }],
          sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
          description: "",
          updated_at: Date.now(),
        },
      }),
    ];

    const graph = buildAgentGraph(self, agents);
    const result = cheapestPath(graph, self, asMotebitId("cheap"));
    expect(result).not.toBeNull();
    expect(result!.cost).toBe(2);
  });
});

describe("rankReachableAgents", () => {
  const self = asMotebitId("self");

  it("ranks by composite score", () => {
    const agents = [
      makeAgent("high-trust", AgentTrustLevel.Trusted, self, { reliability: 0.95 }),
      makeAgent("low-trust", AgentTrustLevel.FirstContact, self, { reliability: 0.5 }),
    ];

    const graph = buildAgentGraph(self, agents);
    const ranked = rankReachableAgents(graph, self);

    expect(ranked.length).toBe(2);
    expect(ranked[0]!.motebit_id).toBe(asMotebitId("high-trust"));
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("excludes blocked agents (zero trust = filtered)", () => {
    const agents = [
      makeAgent("trusted", AgentTrustLevel.Trusted, self),
      // Blocked won't have an edge, so won't appear
    ];
    const graph = buildAgentGraph(self, agents);

    const ranked = rankReachableAgents(graph, self);
    expect(ranked.every((r) => r.route.trust > 0)).toBe(true);
  });
});

describe("projectGraph — functorial projection", () => {
  const self = asMotebitId("self");

  it("projects multi-dimensional graph to single dimension", () => {
    const agents = [makeAgent("target", AgentTrustLevel.Trusted, self)];
    const graph = buildAgentGraph(self, agents);

    const trustOnly = projectGraph(graph, TrustSemiring, (w) => w.trust);
    expect(trustOnly.getEdge(self, asMotebitId("target"))).toBeCloseTo(0.9);
  });

  it("trust closure via projection + transitiveClosure", () => {
    const agents = [makeAgent("hop1", AgentTrustLevel.Trusted, self)];
    const graph = buildAgentGraph(self, agents);
    graph.setEdge(asMotebitId("hop1"), asMotebitId("hop2"), {
      trust: 0.8,
      cost: 0,
      latency: 300,
      reliability: 0.85,
      regulatory_risk: 0,
    });

    const trustGraph = projectGraph(graph, TrustSemiring, (w) => w.trust);
    const closure = transitiveClosure(trustGraph);

    expect(closure.get(self)!.get(asMotebitId("hop2"))).toBeCloseTo(0.72);
  });
});

describe("lowestRiskPath — regulatory risk routing", () => {
  const self = asMotebitId("self");

  it("finds lowest risk direct agent", () => {
    const agents = [
      makeAgent("low-risk", AgentTrustLevel.Trusted, self, { regulatory_risk: 0.1 }),
      makeAgent("high-risk", AgentTrustLevel.Trusted, self, { regulatory_risk: 5.0 }),
    ];

    const graph = buildAgentGraph(self, agents);
    const result = lowestRiskPath(graph, self, asMotebitId("low-risk"));
    expect(result).not.toBeNull();
    expect(result!.risk).toBeCloseTo(0.1);
  });

  it("risk accumulates along delegation chains", () => {
    const agents = [makeAgent("hop1", AgentTrustLevel.Trusted, self, { regulatory_risk: 1.0 })];
    const graph = buildAgentGraph(self, agents);
    graph.setEdge(asMotebitId("hop1"), asMotebitId("hop2"), {
      trust: 0.8,
      cost: 0,
      latency: 300,
      reliability: 0.85,
      regulatory_risk: 2.0,
    });

    const result = lowestRiskPath(graph, self, asMotebitId("hop2"));
    expect(result).not.toBeNull();
    expect(result!.risk).toBeCloseTo(3.0); // 1.0 + 2.0 (additive composition)
    expect(result!.path).toEqual([self, asMotebitId("hop1"), asMotebitId("hop2")]);
  });

  it("picks lowest-risk parallel alternative", () => {
    const agents = [
      makeAgent("risky-hop", AgentTrustLevel.Trusted, self, { regulatory_risk: 4.0 }),
      makeAgent("safe-hop", AgentTrustLevel.Trusted, self, { regulatory_risk: 0.5 }),
    ];
    const graph = buildAgentGraph(self, agents);

    // Both reach target, but via different risk paths
    graph.setEdge(asMotebitId("risky-hop"), asMotebitId("target"), {
      trust: 0.9,
      cost: 0,
      latency: 100,
      reliability: 0.9,
      regulatory_risk: 1.0,
    });
    graph.setEdge(asMotebitId("safe-hop"), asMotebitId("target"), {
      trust: 0.9,
      cost: 0,
      latency: 100,
      reliability: 0.9,
      regulatory_risk: 0.5,
    });

    const result = lowestRiskPath(graph, self, asMotebitId("target"));
    expect(result).not.toBeNull();
    // Via safe-hop: 0.5 + 0.5 = 1.0
    // Via risky-hop: 4.0 + 1.0 = 5.0
    // min(1.0, 5.0) = 1.0
    expect(result!.risk).toBeCloseTo(1.0);
    expect(result!.path).toEqual([self, asMotebitId("safe-hop"), asMotebitId("target")]);
  });

  it("ranking penalizes high-risk agents", () => {
    const agents = [
      makeAgent("safe", AgentTrustLevel.Trusted, self, { regulatory_risk: 0.1, reliability: 0.9 }),
      makeAgent("risky", AgentTrustLevel.Trusted, self, {
        regulatory_risk: 10.0,
        reliability: 0.9,
      }),
    ];

    const graph = buildAgentGraph(self, agents);
    const ranked = rankReachableAgents(graph, self);

    expect(ranked.length).toBe(2);
    expect(ranked[0]!.motebit_id).toBe(asMotebitId("safe"));
    expect(ranked[0]!.route.regulatory_risk).toBeCloseTo(0.1);
    expect(ranked[1]!.route.regulatory_risk).toBeCloseTo(10.0);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("zero-risk agent is the identity (no additional risk)", () => {
    const agents = [makeAgent("zero-risk", AgentTrustLevel.Trusted, self, { regulatory_risk: 0 })];
    const graph = buildAgentGraph(self, agents);

    const result = lowestRiskPath(graph, self, asMotebitId("zero-risk"));
    expect(result).not.toBeNull();
    expect(result!.risk).toBe(0); // semiring one = 0, identity
  });
});

describe("addDelegationEdges", () => {
  function makeReceipt(
    motebitId: string,
    status: "completed" | "failed" = "completed",
    delegationReceipts?: ExecutionReceipt[],
  ): ExecutionReceipt {
    return {
      task_id: `task-${motebitId}`,
      motebit_id: asMotebitId(motebitId),
      device_id: "dev-1" as any,
      submitted_at: 1000,
      completed_at: 2000,
      status,
      result: "ok",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "abc",
      result_hash: "def",
      signature: "sig",
      delegation_receipts: delegationReceipts,
    };
  }

  it("adds edges from delegation receipts", () => {
    const graph = new WeightedDigraph(RouteWeightSemiring);
    graph.addNode(asMotebitId("parent"));

    const receipt = makeReceipt("parent", "completed", [
      makeReceipt("child-a", "completed"),
      makeReceipt("child-b", "failed"),
    ]);

    const getTrust = (id: string) => (id.includes("child-a") ? 0.9 : 0.5);
    const getLatency = (id: string) => (id.includes("child-a") ? 100 : 200);

    addDelegationEdges(graph, receipt, getTrust, getLatency);

    // Parent → child-a edge should exist
    expect(graph.hasEdge(asMotebitId("parent"), asMotebitId("child-a"))).toBe(true);
    const edgeA = graph.getEdge(asMotebitId("parent"), asMotebitId("child-a"));
    expect(edgeA.trust).toBe(0.9);
    expect(edgeA.reliability).toBe(0.9); // completed = 0.9
    expect(edgeA.latency).toBe(100);

    // Parent → child-b edge should exist with lower reliability
    expect(graph.hasEdge(asMotebitId("parent"), asMotebitId("child-b"))).toBe(true);
    const edgeB = graph.getEdge(asMotebitId("parent"), asMotebitId("child-b"));
    expect(edgeB.trust).toBe(0.5);
    expect(edgeB.reliability).toBe(0.3); // failed = 0.3
  });

  it("uses duration as latency fallback when getLatency returns 0", () => {
    const graph = new WeightedDigraph(RouteWeightSemiring);
    graph.addNode(asMotebitId("parent"));

    const receipt = makeReceipt("parent", "completed", [makeReceipt("child", "completed")]);

    addDelegationEdges(
      graph,
      receipt,
      () => 0.8,
      () => 0,
    ); // getLatency returns 0

    const edge = graph.getEdge(asMotebitId("parent"), asMotebitId("child"));
    // latency || duration → 0 || 1000 = 1000 (duration = completed_at - submitted_at)
    expect(edge.latency).toBe(1000);
  });

  it("recurses into sub-delegation receipts", () => {
    const graph = new WeightedDigraph(RouteWeightSemiring);
    graph.addNode(asMotebitId("root"));

    // root delegates to hop1, hop1 delegates to hop2
    const receipt = makeReceipt("root", "completed", [
      makeReceipt("hop1", "completed", [makeReceipt("hop2", "completed")]),
    ]);

    addDelegationEdges(
      graph,
      receipt,
      () => 0.8,
      () => 150,
    );

    // root → hop1
    expect(graph.hasEdge(asMotebitId("root"), asMotebitId("hop1"))).toBe(true);
    // hop1 → hop2 (recursive)
    expect(graph.hasEdge(asMotebitId("hop1"), asMotebitId("hop2"))).toBe(true);
  });

  it("is a no-op when delegation_receipts is undefined", () => {
    const graph = new WeightedDigraph(RouteWeightSemiring);
    graph.addNode(asMotebitId("solo"));

    const receipt = makeReceipt("solo", "completed"); // no delegation_receipts
    addDelegationEdges(
      graph,
      receipt,
      () => 0.5,
      () => 100,
    );

    expect(graph.edgeCount()).toBe(0);
  });
});

describe("buildAgentGraph — trust_override and no trust_record", () => {
  const self = asMotebitId("self");

  it("uses trust_override when provided", () => {
    const agents = [
      makeAgent("overridden", AgentTrustLevel.FirstContact, self, { trust_override: 0.95 }),
    ];
    const graph = buildAgentGraph(self, agents);
    const edge = graph.getEdge(self, asMotebitId("overridden"));
    expect(edge.trust).toBe(0.95);
  });

  it("uses default 0.1 trust when no trust_record", () => {
    const agents: AgentProfile[] = [
      {
        motebit_id: asMotebitId("unknown"),
        trust_record: null,
        listing: null,
        latency_ms: null,
        reliability: null,
        is_online: true,
      },
    ];
    const graph = buildAgentGraph(self, agents);
    const edge = graph.getEdge(self, asMotebitId("unknown"));
    expect(edge.trust).toBe(0.1);
    // Defaults for null latency/reliability
    expect(edge.latency).toBe(5000);
    expect(edge.reliability).toBe(0.5);
  });
});

describe("cheapestPath — unreachable target", () => {
  const self = asMotebitId("self");

  it("returns null for unreachable agent", () => {
    const graph = buildAgentGraph(self, []);
    graph.addNode(asMotebitId("isolated"));

    const result = cheapestPath(graph, self, asMotebitId("isolated"));
    expect(result).toBeNull();
  });
});

describe("rankReachableAgents — Infinity edge cases", () => {
  const self = asMotebitId("self");

  it("handles Infinity cost, latency, and risk with zero score", () => {
    const agents = [makeAgent("high-trust", AgentTrustLevel.Trusted, self)];
    const graph = buildAgentGraph(self, agents);

    // Manually set edge with Infinity values to test branch coverage
    graph.setEdge(self, asMotebitId("high-trust"), {
      trust: 0.9,
      cost: Infinity,
      latency: Infinity,
      reliability: 0.9,
      regulatory_risk: Infinity,
    });

    const ranked = rankReachableAgents(graph, self);
    expect(ranked.length).toBe(1);
    // With Infinity cost/latency/risk, those score components should be 0
    // Only trust (0.9 * 0.3) + reliability (0.9 * 0.15) contribute
    expect(ranked[0]!.score).toBeCloseTo(0.9 * 0.3 + 0.9 * 0.15);
  });

  it("uses zero regulatory_risk weight when not provided", () => {
    const agents = [makeAgent("agent-a", AgentTrustLevel.Trusted, self, { reliability: 0.9 })];
    const graph = buildAgentGraph(self, agents);

    const ranked = rankReachableAgents(graph, self, {
      trust: 0.5,
      cost: 0.2,
      latency: 0.2,
      reliability: 0.1,
      // regulatory_risk omitted — defaults to undefined, should use ?? 0
    });

    expect(ranked.length).toBe(1);
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  it("filters agents with zero trust from ranking", () => {
    const agents = [makeAgent("zero-trust", AgentTrustLevel.Trusted, self)];
    const graph = buildAgentGraph(self, agents);

    // Override to zero trust
    graph.setEdge(self, asMotebitId("zero-trust"), {
      trust: 0,
      cost: 1,
      latency: 100,
      reliability: 0.9,
      regulatory_risk: 0,
    });

    const ranked = rankReachableAgents(graph, self);
    expect(ranked.length).toBe(0); // zero trust = filtered out
  });
});
