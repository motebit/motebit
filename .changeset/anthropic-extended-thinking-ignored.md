---
"@motebit/ai-core": minor
---

Enable Anthropic extended thinking properly, OFF by default. New `AnthropicProviderConfig.extendedThinking?: { budgetTokens }` opts in; when set (and the model supports it, via `modelSupportsExtendedThinking`) the request carries `thinking: { type: "enabled", budget_tokens }`, omits `temperature` (required), and bumps `max_tokens` above the budget. Critically, thinking blocks + signatures are captured (streaming `thinking_delta`/`signature_delta`, non-streaming `thinking` content blocks) into `AIResponse.thinking_blocks`, carried onto the assistant history message by the loop, and re-emitted FIRST in the assistant tool-use turn by `buildMessages` — so a tool-use continuation stays valid (Anthropic rejects it otherwise). The entire feature is inert when unconfigured: no thinking param, temperature/max_tokens untouched, `thinking_blocks` absent — byte-identical behavior for existing deployments. Operator validates cost/behavior before enabling.
