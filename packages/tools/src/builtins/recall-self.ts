import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

/**
 * `recall_self` — the interior tier of the answer engine.
 *
 * A motebit's first-resort knowledge about itself. The handler is a thin
 * wrapper over a caller-supplied search function that hits
 * `@motebit/self-knowledge`'s committed corpus. Ring 1 surfaces (web, CLI,
 * spatial) register this tool with `querySelfKnowledge` as the search
 * function; the tool itself stays zero-dependency.
 *
 * Format mirrors `recall_memories` — the ranked list is rendered as plain
 * text for the AI loop to summarize. Scores are exposed so the model can
 * decide whether a hit is strong enough to answer from, or whether to
 * fall through to web research.
 */

export const recallSelfDefinition: ToolDefinition = {
  name: "recall_self",
  mode: "api",
  description:
    "Search your own committed knowledge about Motebit — who you are, how you work, the doctrine you live by. Use this BEFORE web_search when the user asks about Motebit, about yourself, or about any concept in your own documentation.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look up in interior knowledge" },
      limit: { type: "number", description: "Max chunks to return (default 3)" },
    },
    required: ["query"],
  },
};

/**
 * Shape expected from the search function. Kept structural rather than
 * importing from `@motebit/self-knowledge` so this module retains zero
 * cross-layer imports.
 */
export interface RecallSelfHit {
  source: string;
  title: string;
  content: string;
  score: number;
}

export function createRecallSelfHandler(
  searchFn: (query: string, limit: number) => Promise<RecallSelfHit[]>,
): ToolHandler {
  return async (args) => {
    const query = args.query as string;
    if (!query) return { ok: false, error: "Missing required parameter: query" };
    const limit = (args.limit as number) ?? 3;

    try {
      const hits = await searchFn(query, limit);
      if (hits.length === 0) {
        return {
          ok: true,
          data: `No interior knowledge matched "${query}". Consider web_search if the user is asking about something beyond Motebit itself.`,
        };
      }
      const formatted = hits
        .map(
          (h, i) =>
            `${i + 1}. [${h.source} · ${h.title} · score=${h.score.toFixed(2)}]\n${h.content}`,
        )
        .join("\n\n---\n\n");
      return { ok: true, data: formatted };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Interior recall error: ${msg}` };
    }
  };
}
