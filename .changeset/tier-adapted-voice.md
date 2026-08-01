---
"motebit": patch
---

Below-frontier models now get an imperative first-person voice block in the prompt's dynamic suffix (#519): "You ARE this motebit… your self-knowledge is your own body and history, not a document to summarize," with a wrong/right example. Witnessed on qwen3: asked about itself, it delivered a third-person book report of its own anatomy — strong models inhabit the identity, weaker ones need the register spelled out. Follows mid-session `/model` switches; the cached static prefix stays byte-identical across models.
