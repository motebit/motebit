/**
 * ProxySearchProvider — routes search through a server-side proxy.
 *
 * Used by browser surfaces where direct fetch to DuckDuckGo is blocked by CORS.
 * The proxy executes the search server-side and returns structured results.
 */

import type { SearchProvider, SearchResult } from "../search-provider.js";
import { SearchProviderError } from "../search-provider.js";

export class ProxySearchProvider implements SearchProvider {
  constructor(private searchUrl: string) {}

  async search(query: string, maxResults: number = 5): Promise<SearchResult[]> {
    const res = await fetch(this.searchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, maxResults }),
    });

    if (!res.ok) {
      throw new SearchProviderError(`Proxy search error: ${res.status}`, res.status, "proxy");
    }

    const json = (await res.json()) as { ok: boolean; results?: SearchResult[]; error?: string };
    if (!json.ok || !json.results) {
      throw new SearchProviderError(`Search failed: ${json.error ?? "no results"}`, 500, "proxy");
    }

    return json.results;
  }
}
