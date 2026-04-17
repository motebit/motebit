import { describe, it, expect } from "vitest";
import { getCorpusMetadata, querySelfKnowledge, tokenize } from "../index.js";

/**
 * Behavioral tests for the interior tier. Queries are phrased the way a user
 * would actually ask — the goal is that "what is Motebit?" surfaces the right
 * chunk without any semantic embedding. The corpus is committed, so these
 * assertions are fully deterministic.
 *
 * When adding a new motebit-native concept to any of the four seed docs,
 * add a probe here so a future doc rewrite can't silently drop recall for
 * the landmark terms.
 */

describe("querySelfKnowledge — happy-path queries", () => {
  it("returns no hits on an empty or pure-stopword query", () => {
    expect(querySelfKnowledge("")).toEqual([]);
    expect(querySelfKnowledge("the and of")).toEqual([]);
  });

  it("ranks the motebit-definition chunk first for 'what is motebit'", () => {
    const hits = querySelfKnowledge("what is motebit", { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    // README's top chunk literally starts with the title "Motebit" and the
    // definition — it must win over thematic satellites for this query.
    const top = hits[0]!;
    expect(top.source).toBe("README.md");
    expect(top.content.toLowerCase()).toContain("motebit");
  });

  it("pulls 'sovereign interior' content when the query mentions it", () => {
    const hits = querySelfKnowledge("sovereign interior identity", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    const fromSovereign = hits.filter((h) => h.source === "THE_SOVEREIGN_INTERIOR.md");
    expect(fromSovereign.length).toBeGreaterThan(0);
  });

  it("pulls the metabolic-principle doc when asked about 'metabolic' or 'enzyme'", () => {
    const hits = querySelfKnowledge("metabolic enzyme", { limit: 5 });
    expect(hits.some((h) => h.source === "THE_METABOLIC_PRINCIPLE.md")).toBe(true);
  });

  it("pulls the droplet doc when asked about the physics of form", () => {
    const hits = querySelfKnowledge("droplet physics form surface tension", { limit: 5 });
    expect(hits.some((h) => h.source === "DROPLET.md")).toBe(true);
  });

  it("respects the minScore cutoff", () => {
    // High cutoff should eliminate all but the most lexically dense match.
    const tight = querySelfKnowledge("motebit", { minScore: 100 });
    expect(tight.length).toBe(0);
    // Loose default cutoff still returns top-k.
    const loose = querySelfKnowledge("motebit", { limit: 2 });
    expect(loose.length).toBeGreaterThan(0);
  });

  it("caps results by limit", () => {
    const limited = querySelfKnowledge("motebit sovereign identity", { limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });
});

describe("tokenize — determinism", () => {
  it("is case-insensitive and lowercases output", () => {
    expect(tokenize("Motebit IS a Droplet")).toEqual(["motebit", "droplet"]);
  });

  it("drops stopwords but keeps motebit-native terms", () => {
    const tokens = tokenize("the motebit is a sovereign droplet of intelligence");
    expect(tokens).toContain("motebit");
    expect(tokens).toContain("sovereign");
    expect(tokens).toContain("droplet");
    expect(tokens).toContain("intelligence");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("is");
    expect(tokens).not.toContain("a");
    expect(tokens).not.toContain("of");
  });

  it("splits on non-word punctuation", () => {
    expect(tokenize("motebit.com — open-protocol!")).toEqual([
      "motebit",
      "com",
      "open",
      "protocol",
    ]);
  });
});

describe("corpus metadata", () => {
  it("exposes a stable source hash and chunk count", () => {
    const meta = getCorpusMetadata();
    expect(meta.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.totalDocuments).toBeGreaterThan(0);
    expect(meta.averageLength).toBeGreaterThan(0);
    // generatedAt is deterministic — tied to the source hash, not wall clock.
    expect(meta.generatedAt.startsWith("sha256:")).toBe(true);
  });
});
