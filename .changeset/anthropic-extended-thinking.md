---
"@motebit/sdk": minor
---

New `ThinkingBlock` type + optional `thinking_blocks` on `AIResponse` and the `assistant` `ConversationMessage` variant — the round-trip carrier for Anthropic extended-thinking blocks (with signatures), required to preserve a valid multi-turn tool-use conversation when thinking is enabled. Opaque and never rendered (distinct from `reasoning`, the display text); absent unless extended thinking is enabled, so inert for every other provider/config.
