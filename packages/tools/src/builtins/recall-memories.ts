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
  /**
   * History recall: return ALL versions of a belief — current AND
   * since-superseded — instead of just the current ones. Each result then
   * carries `supersededAt` so the caller can tell them apart. Distinct from
   * `asOf` (a point-in-time snapshot); the two are mutually exclusive.
   */
  includeExpired?: boolean;
}

/**
 * One recalled memory. `supersededAt` is present ONLY when the belief has been
 * invalidated (its `valid_until`, Unix ms) — its absence means the belief is
 * current. Surfaces map it straight from `MemoryNode.valid_until`.
 */
export interface RecallMemoriesResult {
  content: string;
  confidence: number;
  supersededAt?: number;
}

/** @internal */
export const recallMemoriesDefinition: ToolDefinition = {
  name: "recall_memories",
  mode: "api",
  description:
    "Search your own memory graph for relevant information. Use when you need to " +
    "remember something about the user or past conversations. Two optional " +
    "bi-temporal modes (mutually exclusive): pass `as_of` (an ISO date, e.g. " +
    '"2026-06-01") to reconstruct what you believed AS OF that date; pass ' +
    "`include_history: true` to see ALL versions of a belief at once — current " +
    "beliefs and the ones they replaced, each labelled. In both modes some results " +
    "are beliefs you have since revised, so report them as past belief, never as " +
    "current fact.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for in memories" },
      limit: { type: "number", description: "Max results (default 5)" },
      as_of: {
        type: "string",
        description:
          "Optional ISO 8601 date/datetime. Reconstruct beliefs valid AS OF this " +
          "point in time (a snapshot). Mutually exclusive with include_history. " +
          "Omit for current recall.",
      },
      include_history: {
        type: "boolean",
        description:
          "Optional. Return ALL versions of a belief — current and since-" +
          "superseded — each labelled [current] or [superseded <date>]. Use to " +
          "see how a belief changed. Mutually exclusive with as_of.",
      },
    },
    required: ["query"],
  },
};

export function createRecallMemoriesHandler(
  searchFn: (query: string, opts: RecallMemoriesOptions) => Promise<RecallMemoriesResult[]>,
): ToolHandler {
  return async (args) => {
    const query = args.query as string;
    if (!query) return { ok: false, error: "Missing required parameter: query" };
    const limit = (args.limit as number) ?? 5;

    const includeHistory = args.include_history === true;

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

    // as_of and include_history answer different questions (a snapshot at T vs.
    // every version now) and internally take different filter paths, so refuse
    // the ambiguous combination rather than silently pick one.
    if (asOf != null && includeHistory) {
      return {
        ok: false,
        error:
          "Use as_of OR include_history, not both: as_of is a point-in-time snapshot; include_history returns every version.",
      };
    }

    try {
      const memories = await searchFn(query, {
        limit,
        ...(asOf != null ? { asOf } : {}),
        ...(includeHistory ? { includeExpired: true } : {}),
      });
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
      // Typed-truth framing (docs/doctrine/typed-truth-perception.md): in history
      // mode each line is labelled current vs superseded so a revised belief can
      // never be read as present fact; in as-of mode the WHOLE batch is a T
      // snapshot, framed once below (no per-line label — they were all current at
      // T). Plain current recall carries neither.
      const formatted = memories
        .map((m, i) => {
          const status = includeHistory
            ? m.supersededAt != null
              ? `[superseded ${new Date(m.supersededAt).toISOString()}] `
              : "[current] "
            : "";
          return `${i + 1}. ${status}[confidence=${m.confidence.toFixed(2)}] ${escape(m.content)}`;
        })
        .join("\n");
      let data = formatted;
      if (asOf != null) {
        data = `As of ${new Date(asOf).toISOString()}, you believed (historical snapshot — some may since have been superseded):\n${formatted}`;
      } else if (includeHistory) {
        data = `All versions found — current beliefs and the ones they replaced. A [superseded] entry is NOT current fact:\n${formatted}`;
      }
      return { ok: true, data };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Memory search error: ${msg}` };
    }
  };
}
