import { defineMotebitTest } from "../../vitest.shared.js";

// Full coverage (100/100/100/100) established 2026-04-12 via mock-LLM tests.
// conversation.ts re-exports ai-core; index.ts is a barrel; engine.ts runs
// the full pipeline with real MemoryGraph + StateVectorEngine + MemoryGovernor
// and a stub StreamingProvider whose `generate` returns canned reflection text.
// Defensive branches (audit throws, embed throws, persistence throws) are
// exercised via targeted module mocks — keeps the safety nets honest.
export default defineMotebitTest({
  thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
});
