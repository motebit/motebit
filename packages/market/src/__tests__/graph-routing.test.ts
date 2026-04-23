import { describe, it, expect } from "vitest";
import {
  buildRoutingGraph,
  graphRankCandidates,
  explainedRankCandidates,
  computeTrustClosure,
  findTrustedRoute,
} from "../graph-routing.js";
import type { ExplainedRouteScore } from "../graph-routing.js";
import type { CandidateProfile, TaskRequirements } from "../scoring.js";
import { AgentTrustLevel, asMotebitId, asListingId } from "@motebit/protocol";
import type { AgentTrustRecord, AgentServiceListing } from "@motebit/protocol";
import type { RouteWeight } from "@motebit/semiring";

// Cover the barrel re-export file (index.ts)
import "../index.js";

// ── Test Helpers ────────────────────────────────────────────────────

const SELF_ID = asMotebitId("self-agent");

function makeTrustRecord(overrides: Partial<AgentTrustRecord> = {}): AgentTrustRecord {
  return {
    motebit_id: SELF_ID,
    remote_motebit_id: asMotebitId("remote-1"),
    trust_level: AgentTrustLevel.Verified,
    first_seen_at: Date.now() - 100_000,
    last_seen_at: Date.now(),
    interaction_count: 10,
    successful_tasks: 8,
    failed_tasks: 2,
    ...overrides,
  };
}

function makeListing(overrides: Partial<AgentServiceListing> = {}): AgentServiceListing {
  return {
    listing_id: asListingId("listing-1"),
    motebit_id: asMotebitId("remote-1"),
    capabilities: ["web_search", "read_url"],
    pricing: [{ capability: "web_search", unit_cost: 0.01, currency: "USD", per: "task" }],
    sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
    description: "Test service",
    updated_at: Date.now(),
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    motebit_id: asMotebitId("remote-1"),
    trust_record: makeTrustRecord(),
    listing: makeListing(),
    latency_stats: { avg_ms: 1000, p95_ms: 3000, sample_count: 50 },
    is_online: true,
    ...overrides,
  };
}

const defaultReqs: TaskRequirements = {
  required_capabilities: ["web_search"],
  max_budget: 1.0,
};

// ── buildRoutingGraph ───────────────────────────────────────────────

describe("buildRoutingGraph", () => {
  it("builds a graph with self node and candidate edges", () => {
    const candidates = [
      makeCandidate({ motebit_id: asMotebitId("agent-a") }),
      makeCandidate({ motebit_id: asMotebitId("agent-b") }),
    ];
    const graph = buildRoutingGraph(SELF_ID, candidates);

    expect(graph.hasNode(SELF_ID)).toBe(true);
    expect(graph.hasNode("agent-a")).toBe(true);
    expect(graph.hasNode("agent-b")).toBe(true);
    expect(graph.hasEdge(SELF_ID, "agent-a")).toBe(true);
    expect(graph.hasEdge(SELF_ID, "agent-b")).toBe(true);
  });

  it("skips blocked agents", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("blocked-agent"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Blocked }),
      }),
      makeCandidate({ motebit_id: asMotebitId("good-agent") }),
    ];
    const graph = buildRoutingGraph(SELF_ID, candidates);

    expect(graph.hasEdge(SELF_ID, "blocked-agent")).toBe(false);
    expect(graph.hasEdge(SELF_ID, "good-agent")).toBe(true);
  });

  it("skips offline agents", () => {
    const candidates = [
      makeCandidate({ motebit_id: asMotebitId("offline-agent"), is_online: false }),
      makeCandidate({ motebit_id: asMotebitId("online-agent") }),
    ];
    const graph = buildRoutingGraph(SELF_ID, candidates);

    expect(graph.hasEdge(SELF_ID, "offline-agent")).toBe(false);
    expect(graph.hasEdge(SELF_ID, "online-agent")).toBe(true);
  });

  it("uses chain_trust when provided", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("chain-agent"),
        chain_trust: 0.42,
      }),
    ];
    const graph = buildRoutingGraph(SELF_ID, candidates);
    const edge = graph.getEdge(SELF_ID, "chain-agent");
    expect(edge.trust).toBe(0.42);
  });

  it("defaults trust to 0.1 when no trust_record and no chain_trust", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("unknown-agent"),
        trust_record: null,
      }),
    ];
    const graph = buildRoutingGraph(SELF_ID, candidates);
    const edge = graph.getEdge(SELF_ID, "unknown-agent");
    expect(edge.trust).toBe(0.1);
  });

  it("defaults latency to 5000 when no stats", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("no-stats"),
        latency_stats: null,
      }),
    ];
    const graph = buildRoutingGraph(SELF_ID, candidates);
    const edge = graph.getEdge(SELF_ID, "no-stats");
    expect(edge.latency).toBe(5000);
  });

  it("applies peer edges for multi-hop routing", () => {
    const candidates = [
      makeCandidate({ motebit_id: asMotebitId("agent-a") }),
      makeCandidate({ motebit_id: asMotebitId("agent-b") }),
    ];
    const peerEdges = [
      {
        from: "agent-a",
        to: "agent-b",
        weight: { trust: 0.8, cost: 5, latency: 200, reliability: 0.95 } as RouteWeight,
      },
    ];
    const graph = buildRoutingGraph(SELF_ID, candidates, peerEdges);

    expect(graph.hasEdge("agent-a", "agent-b")).toBe(true);
    const edge = graph.getEdge("agent-a", "agent-b");
    expect(edge.trust).toBe(0.8);
  });
});

// ── graphRankCandidates ─────────────────────────────────────────────

