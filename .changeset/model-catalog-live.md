---
"motebit": patch
---

`/model` now lists the ACTIVE provider's live catalog (#475): Anthropic and OpenAI via their models endpoints, local servers via ollama's `/api/tags` (with the OpenAI-compatible `/v1/models` as second shot). The list shown is the list served — a live id outside the static alias table is admissible, and an aliased id the provider no longer serves is refused with the reason. The static table demotes to name resolution plus a clearly marked offline fallback (`offline list — live catalog unavailable (…)`); any fetch failure degrades softly, never blocks the command.
