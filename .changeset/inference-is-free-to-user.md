---
"@motebit/sdk": minor
---

Add `inferenceIsFreeToUser(mode)` — the canonical predicate for whether inference under a given `ProviderMode` is free to the user (`on-device` / `byok`) versus operator-metered (`motebit-cloud`). Single source of truth for the "proactive consolidation defaults ON only when inference is free" policy; web / desktop / mobile consume it instead of inlining the mode comparison, so the default-on policy cannot drift between surfaces. Exhaustive switch — a future `ProviderMode` entry forces an explicit free-or-metered decision. See `docs/doctrine/proactive-interior.md` § "Default posture".
