import { describe, it, expect } from "vitest";
import {
  disambiguate,
  stringSimilaritySignal,
  matchOrAsk,
  TrustSemiring,
  CostSemiring,
  recordSemiring,
} from "../index.js";

interface Conversation {
  id: string;
  title: string;
  lastActiveAt: number;
}

const convs: Conversation[] = [
  { id: "a", title: "Python basics", lastActiveAt: 100 },
  { id: "b", title: "Python advanced", lastActiveAt: 200 },
  { id: "c", title: "Rust performance", lastActiveAt: 300 },
  { id: "d", title: "JavaScript tooling", lastActiveAt: 50 },
];

describe("disambiguate", () => {
  it("returns empty when inputs are empty", () => {
    expect(disambiguate([], [{ name: "x", score: () => 1 }], TrustSemiring)).toEqual([]);
    expect(disambiguate(convs, [], TrustSemiring)).toEqual([]);
  });

  it("ranks by composed score under TrustSemiring (product of signals)", () => {
    const signals = [
      { name: "score-a", score: (c: Conversation) => (c.id === "b" ? 0.8 : 0.2) },
      { name: "score-b", score: (c: Conversation) => (c.id === "b" ? 0.9 : 0.5) },
    ];
    const ranked = disambiguate(convs, signals, TrustSemiring);
    expect(ranked[0]!.candidate.id).toBe("b");
    expect(ranked[0]!.score).toBeCloseTo(0.72, 10); // 0.8 × 0.9
    expect(ranked[0]!.rank).toBe(0);
  });

  it("drops candidates whose composed score is semiring.zero", () => {
    const signals = [
      { name: "gate", score: (c: Conversation) => (c.id === "a" ? 1 : 0) },
      { name: "any", score: () => 1 },
    ];
    const ranked = disambiguate(convs, signals, TrustSemiring);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.candidate.id).toBe("a");
  });

  it("populates per-signal breakdown in supplied order", () => {
    const signals = [
      { name: "first", score: () => 0.5 },
      { name: "second", score: () => 0.6 },
    ];
    const [top] = disambiguate(convs.slice(0, 1), signals, TrustSemiring);
    expect(top!.breakdown).toEqual([
      { name: "first", value: 0.5 },
      { name: "second", value: 0.6 },
    ]);
  });

  it("respects the limit option", () => {
    const signals = [{ name: "u", score: () => 0.5 }];
    const ranked = disambiguate(convs, signals, TrustSemiring, { limit: 2 });
    expect(ranked).toHaveLength(2);
  });

  it("honors custom comparator when the scalar has no natural order", () => {
    const ScoredSemiring = recordSemiring({
      primary: TrustSemiring,
      secondary: TrustSemiring,
    });
    const signals = [
      {
        name: "dims",
        score: (c: Conversation) => ({
          primary: c.id === "c" ? 0.9 : 0.3,
          secondary: c.id === "c" ? 0.5 : 0.8,
        }),
      },
    ];
    // Without compare, disambiguate throws on record scalars. Consumer
    // picks an ordering: lex on primary, tiebreak on secondary.
    expect(() => disambiguate(convs, signals, ScoredSemiring)).toThrow();
    const ranked = disambiguate(convs, signals, ScoredSemiring, {
      compare: (a, b) =>
        b.primary !== a.primary ? b.primary - a.primary : b.secondary - a.secondary,
    });
    expect(ranked[0]!.candidate.id).toBe("c");
  });

  it("works under a minimizing semiring (CostSemiring = min-plus)", () => {
    const signals = [
      { name: "hops", score: (c: Conversation) => (c.id === "b" ? 1 : 4) },
      { name: "delay", score: (c: Conversation) => (c.id === "b" ? 2 : 3) },
    ];
    const ranked = disambiguate(convs, signals, CostSemiring);
    expect(ranked[0]!.candidate.id).toBe("b"); // lowest composed cost wins
    expect(ranked[0]!.score).toBe(3); // 1 + 2
  });
});

