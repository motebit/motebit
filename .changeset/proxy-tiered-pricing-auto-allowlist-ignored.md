---
"@motebit/proxy": patch
---

Proxy pricing + routing authority. `gemini-2.5-pro` is now billed at Google's long-context tier (the whole turn at $2.50/$15 per M) when the REPORTED prompt (uncached + cached tokens) exceeds 200k, as data on the model row (`longContext`), not a special case. Every other row carries an explicit posture: Anthropic is bounded by its own 200k window (the long-context beta header is never sent); rows whose context-length tiers are not confirmed (OpenAI, Gemini Flash/Flash-Lite, Groq) refuse a prompt whose conservative byte bound exceeds 200k tokens with `400 prompt_exceeds_priced_tier` before anything spends. `model: "auto"` now resolves only to a model the token's allowlist names (with a configured key and a priced ceiling that covers the prompt) on every routing exit; the resolved model passes the same allowlist check as an explicit one, so auto never escalates past a welcome-credit token's ceiling.
