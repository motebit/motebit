---
"@motebit/proxy": patch
---

Server-side extended-thinking switch for the cloud path. The proxy reconstructs the Anthropic request body (a client-set `thinking` would be dropped), so this is the single place to enable extended thinking for all cloud users. OFF by default — inert unless `MOTEBIT_EXTENDED_THINKING_BUDGET_TOKENS` is set to a positive integer. When set (and the model supports it — inline gate mirroring ai-core's `modelSupportsExtendedThinking`, since the proxy doesn't depend on ai-core), the reconstructed body carries `thinking: { type: "enabled", budget_tokens }`, OMITS `temperature`, and bumps `max_tokens` above the budget. Response streaming already passes `thinking_delta`/`signature_delta` through verbatim and `messages` forward verbatim, so capture + tool-use signature preservation work end-to-end once flipped on. Operator validates cost/behavior before setting the env var in prod.
