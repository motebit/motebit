/**
 * Desktop tool registration — browser-safe builtins + Tauri-privileged tools.
 *
 * The desktop can't eagerly import @motebit/tools because it pulls in
 * node:child_process (via shell_exec). Instead, we use
 * @motebit/tools/web-safe which ships only browser-safe tools plus the
 * `registerBrowserSafeBuiltins` helper that collapses Ring-1 wiring
 * into a single call.
 *
 * Browser-safe tools (registered via helper):
 *   current_time    (R0) — always available
 *   web_search      (R0) — fetch-based, always available
 *   read_url        (R0) — fetch-based, always available
 *   recall_memories (R0) — uses runtime memory.recallRelevant()
 *   list_events     (R0) — uses runtime events.query()
 *   self_reflect    (R0) — uses runtime.reflect()
 *
 * Tauri-privileged tools (registered only when invoke is available):
 *   read_file   (R0)  — Tauri IPC → Rust fs::read_to_string
 *   write_file  (R2)  — Tauri IPC → Rust fs::write (requires approval)
 *   shell_exec  (R3)  — Tauri IPC → Rust Command (requires approval)
 */

import { SimpleToolRegistry } from "@motebit/runtime";
import type { MotebitRuntime } from "@motebit/runtime";
import type { EventType } from "@motebit/sdk";
import { embedText } from "@motebit/memory-graph";
import {
  registerBrowserSafeBuiltins,
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
  // Search provider chain: Brave (if API key configured) → DuckDuckGo fallback
  const braveKey = import.meta.env.VITE_BRAVE_SEARCH_API_KEY as string | undefined;
  let searchProvider: SearchProvider | undefined;
  if (braveKey != null && braveKey !== "") {
    searchProvider = new FallbackSearchProvider([
      new BraveSearchProvider(braveKey),
      new DuckDuckGoSearchProvider(),
    ]);
  }

  registerBrowserSafeBuiltins(registry, {
    searchProvider,
    memorySearchFn: async (query, limit) => {
      const queryEmbedding = await embedText(query);
      const nodes = await runtime.memory.recallRelevant(queryEmbedding, { limit });
      return nodes.map((n) => ({ content: n.content, confidence: n.confidence }));
    },
    eventQueryFn: async (limit, eventType) => {
      const events = await runtime.events.query({
        motebit_id: runtime.motebitId,
        limit,
        event_types: eventType != null && eventType !== "" ? [eventType as EventType] : undefined,
      });
      return events.map((e) => ({
        event_type: e.event_type,
        timestamp: e.timestamp,
        payload: e.payload,
      }));
    },
    reflectFn: () => runtime.reflect(),
    rewriteMemoryDeps: {
      resolveNodeId: (shortIdOrUuid) => runtime.memory.resolveNodeIdPrefix(shortIdOrUuid),
      supersedeMemory: (nodeId, newContent, reason) =>
        runtime.memory.supersedeMemoryByNodeId(nodeId, newContent, reason),
    },
    conversationSearchFn: (query, limit) => runtime.searchConversations(query, limit),
  });

  // Tauri-privileged tools — only available when running inside Tauri
  if (invoke) {
    registry.register(tauriReadFileDefinition, createTauriReadFileHandler(invoke));
    registry.register(tauriWriteFileDefinition, createTauriWriteFileHandler(invoke));
    registry.register(tauriShellExecDefinition, createTauriShellExecHandler(invoke));
  }
}