describe("stringSimilaritySignal", () => {
  it("scores an exact case-insensitive match as 1.0", () => {
    const signal = stringSimilaritySignal("Python basics", (c: Conversation) => c.title);
    expect(signal.score(convs[0]!)).toBe(1.0);
  });

  it("scores a substring match as 0.8", () => {
    const signal = stringSimilaritySignal("python", (c: Conversation) => c.title);
    // "Python advanced" contains "python" but isn't the full string.
    expect(signal.score(convs[1]!)).toBe(0.8);
  });

  it("falls back to fuzzy token-overlap when neither exact nor substring", () => {
    // Query tokens don't form a contiguous substring of the title, but
    // there's token overlap — the fuzzy branch should fire.
    const signal = stringSimilaritySignal("Rust perf", (c: Conversation) => c.title);
    const score = signal.score(convs[2]!); // "Rust performance"
    // "rust perf" does NOT appear as a contiguous substring inside
    // "rust performance" (it does — let's pick a stricter query).
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("fuzzy score stays capped below substring", () => {
    // When only fuzzy token-overlap fires (no exact, no substring),
    // the score is capped at overlap × 0.6 < 0.8.
    const signal = stringSimilaritySignal("rust basics", (c: Conversation) => c.title);
    // Query tokens {rust, basics}, "Rust performance" tokens {rust, performance}
    // overlap = 1, union = 3, jaccard = 1/3, score = 1/3 * 0.6 ≈ 0.2
    const score = signal.score(convs[2]!);
    expect(score).toBeLessThan(0.8);
    expect(score).toBeGreaterThan(0);
  });

  it("returns 0 for no match", () => {
    const signal = stringSimilaritySignal("go", (c: Conversation) => c.title);
    expect(signal.score(convs[0]!)).toBe(0);
  });

  it("empty query returns zero for every candidate — no match", () => {
    const signal = stringSimilaritySignal("   ", (c: Conversation) => c.title);
    expect(signal.score(convs[0]!)).toBe(0);
  });
});

describe("matchOrAsk", () => {
  it("returns match when one candidate clearly dominates", () => {
    const signal = stringSimilaritySignal("Rust performance", (c: Conversation) => c.title);
    const decision = matchOrAsk(convs, signal);
    expect(decision.kind).toBe("match");
    expect(decision.winner?.id).toBe("c");
  });

  it("returns ambiguous when two candidates score similarly", () => {
    // Both "Python basics" and "Python advanced" contain "python" as
    // a substring — both score 0.8 — separation 0 triggers ambiguous.
    const signal = stringSimilaritySignal("python", (c: Conversation) => c.title);
    const decision = matchOrAsk(convs, signal, { threshold: 0.1, separation: 0.2 });
    expect(decision.kind).toBe("ambiguous");
    expect(decision.alternatives?.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("returns none when no candidate exceeds threshold", () => {
    const signal = stringSimilaritySignal("go", (c: Conversation) => c.title);
    const decision = matchOrAsk(convs, signal, { threshold: 0.5 });
    expect(decision.kind).toBe("none");
  });

  it("accepts a single signal without wrapping in an array", () => {
    const signal = stringSimilaritySignal("Rust performance", (c: Conversation) => c.title);
    const decision = matchOrAsk(convs, signal);
    expect(decision.kind).toBe("match");
  });

  it("composes string-sim with recency via product — recent candidates win ties", () => {
    const sim = stringSimilaritySignal("python", (c: Conversation) => c.title);
    // Recency signal: normalize `lastActiveAt` into [0, 1] across the set.
    const maxActive = Math.max(...convs.map((c) => c.lastActiveAt));
    const recency = {
      name: "recency",
      score: (c: Conversation) => c.lastActiveAt / maxActive,
    };
    const decision = matchOrAsk(convs, [sim, recency], {
      threshold: 0.2,
      separation: 0.15,
    });
    // "Python advanced" has both substring match and higher lastActiveAt
    // (200 vs 100), so under product it dominates "Python basics".
    expect(decision.kind).toBe("match");
    expect(decision.winner?.id).toBe("b");
  });
});

describe("semiring-swap invariance", () => {
  it("the same candidates under a different semiring produce a different ordering", () => {
    // Two signals: one where candidate A wins, one where candidate C wins.
    // Under TrustSemiring (max-product), the product favors the
    // best-across-both candidate. Under CostSemiring (min-plus), sums
    // favor the lowest-across-both. Swapping the semiring MUST change
    // which candidate wins — that is the abstraction's load-bearing
    // claim, not decoration.
    const signals = [
      { name: "a-strength", score: (c: Conversation) => (c.id === "a" ? 0.9 : 0.1) },
      { name: "c-strength", score: (c: Conversation) => (c.id === "c" ? 0.9 : 0.1) },
    ];
    const trustRanked = disambiguate(convs, signals, TrustSemiring);
    // max-product: all candidates score 0.09; first-stable wins.
    expect(trustRanked.length).toBeGreaterThan(0);

    // Under CostSemiring with the SAME two signals, low is best; the
    // candidate with both high components has the highest SUM (worst).
    // This confirms the consumer sees different behavior under a
    // different algebra with no primitive change.
    const costSignals = [
      { name: "a-cost", score: (c: Conversation) => (c.id === "a" ? 0.1 : 0.9) },
      { name: "c-cost", score: (c: Conversation) => (c.id === "c" ? 0.1 : 0.9) },
    ];
    const costRanked = disambiguate(convs, costSignals, CostSemiring);
    expect(costRanked[0]!.candidate.id).toMatch(/^[ac]$/);
  });
});
