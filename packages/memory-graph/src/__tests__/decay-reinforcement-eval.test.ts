/**
 * Decay + reinforcement eval — the POSITIVE half of thesis #2 ("more capable over
 * time"). The growth-rot eval (compounding-eval.test.ts) proved the NEGATIVE: graph
 * growth alone does not rot retrieval. This proves the positive mechanism — the interior
 * gets more capable not by hoarding everything, but by FORGETTING the unused on schedule
 * while REINFORCEMENT keeps the used alive far longer. That asymmetry is what makes
 * accumulated memory bounded-yet-compounding instead of an ever-growing junk drawer.
 *
 * Drives the REAL pipeline, not mocks:
 *  - reinforcement via the production REINFORCE branch of `consolidateAndForm`
 *    (confidence += 0.1 capped 1.0, half_life *= 1.5 capped 365d, last_accessed = now);
 *  - "forgetting" via the canonical `auditMemoryGraph` → `nearDeath` classifier
 *    (decayed confidence in (0, 0.15) = "about to be pruned by housekeeping"), which
 *    runs the real `computeDecayedConfidence(confidence, half_life, now - created_at)`.
 *
 * Two cohorts, IDENTICAL except reinforcement history, both born `age` ago:
 *  - U (unreinforced): never touched — confidence 0.85, half_life = 30d (semantic).
 *  - R (reinforced): the same fact, reinforced K times over its life (drives the real
 *    branch K times) — confidence saturates to 1.0, half_life stretches to ~228d.
 * We sweep `age` and measure each cohort's decayed confidence + alive fraction. Embeddings
 * are distinct (D=256, near-orthogonal) but the audit ignores them — survival turns purely
 * on the decay/reinforcement mechanics motebit OWNS, so any signal is attributable to them.
 *
 * Named follow-on (out of scope to keep THIS signal clean): the recency-vs-similarity
 * BALANCE in retrieval ranking under competition (does a genuinely-old-but-distinct fact
 * lose its top-k slot to fresher noise) — that exercises recallRelevant's scoring, a
 * different surface than the forget/prune schedule measured here. See [[memory_compounding_eval]].
 */
import { describe, it, expect } from "vitest";
import { MemoryGraph, InMemoryMemoryStorage, auditMemoryGraph } from "../index";
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

const D = 256;
const DAY = 24 * 60 * 60 * 1000;
// MUST be real now: auditMemoryGraph + decay score against `Date.now()`, so a hardcoded
// past constant would make every node appear years old (the time-base bug from the
// growth eval). created_at is set relative to THIS captured value.
const NOW = Date.now();
const NEAR_DEATH = 0.15; // auditMemoryGraph's default near-death threshold.
const COHORT = 16; // facts per cohort.
const K = 5; // reinforcements applied to the R cohort over its life.
// A provider that ADDs the first observation of each fact.
const ADD_PROVIDER: ConsolidationProvider = {
  classify: async () => ({ action: ConsolidationAction.ADD, reason: "eval" }),
};
// A provider that REINFORCEs a specific existing node — drives the production branch.
const reinforceProvider = (targetId: string): ConsolidationProvider => ({
  classify: async () => ({
    action: ConsolidationAction.REINFORCE,
    existingNodeId: targetId,
    reason: "eval-reinforce",
  }),
});

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Build a fresh graph aged `ageDays`: COHORT unreinforced + COHORT reinforced facts,
 * all born `ageDays` ago. Returns each cohort's decayed confidences (from the REAL
 * auditMemoryGraph scan) plus the realized (confidence, half_life) so we can prove the
 * reinforce mechanism actually fired.
 */
