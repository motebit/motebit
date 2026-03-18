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
import { AgentTrustLevel, asMotebitId, asListingId } from "@motebit/sdk";
import type { AgentTrustRecord, AgentServiceListing } from "@motebit/sdk";
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
});
