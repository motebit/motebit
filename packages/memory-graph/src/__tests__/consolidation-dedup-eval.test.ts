/**
 * Consolidation/dedup eval — the FOURTH thesis-#2 measurement ("more capable over time"),
 * on the surface the first three did not touch. Eval 1 (compounding) showed graph GROWTH
 * doesn't rot retrieval; eval 2 (decay-reinforcement) measured the FORGET schedule; eval 3
 * (recency-balance) measured the RANKING blend. All three fed memories in through an
 * ADD-always provider — i.e. they measured a graph that never CONSOLIDATES. This one measures
 * consolidation itself: when the same fact arrives repeatedly, or a fact CHANGES, does the
 * graph stay compact and current — or does it bloat with duplicates and serve stale beliefs?
 *
 * Thesis #2 on this surface has two halves, both driven through the REAL `consolidateAndForm`
 * pipeline (real `recallRelevant` neighbor lookup → real ADD/UPDATE/REINFORCE/NOOP mutation):
 *
 *   (A) DEDUP keeps the graph COMPACT *and* makes the survivor MORE DURABLE. K restatements
 *       of one fact collapse to a single node (vs K nodes under naive append), and that one
 *       node's confidence + half-life COMPOUND on every restatement — repeated exposure
 *       builds durable memory, the exact opposite of duplicate bloat.
 *
 *   (B) UPDATE keeps beliefs CURRENT while preserving HISTORY. A changed fact supersedes the
 *       old one (bi-temporal `valid_until`, not a tombstone) + a `Supersedes` edge, so an
 *       as-of-now recall returns the new belief and an as-of-then recall still returns the old
 *       one. "More capable over time" = beliefs track the world AND the past stays auditable.
 *
 * The decision oracle (ADD/UPDATE/REINFORCE/NOOP) is the LLM's job in production; here it is
 * STUBBED DETERMINISTICALLY from structured `subject=value` content — the same move eval 1–3
 * made for embeddings (controlled, reproducible), so the eval validates the consolidation
 * MACHINERY's response to correct decisions, not the classifier's accuracy (a separate axis).
 *
 * Method: each fact embeds at cosine ~0.99 to its subject's base vector (D=256, no low-dim
 * collision per eval 1's lesson), so same-subject facts are genuine retrieval neighbors and
 * the real pipeline actually CALLS the oracle (consolidateAndForm skips classify and falls
 * through to ADD when no neighbor is found). Every empirical node state is cross-checked
 * against the closed-form compounding algebra — the test pins the exact +0.1 confidence /
 * ×1.5 half-life rule and breaks if either drifts.
 *
 * PART 4 is the honest finding caught only by running the real primitive: `clusterBySimilarity`
 * (the episodic-summarization dedup grouper) is SINGLE-LINKAGE, so it transitively CHAINS —
 * two facts that are not themselves similar land in one cluster through an intermediary. That
 * is a real over-merge hazard a naive reading misses; this pins it so a future switch to
 * complete-linkage is a deliberate, test-visible decision. See [[memory_compounding_eval]].
 */
import { describe, it, expect } from "vitest";
import { MemoryGraph, InMemoryMemoryStorage, cosineSimilarity, recallRelevantCore } from "../index";
import type { ScoringConfig } from "../index";
import { ConsolidationAction, clusterBySimilarity } from "../consolidation";
import type { ConsolidationProvider } from "../consolidation";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryType, SensitivityLevel, RelationType } from "@motebit/sdk";
import type { MemoryNode } from "@motebit/sdk";

// ── deterministic geometry (same helpers eval 3 uses; not exported, kept local) ──

/** Deterministic RNG (mulberry32) — reproducible runs. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randUnit(D: number, rand: () => number): number[] {
  const v = Array.from({ length: D }, () => rand() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
function orthoUnit(q: number[], rand: () => number): number[] {
  const r = randUnit(q.length, rand);
  const dot = r.reduce((s, x, i) => s + x * q[i]!, 0);
  const u = r.map((x, i) => x - dot * q[i]!);
  const norm = Math.sqrt(u.reduce((s, x) => s + x * x, 0)) || 1;
  return u.map((x) => x / norm);
}
/** An embedding with EXACT cosine `c` to q: c·q + √(1−c²)·u (q ⊥ u, both unit ⇒ unit). */
function atCosine(q: number[], c: number, u: number[]): number[] {
  const s = Math.sqrt(Math.max(0, 1 - c * c));
  return q.map((x, i) => c * x + s * u[i]!);
}

