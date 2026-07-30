---
"motebit": patch
---

Requests to the Opus 4.7+/Claude-5 model family are now shaped to what those models accept (#471 sibling, witnessed live: every claude-opus-5 turn 400'd because the CLI's personality default temperature rode every request — Anthropic removed sampling parameters on that family). The provider now omits `temperature` at the request-body build for models that reject it, whatever any caller configured, and extended thinking emits the adaptive shape instead of the removed `budget_tokens` form on the same family. Models that still accept sampling (Opus 4.6, Sonnet 4.5, Haiku 4.5, local models) are untouched.
