---
"motebit": patch
---

An implicit model now follows a persisted `default_provider` flip (found live on the founder's first 1.11.2 launch): the parse-time model default was derived from the parse-time provider, so a config-persisted provider switch left the old provider's default behind — bare `motebit` rendered `local-server · claude-sonnet-4-6`, the exact illegal pairing the admission gate exists to prevent, minted by the fallback path itself. The yield target is now derived through `defaultModelForProvider`, never trusted from residue; an explicit `--model` remains the user's word. Locked by an invariant test: every provider's own default is admissible on that provider.