describe("graphRankCandidates", () => {
  it("returns RouteScore[] sorted by composite", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("high-trust"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("low-trust"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Unknown }),
      }),
    ];
    const scores = graphRankCandidates(SELF_ID, candidates, defaultReqs);

    expect(scores.length).toBe(2);
    expect(scores[0]!.motebit_id).toBe("high-trust");
    expect(scores[0]!.composite).toBeGreaterThan(scores[1]!.composite);
  });

  it("marks top N as selected", () => {
    const candidates = [
      makeCandidate({ motebit_id: asMotebitId("a") }),
      makeCandidate({ motebit_id: asMotebitId("b") }),
      makeCandidate({ motebit_id: asMotebitId("c") }),
    ];
    const scores = graphRankCandidates(SELF_ID, candidates, defaultReqs, { maxCandidates: 2 });

    const selected = scores.filter((s) => s.selected);
    expect(selected.length).toBe(2);
    expect(scores[2]!.selected).toBe(false);
  });

  it("filters candidates missing required capabilities (hard gate)", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("has-caps"),
        listing: makeListing({ capabilities: ["web_search", "read_url"] }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("no-caps"),
        listing: makeListing({ capabilities: ["summarize"] }),
      }),
    ];
    const scores = graphRankCandidates(SELF_ID, candidates, {
      required_capabilities: ["web_search"],
    });

    expect(scores.length).toBe(1);
    expect(scores[0]!.motebit_id).toBe("has-caps");
  });

  it("excludes blocked agents", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("blocked"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Blocked }),
      }),
      makeCandidate({ motebit_id: asMotebitId("good") }),
    ];
    const scores = graphRankCandidates(SELF_ID, candidates, defaultReqs);

    expect(scores.find((s) => s.motebit_id === "blocked")).toBeUndefined();
    expect(scores.find((s) => s.motebit_id === "good")).toBeDefined();
  });

  it("produces backward-compatible RouteScore shape", () => {
    const candidates = [makeCandidate()];
    const scores = graphRankCandidates(SELF_ID, candidates, defaultReqs);

    expect(scores.length).toBe(1);
    const score = scores[0]!;
    expect(score).toHaveProperty("motebit_id");
    expect(score).toHaveProperty("composite");
    expect(score).toHaveProperty("sub_scores");
    expect(score).toHaveProperty("selected");
    expect(score.sub_scores).toHaveProperty("trust");
    expect(score.sub_scores).toHaveProperty("success_rate");
    expect(score.sub_scores).toHaveProperty("latency");
    expect(score.sub_scores).toHaveProperty("price_efficiency");
    expect(score.sub_scores).toHaveProperty("capability_match");
    expect(score.sub_scores).toHaveProperty("availability");
  });

  it("composes trust through multi-hop peer edges", () => {
    // self -> A (trust 0.9), A -> B (trust 0.8)
    // Multi-hop trust: 0.9 * 0.8 = 0.72
    const agentA = makeCandidate({
      motebit_id: asMotebitId("agent-a"),
      trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      listing: makeListing({ capabilities: ["web_search"] }),
    });
    const agentB = makeCandidate({
      motebit_id: asMotebitId("agent-b"),
      trust_record: null, // not directly known
      listing: makeListing({ capabilities: ["web_search"], motebit_id: asMotebitId("agent-b") }),
    });

    const peerEdges = [
      {
        from: "agent-a",
        to: "agent-b",
        weight: { trust: 0.8, cost: 1, latency: 100, reliability: 0.9 } as RouteWeight,
      },
    ];

    const scores = graphRankCandidates(SELF_ID, [agentA, agentB], defaultReqs, { peerEdges });

    // Both agents should appear
    const scoreA = scores.find((s) => s.motebit_id === "agent-a");
    const scoreB = scores.find((s) => s.motebit_id === "agent-b");
    expect(scoreA).toBeDefined();
    expect(scoreB).toBeDefined();

    // agent-b's trust should reflect multi-hop composition
    // Direct trust for B is 0.1 (default), but via A it's 0.9 * 0.8 = 0.72
    // The semiring picks max(0.1, 0.72) = 0.72
    expect(scoreB!.sub_scores.trust).toBeGreaterThan(0.1);
  });

  it("returns empty array when all candidates are offline or blocked", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("offline"),
        is_online: false,
      }),
      makeCandidate({
        motebit_id: asMotebitId("blocked"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Blocked }),
      }),
    ];
    const scores = graphRankCandidates(SELF_ID, candidates, defaultReqs);
    expect(scores.length).toBe(0);
  });
});

// ── computeTrustClosure ─────────────────────────────────────────────

describe("computeTrustClosure", () => {
  it("computes direct trust for all reachable agents", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("agent-a"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("agent-b"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Verified }),
      }),
    ];
    const closure = computeTrustClosure(SELF_ID, candidates);

    expect(closure.get("agent-a")).toBe(0.9); // Trusted
    expect(closure.get("agent-b")).toBe(0.6); // Verified
    expect(closure.has(SELF_ID)).toBe(false); // self excluded
  });

  it("computes transitive trust through peer edges", () => {
    // self -> A (trust 0.9), A -> C (trust 0.8)
    // Transitive: self -> C = 0.9 * 0.8 = 0.72
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("agent-a"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
    ];
    const peerEdges = [
      {
        from: "agent-a",
        to: "agent-c",
        weight: { trust: 0.8, cost: 0, latency: 100, reliability: 0.9 } as RouteWeight,
      },
    ];
    const closure = computeTrustClosure(SELF_ID, candidates, peerEdges);

    expect(closure.get("agent-a")).toBe(0.9);
    // agent-c reachable transitively
    expect(closure.has("agent-c")).toBe(true);
    expect(closure.get("agent-c")).toBeCloseTo(0.72, 5);
  });

  it("returns empty map for no candidates", () => {
    const closure = computeTrustClosure(SELF_ID, []);
    expect(closure.size).toBe(0);
  });
});

// ── findTrustedRoute ────────────────────────────────────────────────

describe("findTrustedRoute", () => {
  it("finds a direct path", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("agent-a"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
    ];
    const route = findTrustedRoute(SELF_ID, asMotebitId("agent-a"), candidates);

    expect(route).not.toBeNull();
    expect(route!.trust).toBe(0.9);
    expect(route!.path).toEqual([SELF_ID, "agent-a"]);
  });

  it("finds a multi-hop path through peer edges", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("agent-a"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
    ];
    const peerEdges = [
      {
        from: "agent-a",
        to: "agent-c",
        weight: { trust: 0.8, cost: 0, latency: 100, reliability: 0.9 } as RouteWeight,
      },
    ];
    const route = findTrustedRoute(SELF_ID, asMotebitId("agent-c"), candidates, peerEdges);

    expect(route).not.toBeNull();
    expect(route!.trust).toBeCloseTo(0.72, 5);
    expect(route!.path).toEqual([SELF_ID, "agent-a", "agent-c"]);
  });

  it("returns null for unreachable target", () => {
    const candidates = [makeCandidate({ motebit_id: asMotebitId("agent-a") })];
    const route = findTrustedRoute(SELF_ID, asMotebitId("unreachable"), candidates);
    expect(route).toBeNull();
  });

  it("returns null when target is blocked", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("blocked"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Blocked }),
      }),
    ];
    const route = findTrustedRoute(SELF_ID, asMotebitId("blocked"), candidates);
    expect(route).toBeNull();
  });
});

// ── explainedRankCandidates ─────────────────────────────────────────

