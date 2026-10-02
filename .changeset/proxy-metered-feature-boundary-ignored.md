---
"@motebit/proxy": patch
---

Charge exactly what the provider billed, once — and refuse what cannot be metered instead of under-billing it.

- A 200 stream that carries only a provider error event (e.g. Anthropic `overloaded_error`, no `message_start`), or an empty body, is no longer billed the upper bound: the provider never started a message and billed nothing, so the turn's provider cost is 0 (a spent classifier is still billed once), logged `proxy.turn_unbilled_provider_error` with the provider error type. The upper bound stays for a provider that demonstrably started generating and then lost its usage.
- Deny-by-default request-feature boundary on motebit-cloud: only features the meter prices pass (client tools — Anthropic custom / OpenAI function; text, image, document and conversation-replay content blocks; `system`, `metadata`, `stop_sequences`, sampling params, `max_tokens`, `stream`, `thinking`). Server tools (web_search, web_fetch, code_execution, …), MCP connectors, unknown top-level keys and unknown content-block types are refused with 400 `unsupported_feature` (naming the feature and its path) before the classifier or provider spends. The real cloud client builder (`@motebit/ai-core` `AnthropicProvider`) is tested against the allowlist.
- Gemini: the OpenAI-compatible endpoint omits thinking tokens from `completion_tokens`; output is now billed as `total_tokens - prompt_tokens` when present (never less than `completion_tokens`).
- A failure to register the post-response accounting with the platform's `waitUntil` is logged `proxy.accounting_unregistered` (error) instead of swallowed.