const D = 256;
const DAY = 24 * 60 * 60 * 1000;
const MOTE = "dedup-eval-mote";
const BASE_CONF = 0.85;
const SEMANTIC_HL_DAYS = MemoryGraph.HALF_LIFE_SEMANTIC / DAY; // 30
const MAX_HL_DAYS = MemoryGraph.MAX_HALF_LIFE / DAY; // 365
/** Facts embed ~identically within a subject so they retrieve as neighbors (home=Paris ≈ home=Lyon). */
const WITHIN_SUBJECT_COSINE = 0.99;

/**
 * The decision oracle — the LLM's job in production, stubbed deterministically from structured
 * `subject=value` content. Same subject + same value ⇒ NOOP ("I already know this"); same
 * subject + different value ⇒ UPDATE (the fact changed); novel subject ⇒ ADD. Transparent and
 * grounded in content, so it drives the REAL consolidateAndForm mutation paths.
 */
const subjectOf = (c: string) => c.split("=")[0]!;
const valueOf = (c: string) => c.split("=")[1] ?? "";
const ORACLE: ConsolidationProvider = {
  classify: async (newContent, existing) => {
    const subj = subjectOf(newContent);
    const match = existing.find((e) => subjectOf(e.content) === subj);
    if (!match) return { action: ConsolidationAction.ADD, reason: "novel subject" };
    if (valueOf(match.content) === valueOf(newContent)) {
      return { action: ConsolidationAction.NOOP, existingNodeId: match.node_id, reason: "known" };
    }
    return { action: ConsolidationAction.UPDATE, existingNodeId: match.node_id, reason: "changed" };
  },
};
/** Naive baseline — never consolidates (what eval 1–3 implicitly used). */
const ADD_ALWAYS: ConsolidationProvider = {
  classify: async () => ({ action: ConsolidationAction.ADD, reason: "baseline" }),
};

function freshGraph() {
  const storage = new InMemoryMemoryStorage();
  const graph = new MemoryGraph(storage, new EventStore(new InMemoryEventStore()), MOTE);
  return { storage, graph };
}

/** Insert `subject=value` at cosine ~0.99 to the subject base, through the given oracle. */
async function insert(
  graph: MemoryGraph,
  base: number[],
  content: string,
  provider: ConsolidationProvider,
  rand: () => number,
) {
  const emb = atCosine(base, WITHIN_SUBJECT_COSINE, orthoUnit(base, rand));
  return graph.consolidateAndForm(
    { content, confidence: BASE_CONF, sensitivity: SensitivityLevel.None, source: "user_stated" },
    emb,
    provider,
    SEMANTIC_HL_DAYS * DAY,
  );
}

// Closed-form compounding (REINFORCE/NOOP: confidence += 0.1 cap 1.0, half-life ×= 1.5 cap 365d).
const expectedConf = (n: number) => Math.min(1.0, BASE_CONF + 0.1 * n);
const expectedHlDays = (n: number) => Math.min(MAX_HL_DAYS, SEMANTIC_HL_DAYS * Math.pow(1.5, n));

