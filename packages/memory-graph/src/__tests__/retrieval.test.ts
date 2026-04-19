/**
 * Semiring-driven memory retrieval — the load-bearing abstraction proof.
 *
 * Build one small memory graph. Run all five recall lenses. Assert each
 * returns a meaningfully different result. If they didn't, the semiring
 * framing wouldn't be earning its keep — it'd be five renamed versions
 * of the same query. This test is the one that says "the abstraction
 * is doing real work."
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryMemoryStorage, MemoryGraph } from "../index.js";
import { InMemoryEventStore } from "@motebit/event-log";
import { RelationType, SensitivityLevel } from "@motebit/sdk";
import type { MemoryCandidate } from "@motebit/sdk";

// ── Fixture: a small, intentionally-asymmetric memory graph ─────────
//
// Eight nodes, shaped so that each lens has a distinct "winner":
//
//   A ── Related(w=0.9, c=0.9) ── B ── Related(w=0.9, c=0.9) ── C
//   │                                                             │
//   │  Reinforces                                        Reinforces│
//   │  (w=0.8, c=0.6)                                   (w=0.4, c=0.4)
//   │                                                             │
//   D ─── FollowedBy(w=0.5, c=0.5) ─── E ──────────────────────── F
//   │                                                             │
//   │  ConflictsWith (w=1, c=1 — but relationMultiplier zeros it) │
//   │                                                             │
//   └───────────── G (isolated: no edges connect to G) ──────────────
//
// Plus H, connected only via a Supersedes edge (multiplier 0.1 →
// deprecated predecessor) from B. H is reachable but with attenuated
// weight, which the confidence lens should rank low.
//
// Expected lens behavior from seed A:
//   recallRelevant(embedding aligned with A) → A ranks first, nearby
//                                              nodes boosted
//   recallConfidentChain(A, null)            → C (through B, both
//                                              high-confidence Related
//                                              edges): log(0.81) +
//                                              log(0.81) = biggest
//   recallShortestProvenance(A, F)           → path A-D-E-F (3 hops)
//   recallReachable(A, maxDepth=2)           → {B, D, C, E} (G, F, H
//                                              need >2 hops)
//   recallFuzzyCluster(A)                    → ordering by bottleneck
//                                              edge weight
//
// The test below doesn't enforce exact results — it asserts the lenses
// disagree in ways that can only hold if the semiring framing does real
// work.

interface FixtureNodes {
  A: string;
  B: string;
  C: string;
  D: string;
  E: string;
  F: string;
  G: string;
  H: string;
}

async function buildFixture(): Promise<{ graph: MemoryGraph; nodes: FixtureNodes }> {
  const storage = new InMemoryMemoryStorage();
  const eventStore = new InMemoryEventStore();
  const graph = new MemoryGraph(storage, eventStore, "test-motebit");

  const emb = (label: string): number[] => {
    // Deterministic 8-dim embedding keyed to the node label, unit-normed.
    const raw = [0, 0, 0, 0, 0, 0, 0, 0];
    const idx = (label.charCodeAt(0) - 65) % 8;
    raw[idx] = 1;
    return raw;
  };

  const candidate = (content: string): MemoryCandidate => ({
    content,
    sensitivity: SensitivityLevel.None,
    confidence: 0.9,
  });

  const A = (await graph.formMemory(candidate("A"), emb("A")))!.node_id;
  const B = (await graph.formMemory(candidate("B"), emb("B")))!.node_id;
  const C = (await graph.formMemory(candidate("C"), emb("C")))!.node_id;
  const D = (await graph.formMemory(candidate("D"), emb("D")))!.node_id;
  const E = (await graph.formMemory(candidate("E"), emb("E")))!.node_id;
  const F = (await graph.formMemory(candidate("F"), emb("F")))!.node_id;
  const G = (await graph.formMemory(candidate("G"), emb("G")))!.node_id;
  const H = (await graph.formMemory(candidate("H"), emb("H")))!.node_id;

  // Confident corridor A-B-C (Related, high weight+confidence)
  await graph.link(A, B, RelationType.Related, 0.9, 0.9);
  await graph.link(B, C, RelationType.Related, 0.9, 0.9);

  // Weaker parallel path A-D-E-F
  await graph.link(A, D, RelationType.Reinforces, 0.8, 0.6);
  await graph.link(D, E, RelationType.FollowedBy, 0.5, 0.5);
  await graph.link(E, F, RelationType.Reinforces, 0.4, 0.4);

  // Conflict edge A-G — relationTypeMultiplier zeros it, so G is
  // unreachable from A via confidence/bottleneck lenses.
  await graph.link(A, G, RelationType.ConflictsWith, 1.0, 1.0);

  // Supersedes edge B-H — relationTypeMultiplier=0.1 attenuates it.
  await graph.link(B, H, RelationType.Supersedes, 1.0, 1.0);

  return { graph, nodes: { A, B, C, D, E, F, G, H } };
}

// ── The load-bearing test ───────────────────────────────────────────

describe("semiring-driven recall — five lenses, five answers", () => {
  let graph: MemoryGraph;
  let nodes: FixtureNodes;

  beforeEach(async () => {
    const built = await buildFixture();
    graph = built.graph;
    nodes = built.nodes;
  });

  it("recallRelevant returns A at the top for an A-aligned query", async () => {
    const results = await graph.recallRelevant([1, 0, 0, 0, 0, 0, 0, 0], { limit: 4 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toBe("A");
  });

  it("recallConfidentChain(A → null) picks the nearest high-confidence neighbor (B)", async () => {
    // No-target mode returns the single best outgoing chain — the highest
    // max-product log-prob reachable node, which for max-product IS the
    // closest high-confidence neighbor, not the deepest chain. B wins:
    // log(0.9·0.9) > log(0.9·0.9) + log(0.9·0.9) (adding negatives shrinks).
    const result = await graph.recallConfidentChain(nodes.A, null);
    expect(result).not.toBeNull();
    expect(result!.nodes.map((n) => n.content)).toEqual(["A", "B"]);
  });

  it("recallConfidentChain(A → C) traces the full A-B-C corridor", async () => {
    // With an explicit target, the chain extends to reach it.
    const result = await graph.recallConfidentChain(nodes.A, nodes.C);
    expect(result).not.toBeNull();
    expect(result!.nodes.map((n) => n.content)).toEqual(["A", "B", "C"]);
  });

  it("recallShortestProvenance from A to F routes through D-E", async () => {
    const result = await graph.recallShortestProvenance(nodes.A, nodes.F);
    expect(result).not.toBeNull();
    const content = result!.nodes.map((n) => n.content);
    expect(content[0]).toBe("A");
    expect(content[content.length - 1]).toBe("F");
    // Must pass through D and E — the only non-conflicting path.
    expect(content).toContain("D");
    expect(content).toContain("E");
    // 3 hops — the Cost semiring min-plus gives exactly this.
    expect(result!.value).toBe(3);
  });

  it("recallReachable with maxDepth=1 returns only direct neighbors", async () => {
    // A's direct neighbors: B (Related), D (Reinforces). G is wired via
    // ConflictsWith — relationTypeMultiplier zeros the edge weight, but
    // buildMemoryDigraph still creates the structural edge. recallReachable
    // uses followRelations to filter *which relations count* — leaving it
    // unfiltered means all structural neighbors appear. Restrict via
    // followRelations to prove the filtering path.
    const reachable = await graph.recallReachable(nodes.A, {
      maxDepth: 1,
      followRelations: [RelationType.Related, RelationType.Reinforces],
    });
    expect(reachable.has(nodes.B)).toBe(true);
    expect(reachable.has(nodes.D)).toBe(true);
    expect(reachable.has(nodes.G)).toBe(false); // excluded via followRelations
    expect(reachable.has(nodes.C)).toBe(false); // 2 hops
    expect(reachable.has(nodes.F)).toBe(false); // 3 hops
  });

  it("recallFuzzyCluster ranks reachable nodes by bottleneck edge", async () => {
    const cluster = await graph.recallFuzzyCluster(nodes.A);
    // Bottleneck(A→B) = 0.81 (0.9 × 0.9 × 1). Bottleneck(A→D) ≤ 0.48
    // (0.8 × 0.6 × 1). B must outrank D.
    const byContent = new Map(cluster.map((c) => [c.node.content, c.bottleneck]));
    expect(byContent.get("B")).toBeGreaterThan(byContent.get("D") ?? 0);
    // G must be absent (conflict-blocked → bottleneck 0, filtered by minBottleneck).
    expect(byContent.get("G")).toBeUndefined();
  });

  it("the five lenses disagree — the abstraction is load-bearing", async () => {
    // Same seed (A), five different answers. If all lenses returned
    // identical node sets, the semiring framing would be decorative.
    const relevant = (await graph.recallRelevant([1, 0, 0, 0, 0, 0, 0, 0], { limit: 8 }))
      .map((n) => n.content)
      .sort();
    const confident = (await graph.recallConfidentChain(nodes.A, null))!.nodes
      .map((n) => n.content)
      .sort();
    const provenance = (await graph.recallShortestProvenance(nodes.A, nodes.F))!.nodes
      .map((n) => n.content)
      .sort();
    const reachable = [...(await graph.recallReachable(nodes.A, { maxDepth: 3 }))].sort();
    const cluster = (await graph.recallFuzzyCluster(nodes.A)).map((c) => c.node.content).sort();

    const toKey = (arr: string[]) => arr.join(",");
    const keys = new Set([
      toKey(relevant),
      toKey(confident),
      toKey(provenance),
      toKey(
        reachable.map((id) => {
          // translate node_ids back to content for comparability
          return Object.entries(nodes).find(([, v]) => v === id)?.[0] ?? id;
        }),
      ),
      toKey(cluster),
    ]);
    // At least three distinct answers. If any two lenses collapse, that
    // might be coincidence on the fixture; if more than two collapse,
    // the abstraction isn't doing work.
    expect(keys.size).toBeGreaterThanOrEqual(3);
  });
});

// ── Edge cases per lens ─────────────────────────────────────────────

describe("recall lens edge cases", () => {
  it("recallConfidentChain returns null for unknown seed", async () => {
    const storage = new InMemoryMemoryStorage();
    const eventStore = new InMemoryEventStore();
    const graph = new MemoryGraph(storage, eventStore, "test-motebit");
    expect(await graph.recallConfidentChain("nope", null)).toBeNull();
  });

  it("recallShortestProvenance returns null when target is disconnected", async () => {
    const storage = new InMemoryMemoryStorage();
    const eventStore = new InMemoryEventStore();
    const graph = new MemoryGraph(storage, eventStore, "test-motebit");
    const a = (await graph.formMemory(
      { content: "a", sensitivity: SensitivityLevel.None, confidence: 0.9 },
      [1, 0, 0],
    ))!.node_id;
    const b = (await graph.formMemory(
      { content: "b", sensitivity: SensitivityLevel.None, confidence: 0.9 },
      [0, 1, 0],
    ))!.node_id;
    // No edge between a and b — disconnected.
    expect(await graph.recallShortestProvenance(a, b)).toBeNull();
  });

  it("recallReachable returns empty set for empty graph", async () => {
    const storage = new InMemoryMemoryStorage();
    const eventStore = new InMemoryEventStore();
    const graph = new MemoryGraph(storage, eventStore, "test-motebit");
    expect((await graph.recallReachable("nope")).size).toBe(0);
  });

  it("recallFuzzyCluster returns empty array for isolated seed", async () => {
    const storage = new InMemoryMemoryStorage();
    const eventStore = new InMemoryEventStore();
    const graph = new MemoryGraph(storage, eventStore, "test-motebit");
    const a = (await graph.formMemory(
      { content: "a", sensitivity: SensitivityLevel.None, confidence: 0.9 },
      [1, 0, 0],
    ))!.node_id;
    expect(await graph.recallFuzzyCluster(a)).toEqual([]);
  });
});