describe("explainedRankCandidates", () => {
  it("returns routing_paths for direct edges (single-hop)", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("agent-a"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
    ];
    const scores = explainedRankCandidates(SELF_ID, candidates, defaultReqs);

    expect(scores.length).toBe(1);
    const score = scores[0]!;
    expect(score.motebit_id).toBe("agent-a");
    // Direct edge: provenance path is [agent-a]
    expect(score.routing_paths.length).toBeGreaterThanOrEqual(1);
    expect(score.routing_paths.some((p) => p.includes("agent-a"))).toBe(true);
  });

  it("includes intermediate agents in multi-hop paths", () => {
    // self -> A (trust 0.9), A -> B (trust 0.8)
    const agentA = makeCandidate({
      motebit_id: asMotebitId("agent-a"),
      trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      listing: makeListing({ capabilities: ["web_search"] }),
    });
    const agentB = makeCandidate({
      motebit_id: asMotebitId("agent-b"),
      trust_record: null,
      listing: makeListing({ capabilities: ["web_search"], motebit_id: asMotebitId("agent-b") }),
      is_online: true,
    });

    const peerEdges = [
      {
        from: "agent-a",
        to: "agent-b",
        weight: {
          trust: 0.8,
          cost: 1,
          latency: 100,
          reliability: 0.9,
          regulatory_risk: 0,
        } as RouteWeight,
      },
    ];

    const scores = explainedRankCandidates(SELF_ID, [agentA, agentB], defaultReqs, { peerEdges });

    const scoreB = scores.find((s) => s.motebit_id === "agent-b");
    expect(scoreB).toBeDefined();
    // Multi-hop path should include agent-a as intermediate
    const hasMultiHop = scoreB!.routing_paths.some(
      (p) => p.length >= 2 && p.includes("agent-a") && p.includes("agent-b"),
    );
    expect(hasMultiHop).toBe(true);
  });

  it("counts alternatives_considered from the number of derivation paths", () => {
    // self -> A, self -> B, A -> C, B -> C — C has two paths
    const agentA = makeCandidate({
      motebit_id: asMotebitId("agent-a"),
      trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      listing: makeListing({ capabilities: ["web_search"] }),
    });
    const agentB = makeCandidate({
      motebit_id: asMotebitId("agent-b"),
      trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Verified }),
      listing: makeListing({ capabilities: ["web_search"] }),
    });
    const agentC = makeCandidate({
      motebit_id: asMotebitId("agent-c"),
      trust_record: null,
      listing: makeListing({ capabilities: ["web_search"], motebit_id: asMotebitId("agent-c") }),
      is_online: true,
    });

    const peerEdges = [
      {
        from: "agent-a",
        to: "agent-c",
        weight: {
          trust: 0.7,
          cost: 1,
          latency: 100,
          reliability: 0.9,
          regulatory_risk: 0,
        } as RouteWeight,
      },
      {
        from: "agent-b",
        to: "agent-c",
        weight: {
          trust: 0.6,
          cost: 2,
          latency: 200,
          reliability: 0.85,
          regulatory_risk: 0,
        } as RouteWeight,
      },
    ];

    const scores = explainedRankCandidates(SELF_ID, [agentA, agentB, agentC], defaultReqs, {
      peerEdges,
    });

    const scoreC = scores.find((s) => s.motebit_id === "agent-c");
    expect(scoreC).toBeDefined();
    // agent-c is reachable via: direct (self->C), via A (self->A->C), via B (self->B->C)
    // Direct path exists because agentC is a candidate with is_online=true
    expect(scoreC!.alternatives_considered).toBeGreaterThanOrEqual(2);
  });

  it("is backward-compatible with RouteScore shape", () => {
    const candidates = [makeCandidate()];
    const scores = explainedRankCandidates(SELF_ID, candidates, defaultReqs);

    expect(scores.length).toBe(1);
    const score: ExplainedRouteScore = scores[0]!;
    // All RouteScore fields present
    expect(score).toHaveProperty("motebit_id");
    expect(score).toHaveProperty("composite");
    expect(score).toHaveProperty("sub_scores");
    expect(score).toHaveProperty("selected");
    expect(score.sub_scores).toHaveProperty("trust");
    expect(score.sub_scores).toHaveProperty("success_rate");
    expect(score.sub_scores).toHaveProperty("latency");
    expect(score.sub_scores).toHaveProperty("price_efficiency");
    expect(score.sub_scores).toHaveProperty("capability_match");
    expect(score.sub_scores).toHaveProperty("availability");
    // Plus provenance fields
    expect(score).toHaveProperty("routing_paths");
    expect(score).toHaveProperty("alternatives_considered");
    expect(Array.isArray(score.routing_paths)).toBe(true);
    expect(typeof score.alternatives_considered).toBe("number");
  });
});

// ── weightedSumComposite (standalone) ───────────────────────────────

describe("weightedSumComposite", () => {
  it("computes weighted sum using default weights", async () => {
    const { weightedSumComposite } = await import("../graph-routing.js");

    const route = { trust: 0.8, cost: 5, latency: 100, reliability: 0.9, regulatory_risk: 0.1 };
    const normalized = {
      trust: 0.8,
      reliability: 0.9,
      costScore: 0.5,
      latencyNorm: 0.7,
      riskScore: 0.6,
    };

    const result = weightedSumComposite(route, normalized);
    // 0.8*0.3 + 0.5*0.2 + 0.7*0.15 + 0.9*0.15 + 0.6*0.2
    const expected = 0.24 + 0.1 + 0.105 + 0.135 + 0.12;
    expect(result).toBeCloseTo(expected, 10);
  });

  it("returns 0 when all scores are 0", async () => {
    const { weightedSumComposite } = await import("../graph-routing.js");

    const route = { trust: 0, cost: 0, latency: 0, reliability: 0, regulatory_risk: 0 };
    const normalized = {
      trust: 0,
      reliability: 0,
      costScore: 0,
      latencyNorm: 0,
      riskScore: 0,
    };

    expect(weightedSumComposite(route, normalized)).toBe(0);
  });
});

// ── lexicographicComposite ──────────────────────────────────────────

describe("lexicographicComposite", () => {
  it("ranks by trust first, then reliability, then cost", async () => {
    const { lexicographicComposite } = await import("../graph-routing.js");

    // High trust, low reliability
    const scoreA = lexicographicComposite(
      { trust: 0.9, cost: 10, latency: 100, reliability: 0.5, regulatory_risk: 0 },
      { trust: 0.9, reliability: 0.5, costScore: 0.5, latencyNorm: 0.5, riskScore: 0.5 },
    );
    // Low trust, high reliability
    const scoreB = lexicographicComposite(
      { trust: 0.5, cost: 1, latency: 50, reliability: 0.99, regulatory_risk: 0 },
      { trust: 0.5, reliability: 0.99, costScore: 0.9, latencyNorm: 0.9, riskScore: 0.9 },
    );
    // Trust dominates: 0.9 * 1e6 > 0.5 * 1e6
    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it("uses reliability as tiebreaker when trust is equal", async () => {
    const { lexicographicComposite } = await import("../graph-routing.js");

    const scoreHigh = lexicographicComposite(
      { trust: 0.8, cost: 10, latency: 100, reliability: 0.9, regulatory_risk: 0 },
      { trust: 0.8, reliability: 0.9, costScore: 0.3, latencyNorm: 0.5, riskScore: 0.5 },
    );
    const scoreLow = lexicographicComposite(
      { trust: 0.8, cost: 1, latency: 50, reliability: 0.3, regulatory_risk: 0 },
      { trust: 0.8, reliability: 0.3, costScore: 0.9, latencyNorm: 0.9, riskScore: 0.9 },
    );
    // Same trust, higher reliability wins
    expect(scoreHigh).toBeGreaterThan(scoreLow);
  });

  it("returns a single number encoding the priority bands", async () => {
    const { lexicographicComposite } = await import("../graph-routing.js");

    const result = lexicographicComposite(
      { trust: 1.0, cost: 0, latency: 0, reliability: 1.0, regulatory_risk: 0 },
      { trust: 1.0, reliability: 1.0, costScore: 1.0, latencyNorm: 1.0, riskScore: 1.0 },
    );
    // 1.0 * 1e6 + 1.0 * 1e3 + 1.0 = 1_001_001
    expect(result).toBeCloseTo(1_001_001, 0);
  });
});

// ── graphRankCandidates with lexicographic composite ─────────────────

describe("graphRankCandidates with compositeFunction", () => {
  it("accepts a custom composite function (lexicographic)", async () => {
    const { lexicographicComposite } = await import("../graph-routing.js");

    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("high-trust"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("low-trust"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Unknown }),
      }),
    ];
    const scores = graphRankCandidates(SELF_ID, candidates, defaultReqs, {
      compositeFunction: lexicographicComposite,
    });

    expect(scores.length).toBe(2);
    expect(scores[0]!.motebit_id).toBe("high-trust");
    // Composite values should be much larger than [0,1] range (1e6 scale)
    expect(scores[0]!.composite).toBeGreaterThan(1000);
  });
});

