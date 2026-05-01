/**
 * Tavily search provider — purpose-built for agent RAG.
 *
 * Differs from generic web search indexes in two ways that matter for the
 * three-tier answer engine:
 *
 *   1. Ranking is tuned for AI-agent queries, not ad-supported click-through.
 *      For niche or new domains (like motebit.com today) the recall is higher
 *      than generic engines whose signal is dominated by backlink density.
 *   2. The response is already structured — title / url / content / score
 *      per result, no HTML to parse. Maps cleanly onto `SearchResult`.
 *
 * Adapter boundary: the interior never binds to Tavily's wire shape.
 * Services slot this behind `FallbackSearchProvider` so a key outage or
 * rate-limit falls through to Brave → DuckDuckGo, and the whole thing
 * can be wrapped by `BiasedSearchProvider` for self-query rewrites.
 *
 * Requires `TAVILY_API_KEY` passed via constructor.
 * API docs: https://docs.tavily.com/docs/rest-api/api-reference
 */

import type { SearchProvider, SearchResult } from "../search-provider.js";
import { SearchProviderError } from "../search-provider.js";

interface TavilyRawResult {
  title?: string;
  url?: string;
  /** Tavily's extracted snippet — clean prose, not raw HTML. */
  content?: string;
  /** Relevance score 0..1. Exposed on the wire but not propagated to SearchResult. */
  score?: number;
}

interface TavilySearchResponse {
  query?: string;
  results?: TavilyRawResult[];
  /** Tavily's own synthesis — unused here; we run our own synthesizer. */
  answer?: string | null;
  response_time?: number;
}

export interface TavilySearchProviderOptions {
  /** Injected fetch for test seams. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * "basic" (default, faster, shallower) or "advanced" (slower, wider,
   * more expensive). Basic is right for the default path; let a caller
   * override when they explicitly want deeper coverage.
   */
  searchDepth?: "basic" | "advanced";
}

export class TavilySearchProvider implements SearchProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly searchDepth: "basic" | "advanced";

  constructor(apiKey: string, options: TavilySearchProviderOptions = {}) {
    this.apiKey = apiKey;
    // Defer-bind the default so test stubs of globalThis.fetch
    // (e.g., vi.stubGlobal) installed AFTER constructor execution
    // are observed at call time. Bind-at-construction would freeze
    // the pre-stub global fetch — same shape as the §6.2 orchestrator
    // bug fixed in commit 4b.
    this.fetchImpl =
      options.fetch ?? ((...args) => globalThis.fetch(...(args as Parameters<typeof fetch>)));
    this.searchDepth = options.searchDepth ?? "basic";
  }

  async search(query: string, maxResults: number = 5): Promise<SearchResult[]> {
    const res = await this.fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: maxResults,
        search_depth: this.searchDepth,
        // We run our own synthesizer in services/research; suppress Tavily's
        // to avoid paying for work we don't use.
        include_answer: false,
      }),
    });

    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {
        /* ignore read errors */
      }
      throw new SearchProviderError(
        `Tavily search error: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`,
        res.status,
        "tavily",
      );
    }

    const data = (await res.json()) as TavilySearchResponse;
    const rawResults = data.results ?? [];

    return rawResults
      .filter((r): r is Required<Pick<TavilyRawResult, "title" | "url">> & TavilyRawResult =>
        Boolean(r.title && r.url),
      )
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? "",
      }));
  }
}
