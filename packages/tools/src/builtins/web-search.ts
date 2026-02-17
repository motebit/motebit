import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

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

export function createWebSearchHandler(): ToolHandler {
  return async (args) => {
    const query = args.query as string;
    if (!query) return { ok: false, error: "Missing required parameter: query" };

    // Use DuckDuckGo's instant answer API (no API key needed)
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
      const res = await fetch(url);
      if (!res.ok) return { ok: false, error: `Search failed: ${res.status}` };
      const data = (await res.json()) as {
        AbstractText?: string;
        AbstractSource?: string;
        RelatedTopics?: Array<{ Text?: string }>;
      };

      const results: string[] = [];
      if (data.AbstractText) {
        results.push(data.AbstractText);
      }
      if (data.RelatedTopics) {
        for (const topic of data.RelatedTopics.slice(0, 5)) {
          if (topic.Text) results.push(topic.Text);
        }
      }

      if (results.length === 0) {
        return { ok: true, data: `No results found for "${query}". Try a more specific query.` };
      }

      return { ok: true, data: results.join("\n\n").slice(0, MAX_RESULT_SIZE) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Search error: ${msg}` };
    }
  };
}
