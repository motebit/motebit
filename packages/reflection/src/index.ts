/**
 * Reflection — adaptive intelligence for motebit agents.
 *
 * "What should I change?" — the agent reviews its own performance,
 * extracts insights, adjusts behavior, and stores learnings as memories.
 *
 * Two layers:
 *   conversation.ts — re-exports the raw LLM reflection from @motebit/ai-core
 *   engine.ts       — full pipeline: LLM call → insight storage → event log
 *
 * Plan reflection lives in @motebit/planner (tightly coupled to plan execution).
 */

export {
  type ReflectionResult,
  type PastReflection,
  reflect,
  parseReflectionResponse,
} from "./conversation.js";
export { type ReflectionDeps, performReflection, runReflectionSafe } from "./engine.js";
