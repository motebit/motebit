/**
 * DuckDuckGo Instant Answer provider — no API key required.
 *
 * Metabolic fallback: when no premium search API key is available,
 * DuckDuckGo's free Instant Answer API provides basic results.
 * Returns Wikipedia summaries and related topics.
 */

import type { SearchProvider, SearchResult } from "../search-provider.js";

interface DuckDuckGoResponse {
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: Array<{
    Text?: string;
    FirstURL?: string;
  }>;
}

export class DuckDuckGoSearchProvider implements SearchProvider {
  async search(query: string, maxResults: number = 5): Promise<SearchResult[]> {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`DuckDuckGo API error: ${res.status}`);
    }

    const data = (await res.json()) as DuckDuckGoResponse;
    const results: SearchResult[] = [];

    if (data.AbstractText) {
      results.push({
        title: data.Heading ?? query,
        url: data.AbstractURL ?? `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        snippet: data.AbstractText,
      });
    }

    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics.slice(0, maxResults - results.length)) {
        if (topic.Text) {
          results.push({
            title: topic.Text.split(" - ")[0] ?? topic.Text.slice(0, 60),
            url: topic.FirstURL ?? "",
            snippet: topic.Text,
          });
        }
      }
    }

    return results.slice(0, maxResults);
  }
}
