/**
 * Brave Search provider — uses the Brave Web Search API.
 *
 * Metabolic principle: absorb Brave Search as a nutrient.
 * The adapter boundary ensures the interior never binds to Brave directly.
 *
 * Requires BRAVE_SEARCH_API_KEY passed via constructor.
 * API docs: https://api.search.brave.com/app/documentation/web-search
 */

import type { SearchProvider, SearchResult } from "../search-provider.js";
import { SearchProviderError } from "../search-provider.js";

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export class BraveSearchProvider implements SearchProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(query: string, maxResults: number = 5): Promise<SearchResult[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.apiKey,
      },
    });

    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {
        /* ignore read errors */
      }
      throw new SearchProviderError(
        `Brave Search API error: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`,
        res.status,
        "brave",
      );
    }

    const data = (await res.json()) as BraveSearchResponse;
    const webResults = data.web?.results ?? [];

    return webResults
      .filter((r): r is Required<Pick<BraveWebResult, "title" | "url">> & BraveWebResult =>
        Boolean(r.title && r.url),
      )
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description ?? "",
      }));
  }
}