describe("consolidation/dedup eval — thesis #2 on the consolidation surface", () => {
  it("PART 1 — dedup keeps the graph COMPACT: K restatements collapse to 1 node (vs K under naive append)", async () => {
    const K = 10;
    const rand = mulberry32(101);
    const base = randUnit(D, rand);

    // Consolidating graph: first insert ADDs (no neighbor), the rest NOOP onto it.
    const { storage, graph } = freshGraph();
    for (let i = 0; i < K; i++) await insert(graph, base, "home=Paris", ORACLE, rand);
    const consolidated = await storage.getAllNodes(MOTE);

    // Naive baseline: every restatement is a new node.
    const baseRand = mulberry32(101);
    const base2 = randUnit(D, baseRand);
    const naive = freshGraph();
    for (let i = 0; i < K; i++)
      await insert(naive.graph, base2, "home=Paris", ADD_ALWAYS, baseRand);
    const bloated = await naive.storage.getAllNodes(MOTE);

    // eslint-disable-next-line no-console
    console.log(
      `[dedup] ${K} restatements → consolidated:${consolidated.length} naive:${bloated.length}`,
    );

    expect(consolidated).toHaveLength(1);
    expect(bloated).toHaveLength(K);
    // The one survivor still carries the fact.
    expect(consolidated[0]!.content).toBe("home=Paris");
  }, 60_000);

  it("PART 2 — dedup makes the survivor MORE DURABLE: confidence + half-life compound on the exact closed-form schedule", async () => {
    const INSERTS = 10;
    const rand = mulberry32(202);
    const base = randUnit(D, rand);
    const { storage, graph } = freshGraph();

    const curve: Array<{ n: number; conf: number; hlDays: number; capped: boolean }> = [];
    for (let i = 1; i <= INSERTS; i++) {
      await insert(graph, base, "fav=tea", ORACLE, rand);
      const nodes = await storage.getAllNodes(MOTE);
      expect(nodes).toHaveLength(1); // never bloats, every iteration
      const node = nodes[0]!;
      const n = i - 1; // reinforcements applied = inserts after the initial ADD
      curve.push({
        n,
        conf: Number(node.confidence.toFixed(4)),
        hlDays: Number((node.half_life / DAY).toFixed(2)),
        capped: node.half_life >= MemoryGraph.MAX_HALF_LIFE,
      });
      // ── empirical node state matches the closed-form compounding algebra at every step ──
      expect(node.confidence).toBeCloseTo(expectedConf(n), 6);
      expect(node.half_life / DAY).toBeCloseTo(expectedHlDays(n), 4);
    }

    // eslint-disable-next-line no-console
    console.log("[dedup] compounding curve:", JSON.stringify(curve));

    // ── confidence saturates fast (caps at n=2: 0.85 → 0.95 → 1.0) ──
    expect(curve.find((c) => c.n === 1)!.conf).toBeCloseTo(0.95, 6);
    expect(curve.find((c) => c.n === 2)!.conf).toBeCloseTo(1.0, 6);
    expect(curve.find((c) => c.n === 9)!.conf).toBeCloseTo(1.0, 6);

    // ── half-life grows geometrically, then saturates at the 365-day stability ceiling (n=7) ──
    expect(curve.find((c) => c.n === 6)!.capped).toBe(false); // 30·1.5^6 ≈ 341.7d < 365
    expect(curve.find((c) => c.n === 7)!.capped).toBe(true); //  30·1.5^7 ≈ 512.6d → capped
    expect(curve.find((c) => c.n === 7)!.hlDays).toBeCloseTo(MAX_HL_DAYS, 4);

    // ── half-life is strictly increasing until the cap (durability only grows with exposure) ──
    for (let i = 1; i < curve.length; i++) {
      if (!curve[i - 1]!.capped) expect(curve[i]!.hlDays).toBeGreaterThan(curve[i - 1]!.hlDays);
    }
  }, 60_000);

  it("PART 3 — UPDATE keeps beliefs CURRENT while preserving HISTORY (supersede + as-of recall)", async () => {
    const rand = mulberry32(303);
    const homeBase = randUnit(D, rand);
    const { storage, graph } = freshGraph();

    const { node: paris } = await insert(graph, homeBase, "home=Paris", ORACLE, rand);

    // Age Paris's interval-start 10 days into the past BEFORE the update. consolidateAndForm
    // stamps valid_from (Paris insert) and valid_until (Lyon update) from the real wall clock,
    // and in-test both land in the same millisecond — collapsing Paris's interval to the empty
    // [t, t), for which isValidAt is false at every asOf (confound caught by running; in
    // production a fact changes days apart, so the interval is real). Widen it deterministically.
    const parisAged = (await storage.getNode(paris!.node_id))!;
    const tenDaysAgo = Date.now() - 10 * DAY;
    parisAged.valid_from = tenDaysAgo;
    parisAged.created_at = tenDaysAgo;
    await storage.saveNode(parisAged);

    const lyonEmb = atCosine(homeBase, WITHIN_SUBJECT_COSINE, orthoUnit(homeBase, rand));
    const { node: lyon } = await graph.consolidateAndForm(
      {
        content: "home=Lyon",
        confidence: BASE_CONF,
        sensitivity: SensitivityLevel.None,
        source: "user_stated",
      },
      lyonEmb,
      ORACLE,
      SEMANTIC_HL_DAYS * DAY,
    );

    expect(paris).not.toBeNull();
    expect(lyon).not.toBeNull();

    // ── both nodes persist — supersession is invalidation-with-provenance, NOT deletion ──
    const all = await storage.getAllNodes(MOTE);
    expect(all).toHaveLength(2);

    const parisAfter = (await storage.getNode(paris!.node_id))!;
    expect(parisAfter.tombstoned).toBe(false);
    expect(typeof parisAfter.valid_until).toBe("number"); // interval closed at update time
    expect(lyon!.valid_until ?? null).toBeNull(); // current belief is open-ended
    expect(lyon!.valid_from).toBe(parisAfter.valid_until); // intervals abut exactly (no gap/overlap)

    // ── Supersedes edge records the provenance Lyon → Paris ──
    const edges = await storage.getEdges(lyon!.node_id);
    expect(
      edges.some(
        (e) =>
          e.relation_type === RelationType.Supersedes &&
          (e.target_id === paris!.node_id || e.source_id === paris!.node_id),
      ),
    ).toBe(true);

    // ── as-of-NOW recall returns the CURRENT belief (Lyon), not the stale one (Paris) ──
    const SCORING: ScoringConfig = {
      similarityWeight: 0.5,
      confidenceWeight: 0.3,
      recencyWeight: 0.2,
      recencyHalfLife: DAY,
      overFetchRatio: 5,
    };
    const recall = (options: Record<string, unknown>) =>
      recallRelevantCore({
        storage,
        motebitId: MOTE,
        queryEmbedding: lyonEmb,
        baseScoring: SCORING,
        options: { expandEdges: false, ...options },
      });

    const nowIds = (await recall({})).nodes.map((n) => n.node_id);
    expect(nowIds).toContain(lyon!.node_id);
    expect(nowIds).not.toContain(paris!.node_id);

    // ── as-of-THEN recall (inside Paris's interval) still returns the historical belief ──
    const thenIds = (await recall({ asOf: parisAfter.valid_until! - 1 })).nodes.map(
      (n) => n.node_id,
    );
    expect(thenIds).toContain(paris!.node_id);
    expect(thenIds).not.toContain(lyon!.node_id);
  }, 60_000);

  it("PART 4 — honest finding: clusterBySimilarity is single-linkage, so dedup grouping CHAINS transitively", () => {
    // Three facts laid out by rotation in one plane: A↔B and B↔C are similar (37° apart),
    // but A↔C are NOT (74° apart). Single-linkage merges A–B–C through B even though the
    // endpoints fail the threshold directly — the classic chaining over-merge.
    const THETA = (37 * Math.PI) / 180;
    const THRESHOLD = 0.75;
    const planar = (angle: number): number[] => {
      const v = new Array(D).fill(0);
      v[0] = Math.cos(angle);
      v[1] = Math.sin(angle);
      return v;
    };
    const makeNode = (id: string, embedding: number[]): MemoryNode => ({
      node_id: id,
      motebit_id: MOTE,
      content: id,
      embedding,
      confidence: 0.9,
      sensitivity: SensitivityLevel.None,
      created_at: 0,
      last_accessed: 0,
      half_life: Number.MAX_SAFE_INTEGER,
      tombstoned: false,
      pinned: false,
      memory_type: MemoryType.Semantic,
      valid_from: 0,
      valid_until: null,
    });
    const A = makeNode("A", planar(0));
    const B = makeNode("B", planar(THETA));
    const C = makeNode("C", planar(2 * THETA));

    // The chaining premise is real: consecutive pairs clear the bar, the endpoints do not.
    expect(cosineSimilarity(A.embedding, B.embedding)).toBeGreaterThan(THRESHOLD);
    expect(cosineSimilarity(B.embedding, C.embedding)).toBeGreaterThan(THRESHOLD);
    expect(cosineSimilarity(A.embedding, C.embedding)).toBeLessThan(THRESHOLD);

    // Single-linkage chains A–B–C into ONE cluster despite A and C being dissimilar.
    const chained = clusterBySimilarity([A, B, C], THRESHOLD);
    expect(chained).toHaveLength(1);
    expect(chained[0]!).toHaveLength(3);

    // Control: above the chaining link (θ's cosine), no edge survives → three singletons.
    // Proves the merge above is specifically the chaining effect, not blanket grouping.
    const split = clusterBySimilarity([A, B, C], 0.85);
    expect(split).toHaveLength(3);
  });
});