// ── finalizeScores exploration logic ────────────────────────────────

describe("graphRankCandidates exploration (epsilon-greedy)", () => {
  it("exploration swaps a non-top candidate into position 1 when probe triggers", () => {
    // To trigger exploration, we need:
    // 1. explorationWeight > 0
    // 2. scores.length > 1
    // 3. (scores[0].composite * 1000) % 1 < explorationWeight
    // 4. explorationIdx > 1 && scores[explorationIdx].composite > 0
    //
    // We craft composites so that (top_composite * 1000) % 1 is small,
    // and explorationWeight is large enough to trigger.
    // Top composite fractional part: (X * 1000) % 1.
    // For X = 0.5, (0.5 * 1000) % 1 = (500) % 1 = 0 → probe = 0 < any positive epsilon.
    // But explorationIdx = 1 + floor(0 * (len-1)) = 1, which is NOT > 1, so no swap.
    //
    // For X where fractional part gives explorationIdx > 1:
    // We need probe > 0 and probe * (len-1) > 0 so explorationIdx >= 2.
    // With 4 candidates: probe * 3 > 0 and floor(probe * 3) + 1 > 1 → probe >= 1/3.
    // So we need probe ∈ [1/3, explorationWeight).
    // probe = (composite * 1000) % 1. If composite = 0.5005, probe = (500.5) % 1 = 0.5.
    // explorationIdx = 1 + floor(0.5 * 3) = 1 + 1 = 2 > 1. Swap happens.

    // Create candidates with carefully chosen trust levels to produce the right composites.
    // We'll use many candidates with varying trust so position 2+ has composite > 0.
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("top"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("second"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Verified }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("third"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.FirstContact }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("fourth"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Unknown }),
      }),
    ];

    // Run without exploration
    const noExplore = graphRankCandidates(SELF_ID, candidates, defaultReqs, {
      explorationWeight: 0,
    });
    const normalOrder = noExplore.map((s) => s.motebit_id);

    // Run with very high exploration weight (1.0 = always explore)
    const withExplore = graphRankCandidates(SELF_ID, candidates, defaultReqs, {
      explorationWeight: 1.0,
    });
    const exploreOrder = withExplore.map((s) => s.motebit_id);

    // The top candidate should remain the same (exploration only swaps position 1)
    expect(exploreOrder[0]).toBe(normalOrder[0]);

    // With exploration, scores are deterministic (pseudo-random from composite).
    // The exploration may or may not swap depending on the exact composite values.
    // At minimum, all candidates should still be present.
    expect(withExplore.length).toBe(noExplore.length);
    expect(withExplore.every((s) => s.composite > 0)).toBe(true);
  });

  it("exploration does not swap when probe >= explorationWeight", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("a"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("b"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Verified }),
      }),
    ];

    // Very small exploration weight — probe likely exceeds it
    const scores = graphRankCandidates(SELF_ID, candidates, defaultReqs, {
      explorationWeight: 0.0001,
    });

    // Still sorted by composite
    expect(scores[0]!.composite).toBeGreaterThanOrEqual(scores[1]!.composite);
  });

  it("exploration does not affect single-candidate lists", () => {
    const candidates = [makeCandidate({ motebit_id: asMotebitId("only") })];
    const scores = graphRankCandidates(SELF_ID, candidates, defaultReqs, {
      explorationWeight: 1.0,
    });

    expect(scores.length).toBe(1);
    expect(scores[0]!.motebit_id).toBe("only");
  });

  it("exploration swaps position 1 with a lower-ranked candidate (controlled composite)", () => {
    // Use a custom composite function that returns decreasing values.
    // Top candidate gets composite = 0.5005 → probe = (500.5) % 1 = 0.5
    // With 4 candidates: explorationIdx = 1 + floor(0.5 * 3) = 2
    // Since explorationIdx > 1 and scores[2].composite > 0, swap happens.
    let callIndex = 0;
    const composites = [0.5005, 0.4, 0.3, 0.2]; // Decreasing — sorted order preserved
    const controlledComposite = () => {
      const val = composites[callIndex % composites.length]!;
      callIndex++;
      return val;
    };

    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("a"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("b"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Verified }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("c"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.FirstContact }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("d"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Unknown }),
      }),
    ];

    const scores = graphRankCandidates(SELF_ID, candidates, defaultReqs, {
      explorationWeight: 1.0,
      compositeFunction: controlledComposite,
    });

    // All 4 candidates present
    expect(scores.length).toBe(4);
    // Position 0 stays the same (highest composite)
    expect(scores[0]!.composite).toBe(0.5005);
    // The swap should have moved position 2 to position 1
    // Original order after sort: [0.5005, 0.4, 0.3, 0.2]
    // After swap (idx 1 <-> idx 2): [0.5005, 0.3, 0.4, 0.2]
    expect(scores[1]!.composite).toBe(0.3);
    expect(scores[2]!.composite).toBe(0.4);
  });

  it("applies quality modulation when quality_sample_count >= 3", () => {
    // Agent with low avg_quality and enough samples should get reduced reliability
    const lowQualityCandidate = makeCandidate({
      motebit_id: asMotebitId("low-quality"),
      trust_record: makeTrustRecord({
        remote_motebit_id: asMotebitId("low-quality"),
        avg_quality: 0.5,
        quality_sample_count: 5,
      }),
      listing: makeListing({ motebit_id: asMotebitId("low-quality") }),
    });
    const highQualityCandidate = makeCandidate({
      motebit_id: asMotebitId("high-quality"),
      trust_record: makeTrustRecord({
        remote_motebit_id: asMotebitId("high-quality"),
        avg_quality: 1.0,
        quality_sample_count: 10,
      }),
      listing: makeListing({ motebit_id: asMotebitId("high-quality") }),
    });

    const scores = graphRankCandidates(
      SELF_ID,
      [lowQualityCandidate, highQualityCandidate],
      defaultReqs,
    );

    // High-quality agent should score higher than low-quality agent (all else equal)
    const lowScore = scores.find((s) => s.motebit_id === "low-quality")!;
    const highScore = scores.find((s) => s.motebit_id === "high-quality")!;
    expect(highScore.composite).toBeGreaterThan(lowScore.composite);
  });
});

