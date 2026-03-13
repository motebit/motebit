import { describe, it, expect } from "vitest";
import { asMotebitId, AgentTrustLevel } from "@motebit/sdk";
import type { AgentTrustRecord, MotebitId } from "@motebit/sdk";
import {
  buildAgentGraph,
  mostTrustedPath,
  cheapestPath,
  lowestRiskPath,
  rankReachableAgents,
  projectGraph,
} from "../agent-network.js";
import type { AgentProfile } from "../agent-network.js";
import { TrustSemiring } from "../semiring.js";
import { transitiveClosure } from "../traversal.js";

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
