---
"@motebit/sdk": minor
---

New defaults: Anthropic `DEFAULT_ANTHROPIC_MODEL` is now `claude-sonnet-5-5` (was `claude-sonnet-5`), and OpenAI `DEFAULT_OPENAI_MODEL` is now the full `gpt-5.4` (was `gpt-5.4-mini`). The Anthropic picker's fast tier is now Claude Haiku 5.5 (`claude-haiku-5-5`), added to `ANTHROPIC_MODELS` after the scheduled catalog check found it live and missing (#654). A model you already chose is kept; only an unset model picks up the new default.
