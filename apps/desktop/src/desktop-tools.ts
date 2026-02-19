/**
 * Desktop tool registration — browser-safe subset of builtins.
 *
 * The desktop can't eagerly import @motebit/tools because it pulls in
 * node:child_process (via shell_exec). Instead, we import from
 * @motebit/tools/web-safe which only re-exports the browser-safe tools.
 *
 * Tools registered here:
 *   web_search  (R0) — fetch-based, always available
 *   read_url    (R0) — fetch-based, always available
 *   recall_memories (R0) — uses runtime memory.retrieve()
 *   list_events     (R0) — uses runtime events.query()
 */

import { SimpleToolRegistry } from "@motebit/runtime";
import type { MotebitRuntime } from "@motebit/runtime";
import type { EventType } from "@motebit/sdk";
import type { EventFilter } from "@motebit/event-log";
import { embedText } from "@motebit/memory-graph";
import {
  webSearchDefinition,
  createWebSearchHandler,
  readUrlDefinition,
  createReadUrlHandler,
  recallMemoriesDefinition,
  createRecallMemoriesHandler,
  listEventsDefinition,
  createListEventsHandler,
} from "@motebit/tools/web-safe";

export function registerDesktopTools(
  registry: SimpleToolRegistry,
  runtime: MotebitRuntime,
): void {
  // Fetch-based tools — work in any environment
  registry.register(webSearchDefinition, createWebSearchHandler());
  registry.register(readUrlDefinition, createReadUrlHandler());

  // Memory recall — bridges to runtime's semantic memory graph
  registry.register(
    recallMemoriesDefinition,
    createRecallMemoriesHandler(async (query, limit) => {
      const queryEmbedding = await embedText(query);
      const nodes = await runtime.memory.retrieve(queryEmbedding, { limit });
      return nodes.map((n) => ({ content: n.content, confidence: n.confidence }));
    }),
  );

  // Event log query — bridges to runtime's event store
  registry.register(
    listEventsDefinition,
    createListEventsHandler(async (limit, eventType) => {
      const filter: EventFilter = {
        motebit_id: runtime.motebitId,
        limit,
      };
      if (eventType) {
        filter.event_types = [eventType as EventType];
      }
      const events = await runtime.events.query(filter);
      return events.map((e) => ({
        event_type: e.event_type,
        timestamp: e.timestamp,
        payload: e.payload,
      }));
    }),
  );
}
