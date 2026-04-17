/**
 * BiasedSearchProvider — composable query-rewrite wrapper.
 *
 * Adapts an underlying `SearchProvider` by appending site-operator clauses
 * to queries that match a configured rule. The primary use is self-queries:
 * when a motebit searches for "motebit", a vanilla Brave index returns
 * Motobilt (Jeep parts) because the open-web index has near-zero signal
 * for a new product. Biasing rewrites the query to
 * `motebit (site:motebit.com OR site:docs.motebit.com OR site:github.com/motebit)`
 * so the same provider surfaces first-party content.
 *
 * Rules are matched in declaration order; the first match wins. Callers
 * should order narrow-term rules before broad-term ones. A query that
 * matches no rule passes through unchanged — the wrapper is inert by default.
 *
 * Composes with `FallbackSearchProvider` on either side:
 *   new BiasedSearchProvider(new FallbackSearchProvider([Brave, DDG]), rules)
 *   new FallbackSearchProvider([new BiasedSearchProvider(Brave, rules), DDG])
 * Both work; the outer shape decides whether the bias applies before or
 * after fallback.
 */

import type { SearchProvider, SearchResult } from "../search-provider.js";

/**
 * One rewrite rule. When any token in `terms` appears in the query as a
 * whole word (case-insensitive), append `biasSuffix` to the rewritten query.
 *
 * Site biasing syntax is standard across major search providers
 * (Brave, DuckDuckGo, Google, Bing): `site:domain.com`. Multiple sites
 * joined with `OR` narrow to the union of those domains.
 */
export interface BiasRule {
  /** Case-insensitive whole-word tokens that trigger this rule. */
  terms: readonly string[];
  /** Clause appended to the query when any term matches. */
  biasSuffix: string;
}

/**
 * Default motebit self-query bias. Trips on a whole-word mention of
 * "motebit" and restricts to first-party domains. Case-insensitive.
 * Whole-word matching is critical — a substring match would fire on
 * "motobilt" in a result synthesis and double-bias the query.
 */
export const DEFAULT_MOTEBIT_BIAS: BiasRule = {
  terms: ["motebit"],
  biasSuffix: "(site:motebit.com OR site:docs.motebit.com OR site:github.com/motebit)",
};

/** Escape a term for safe insertion into a word-boundary regex. */
function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Test whether a query matches a rule. A rule matches when any of its
 * `terms` appears as a whole word in the query (case-insensitive).
 */
function ruleMatches(query: string, rule: BiasRule): boolean {
  for (const term of rule.terms) {
    const re = new RegExp(`\\b${escapeRegex(term)}\\b`, "i");
    if (re.test(query)) return true;
  }
  return false;
}

export class BiasedSearchProvider implements SearchProvider {
  constructor(
    private readonly inner: SearchProvider,
    private readonly rules: readonly BiasRule[] = [DEFAULT_MOTEBIT_BIAS],
  ) {}

  async search(query: string, maxResults?: number): Promise<SearchResult[]> {
    const rewritten = this.rewrite(query);
    return this.inner.search(rewritten, maxResults);
  }

  /**
   * Apply the first matching rule's bias. Exposed for tests and for
   * `services/web-search`'s structured-log path (callers may want to emit
   * the rewritten query to observe bias hit rate over time).
   */
  rewrite(query: string): string {
    for (const rule of this.rules) {
      if (ruleMatches(query, rule)) {
        return `${query} ${rule.biasSuffix}`;
      }
    }
    return query;
  }
}
