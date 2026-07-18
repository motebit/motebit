import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

/** Options threaded from the recall tool into a surface's memory-search closure. */
export interface RecallMemoriesOptions {
  /** Max results. */
  limit: number;
  /**
   * Point-in-time recall: reconstruct the beliefs that were valid AS OF this
   * instant (Unix ms), instead of current beliefs. Absent ⇒ current recall.
   * Backed by bi-temporal validity — the memory graph filters `[valid_from,
   * valid_until)` around this time. See spec/memory-delta-v1.md §3.5.
   */
  asOf?: number;
}

/** @internal */
export const recallMemoriesDefinition: ToolDefinition = {
  name: "recall_memories",
  mode: "api",
  description:
    "Search your own memory graph for relevant information. Use when you need to " +
    "remember something about the user or past conversations. Pass `as_of` (an ISO " +
    'date, e.g. "2026-06-01") to reconstruct what you believed AS OF that date ' +
    "instead of now: the results are beliefs that were valid then — including ones " +
    "you have since revised — so report them as what you believed at that time, " +
    "never as current fact.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for in memories" },
      limit: { type: "number", description: "Max results (default 5)" },
      as_of: {
        type: "string",
        description:
          "Optional ISO 8601 date/datetime. Reconstruct beliefs valid AS OF this " +
          "point in time (bi-temporal recall), including since-superseded ones. " +
          "Omit for current recall.",
      },
    },
    required: ["query"],
  },
};

export function createRecallMemoriesHandler(
  searchFn: (
    query: string,
    opts: RecallMemoriesOptions,
  ) => Promise<Array<{ content: string; confidence: number }>>,
): ToolHandler {
  return async (args) => {
    const query = args.query as string;
    if (!query) return { ok: false, error: "Missing required parameter: query" };
    const limit = (args.limit as number) ?? 5;

    // Parse the optional as-of instant. An unparseable date is a HARD error —
    // never silently fall back to current recall, which would quietly answer a
    // different question than the one asked.
    let asOf: number | undefined;
    const asOfRaw = args.as_of;
    if (asOfRaw != null && asOfRaw !== "") {
      if (typeof asOfRaw !== "string") {
        return { ok: false, error: "Invalid as_of: expected an ISO 8601 date string." };
      }
      const parsed = Date.parse(asOfRaw);
      if (Number.isNaN(parsed)) {
        return {
          ok: false,
          error: `Invalid as_of date: "${asOfRaw}". Use an ISO 8601 date, e.g. "2026-06-01".`,
        };
      }
      asOf = parsed;
    }

    try {
      const memories = await searchFn(query, { limit, ...(asOf != null ? { asOf } : {}) });
      if (memories.length === 0) {
        return {
          ok: true,
          data:
            asOf != null
              ? `No memories were valid as of ${new Date(asOf).toISOString()}.`
              : "No relevant memories found.",
        };
      }
      // Escape data-boundary + provenance markers embedded in recalled
      // content — recalled memories may have absorbed injected text, and
      // the system prompt teaches the model that a `[from:…]` marker is
      // authoritative provenance. Content must not be able to fabricate
      // one (same discipline as packContext in @motebit/ai-core).
      // docs/doctrine/memory-provenance.md.
      const escape = (content: string): string =>
        content
          .replace(/\[MEMORY_DATA\b/g, "[ESCAPED_MEMORY")
          .replace(/\[\/MEMORY_DATA\]/g, "[/ESCAPED_MEMORY]")
          .replace(/\[from:/g, "[escaped-from:");
      const formatted = memories
        .map((m, i) => `${i + 1}. [confidence=${m.confidence.toFixed(2)}] ${escape(m.content)}`)
        .join("\n");
      // Typed-truth framing (docs/doctrine/typed-truth-perception.md): an as-of
      // recall reconstructs PAST beliefs, some since superseded. Mark the batch so
      // the model reports "as of <date> you believed…", never as present fact.
      const data =
        asOf != null
          ? `As of ${new Date(asOf).toISOString()}, you believed (historical snapshot — some may since have been superseded):\n${formatted}`
          : formatted;
      return { ok: true, data };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Memory search error: ${msg}` };
    }
  };
}
