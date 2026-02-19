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
 * Chains multiple SearchProviders — tries each in order until one returns results.
 * If all providers fail or return empty, returns an empty array.
 */
export class FallbackSearchProvider implements SearchProvider {
  constructor(private providers: SearchProvider[]) {}

  async search(query: string, maxResults?: number): Promise<SearchResult[]> {
    for (const provider of this.providers) {
      try {
        const results = await provider.search(query, maxResults);
        if (results.length > 0) return results;
      } catch {
        continue;
      }
    }
    return [];
  }
}
