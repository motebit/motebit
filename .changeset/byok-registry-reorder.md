---
"@motebit/sdk": patch
---

**Reorder the `ByokVendor` union — DeepSeek last to surface its geographic outlier-ness.** Changed from `"anthropic" | "openai" | "google" | "deepseek" | "groq"` to `"anthropic" | "openai" | "google" | "groq" | "deepseek"`. The four American-hosted vendors group first; DeepSeek (the sole Chinese-hosted instance) reads last so the geographic asymmetry surfaces as intentional structural ordering rather than oversight.

Pure reorder — no breaking change. The union's membership is unchanged; switch statements and consumers that already handle all five vendors keep working identically. Test assertion order and sdk.api.md baseline regenerated to match the new declared order. Pairs naturally with the UI calm-down commit that immediately preceded this slice: DeepSeek's "Hosted in China" disclosure is the only descriptive note in the entire BYOK row, and it's now at the end of the row where the geographic-outlier framing reads cleanly.

Sibling reorders on every surface (web HTML buttons + sections, desktop HTML buttons, mobile IntelligenceTab radio buttons + conditional sections, CLI VALID_PROVIDERS array + default-model fallback chain) land in the same commit per CLAUDE.md's one-pass-delivery principle. Doctrine `docs/doctrine/agility-as-role.md` updated with a one-line framing note explaining the order.
