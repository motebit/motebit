---
"motebit": patch
---

The CLI picks up `@motebit/sdk`'s new defaults: Anthropic's default is now Sonnet 5.5 (was Sonnet 5), its fast tier is now Haiku 5.5, and OpenAI's default is the full `gpt-5.4` (was `gpt-5.4-mini`). The exact model ids are in `@motebit/sdk`'s changelog for this release. A model you already chose is kept; only an unset model picks up the new default.
