---
"@motebit/sdk": patch
---

`openai` is now verified live.

A real turn ran through `OpenAIProvider` against `gpt-5.4-mini` — 39 streamed chunks and a tool call whose arguments reassembled intact — so `PROVIDER_VERIFICATION.openai` moves from `available` to `verified` and its note drops "no live turn witnessed yet".

The status is evidence-backed rather than expected-to-work: the same probe found the vendor completely broken two runs earlier, 400-ing on every turn against a parameter the gpt-5 family had removed. That is what `available` was there to say.

Only `openai` moves. `google`, `groq` and `deepseek` ride the same OpenAI-compat wire, and a passing openai turn is evidence about the SHAPE, never about their own quirks behind it — Gemini's compat gaps and DeepSeek's parameter rejections are exactly the kind of thing that hides behind a shared adapter. They stay `available` until each has its own key and its own passing probe.
