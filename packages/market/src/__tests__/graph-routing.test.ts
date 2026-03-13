import { describe, it, expect } from "vitest";
import {
  buildRoutingGraph,
  graphRankCandidates,
  computeTrustClosure,
  findTrustedRoute,
} from "../graph-routing.js";
import type { CandidateProfile, TaskRequirements } from "../scoring.js";
import { AgentTrustLevel, asMotebitId, asListingId } from "@motebit/sdk";
import type { AgentTrustRecord, AgentServiceListing } from "@motebit/sdk";
import type { RouteWeight } from "@motebit/semiring";

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
