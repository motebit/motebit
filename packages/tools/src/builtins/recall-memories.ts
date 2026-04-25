import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

/** @internal */
export const recallMemoriesDefinition: ToolDefinition = {
  name: "recall_memories",
  mode: "api",
  description:
    "Search your own memory graph for relevant information. Use when you need to remember something about the user or past conversations.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for in memories" },
      limit: { type: "number", description: "Max results (default 5)" },
    },
    required: ["query"],
  },
};

export function createRecallMemoriesHandler(
  searchFn: (
    query: string,
    limit: number,
  ) => Promise<Array<{ content: string; confidence: number }>>,
): ToolHandler {
  return async (args) => {
    const query = args.query as string;
    if (!query) return { ok: false, error: "Missing required parameter: query" };
    const limit = (args.limit as number) ?? 5;

    try {
      const memories = await searchFn(query, limit);
      if (memories.length === 0) {
        return { ok: true, data: "No relevant memories found." };
      }
      const formatted = memories
        .map((m, i) => `${i + 1}. [confidence=${m.confidence.toFixed(2)}] ${m.content}`)
        .join("\n");
      return { ok: true, data: formatted };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Memory search error: ${msg}` };
    }
  };
}
