/**
 * Conversation reflection — re-exported from @motebit/ai-core.
 *
 * The raw LLM call and parsing live in ai-core (Layer 3).
 * This re-export makes them available through the unified reflection package.
 */

export { reflect, parseReflectionResponse } from "@motebit/ai-core";
export type { ReflectionResult, PastReflection } from "@motebit/ai-core";
