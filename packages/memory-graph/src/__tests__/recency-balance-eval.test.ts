/**
 * Recency-vs-similarity balance eval — the THIRD thesis-#2 measurement, on a different
 * surface than the first two. Eval 1 (compounding) showed growth doesn't rot retrieval;
 * eval 2 (decay-reinforcement) measured the FORGET/prune schedule via auditMemoryGraph.
 * This one measures the RANKING balance inside `recallRelevant`: when a query is relevant
 * to a genuinely-relevant-but-STALE memory AND the graph also holds FRESH low-relevance
 * noise, does the relevant memory keep its top-k slot, or does freshness bury it?
 *
 * The real scoring (recallRelevantCore) is a fixed blend — `similarity·0.5 +
 * decayedConfidence·0.3 + recencyBoost·0.2` — where recencyBoost = 0.5^(daysSinceAccess/1)
 * (a ONE-DAY half-life: recency is a strong but short-lived signal) and decayedConfidence
 * fades over the node's half_life (30d semantic). A pure-similarity ranker would ignore
 * freshness (surfacing stale info over corrections); a recency-first ranker would bury a
 * clearly-relevant memory under any fresh chatter. The balance should be neither.
 *
 * Method (drives the REAL pipeline): controlled embeddings give each node an EXACT cosine
 * to the query (e = c·q + √(1−c²)·u, u ⊥ q ⇒ dotProduct = c exactly, D=256 so there is no
 * low-dim collision). A fresh graph is built per measurement and probed ONCE — because the
 * public recallRelevant refreshes last_accessed on what it returns, repeated probing of one
 * graph would contaminate recency. Ages are kept where the stale target stays a valid
 * candidate (decayed confidence > the 0.1 floor), so any drop is a RANKING effect (this
 * eval's surface), not the candidacy/prune filter (eval 2's surface). Every empirical
 * ranking is cross-checked against the closed-form weight algebra — so the test pins the
 * exact balance point and breaks if any weight or half-life drifts.
 *
 * Integration note (NOT measured here, to keep the signal clean): reinforcement (eval 2)
 * resets last_accessed and raises confidence — so re-using a memory restores the rank this
 * eval shows it losing. The protection window measured below is the UNREINFORCED window;
 * reinforcement is what extends it. See [[memory_compounding_eval]].
 */
import { describe, it, expect } from "vitest";
import { MemoryGraph, InMemoryMemoryStorage } from "../index";
import { ConsolidationAction } from "../index";
import type { ConsolidationProvider } from "../consolidation";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { SensitivityLevel } from "@motebit/sdk";

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

