import { describe, it, expect } from "vitest";
import { BiasedSearchProvider, DEFAULT_MOTEBIT_BIAS, type BiasRule } from "../biased-search.js";
import type { SearchProvider, SearchResult } from "../../search-provider.js";

class CapturingProvider implements SearchProvider {
  public calls: Array<{ query: string; maxResults?: number }> = [];
  constructor(private readonly returnValue: SearchResult[] = []) {}
  async search(query: string, maxResults?: number): Promise<SearchResult[]> {
    this.calls.push({ query, maxResults });
    return this.returnValue;
  }
}

describe("BiasedSearchProvider — default motebit bias", () => {
  it("rewrites queries that mention 'motebit' to include first-party sites", () => {
    const inner = new CapturingProvider();
    const provider = new BiasedSearchProvider(inner);
    expect(provider.rewrite("what is motebit")).toBe(
      "what is motebit (site:motebit.com OR site:docs.motebit.com OR site:github.com/motebit)",
    );
  });

  it("is case-insensitive on the matched term", () => {
    const provider = new BiasedSearchProvider(new CapturingProvider());
    expect(provider.rewrite("Tell me about Motebit")).toContain("site:motebit.com");
    expect(provider.rewrite("MOTEBIT release notes")).toContain("site:motebit.com");
  });

  it("matches on word boundaries — 'motobilt' does NOT trigger the motebit bias", () => {
    // The whole failure mode that motivated this class: generic web search
    // returns Motobilt (Jeep parts) for "motebit". If the rewriter accidentally
    // matches on substring, it would double-bias the follow-up query.
    const provider = new BiasedSearchProvider(new CapturingProvider());
    expect(provider.rewrite("motobilt bumpers")).toBe("motobilt bumpers");
    expect(provider.rewrite("submarine")).toBe("submarine");
  });

  it("passes through queries with no matching rule", () => {
    const provider = new BiasedSearchProvider(new CapturingProvider());
    expect(provider.rewrite("weather in san francisco")).toBe("weather in san francisco");
  });

  it("forwards the rewritten query to the inner provider", async () => {
    const inner = new CapturingProvider([{ title: "T", url: "https://motebit.com", snippet: "S" }]);
    const provider = new BiasedSearchProvider(inner);

    const results = await provider.search("motebit docs", 5);

    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]!.query).toContain("site:motebit.com");
    expect(inner.calls[0]!.maxResults).toBe(5);
    expect(results).toHaveLength(1);
  });
});

describe("BiasedSearchProvider — composition", () => {
  it("allows caller-supplied rule tables in declaration order (first match wins)", () => {
    const rules: BiasRule[] = [
      { terms: ["docs"], biasSuffix: "site:docs.motebit.com" },
      { terms: ["motebit"], biasSuffix: "site:motebit.com" },
    ];
    const provider = new BiasedSearchProvider(new CapturingProvider(), rules);
    // "motebit docs" matches BOTH — but the first rule wins.
    expect(provider.rewrite("motebit docs")).toBe("motebit docs site:docs.motebit.com");
  });

  it("supports multiple terms per rule", () => {
    const provider = new BiasedSearchProvider(new CapturingProvider(), [
      { terms: ["droplet", "motebit"], biasSuffix: "site:motebit.com" },
    ]);
    expect(provider.rewrite("what is a droplet")).toContain("site:motebit.com");
    expect(provider.rewrite("cloud storage")).toBe("cloud storage");
  });

  it("is inert with an empty rule table — pass-through wrapper", () => {
    const provider = new BiasedSearchProvider(new CapturingProvider(), []);
    expect(provider.rewrite("motebit")).toBe("motebit");
  });

  it("DEFAULT_MOTEBIT_BIAS matches 'motebit' and biases to first-party sites", () => {
    expect(DEFAULT_MOTEBIT_BIAS.terms).toContain("motebit");
    expect(DEFAULT_MOTEBIT_BIAS.biasSuffix).toContain("site:motebit.com");
    expect(DEFAULT_MOTEBIT_BIAS.biasSuffix).toContain("site:docs.motebit.com");
    expect(DEFAULT_MOTEBIT_BIAS.biasSuffix).toContain("site:github.com/motebit");
  });

  it("escapes regex-special characters in terms (no runtime error when rules contain '.' or '+')", () => {
    // Bias rules today use alphanumeric terms, but the escape is
    // defensive — an operator-maintained rule table may contain anything.
    // The assertion is just "doesn't crash"; whole-word matching semantics
    // for non-alphanumeric tokens are intentionally undefined (JS \b
    // treats `+` and `.` as non-word chars).
    const provider = new BiasedSearchProvider(new CapturingProvider(), [
      { terms: ["c++", "node.js"], biasSuffix: "site:example.com" },
    ]);
    expect(() => provider.rewrite("c++ libraries")).not.toThrow();
    expect(() => provider.rewrite("node.js runtime")).not.toThrow();
  });
});
