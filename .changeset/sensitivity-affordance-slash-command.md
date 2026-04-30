---
"motebit": patch
---

Privacy doctrine — `/sensitivity [<level>]` slash command on the published `motebit` runtime (CLI surface). Closes the "code without UX" gap left by sensitivity-routing v1+v2: the runtime engine API exists (`setSessionSensitivity` / `getSessionSensitivity`), the gates fire correctly (`SovereignTierRequiredError` on AI calls + outbound tool dispatch), but until this ship no surface let users actually elevate the tier. Session sensitivity stayed pinned at `"none"` everywhere — gates were unreachable from any user action.

**Surface symmetry:** all four surfaces (cli / desktop / mobile / web) ship the same affordance with surface-native semantics:

- `/sensitivity` — show current tier
- `/sensitivity status` — same
- `/sensitivity none|personal|medical|financial|secret` — set tier
- Invalid tier → usage hint with current tier inline

**Calm-software-doctrine compliant.** Silent on default (no toast on status); single system-message line on elevation explaining the consequence ("Session elevated to medical — outbound tools and external AI will fail-close until you switch to a sovereign provider"). No popups, no nagging, no double-confirmation — the user typed the command, the gate is in effect.

`apps/cli` implementation: added entry to `args.ts` `COMMANDS` list and dispatch case in `slash-commands.ts`. Reads/writes through `runtime.getSessionSensitivity` / `setSessionSensitivity` directly. Desktop/mobile/web halves ship in the sibling `sensitivity-affordance-slash-command-ignored.md` changeset.

The full sensitivity-routing arc is now end-to-end: doctrine claim → runtime engine API → gate enforcement (AI + outbound tools) → drift defense → user surface. No surface forks the dispatch; every surface routes through the same canonical setter.
