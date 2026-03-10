/**
 * Main entry point — re-exports everything including loop.js (Node-only).
 * For browser environments, use "@motebit/ai-core/browser" instead.
 */

// Core: providers, tag parsing, context packing (browser-safe)
export * from "./core.js";

// Loop: agentic turn execution (requires memory-graph → onnxruntime-node)
export { runTurn, runTurnStreaming } from "./loop.js";
export type {
  MotebitLoopDependencies,
  TurnResult,
  TurnOptions,
  AgenticChunk,
  LoopMemoryGovernor,
} from "./loop.js";

// loadConfig is Node-only (node:fs) — import directly from @motebit/ai-core/dist/config-loader.js
