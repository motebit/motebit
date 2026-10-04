---
"motebit": minor
---

Anthropic model defaults follow the sdk picker (#654). With no `--model`, `--provider anthropic` now runs `claude-sonnet-5` (from `DEFAULT_ANTHROPIC_MODEL`; an explicit `--model` or config `default_model` is unchanged). `/model opus|sonnet|haiku` resolve through the picker tiers — Opus 5.5, Sonnet 5, Haiku 4.5 — fixing `/model haiku`, which named `claude-haiku-4-5`, an id outside the registry. `--help` defaults and the `motebit.yaml` schema's model description are rendered from the sdk default constants instead of hand-copied literals.
