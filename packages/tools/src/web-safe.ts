/**
 * Web-safe tool exports — no Node.js dependencies.
 *
 * Desktop and other browser-context consumers import from here
 * instead of the main index, which eagerly pulls in node:child_process.
 */

import type { ToolRegistry } from "@motebit/sdk";
import { webSearchDefinition, createWebSearchHandler } from "./builtins/web-search.js";
import { readUrlDefinition, createReadUrlHandler } from "./builtins/read-url.js";
import {
  recallMemoriesDefinition,
  createRecallMemoriesHandler,
} from "./builtins/recall-memories.js";
import { currentTimeDefinition, createCurrentTimeHandler } from "./builtins/current-time.js";
import { listEventsDefinition, createListEventsHandler } from "./builtins/list-events.js";
import {
  rewriteMemoryDefinition,
  createRewriteMemoryHandler,
  type RewriteMemoryDeps,
} from "./builtins/rewrite-memory.js";
import {
  searchConversationsDefinition,
  createSearchConversationsHandler,
  type ConversationSearchHit,
} from "./builtins/search-conversations.js";
import {
  selfReflectDefinition,
  createSelfReflectHandler,
  type ReflectionToolResult,
} from "./builtins/self-reflect.js";
import type { SearchProvider } from "./search-provider.js";

export { webSearchDefinition, createWebSearchHandler } from "./builtins/web-search.js";
export { readUrlDefinition, createReadUrlHandler } from "./builtins/read-url.js";
export {
  recallMemoriesDefinition,
  createRecallMemoriesHandler,
} from "./builtins/recall-memories.js";
export { currentTimeDefinition, createCurrentTimeHandler } from "./builtins/current-time.js";
export {
  recallSelfDefinition,
  createRecallSelfHandler,
  type RecallSelfHit,
} from "./builtins/recall-self.js";
export { listEventsDefinition, createListEventsHandler } from "./builtins/list-events.js";
export { selfReflectDefinition, createSelfReflectHandler } from "./builtins/self-reflect.js";
export type { ReflectionToolResult } from "./builtins/self-reflect.js";
export type { SearchProvider, SearchResult } from "./search-provider.js";
export { FallbackSearchProvider } from "./search-provider.js";
export { BraveSearchProvider } from "./providers/brave-search.js";
export { DuckDuckGoSearchProvider } from "./providers/duckduckgo.js";
export { ProxySearchProvider } from "./providers/proxy-search.js";
export {
  TavilySearchProvider,
  type TavilySearchProviderOptions,
} from "./providers/tavily-search.js";
export {
  BiasedSearchProvider,
  DEFAULT_MOTEBIT_BIAS,
  type BiasRule,
} from "./providers/biased-search.js";
export {
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "./builtins/goal-tools.js";
export {
  computerDefinition,
  createComputerHandler,
  type ComputerDispatcher,
  type ComputerHandlerOptions,
  type ComputerUnsupportedReason,
} from "./builtins/computer.js";
export { InMemoryToolRegistry } from "./registry.js";
export type { ToolDefinition, ToolResult, ToolHandler, ToolRegistry } from "@motebit/sdk";

export interface BrowserSafeBuiltinOptions {
  searchProvider?: SearchProvider;
  readUrlProxy?: string;
  memorySearchFn?: (
    query: string,
    limit: number,
  ) => Promise<Array<{ content: string; confidence: number }>>;
  eventQueryFn?: (
    limit: number,
    eventType?: string,
  ) => Promise<Array<{ event_type: string; timestamp: number; payload: Record<string, unknown> }>>;
  reflectFn?: () => Promise<ReflectionToolResult>;
  /**
   * When provided, registers the `rewrite_memory` tool. The agent
   * uses this to supersede a stale memory by the short node id
   * surfaced in the Layer-1 memory index (spec/memory-delta-v1.md
   * §5.8). Absent when the surface hasn't wired the memory-graph
   * resolvers yet — the tool is useless without them.
   */
  rewriteMemoryDeps?: RewriteMemoryDeps;
  /**
   * When provided, registers `search_conversations` — Layer-3
   * lexical BM25 retrieval over conversation transcripts.
   */
  conversationSearchFn?: (
    query: string,
    limit: number,
  ) => Promise<ConversationSearchHit[]> | ConversationSearchHit[];
}

/**
 * Register every Ring-1 browser-safe builtin on `registry` in one call.
 *
 * Always-registered (zero config): current_time, web_search, read_url.
 * Conditionally registered when the corresponding closure is supplied:
 * recall_memories, list_events, self_reflect.
 *
 * Surfaces that wire runtime-dependent behavior pass closures that capture
 * their own runtime instance (`@motebit/tools` is Layer 1 and cannot depend
 * on runtime). The N+1 Ring-1 tool lands here — not in N surfaces.
 */
export function registerBrowserSafeBuiltins(
  registry: ToolRegistry,
  options: BrowserSafeBuiltinOptions = {},
): void {
  registry.register(currentTimeDefinition, createCurrentTimeHandler());
  registry.register(webSearchDefinition, createWebSearchHandler(options.searchProvider));
  registry.register(
    readUrlDefinition,
    createReadUrlHandler(options.readUrlProxy ? { proxyUrl: options.readUrlProxy } : undefined),
  );

  if (options.memorySearchFn) {
    registry.register(
      recallMemoriesDefinition,
      createRecallMemoriesHandler(options.memorySearchFn),
    );
  }
  if (options.eventQueryFn) {
    registry.register(listEventsDefinition, createListEventsHandler(options.eventQueryFn));
  }
  if (options.reflectFn) {
    registry.register(selfReflectDefinition, createSelfReflectHandler(options.reflectFn));
  }
  if (options.rewriteMemoryDeps) {
    registry.register(
      rewriteMemoryDefinition,
      createRewriteMemoryHandler(options.rewriteMemoryDeps),
    );
  }
  if (options.conversationSearchFn) {
    registry.register(
      searchConversationsDefinition,
      createSearchConversationsHandler(options.conversationSearchFn),
    );
  }
}