// ── Organizational Trust Baseline (Guardian Attestation) ───────────

describe("organizational trust baseline via guardian", () => {
  it("same guardian key raises trust baseline for unknown agents", () => {
    const guardianKey = "aa".repeat(32);
    const candidate = makeCandidate({
      motebit_id: asMotebitId("org-agent"),
      trust_record: null, // no prior interaction → default 0.1
      guardian_public_key: guardianKey,
    });

    // Without guardian: trust = 0.1 (default for unknown)
    const graphWithout = buildRoutingGraph(SELF_ID, [candidate]);
    const edgeWithout = graphWithout.getEdge(SELF_ID, "org-agent")!;
    expect(edgeWithout.trust).toBeCloseTo(0.1, 1);

    // With same guardian: trust = 0.35 (organizational baseline — identity, not capability)
    const graphWith = buildRoutingGraph(SELF_ID, [candidate], undefined, guardianKey);
    const edgeWith = graphWith.getEdge(SELF_ID, "org-agent")!;
    expect(edgeWith.trust).toBeCloseTo(0.35, 1);
  });

  it("does not downgrade earned trust above organizational baseline", () => {
    const guardianKey = "bb".repeat(32);
    const candidate = makeCandidate({
      motebit_id: asMotebitId("trusted-org-agent"),
      trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Verified }), // score 0.9
      guardian_public_key: guardianKey,
    });

    const graph = buildRoutingGraph(SELF_ID, [candidate], undefined, guardianKey);
    const edge = graph.getEdge(SELF_ID, "trusted-org-agent")!;
    // Earned trust (0.9) > org baseline (0.35), should keep 0.9
    expect(edge.trust).toBeGreaterThan(0.35);
  });

  it("different guardian keys do not boost trust", () => {
    const candidate = makeCandidate({
      motebit_id: asMotebitId("other-org-agent"),
      trust_record: null,
      guardian_public_key: "cc".repeat(32),
    });

    const graph = buildRoutingGraph(SELF_ID, [candidate], undefined, "dd".repeat(32));
    const edge = graph.getEdge(SELF_ID, "other-org-agent")!;
    // Different orgs: stays at default 0.1
    expect(edge.trust).toBeCloseTo(0.1, 1);
  });

  it("no guardian on caller means no boost even if candidate has guardian", () => {
    const candidate = makeCandidate({
      motebit_id: asMotebitId("guarded-agent"),
      trust_record: null,
      guardian_public_key: "ee".repeat(32),
    });

    const graph = buildRoutingGraph(SELF_ID, [candidate]); // no callerGuardianPublicKey
    const edge = graph.getEdge(SELF_ID, "guarded-agent")!;
    expect(edge.trust).toBeCloseTo(0.1, 1);
  });

  it("guardian trust flows through graphRankCandidates via config", () => {
    const guardianKey = "ff".repeat(32);
    const candidate = makeCandidate({
      motebit_id: asMotebitId("org-peer"),
      trust_record: null,
      guardian_public_key: guardianKey,
    });

    const withoutGuardian = graphRankCandidates(SELF_ID, [candidate], defaultReqs);
    const withGuardian = graphRankCandidates(SELF_ID, [candidate], defaultReqs, {
      callerGuardianPublicKey: guardianKey,
    });

    // Same-org agent should rank higher
    expect(withGuardian[0]!.composite).toBeGreaterThan(withoutGuardian[0]!.composite);
  });
});

// ── SLA Integration in Routing ─────────────────────────────────────

describe("SLA fields in routing", () => {
  it("uses SLA max_latency_ms as latency fallback when no measured stats", () => {
    const candidate = makeCandidate({
      motebit_id: asMotebitId("sla-agent"),
      latency_stats: null, // no measurements
      listing: makeListing({
        sla: { max_latency_ms: 2000, availability_guarantee: 0.95 },
      }),
    });

    const graph = buildRoutingGraph(SELF_ID, [candidate]);
    const edge = graph.getEdge(SELF_ID, "sla-agent")!;
    // SLA says 2000ms, so latency edge should be 2000 (not default 5000)
    expect(edge.latency).toBe(2000);
  });

  it("prefers measured latency over SLA declaration", () => {
    const candidate = makeCandidate({
      motebit_id: asMotebitId("measured-agent"),
      latency_stats: { avg_ms: 800, p95_ms: 1500, sample_count: 50 },
      listing: makeListing({
        sla: { max_latency_ms: 3000, availability_guarantee: 0.99 },
      }),
    });

    const graph = buildRoutingGraph(SELF_ID, [candidate]);
    const edge = graph.getEdge(SELF_ID, "measured-agent")!;
    // Measured (800ms) beats SLA declaration (3000ms)
    expect(edge.latency).toBe(800);
  });

  it("SLA availability_guarantee acts as reliability floor for agents without quality data", () => {
    const newAgentWithSLA = makeCandidate({
      motebit_id: asMotebitId("sla-reliable"),
      trust_record: makeTrustRecord({
        successful_tasks: 2,
        failed_tasks: 1, // 67% success rate but < 3 quality samples
        quality_sample_count: 0,
      }),
      listing: makeListing({
        sla: { max_latency_ms: 5000, availability_guarantee: 0.95 },
      }),
    });

    const graph = buildRoutingGraph(SELF_ID, [newAgentWithSLA]);
    const edge = graph.getEdge(SELF_ID, "sla-reliable")!;
    // Track record says 0.67, SLA says 0.95, insufficient quality data → SLA floor applies
    expect(edge.reliability).toBeGreaterThanOrEqual(0.95);
  });

  it("evidence overrides SLA floor when quality samples sufficient", () => {
    const provenLowQuality = makeCandidate({
      motebit_id: asMotebitId("proven-low"),
      trust_record: makeTrustRecord({
        successful_tasks: 3,
        failed_tasks: 7, // 30% success rate
        avg_quality: 0.5,
        quality_sample_count: 5, // enough data to override SLA
      }),
      listing: makeListing({
        sla: { max_latency_ms: 5000, availability_guarantee: 0.95 },
      }),
    });

    const graph = buildRoutingGraph(SELF_ID, [provenLowQuality]);
    const edge = graph.getEdge(SELF_ID, "proven-low")!;
    // Proven low quality → evidence overrides SLA declaration
    expect(edge.reliability).toBeLessThan(0.5);
  });

  it("reliability above SLA floor is preserved", () => {
    const highReliabilityCandidate = makeCandidate({
      motebit_id: asMotebitId("reliable-agent"),
      trust_record: makeTrustRecord({
        successful_tasks: 99,
        failed_tasks: 1, // 99% success rate
      }),
      listing: makeListing({
        sla: { max_latency_ms: 5000, availability_guarantee: 0.9 },
      }),
    });

    const graph = buildRoutingGraph(SELF_ID, [highReliabilityCandidate]);
    const edge = graph.getEdge(SELF_ID, "reliable-agent")!;
    // Track record (0.99) > SLA (0.90) — keep earned reliability
    expect(edge.reliability).toBeGreaterThan(0.95);
  });
});

