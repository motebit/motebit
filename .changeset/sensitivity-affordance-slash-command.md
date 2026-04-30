---
"motebit": patch
"@motebit/desktop": patch
"@motebit/mobile": patch
"@motebit/web": patch
---

Privacy doctrine — `/sensitivity [<level>]` slash command on every surface. Closes the "code without UX" gap left by sensitivity-routing v1+v2: the runtime API exists (`setSessionSensitivity` / `getSessionSensitivity`), the gates fire correctly (`SovereignTierRequiredError` on AI calls + outbound tool dispatch), but until this ship no surface let users actually elevate the tier. Session sensitivity stayed pinned at `"none"` everywhere — gates were unreachable from any user action.

**Surface symmetry:** all four surfaces (cli / desktop / mobile / web) ship the same affordance with surface-native semantics:

- `/sensitivity` — show current tier
- `/sensitivity status` — same
- `/sensitivity none|personal|medical|financial|secret` — set tier
- Invalid tier → usage hint with current tier inline

**Calm-software-doctrine compliant.** Silent on default (no toast on status); single system-message line on elevation explaining the consequence ("Session elevated to medical — outbound tools and external AI will fail-close until you switch to a sovereign provider"). No popups, no nagging, no double-confirmation — the user typed the command, the gate is in effect.

**Per-surface implementation notes:**

- `apps/cli` — added entry to `args.ts` `COMMANDS` list and dispatch case in `slash-commands.ts`. Reads/writes through `runtime.getSessionSensitivity` / `setSessionSensitivity` directly.
- `apps/desktop` — added entry to `ui/slash-commands.ts` `SLASH_COMMANDS` and dispatch case in `ui/chat.ts`. Routes through new `DesktopApp.{get,set}SessionSensitivity` thin wrappers around the runtime methods.
- `apps/mobile` — added dispatch case in `slash-commands.ts` and corresponding `MobileApp` wrappers. Help text updated to list the new command.
- `apps/web` — added entry to `ui/slash-commands.ts` `SLASH_COMMANDS`. Web's autocomplete-select indirection discards args (path designed for UI-action commands), so `tryExecute` now intercepts `/sensitivity` inline and routes through `ctx.app.getRuntime()` directly. First arg-bearing slash command on the web surface — the inline-handling pattern composes cleanly if more arg-bearing commands land later.

The full sensitivity-routing arc is now end-to-end: doctrine claim → runtime API → gate enforcement (AI + outbound tools) → drift defense → user surface. No surface forks the dispatch; every surface routes through the same canonical setter.
