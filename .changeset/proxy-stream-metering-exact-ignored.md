---
"@motebit/proxy": patch
---

Meter the motebit-cloud stream exactly, client abort or not: the identity is charged for what the provider consumed, never less.

- Usage is parsed from every upstream chunk BEFORE the client write, so a chunk whose write fails (abort before the first chunk, cancel under backpressure) no longer drops the usage it carried.
- On a client abort the pump keeps draining upstream (no more writes) until the provider's final usage arrives — Anthropic reports output last, OpenAI/Groq report all usage last, so stopping at the abort undercharged (to zero on OpenAI-shaped hosts). The drain is time-boxed; if it expires, upstream errors, or a stream ends without final usage, the unreported part is billed at a conservative upper bound (`max_tokens` for output, request bytes + headroom for input) and logged `estimated: true` with the reason.
- The spend-KV record and slot release are each bounded by a timeout, so a stalled KV can no longer withhold the relay debit.
- The post-response accounting is registered with Next's `after` (the platform `waitUntil`, edge included), so an isolate teardown after the response closes cannot drop the debit.
