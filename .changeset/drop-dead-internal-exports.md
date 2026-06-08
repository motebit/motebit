---
"motebit": patch
---

Remove the dead internal `isPlanEmpty` helper from the `up` subcommand — it was exported but had zero callers (not a CLI command or public API). No behavior change.
