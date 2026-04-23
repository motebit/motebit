/**
 * `search_conversations` — Layer-3 transcript retrieval tool.
 *
 * The agent uses this to cite or recall the verbatim exchange that
 * produced a memory (or that happened without producing one). It
 * complements:
 *
 *   - `recall_memories` (Layer 2) — embedding search over DISTILLED
 *     memory nodes. Misses things the motebit never chose to remember.
 *   - the memory index (Layer 1, always-loaded) — pointers, not content.
 *     Useful for "what do I know about?" questions, not "what did we
 *     discuss last Tuesday?"
 *
 * Handler is storage-agnostic. The surface wires a `searchFn` closure
 * over its runtime; this file only knows the tool contract.
 */

import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

export const searchConversationsDefinition: ToolDefinition = {
  name: "search_conversations",
  mode: "api",
  description:
    "Search your conversation history (verbatim user + assistant messages) by keyword. " +
    "Use this when you want to cite something the user actually said, or when you " +
    "recall discussing a topic but did not form a memory about it. Distinct from " +
    "`recall_memories` — this searches raw transcripts, not distilled memory nodes.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords to search for across every past message.",
      },
      limit: {
        type: "number",
        description: "Max hits to return (default 5).",
      },
    },
    required: ["query"],
  },
};

/**
 * Shape of the hits the closure returns. Intentionally compatible
 * with `ConversationSearchHit` from `@motebit/runtime/conversation-search`
 * without importing across packages — this way `@motebit/tools` stays
 * at Layer 1.
 */
export interface ConversationSearchHit {
  conversationId: string;
  role: string;
  content: string;
  timestamp: number;
  score: number;
  snippet: string;
}

export function createSearchConversationsHandler(
  searchFn: (
    query: string,
    limit: number,
  ) => Promise<ConversationSearchHit[]> | ConversationSearchHit[],
): ToolHandler {
  return async (args) => {
    const query = args.query as string;
    if (!query) return { ok: false, error: "Missing required parameter: query" };
    const limit = typeof args.limit === "number" ? args.limit : 5;

    try {
      const hits = await searchFn(query, limit);
      if (hits.length === 0) {
        return { ok: true, data: "No matching conversation messages found." };
      }

      const formatted = hits
        .map((h, i) => {
          const when = new Date(h.timestamp).toISOString();
          const roleLabel = h.role === "user" ? "You" : "Me";
          return `${i + 1}. [${when} · ${roleLabel}] ${h.snippet}`;
        })
        .join("\n");

      return { ok: true, data: formatted };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `search_conversations error: ${msg}` };
    }
  };
}
