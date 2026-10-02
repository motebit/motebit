---
"@motebit/proxy": patch
---

Charge exactly what the provider billed, once — and refuse what cannot be metered instead of under-billing it.

- A 200 stream whose provider never started generating (no Anthropic `message_start` / content event, no OpenAI-shaped chunk with `choices`) and reported no usage is no longer billed the upper bound, however its bytes looked (nothing, an SSE comment, a ping, an error event, a non-SSE JSON error body, garbage) and however it ended (clean, connection reset, hung past the drain deadline): the provider billed nothing, so the turn's provider cost is 0 (a spent classifier is still billed once), logged `proxy.turn_unbilled_provider_error` with a reason. One state predicate replaces the per-shape checks. Reported usage is exact; a provider that started and then lost its usage is billed the logged upper bound for what it did not report.
- A client that leaves while the upstream sends nothing is now noticed (its stream cancellation, not only a failed write), so the drain deadline applies and the turn settles instead of hanging unsettled.
- Deny-by-default request-feature boundary on motebit-cloud: only features the meter prices pass (client tools — Anthropic custom / OpenAI function; text, image, document and conversation-replay content blocks; `system`, `metadata`, `stop_sequences`, sampling params, `max_tokens`, `stream`, `thinking`). Server tools (web_search, web_fetch, code_execution, …), MCP connectors, unknown top-level keys and unknown content-block types are refused with 400 `unsupported_feature` (naming the feature and its path) before the classifier or provider spends. The real cloud client builder (`@motebit/ai-core` `AnthropicProvider`) is tested against the allowlist.
- Gemini: the OpenAI-compatible endpoint omits thinking tokens from `completion_tokens`; output is now billed as `total_tokens - prompt_tokens` when present (never less than `completion_tokens`).
- A failure to register the post-response accounting with the platform's `waitUntil` is logged `proxy.accounting_unregistered` (error) instead of swallowed.
