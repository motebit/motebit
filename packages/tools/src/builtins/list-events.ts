import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

/** @internal */
export const listEventsDefinition: ToolDefinition = {
  name: "list_events",
  mode: "api",
  description:
    "Query your event log for recent activity. Useful for understanding what happened recently.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max events to return (default 10)" },
      event_type: { type: "string", description: "Filter by event type (optional)" },
    },
  },
};

export function createListEventsHandler(
  queryFn: (
    limit: number,
    eventType?: string,
  ) => Promise<Array<{ event_type: string; timestamp: number; payload: Record<string, unknown> }>>,
): ToolHandler {
  return async (args) => {
    const limit = (args.limit as number) ?? 10;
    const eventType = args.event_type as string | undefined;

    try {
      const events = await queryFn(limit, eventType);
      if (events.length === 0) {
        return { ok: true, data: "No events found." };
      }
      const formatted = events
        .map(
          (e) =>
            `[${new Date(e.timestamp).toISOString()}] ${e.event_type}: ${JSON.stringify(e.payload)}`,
        )
        .join("\n");
      return { ok: true, data: formatted };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Event query error: ${msg}` };
    }
  };
}
