---
"@motebit/sdk": minor
---

Add a closed per-model context-window table for the hosted model lists.

`MODEL_CONTEXT_WINDOW_TOKENS` is a `Record` over the new `HostedModel` union (every id in `ANTHROPIC_MODELS`, `OPENAI_MODELS`, `GOOGLE_MODELS`, `DEEPSEEK_MODELS`, `GROQ_MODELS`), so adding a model to a list is a compile error until its window is recorded or recorded as `null` (not known). Values are the vendors' published standard-tier windows; OpenAI and DeepSeek rows are `null` until confirmed. `contextWindowForModel(model)` returns the window or `undefined` (unknown row, unlisted id, or a local-server model, whose window is a server setting rather than a model property).

The runtime reads it to size conversation history to the model's real window instead of a fixed 6,976 tokens, and the BYOK routing catalog now populates `ProviderCapability.contextWindowTokens` from it.
