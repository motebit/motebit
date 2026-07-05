/**
 * Main entry point — re-exports everything including loop.js (Node-only).
 * For browser environments, use "@motebit/ai-core/browser" instead.
 */

// Core: providers, tag parsing, context packing (browser-safe)
export * from "./core.js";

// OpenAI provider — real OpenAI wire protocol client (browser-safe)
export { OpenAIProvider } from "./openai-provider.js";
export type { OpenAIProviderConfig, OpenAIStreamChunk } from "./openai-provider.js";

// Loop: agentic turn execution (requires memory-graph → onnxruntime-node)
export { runTurn, runTurnStreaming, projectProviderClearance } from "./loop.js";
// The live-state boundary clause — exported so evals outside ai-core can
// assert the absorbed-content rule travels with the assembled prompt.
export { PERCEPTION_DOCTRINE } from "./prompt.js";
export type {
  MotebitLoopDependencies,
  TurnResult,
  TurnLatency,
  TurnOptions,
  AgenticChunk,
  LoopMemoryGovernor,
} from "./loop.js";

// loadConfig is Node-only (node:fs) — import directly from @motebit/ai-core/dist/config-loader.js