async function cohortsAt(ageDays: number, rand: () => number) {
  const storage = new InMemoryMemoryStorage();
  const graph = new MemoryGraph(storage, new EventStore(new InMemoryEventStore()), "eval-mote");
  const semanticHalfLife = MemoryGraph.HALF_LIFE_SEMANTIC;

  const formFact = async (content: string): Promise<string> => {
    const { node } = await graph.consolidateAndForm(
      { content, confidence: 0.85, sensitivity: SensitivityLevel.None, source: "user_stated" },
      randUnit(D, rand),
      ADD_PROVIDER,
      semanticHalfLife, // pin the base half-life so U's schedule is deterministic.
    );
    return node!.node_id;
  };

  const unreinforced: string[] = [];
  const reinforced: string[] = [];
  for (let i = 0; i < COHORT; i++) unreinforced.push(await formFact(`unreinforced ${i}`));
  for (let i = 0; i < COHORT; i++) {
    const id = await formFact(`reinforced ${i}`);
    // Reinforce K times over the fact's life — the REAL production branch each time.
    for (let k = 0; k < K; k++) {
      const n = (await storage.getNode(id))!;
      await graph.consolidateAndForm(
        {
          content: n.content,
          confidence: 0.85,
          sensitivity: SensitivityLevel.None,
          source: "user_stated",
        },
        n.embedding,
        reinforceProvider(id),
        semanticHalfLife,
      );
    }
    reinforced.push(id);
  }

  // Backdate BOTH cohorts to a common birth `ageDays` ago. Reinforcement bumps
  // confidence + half_life but never created_at, so the decay clock runs from birth
  // for both — the honest model (reinforcement slows the rate, it doesn't reset age).
  const bornAt = NOW - ageDays * DAY;
  for (const id of [...unreinforced, ...reinforced]) {
    const n = (await storage.getNode(id))!;
    n.created_at = bornAt;
    await storage.saveNode(n);
  }

  const all = await storage.getAllNodes("eval-mote");
  const audit = auditMemoryGraph(all, [], { limit: 1000 });
  const nearDeathIds = new Set(audit.nearDeath.map((d) => d.node.node_id));
  const decayedOf = new Map(audit.nearDeath.map((d) => [d.node.node_id, d.decayedConfidence]));

  // For nodes NOT flagged near-death we still want their decayed value for the log;
  // recompute from the real formula for the alive ones.
  const decayedFor = (id: string): number => {
    if (decayedOf.has(id)) return decayedOf.get(id)!;
    const n = all.find((x) => x.node_id === id)!;
    return n.confidence * Math.pow(0.5, (NOW - n.created_at) / n.half_life);
  };

  const summarize = (ids: string[]) => ({
    aliveFrac: ids.filter((id) => !nearDeathIds.has(id)).length / ids.length,
    medDecayed: median(ids.map(decayedFor)),
  });

  const sampleU = (await storage.getNode(unreinforced[0]!))!;
  const sampleR = (await storage.getNode(reinforced[0]!))!;
  return {
    u: summarize(unreinforced),
    r: summarize(reinforced),
    // Proof the reinforce mechanism fired (guards against a silent no-op regression).
    uHalfLifeDays: sampleU.half_life / DAY,
    rHalfLifeDays: sampleR.half_life / DAY,
    uConfidence: sampleU.confidence,
    rConfidence: sampleR.confidence,
  };
}

describe("decay + reinforcement eval", () => {
  it("forgets the unused on schedule while reinforcement keeps the used alive far longer", async () => {
    const rand = mulberry32(4242);
    const ages = [30, 90, 180, 365, 730];
    const curve: Array<{
      ageDays: number;
      uAlive: number;
      rAlive: number;
      uDecayed: number;
      rDecayed: number;
    }> = [];
    let mechanism: {
      uHalfLifeDays: number;
      rHalfLifeDays: number;
      uConfidence: number;
      rConfidence: number;
    } | null = null;
    for (const age of ages) {
      const res = await cohortsAt(age, rand);
      mechanism ??= res;
      curve.push({
        ageDays: age,
        uAlive: res.u.aliveFrac,
        rAlive: res.r.aliveFrac,
        uDecayed: Number(res.u.medDecayed.toFixed(4)),
        rDecayed: Number(res.r.medDecayed.toFixed(4)),
      });
    }

    // eslint-disable-next-line no-console
    console.log("[decay-reinforcement] mechanism:", JSON.stringify(mechanism));
    // eslint-disable-next-line no-console
    console.log("[decay-reinforcement] survival vs age:", JSON.stringify(curve));

    const at = (age: number) => curve.find((c) => c.ageDays === age)!;

    // ── Mechanism fired (guards against a silent reinforce no-op) ──
    // Reinforcement must measurably raise confidence AND stretch half-life.
    expect(mechanism!.rConfidence).toBeGreaterThan(mechanism!.uConfidence);
    expect(mechanism!.rHalfLifeDays).toBeGreaterThan(mechanism!.uHalfLifeDays * 2);

    // ── Young: nothing forgotten yet — both cohorts fully alive ──
    expect(at(30).uAlive).toBe(1);
    expect(at(30).rAlive).toBe(1);

    // ── Forgetting works on schedule: the UNUSED cohort fades to near-death ──
    // By ~6 half-lives (180d, half-life 30d) the unreinforced facts are all near-death.
    expect(at(180).uAlive).toBe(0);
    expect(at(180).uDecayed).toBeLessThan(NEAR_DEATH);

    // ── The compounding gap: REINFORCED facts persist where unused ones are gone ──
    expect(at(180).rAlive).toBe(1);
    expect(at(365).rAlive).toBe(1);
    expect(at(365).rDecayed).toBeGreaterThan(NEAR_DEATH);

    // ── The gap is real at every mid/late age (reinforced strictly out-survives unused) ──
    for (const age of [90, 180, 365]) {
      expect(at(age).rDecayed).toBeGreaterThan(at(age).uDecayed);
      expect(at(age).rAlive).toBeGreaterThanOrEqual(at(age).uAlive);
    }

    // ── Honesty floor: nothing is immortal. Even reinforced facts eventually fade —
    // reinforcement buys longevity, it is not a `pinned` exemption from decay. ──
    expect(at(730).rAlive).toBeLessThan(1);

    // ── Monotonic forgetting: decayed confidence never rises with age (no clock reset) ──
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.uDecayed).toBeLessThanOrEqual(curve[i - 1]!.uDecayed + 1e-9);
      expect(curve[i]!.rDecayed).toBeLessThanOrEqual(curve[i - 1]!.rDecayed + 1e-9);
    }
  }, 60_000);
});