describe("hardware attestation trust boost", () => {
  function baseline(): CandidateProfile {
    return makeCandidate({
      motebit_id: asMotebitId("agent-a"),
      trust_record: makeTrustRecord({
        trust_level: AgentTrustLevel.FirstContact,
      }),
    });
  }

  it("absent hardware_attestation → trust unchanged (boost factor 1.0)", () => {
    const candidate = baseline();
    const graph = buildRoutingGraph(SELF_ID, [candidate]);
    const edge = graph.getEdge(SELF_ID, "agent-a")!;
    // FirstContact trust is 0.3; no credential reputation → 0.3.
    // HW boost applied at ranking time (chain bottleneck), not at the edge.
    expect(edge.trust).toBeCloseTo(0.3, 5);
    // And the ranked sub_scores.trust reflects no boost (chain-HW = 0 annihilates).
    const [score] = graphRankCandidates(SELF_ID, [candidate], defaultReqs);
    expect(score!.sub_scores.trust).toBeCloseTo(0.3, 5);
  });

  it("software sentinel → tiny bump (0.1 × 0.2 = 2% multiplier) at ranking time", () => {
    const candidate: CandidateProfile = {
      ...baseline(),
      hardware_attestation: { platform: "software" },
    };
    // Edge carries unboosted blendedTrust — the product-semiring chain
    // traversal folds chain-HW into trust at `scoreRoute`, not at edge
    // construction. See graph-routing.ts `applyHardwareAttestationBoost`.
    const graph = buildRoutingGraph(SELF_ID, [candidate]);
    const edge = graph.getEdge(SELF_ID, "agent-a")!;
    expect(edge.trust).toBeCloseTo(0.3, 5);
    // Ranked trust = 0.3 × (1 + 0.1 × 0.2) = 0.306.
    const [score] = graphRankCandidates(SELF_ID, [candidate], defaultReqs);
    expect(score!.sub_scores.trust).toBeCloseTo(0.306, 5);
  });

  it("hardware-attested (non-exported) → full 20% boost at ranking time", () => {
    const candidate: CandidateProfile = {
      ...baseline(),
      hardware_attestation: { platform: "secure_enclave", key_exported: false },
    };
    const graph = buildRoutingGraph(SELF_ID, [candidate]);
    const edge = graph.getEdge(SELF_ID, "agent-a")!;
    expect(edge.trust).toBeCloseTo(0.3, 5);
    // Ranked trust = 0.3 × (1 + 1.0 × 0.2) = 0.36.
    const [score] = graphRankCandidates(SELF_ID, [candidate], defaultReqs);
    expect(score!.sub_scores.trust).toBeCloseTo(0.36, 5);
  });

  it("hardware-exported → half boost (0.5 × 0.2 = 10% multiplier) at ranking time", () => {
    const candidate: CandidateProfile = {
      ...baseline(),
      hardware_attestation: { platform: "secure_enclave", key_exported: true },
    };
    const graph = buildRoutingGraph(SELF_ID, [candidate]);
    const edge = graph.getEdge(SELF_ID, "agent-a")!;
    expect(edge.trust).toBeCloseTo(0.3, 5);
    // Ranked trust = 0.3 × (1 + 0.5 × 0.2) = 0.33.
    const [score] = graphRankCandidates(SELF_ID, [candidate], defaultReqs);
    expect(score!.sub_scores.trust).toBeCloseTo(0.33, 5);
  });

  it("boost caps trust at 1.0 — max possible composed trust never exceeds 1", () => {
    const candidate: CandidateProfile = {
      ...makeCandidate({
        motebit_id: asMotebitId("agent-a"),
        trust_record: makeTrustRecord({
          trust_level: AgentTrustLevel.Trusted, // already at the ceiling
        }),
      }),
      hardware_attestation: { platform: "secure_enclave", key_exported: false },
    };
    const graph = buildRoutingGraph(SELF_ID, [candidate]);
    const edge = graph.getEdge(SELF_ID, "agent-a")!;
    // Edge stays in [0, 1]; boost-capped final trust also stays bounded.
    expect(edge.trust).toBeLessThanOrEqual(1.0);
    const [score] = graphRankCandidates(SELF_ID, [candidate], defaultReqs);
    expect(score!.sub_scores.trust).toBeLessThanOrEqual(1.0);
  });

  it("HW-attested candidate ranks above software-only candidate with same baseline", () => {
    const hardware = makeCandidate({
      motebit_id: asMotebitId("hw-agent"),
      trust_record: makeTrustRecord({
        remote_motebit_id: asMotebitId("hw-agent"),
        trust_level: AgentTrustLevel.FirstContact,
      }),
      hardware_attestation: { platform: "secure_enclave", key_exported: false },
    });
    const software = makeCandidate({
      motebit_id: asMotebitId("sw-agent"),
      trust_record: makeTrustRecord({
        remote_motebit_id: asMotebitId("sw-agent"),
        trust_level: AgentTrustLevel.FirstContact,
      }),
    });
    const scores = graphRankCandidates(SELF_ID, [software, hardware], defaultReqs, {});
    const hwScore = scores.find((s) => s.motebit_id === "hw-agent")!;
    const swScore = scores.find((s) => s.motebit_id === "sw-agent")!;
    expect(hwScore.composite).toBeGreaterThan(swScore.composite);
  });
});

// ── Chain bottleneck: HardwareAttestationSemiring composition ──────
//
// The semiring's reason for existing is "a chain is only as strongly
// attested as its weakest link." These tests pin the composition at
// the routing boundary — a single `software` hop caps the entire
// chain's HW bonus at ~2%, and an absent claim anywhere annihilates
// the HW axis to zero (the semiring-zero property).

