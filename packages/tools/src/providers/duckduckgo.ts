/**
 * DuckDuckGo HTML search provider — no API key required.
 *
 * Metabolic fallback: when no premium search API key is available,
 * DuckDuckGo's HTML search (lite.duckduckgo.com) provides real web
 * search results. Parses the HTML response for result links and snippets.
 *
 * Note: the previous Instant Answer API (api.duckduckgo.com) only returned
 * Wikipedia summaries, not web search results — useless for general queries.
 */

import type { SearchProvider, SearchResult } from "../search-provider.js";

export class DuckDuckGoSearchProvider implements SearchProvider {
  async search(query: string, maxResults: number = 5): Promise<SearchResult[]> {
    // Use DuckDuckGo's HTML lite interface — returns real web results
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; motebit/1.0; +https://motebit.com)",
      },
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo search error: ${res.status}`);
    }

    const html = await res.text();
    const results: SearchResult[] = [];

    // Parse result blocks: each result is in a <div class="result">
    // with <a class="result__a"> for title/URL and <a class="result__snippet"> for snippet
    const resultBlocks = html.split(/class="result\s/);

    for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
      const block = resultBlocks[i]!;

      // Extract URL from result__a href
      const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
      if (!urlMatch) continue;

      // DuckDuckGo wraps URLs in a redirect — extract the actual URL
      let resultUrl = urlMatch[1]!;
      const uddgMatch = resultUrl.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        resultUrl = decodeURIComponent(uddgMatch[1]!);
      }

      // Extract title text
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
      const title = titleMatch
        ? titleMatch[1]!
            .replace(/&#x27;/g, "'")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .trim()
        : query;

      // Extract snippet text
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+(?:<[^>]+>[^<]*)*)/);
      let snippet = "";
      if (snippetMatch) {
        snippet = snippetMatch[1]!
          .replace(/<[^>]+>/g, "") // strip HTML tags
          .replace(/&#x27;/g, "'")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .trim();
      }

      if (resultUrl && title) {
        results.push({ title, url: resultUrl, snippet });
      }
    }

    return results;
  }
}
