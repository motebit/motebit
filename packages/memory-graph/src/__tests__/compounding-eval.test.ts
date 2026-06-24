/**
 * Memory-compounding eval — the first measurement of thesis #2 ("more capable over
 * time"). This iteration answers the GROWTH-rot question in isolation: does retrieval
 * precision HOLD as the memory graph grows, or does a distinct fact get buried as noise
 * accumulates? Drives the REAL pipeline (consolidateAndForm → recallRelevant, with the
 * real recency × confidence × similarity scoring), not mocks.
 *
 * Controlled embeddings (deterministic unit vectors) hold the embedder constant — it is
 * commodity glucose (the metabolic principle), not motebit's contribution — so any
 * precision loss is attributable to the GRAPH mechanics motebit OWNS, not the embedder.
 * To isolate growth from the orthogonal DECAY axis, all facts are kept recent (decay
 * negligible + uniform); the queried fact's cosine-1.0 match should dominate random
 * distractors regardless of graph size, so a precision drop would mean the scoring/graph
 * mechanics bury it. Result (below): they do not.
 *
 * Measurement is NON-INVASIVE: recallRelevant refreshes `last_accessed` on the nodes it
 * returns — which would itself keep the probed facts fresh — so each probe restores the
 * ground-truth facts' `last_accessed` afterward.
 *
 * Named follow-on evals (deliberately out of scope here, so the signal stays clean):
 * (1) DECAY + reinforcement (do unreinforced facts forget on schedule while used/
 * reinforced facts persist — the actual compounding mechanism); (2) the recency-vs-
 * similarity BALANCE under VARIED ages (does a genuinely-old-but-distinct fact survive
 * fresh noise); (3) CONSOLIDATION (this eval always-ADDs; real dedup is untested here).
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

/** A random unit vector in D dimensions — a distinct "topic". */
function randUnit(D: number, rand: () => number): number[] {
  const v = Array.from({ length: D }, () => rand() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

// Realistic embedding dimensionality: at D=16 random unit vectors collide (cosine
// std ≈ 1/sqrt(16) = 0.25), so distractors spuriously rank near a query. Real embedders
// are ~768-dim (random cosine ≈ 0.03), where a distinct fact's cosine-1.0 match should
// dominate — isolating any precision loss to the scoring/graph mechanics, not dimensionality.
const D = 256;
const DAY = 24 * 60 * 60 * 1000;
// MUST be real now: recallRelevant + decay score against `Date.now()`, so a hardcoded
// past constant would make every node appear years old and decay to zero.
const NOW = Date.now();
// Keep ground-truth facts RECENT (within a fraction of their half-life) so confidence
// DECAY is negligible — this isolates the GROWTH-rot question (does graph size bury a
// distinct fact?) from the orthogonal DECAY question (do unreinforced old facts get
// forgotten, which is correct-by-design). A separate eval will cover decay + reinforcement.
const FACT_AGE_DAYS = 1;
// A provider that always ADDs — every candidate becomes a distinct node, so the graph
// grows monotonically (we are measuring growth + aging, not consolidation/dedup here).
const ADD_PROVIDER: ConsolidationProvider = {
  classify: async () => ({ action: "add" as ConsolidationAction, reason: "eval" }),
};

describe("memory-compounding eval", () => {
  it("a distinct fact stays retrievable as the graph grows (growth-rot, decay-isolated)", async () => {
    const rand = mulberry32(1234);
    const storage = new InMemoryMemoryStorage();
    const graph = new MemoryGraph(storage, new EventStore(new InMemoryEventStore()), "eval-mote");

    let count = 0;
    const form = async (embedding: number[], content: string, ageDays: number): Promise<string> => {
      const { node } = await graph.consolidateAndForm(
        { content, confidence: 0.85, sensitivity: SensitivityLevel.None, source: "user_stated" },
        embedding,
        ADD_PROVIDER,
      );
      const n = node!;
      n.created_at = NOW - ageDays * DAY;
      n.last_accessed = n.created_at;
      await storage.saveNode(n);
      count++;
      return n.node_id;
    };

    // 20 ground-truth facts, each a distinct topic, formed recently (decay-isolated).
    const NUM_FACTS = 20;
    const facts: { embedding: number[]; nodeId: string }[] = [];
    for (let i = 0; i < NUM_FACTS; i++) {
      const e = randUnit(D, rand);
      facts.push({ embedding: e, nodeId: await form(e, `ground-truth fact ${i}`, FACT_AGE_DAYS) });
    }

    // Probe precision@5 over the ground-truth facts, restoring their aged last_accessed
    // so the measurement does not itself refresh them (the recency confound).
    const probe = async (): Promise<number> => {
      let hits = 0;
      for (const f of facts) {
        const results = await graph.recallRelevant(f.embedding, { limit: 5 });
        const found = results.find((n) => n.node_id === f.nodeId);
        if (found) {
          hits++;
          found.last_accessed = NOW - FACT_AGE_DAYS * DAY; // restore aged value
          await storage.saveNode(found);
        }
      }
      return hits / facts.length;
    };

    const checkpoints = [NUM_FACTS, 50, 100, 200, 400];
    const curve: { size: number; p5: number }[] = [];
    for (const target of checkpoints) {
      while (count < target) {
        // Distractor noise at ~the same age as the facts (0–2 days) so decay stays
        // uniform — retrieval then turns purely on similarity vs graph size.
        await form(randUnit(D, rand), `distractor ${count}`, FACT_AGE_DAYS);
      }
      curve.push({ size: count, p5: await probe() });
    }

    // eslint-disable-next-line no-console
    console.log("[memory-compounding] precision@5 vs graph size:", JSON.stringify(curve));

    // FINDING (2026-06): precision@5 = 1.0 at every size 20→400 — a distinct fact stays
    // perfectly retrievable as the graph grows. Growth alone does NOT rot retrieval. (The
    // collapse seen at D=16 was a low-dimensional artifact: random distractors collide at
    // cosine std 0.25.) Regression guard: retrieval must not degrade at ANY size — a real
    // rot would drop precision well below this floor.
    for (const point of curve) {
      expect(point.p5).toBeGreaterThanOrEqual(0.9);
    }
  }, 60_000);
});
