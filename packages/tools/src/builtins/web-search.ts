import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import type { SearchProvider } from "../search-provider.js";
import { SearchProviderError } from "../search-provider.js";
import { DuckDuckGoSearchProvider } from "../providers/duckduckgo.js";

export const webSearchDefinition: ToolDefinition = {
  name: "web_search",
  description: "Search the web for information. Returns summarized results.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
    },
    required: ["query"],
  },
};

const MAX_RESULT_SIZE = 8000;

/**
 * Creates a web search tool handler.
 *
 * If a SearchProvider is supplied, uses it for structured search results.
 * If not, falls back to the built-in DuckDuckGo provider (backward compatible).
 */
export function createWebSearchHandler(provider?: SearchProvider): ToolHandler {
  const searchProvider = provider ?? new DuckDuckGoSearchProvider();

  return async (args) => {
    const query = args.query as string;
    if (!query) return { ok: false, error: "Missing required parameter: query" };

    try {
      const results = await searchProvider.search(query, 5);

      if (results.length === 0) {
        return { ok: true, data: `No results found for "${query}". Try a more specific query.` };
      }

      const formatted = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");

      const output = `Results for "${query}":\n\n${formatted}`;
      return { ok: true, data: output.slice(0, MAX_RESULT_SIZE) };
    } catch (err: unknown) {
      if (err instanceof SearchProviderError) {
        return {
          ok: false,
          error: `Search provider error (${err.provider}, HTTP ${err.status}): ${err.message}`,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Search error: ${msg}` };
    }
  };
}
