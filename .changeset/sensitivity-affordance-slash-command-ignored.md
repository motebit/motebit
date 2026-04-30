---
"@motebit/desktop": patch
"@motebit/mobile": patch
"@motebit/web": patch
---

Privacy doctrine — `/sensitivity [<level>]` slash command, surface half. Same affordance shape on every surface (status / set / invalid-arg usage hint), wired to the canonical `runtime.{get,set}SessionSensitivity` setters introduced in `sensitivity-routing-v1`.

Per-surface notes:

- `apps/desktop` — added entry to `ui/slash-commands.ts` `SLASH_COMMANDS` and dispatch case in `ui/chat.ts`. Routes through new `DesktopApp.{get,set}SessionSensitivity` thin wrappers around the runtime methods.
- `apps/mobile` — added dispatch case in `slash-commands.ts` and corresponding `MobileApp` wrappers. Help text updated to list the new command.
- `apps/web` — added entry to `ui/slash-commands.ts` `SLASH_COMMANDS`. Web's autocomplete-select indirection discards args (path designed for UI-action commands), so `tryExecute` now intercepts `/sensitivity` inline and routes through `ctx.app.getRuntime()` directly. First arg-bearing slash command on the web surface — the inline-handling pattern composes cleanly if more arg-bearing commands land later.

Published `motebit` runtime half (CLI-surface implementation in `apps/cli`) ships in the sibling `sensitivity-affordance-slash-command.md` changeset.
