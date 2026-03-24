/**
 * SearchProvider — adapter interface for pluggable web search backends.
 *
 * The adapter pattern: the interior must not bind to a specific provider.
 * Each search backend (Brave, DuckDuckGo, etc.) implements this interface.
 * FallbackSearchProvider chains them for graceful degradation.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
}

/**
 * Typed error for search provider HTTP failures.
 * Carries the HTTP status and provider name so callers can distinguish
 * "no results" from "search provider down/rate-limited."
 */
export class SearchProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly provider: string,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

/**
 * Chains multiple SearchProviders — tries each in order until one returns results.
 *
 * Error propagation: if ALL providers throw, the first error is re-thrown so
 * callers can distinguish "no results" from "all providers failed." Empty
 * results (length === 0) still fall through to the next provider.
 */
export class FallbackSearchProvider implements SearchProvider {
  constructor(private providers: SearchProvider[]) {}

  async search(query: string, maxResults?: number): Promise<SearchResult[]> {
    let firstError: unknown;
    for (const provider of this.providers) {
      try {
        const results = await provider.search(query, maxResults);
        if (results.length > 0) return results;
      } catch (err: unknown) {
        if (firstError === undefined) firstError = err;
        continue;
      }
    }
    // If every provider threw, surface the first error instead of
    // silently returning [] (which callers would read as "no results").
    if (firstError !== undefined) {
      if (firstError instanceof Error) throw firstError;
      throw new Error("All search providers failed");
    }
    return [];
  }
}
