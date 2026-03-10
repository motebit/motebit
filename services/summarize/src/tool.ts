/**
 * summarize_search tool definition and handler factory.
 * Separated from index.ts so tests can import without triggering main().
 */

import type { ToolDefinition, ToolResult } from "@motebit/sdk";
import type { McpClientAdapter } from "@motebit/mcp-client";

export const summarizeSearchDefinition: ToolDefinition = {
  name: "summarize_search",
  description: "Search the web via a delegate service, return top 3 results with a summary prefix.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
};

/**
 * Create the summarize_search handler that delegates to web-search via MCP.
 */
export function createSummarizeSearchHandler(
  webSearchAdapter: McpClientAdapter,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const rawQuery = args["query"];
    const query = typeof rawQuery === "string" ? rawQuery : "";
    if (!query) return { ok: false, error: "Missing query parameter" };

    // Delegate to web-search's motebit_task (qualified name: serverName__toolName)
    const qualifiedName = `${webSearchAdapter.serverName}__motebit_task`;

    const result = await webSearchAdapter.executeTool(qualifiedName, { prompt: query });
    if (!result.ok) {
      return { ok: false, error: `Delegation failed: ${result.error ?? "unknown"}` };
    }

    // Parse the result and extract top 3 results
    try {
      const raw = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
      // The result from motebit_task is a JSON receipt — extract the result field
      const receipt = JSON.parse(raw.replace(/\n\[motebit:[^\]]+\]$/, "")) as Record<
        string,
        unknown
      >;
      const rawResult = receipt["result"];
      const searchResults = typeof rawResult === "string" ? rawResult : raw;

      let parsed: unknown[];
      try {
        parsed = JSON.parse(searchResults) as unknown[];
      } catch {
        parsed = [];
      }

      const top3 = Array.isArray(parsed) ? parsed.slice(0, 3) : [];
      const summary = `Search results for "${query}" (top ${top3.length} via web-search delegate):\n${JSON.stringify(top3)}`;
      return { ok: true, data: summary };
    } catch {
      return {
        ok: true,
        data: `Delegated search for "${query}": ${typeof result.data === "string" ? result.data : JSON.stringify(result.data)}`,
      };
    }
  };
}