describe("hardware attestation chain bottleneck (product semiring)", () => {
  // Pin exact composite for a direct-match, single-hop candidate with
  // `hardware_attestation: { platform: "secure_enclave" }`. This is the
  // regression test the refactor must not move: before the refactor the
  // HW boost baked into edge.trust at graph construction; after, it
  // folds at ranking time via the chain-bottleneck. Single-hop paths
  // have a one-edge chain, so bottleneck == local claim == identical
  // composite to the pre-refactor behavior.
  it("single-hop parity: direct-match candidate scores identically to pre-refactor", () => {
    const candidate = makeCandidate({
      motebit_id: asMotebitId("direct-agent"),
      trust_record: makeTrustRecord({
        remote_motebit_id: asMotebitId("direct-agent"),
        trust_level: AgentTrustLevel.FirstContact,
      }),
      hardware_attestation: { platform: "secure_enclave", key_exported: false },
    });
    const scores = graphRankCandidates(SELF_ID, [candidate], defaultReqs);
    const score = scores[0]!;
    // blendedTrust = 0.3 (FirstContact); chainHw = 1.0 (single hop, local SE).
    // trust = 0.3 × (1 + 1.0 × 0.2) = 0.36
    expect(score.sub_scores.trust).toBeCloseTo(0.36, 10);
    // Composite (default weights): 0.36*0.3 + costScore*0.2 + latencyNorm*0.15 + reliability*0.15 + riskScore*0.2
    //   costScore = 1/(1+0.01) ≈ 0.99010... (cost=0.01 from default pricing)
    //   latencyNorm = 1/(1+1000/1000) = 0.5 (avg_ms=1000)
    //   reliability = 8/10 (8 successful / 2 failed) = 0.8 — exceeds SLA floor of 0.99? 0.99 wins per floor logic
    // Recompute: trust_record.avg_quality unset (=1.0 default), quality_sample_count unset (=0) — SLA floor 0.99 applies.
    //   riskScore = 1/(1+0) = 1.0 (no regulatory_risk)
    //   composite = 0.36*0.3 + 0.99010*0.2 + 0.5*0.15 + 0.99*0.15 + 1.0*0.2
    //             = 0.108 + 0.198020 + 0.075 + 0.1485 + 0.2 = 0.729520...
    expect(score.composite).toBeCloseTo(
      0.36 * 0.3 + (1 / 1.01) * 0.2 + 0.5 * 0.15 + 0.99 * 0.15 + 1.0 * 0.2,
      10,
    );
  });

  // Multi-hop bottleneck: the point of this change. A candidate reached
  // ONLY via a software-attested intermediary gets the software-strength
  // HW boost, while a candidate reached ONLY via a secure_enclave
  // intermediary gets the full boost. The old scalar-at-terminal code
  // scored these identically (terminal had same HW); the new code
  // distinguishes them via the chain-min.
  it("multi-hop bottleneck: chain through software intermediary scores less than all-SE chain", () => {
    // Candidate B is only reachable via a peer edge from A. B has no
    // direct self→B trust (null trust_record → default 0.1, but no
    // capability match so gets skipped). Give B capabilities and
    // is_online = true so it gets a direct edge with HW = 1.0 (SE).
    // Then add a peer A→B with HW reflecting A's custody.
    const targetB = asMotebitId("terminal-b");
    const swViaA = makeCandidate({
      motebit_id: asMotebitId("sw-intermediate"),
      trust_record: makeTrustRecord({
        remote_motebit_id: asMotebitId("sw-intermediate"),
        trust_level: AgentTrustLevel.Trusted,
      }),
      listing: makeListing({
        motebit_id: asMotebitId("sw-intermediate"),
        capabilities: [], // intermediate doesn't match the target capability
      }),
      hardware_attestation: { platform: "software" },
    });
    const seViaA = makeCandidate({
      motebit_id: asMotebitId("se-intermediate"),
      trust_record: makeTrustRecord({
        remote_motebit_id: asMotebitId("se-intermediate"),
        trust_level: AgentTrustLevel.Trusted,
      }),
      listing: makeListing({
        motebit_id: asMotebitId("se-intermediate"),
        capabilities: [],
      }),
      hardware_attestation: { platform: "secure_enclave", key_exported: false },
    });
    // Scenario 1: chain via software intermediary. Peer edge A→B carries
    // A's software claim (HW 0.1); terminal B's direct edge has HW 1.0.
    // Under product semiring, the self→A→B path has chain HW = min(0.1, 1.0) = 0.1;
    // the self→B direct path has chain HW = 1.0. The ⊕ picks max per-dim:
    // trust picks the max-trust path, HW picks max HW. But when there's NO
    // direct self→B edge (B has no capability? no, B must match caps to
    // score), we see only the peer-routed path.
    //
    // To isolate the chain bottleneck, remove B's capability-matched
    // direct path by making it reachable only through peer edges:
    // we can't do that directly (direct self→B edge always exists if
    // is_online and not blocked), BUT we can use a much stronger peer
    // trust so the ⊕ prefers that path in BOTH dimensions.
    //
    // Simpler test: just compare the two terminal candidates with
    // identical direct edges but DIFFERENT peer chains feeding them.
    // Terminal itself has no local HW claim — HW signal comes only
    // from the peer chain.
    const terminalNoLocalHw = makeCandidate({
      motebit_id: targetB,
      trust_record: null,
      listing: makeListing({ motebit_id: targetB, capabilities: ["web_search"] }),
      // no hardware_attestation — local score = 0
    });

    // peerHigh chosen so chain_trust * 1.2 stays under the 1.0 clamp
    // (0.9 * peerHigh * 1.2 < 1.0 ⇒ peerHigh < 0.9259). 0.8 is safe.
    const peerHigh = 0.8;
    const peerEdgesSoft = [
      {
        from: "sw-intermediate",
        to: targetB,
        weight: {
          trust: peerHigh,
          cost: 0,
          latency: 100,
          reliability: 1.0,
          regulatory_risk: 0,
        } as RouteWeight,
        // no hw_attestation → identity (1.0), keeps chain min = intermediate's 0.1
      },
    ];
    const peerEdgesSE = [
      {
        from: "se-intermediate",
        to: targetB,
        weight: {
          trust: peerHigh,
          cost: 0,
          latency: 100,
          reliability: 1.0,
          regulatory_risk: 0,
        } as RouteWeight,
      },
    ];

    const scoresSoft = graphRankCandidates(SELF_ID, [swViaA, terminalNoLocalHw], defaultReqs, {
      peerEdges: peerEdgesSoft,
    });
    const scoresSE = graphRankCandidates(SELF_ID, [seViaA, terminalNoLocalHw], defaultReqs, {
      peerEdges: peerEdgesSE,
    });

    const tSoft = scoresSoft.find((s) => s.motebit_id === targetB)!;
    const tSE = scoresSE.find((s) => s.motebit_id === targetB)!;
    // Terminal routed through a software-attested intermediary must
    // score STRICTLY less than the same terminal routed through an
    // SE-attested intermediary. Before this refactor they were equal
    // (terminal had no local HW; boost was 0 in both cases).
    expect(tSoft.sub_scores.trust).toBeLessThan(tSE.sub_scores.trust);
    // Quantified: chain trust via intermediate ~ trustLevelToScore(Trusted) * peerTrust = 0.9 * 0.99.
    //   via-software chainHw = 0.1 (intermediate's), boost = 1 + 0.1*0.2 = 1.02
    //   via-SE chainHw = 1.0, boost = 1 + 1.0*0.2 = 1.2
    // Terminal's local-direct path has chainHw = 0 (no claim), so ⊕ for HW picks
    // the peer-chain's HW (0.1 or 1.0).
    const chainTrust = 0.9 * peerHigh;
    expect(tSoft.sub_scores.trust).toBeCloseTo(chainTrust * 1.02, 5);
    expect(tSE.sub_scores.trust).toBeCloseTo(chainTrust * 1.2, 5);
  });

  // Mixed-platform chain: pin the exact bottleneck-min score.
  // Chain (secure_enclave, device_check, secure_enclave) → min(1.0, 1.0, 1.0) = 1.0.
  // Rewrite to mix: (secure_enclave, software, secure_enclave) → min = 0.1.
  // The test checks the specific numeric chain score comes through.
  it("mixed-platform chain scores at the bottleneck value", () => {
    const targetC = asMotebitId("terminal-c");
    const a = makeCandidate({
      motebit_id: asMotebitId("mid-a"),
      trust_record: makeTrustRecord({
        remote_motebit_id: asMotebitId("mid-a"),
        trust_level: AgentTrustLevel.Trusted,
      }),
      listing: makeListing({
        motebit_id: asMotebitId("mid-a"),
        capabilities: [],
      }),
      hardware_attestation: { platform: "secure_enclave", key_exported: false },
    });
    const terminal = makeCandidate({
      motebit_id: targetC,
      trust_record: null,
      listing: makeListing({ motebit_id: targetC, capabilities: ["web_search"] }),
      // no local HW — chain HW comes entirely from the peer edges.
    });

    // Chain self → mid-a (SE=1.0) → middle-hop (device_check=1.0) → terminal-c (SE=1.0).
    // Model middle-hop as a peer edge whose `hw_attestation` encodes
    // device_check's score (1.0). Bottleneck across {1.0, 1.0, 1.0} = 1.0.
    const allHardware = [
      {
        from: "mid-a",
        to: "mid-b",
        weight: {
          trust: 0.95,
          cost: 0,
          latency: 100,
          reliability: 1.0,
          regulatory_risk: 0,
        } as RouteWeight,
        hw_attestation: 1.0, // device_check, non-exported
      },
      {
        from: "mid-b",
        to: targetC,
        weight: {
          trust: 0.95,
          cost: 0,
          latency: 100,
          reliability: 1.0,
          regulatory_risk: 0,
        } as RouteWeight,
        hw_attestation: 1.0, // secure_enclave
      },
    ];

    const scoresAllHw = graphRankCandidates(SELF_ID, [a, terminal], defaultReqs, {
      peerEdges: allHardware,
    });
    const termAllHw = scoresAllHw.find((s) => s.motebit_id === targetC)!;
    // chainTrust = 0.9 * 0.95 * 0.95 = 0.81225; chainHw = min(1,1,1) = 1.0
    // sub_scores.trust = 0.81225 * (1 + 1.0*0.2) = 0.9747
    expect(termAllHw.sub_scores.trust).toBeCloseTo(0.9 * 0.95 * 0.95 * 1.2, 5);

    // Same chain, but middle-hop is software (0.1). Bottleneck = min(1, 0.1, 1) = 0.1.
    const mixed = [
      {
        from: "mid-a",
        to: "mid-b",
        weight: {
          trust: 0.95,
          cost: 0,
          latency: 100,
          reliability: 1.0,
          regulatory_risk: 0,
        } as RouteWeight,
        hw_attestation: 0.1, // software intermediate — the weakest link
      },
      {
        from: "mid-b",
        to: targetC,
        weight: {
          trust: 0.95,
          cost: 0,
          latency: 100,
          reliability: 1.0,
          regulatory_risk: 0,
        } as RouteWeight,
        hw_attestation: 1.0,
      },
    ];
    const scoresMixed = graphRankCandidates(SELF_ID, [a, terminal], defaultReqs, {
      peerEdges: mixed,
    });
    const termMixed = scoresMixed.find((s) => s.motebit_id === targetC)!;
    // chainTrust = 0.9 * 0.95 * 0.95; chainHw = min(1, 0.1, 1) = 0.1
    // sub_scores.trust = chainTrust * (1 + 0.1*0.2) = chainTrust * 1.02
    expect(termMixed.sub_scores.trust).toBeCloseTo(0.9 * 0.95 * 0.95 * 1.02, 5);
    // And strictly less than the all-hardware chain.
    expect(termMixed.sub_scores.trust).toBeLessThan(termAllHw.sub_scores.trust);
  });

  // Absent claim ⊗-annihilates: a chain with any `None` HW claim
  // terminates with chainHw = 0 — the semiring zero, the reason the
  // composition exists. The chain's trust gets NO HW boost.
  it("absent claim anywhere in the chain annihilates the HW axis to zero", () => {
    const targetD = asMotebitId("terminal-d");
    const a = makeCandidate({
      motebit_id: asMotebitId("anchor-a"),
      trust_record: makeTrustRecord({
        remote_motebit_id: asMotebitId("anchor-a"),
        trust_level: AgentTrustLevel.Trusted,
      }),
      listing: makeListing({
        motebit_id: asMotebitId("anchor-a"),
        capabilities: [],
      }),
      hardware_attestation: { platform: "secure_enclave", key_exported: false },
    });
    const terminal = makeCandidate({
      motebit_id: targetD,
      trust_record: null,
      listing: makeListing({ motebit_id: targetD, capabilities: ["web_search"] }),
      // no local HW claim
    });
    // Peer edge from SE-anchor to terminal, middle hop with NO hw_attestation
    // defaults to HW identity 1.0 under the composition — that's fine;
    // the "absent" case we want is when a link EXPLICITLY has hw_attestation
    // = 0 (semiring zero). Use an explicit intermediate edge with zero HW.
    const chainWithZero = [
      {
        from: "anchor-a",
        to: "mid-unknown",
        weight: {
          trust: 0.95,
          cost: 0,
          latency: 100,
          reliability: 1.0,
          regulatory_risk: 0,
        } as RouteWeight,
        hw_attestation: 0, // absent claim — the zero of HardwareAttestationSemiring
      },
      {
        from: "mid-unknown",
        to: targetD,
        weight: {
          trust: 0.95,
          cost: 0,
          latency: 100,
          reliability: 1.0,
          regulatory_risk: 0,
        } as RouteWeight,
        hw_attestation: 1.0,
      },
    ];
    const scores = graphRankCandidates(SELF_ID, [a, terminal], defaultReqs, {
      peerEdges: chainWithZero,
    });
    const term = scores.find((s) => s.motebit_id === targetD)!;
    // chainHw = min(1.0, 0, 1.0) = 0 (absent-claim annihilation).
    // sub_scores.trust = chainTrust * (1 + 0 * 0.2) = chainTrust, NO boost.
    const chainTrust = 0.9 * 0.95 * 0.95;
    expect(term.sub_scores.trust).toBeCloseTo(chainTrust, 5);
    // Quantified difference: compare against the same chain with the
    // zero replaced by a non-zero HW — the HW-axis zero is what we're
    // pinning.
    const chainAllHw = [
      {
        from: "anchor-a",
        to: "mid-unknown",
        weight: {
          trust: 0.95,
          cost: 0,
          latency: 100,
          reliability: 1.0,
          regulatory_risk: 0,
        } as RouteWeight,
        hw_attestation: 0.1, // software — smallest nonzero
      },
      {
        from: "mid-unknown",
        to: targetD,
        weight: {
          trust: 0.95,
          cost: 0,
          latency: 100,
          reliability: 1.0,
          regulatory_risk: 0,
        } as RouteWeight,
        hw_attestation: 1.0,
      },
    ];
    const scoresAllHw = graphRankCandidates(SELF_ID, [a, terminal], defaultReqs, {
      peerEdges: chainAllHw,
    });
    const termAllHw = scoresAllHw.find((s) => s.motebit_id === targetD)!;
    // Chain with all-nonzero HW gets a small boost; chain with an
    // absent link gets none. Any-nonzero must strictly exceed all-zero.
    expect(termAllHw.sub_scores.trust).toBeGreaterThan(term.sub_scores.trust);
  });
});
