/**
 * Browser-safe entry point for @motebit/ai-core.
 *
 * Re-exports everything from core.ts (providers, tag parsing, context packing)
 * but EXCLUDES loop.js which transitively requires memory-graph → onnxruntime-node.
 *
 * Usage: import { CloudProvider, ... } from "@motebit/ai-core/browser";
 */
export * from "./core.js";
