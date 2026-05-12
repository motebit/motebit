---
"motebit": minor
---

Add `/trust` slash command to the CLI's command registry.

Surfaces the canonical 5-dimension trust-accumulation summary (memories + conversations + signed receipts + signed deletions + federation peers) computed by `cmdTrust` in `@motebit/runtime`. The same command was already registered on web, desktop, and mobile this session; the CLI registration closes the four-surface contract that `check-trust-slash-cross-surface` (drift-defense #82, landing this commit) locks in.

Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md` § trust-accumulation visibility arc.
