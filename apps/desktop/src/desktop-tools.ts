/**
 * Desktop tool registration — browser-safe builtins + Tauri-privileged tools.
 *
 * The desktop can't eagerly import @motebit/tools because it pulls in
 * node:child_process (via shell_exec). Instead, we import from
 * @motebit/tools/web-safe which only re-exports the browser-safe tools.
 *
 * Browser-safe tools (always registered):
 *   web_search      (R0) — fetch-based, always available
 *   read_url        (R0) — fetch-based, always available
 *   recall_memories (R0) — uses runtime memory.recallRelevant()
 *   list_events     (R0) — uses runtime events.query()
 *
 * Tauri-privileged tools (registered only when invoke is available):
 *   read_file   (R0)  — Tauri IPC → Rust fs::read_to_string
 *   write_file  (R2)  — Tauri IPC → Rust fs::write (requires approval)
 *   shell_exec  (R3)  — Tauri IPC → Rust Command (requires approval)
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
  selfReflectDefinition,
  createSelfReflectHandler,
  BraveSearchProvider,
  DuckDuckGoSearchProvider,
  FallbackSearchProvider,
} from "@motebit/tools/web-safe";
import type { SearchProvider } from "@motebit/tools/web-safe";
import {
  tauriReadFileDefinition,
  createTauriReadFileHandler,
  tauriWriteFileDefinition,
  createTauriWriteFileHandler,
  tauriShellExecDefinition,
  createTauriShellExecHandler,
} from "./tauri-tools.js";
import type { InvokeFn } from "./tauri-storage.js";

export function registerDesktopTools(
  registry: SimpleToolRegistry,
  runtime: MotebitRuntime,
  invoke?: InvokeFn,
): void {
  // Fetch-based tools — work in any environment
  // Search provider chain: Brave (if API key configured) → DuckDuckGo fallback
  const braveKey = import.meta.env.VITE_BRAVE_SEARCH_API_KEY as string | undefined;
  let searchProvider: SearchProvider | undefined;
  if (braveKey != null && braveKey !== "") {
    searchProvider = new FallbackSearchProvider([
      new BraveSearchProvider(braveKey),
      new DuckDuckGoSearchProvider(),
    ]);
  }
  registry.register(webSearchDefinition, createWebSearchHandler(searchProvider));
  registry.register(readUrlDefinition, createReadUrlHandler());

  // Memory recall — bridges to runtime's semantic memory graph
  registry.register(
    recallMemoriesDefinition,
    createRecallMemoriesHandler(async (query, limit) => {
      const queryEmbedding = await embedText(query);
      const nodes = await runtime.memory.recallRelevant(queryEmbedding, { limit });
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
      if (eventType != null && eventType !== "") {
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

  // Self-reflection — creature can introspect on its own behavior
  registry.register(
    selfReflectDefinition,
    createSelfReflectHandler(async () => {
      const result = await runtime.reflect();
      return result;
    }),
  );

  // Tauri-privileged tools — only available when running inside Tauri
  if (invoke) {
    registry.register(tauriReadFileDefinition, createTauriReadFileHandler(invoke));
    registry.register(tauriWriteFileDefinition, createTauriWriteFileHandler(invoke));
    registry.register(tauriShellExecDefinition, createTauriShellExecHandler(invoke));
  }
}
