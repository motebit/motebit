---
"@motebit/ai-core": minor
---

New `extractReasoningTags` producer captures the model's `<thinking>` interior-reasoning trace (concatenating all blocks, no length cap) into `AIResponse.reasoning`, on both the streaming and non-streaming OpenAI-provider paths. Counterpart to `extractNarrationTag`, but cumulative (full trace) and interior-only — it feeds the owner-facing `mind` organ, never the chat register (still stripped from visible text via `stripTags`). Increment 1 of the interior-cognition arc.
