/**
 * Browser-safe entry point for @motebit/ai-core.
 *
 * Re-exports everything from core.ts (providers, tag parsing, context packing)
 * but EXCLUDES loop.js which transitively requires memory-graph → onnxruntime-node.
 *
 * Usage: import { AnthropicProvider, OpenAIProvider, ... } from "@motebit/ai-core/browser";
 */
export * from "./core.js";
export { OpenAIProvider } from "./openai-provider.js";
export type { OpenAIProviderConfig, OpenAIStreamChunk } from "./openai-provider.js";
