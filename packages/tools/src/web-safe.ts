/**
 * Web-safe tool exports — no Node.js dependencies.
 *
 * Desktop and other browser-context consumers import from here
 * instead of the main index, which eagerly pulls in node:child_process.
 */

export { webSearchDefinition, createWebSearchHandler } from "./builtins/web-search.js";
export { readUrlDefinition, createReadUrlHandler } from "./builtins/read-url.js";
export {
  recallMemoriesDefinition,
  createRecallMemoriesHandler,
} from "./builtins/recall-memories.js";
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
  BiasedSearchProvider,
  DEFAULT_MOTEBIT_BIAS,
  type BiasRule,
} from "./providers/biased-search.js";
export {
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "./builtins/goal-tools.js";
export { InMemoryToolRegistry } from "./registry.js";
export type { ToolDefinition, ToolResult, ToolHandler, ToolRegistry } from "@motebit/sdk";
