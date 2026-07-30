---
"motebit": patch
---

Claude model ids are now real (#471, first half). `/model opus` pointed at a fabricated id (`claude-opus-4-6-20250414` — Anthropic 404s it) and `sonnet` at the equally fictional `claude-sonnet-4-5-latest`; switching persisted the broken id as the session default. The alias table now carries the current live aliases (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`), and the task router's model tiers — which fed unservable family names like `claude-opus` straight into the provider — resolve to the same real ids. The provider-blind half of #471 (offering models the active provider cannot serve, and persisting an un-admitted default) remains open as designed work.