/** A random unit vector in D dimensions. */
function randUnit(D: number, rand: () => number): number[] {
  const v = Array.from({ length: D }, () => rand() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** A unit vector orthogonal to q (Gram-Schmidt: strip q's component from a random vector). */
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
const NOW = Date.now();
const SEMANTIC_HL_DAYS = MemoryGraph.HALF_LIFE_SEMANTIC / DAY; // 30
const RECENCY_HL_DAYS = 1; // DEFAULT_SCORING_CONFIG.recencyHalfLife = 24h
const BASE_CONF = 0.85;
const ADD_PROVIDER: ConsolidationProvider = {
  classify: async () => ({ action: ConsolidationAction.ADD, reason: "eval" }),
};

/** The real scoring blend, closed form — what recallRelevantCore computes per node. */
function predictedScore(spec: {
  cosine: number;
  ageDays: number; // age of the node (created_at), drives confidence decay
  lastAccessDays: number; // days since last_accessed, drives recency
  confidence?: number;
  halfLifeDays?: number;
}): number {
  const conf = spec.confidence ?? BASE_CONF;
  const hl = spec.halfLifeDays ?? SEMANTIC_HL_DAYS;
  const decayed = conf * Math.pow(0.5, spec.ageDays / hl);
  const recency = Math.pow(0.5, spec.lastAccessDays / RECENCY_HL_DAYS);
  return 0.5 * spec.cosine + 0.3 * decayed + 0.2 * recency;
}

interface NodeSpec {
  label: string;
  cosine: number;
  ageDays: number;
  lastAccessDays?: number; // defaults to ageDays (never re-accessed)
  confidence?: number;
  halfLifeDays?: number;
}

/**
 * Build a fresh graph from specs (controlled cosine + age), probe ONCE for q, and return
 * the ranked label order (top first) plus each label's rank. Total nodes are kept ≤ the
 * candidate pool (limit×5) so pool selection never truncates — the score ranking decides.
 */
async function rankFor(q: number[], specs: NodeSpec[], rand: () => number, limit = 5) {
  const storage = new InMemoryMemoryStorage();
  const graph = new MemoryGraph(storage, new EventStore(new InMemoryEventStore()), "eval-mote");

  const labelToId = new Map<string, string>();
  for (const spec of specs) {
    const emb = atCosine(q, spec.cosine, orthoUnit(q, rand));
    const { node } = await graph.consolidateAndForm(
      {
        content: spec.label,
        confidence: spec.confidence ?? BASE_CONF,
        sensitivity: SensitivityLevel.None,
        source: "user_stated",
      },
      emb,
      ADD_PROVIDER,
      (spec.halfLifeDays ?? SEMANTIC_HL_DAYS) * DAY,
    );
    labelToId.set(spec.label, node!.node_id);
  }

  // Patch temporal fields LAST so the internal recallRelevant refreshes during formation
  // are overwritten — created_at drives confidence decay, last_accessed drives recency.
  for (const spec of specs) {
    const n = (await storage.getNode(labelToId.get(spec.label)!))!;
    n.created_at = NOW - spec.ageDays * DAY;
    n.last_accessed = NOW - (spec.lastAccessDays ?? spec.ageDays) * DAY;
    n.confidence = spec.confidence ?? BASE_CONF;
    await storage.saveNode(n);
  }

  const results = await graph.recallRelevant(q, { limit });
  const order = results.map((n) => {
    for (const [label, id] of labelToId) if (id === n.node_id) return label;
    return "?";
  });
  const rankOf = (label: string) => order.indexOf(label);
  return { order, rankOf };
}

/** 8 fresh, near-irrelevant noise nodes (≥ limit, so a beaten target drops out of top-k). */
function freshNoise(cosine = 0.15): NodeSpec[] {
  return Array.from({ length: 8 }, (_, i) => ({ label: `noise${i}`, cosine, ageDays: 0 }));
}

describe("recency-vs-similarity balance eval", () => {
  it("PART 1 — relevance is respected: a clearly-relevant stale memory beats fresh noise", async () => {
    const rand = mulberry32(7);
    const q = randUnit(D, rand);
    // Target: cosine 0.85 (clearly relevant), aged 5d → its recency boost is ~gone (0.5^5),
    // yet it must still outrank fresh low-relevance noise. A recency-first ranker would fail.
    const { rankOf } = await rankFor(
      q,
      [{ label: "target", cosine: 0.85, ageDays: 5 }, ...freshNoise()],
      rand,
    );
    expect(rankOf("target")).toBe(0);
    // Algebra agrees: stale-relevant score exceeds fresh-noise score.
    expect(predictedScore({ cosine: 0.85, ageDays: 5, lastAccessDays: 5 })).toBeGreaterThan(
      predictedScore({ cosine: 0.15, ageDays: 0, lastAccessDays: 0 }),
    );
  });

  it("PART 2 — recency breaks a near-tie: among comparably-relevant memories, the fresh one wins", async () => {
    const rand = mulberry32(11);
    const q = randUnit(D, rand);
    // Two near-equally-relevant memories; the STALE one is even slightly MORE relevant.
    // A pure-similarity ranker would surface the stale one; the balance surfaces the fresh one.
    const { rankOf } = await rankFor(
      q,
      [
        { label: "stale-relevant", cosine: 0.7, ageDays: 3 },
        { label: "fresh-similar", cosine: 0.68, ageDays: 0 },
      ],
      rand,
    );
    expect(rankOf("fresh-similar")).toBeLessThan(rankOf("stale-relevant"));
    expect(predictedScore({ cosine: 0.68, ageDays: 0, lastAccessDays: 0 })).toBeGreaterThan(
      predictedScore({ cosine: 0.7, ageDays: 3, lastAccessDays: 3 }),
    );
  });

  it("PART 3 — the protection window: a stale relevant memory loses to fresh noise on a schedule the weights predict", async () => {
    const baseRand = mulberry32(23);
    const q = randUnit(D, baseRand);
    const ages = [0, 10, 20, 30, 40, 50, 60];
    const noiseScore = predictedScore({ cosine: 0.15, ageDays: 0, lastAccessDays: 0 });

    const curve: Array<{
      ageDays: number;
      inTopK: boolean;
      predictedWin: boolean;
      targetScore: number;
    }> = [];
    for (const ageDays of ages) {
      // Fresh rng per age → fresh graph, single probe (no recency contamination).
      const rand = mulberry32(1000 + ageDays);
      const { rankOf } = await rankFor(
        q,
        [{ label: "target", cosine: 0.85, ageDays }, ...freshNoise()],
        rand,
      );
      const targetScore = predictedScore({ cosine: 0.85, ageDays, lastAccessDays: ageDays });
      curve.push({
        ageDays,
        inTopK: rankOf("target") >= 0,
        predictedWin: targetScore > noiseScore,
        targetScore: Number(targetScore.toFixed(4)),
      });
    }

    // eslint-disable-next-line no-console
    console.log(
      "[recency-balance] noiseScore:",
      noiseScore.toFixed(4),
      "window:",
      JSON.stringify(curve),
    );

    // ── The empirical ranking matches the closed-form weight algebra at EVERY age ──
    // (the strong regression guard — breaks if any weight or half-life drifts).
    for (const point of curve) {
      expect(point.inTopK).toBe(point.predictedWin);
    }

    // ── A clearly-relevant memory IS protected for a real window (not buried immediately) ──
    expect(curve.find((c) => c.ageDays === 0)!.inTopK).toBe(true);
    expect(curve.find((c) => c.ageDays === 30)!.inTopK).toBe(true);

    // ── …but the window is FINITE: unreinforced, it eventually loses to fresh noise ──
    // (the honest finding — and exactly what reinforcement, eval 2, exists to prevent).
    expect(curve.find((c) => c.ageDays === 60)!.inTopK).toBe(false);

    // ── Monotonic: target score only falls with age (no ranking non-monotonicity) ──
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.targetScore).toBeLessThanOrEqual(curve[i - 1]!.targetScore + 1e-9);
    }

    // ── Candidacy sanity: at the crossover the target is still a valid candidate
    //    (decayed confidence > 0.1 floor) — so this is a RANKING loss, not a prune. ──
    const crossover = curve.find((c) => !c.inTopK)!.ageDays;
    expect(BASE_CONF * Math.pow(0.5, crossover / SEMANTIC_HL_DAYS)).toBeGreaterThan(0.1);
  }, 60_000);
});
