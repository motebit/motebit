---
"motebit": patch
---

Add explicit `case "trust":` + `case "welcome":` arms in the CLI REPL slash-command dispatcher (`apps/cli/src/slash-commands.ts`). Both delegate to `trySharedCommand` (same path the `default` arm uses for shared-runtime commands), but the explicit dispatch satisfies the CLI's `command-registry` test that pins every COMMANDS registry entry to a corresponding switch case. Functionally identical to the prior default-arm fallback; no runtime behavior change.

Caught by pre-push principal review of the 36-commit session arc — the registry-pin test surfaced when `pnpm test` ran (the drift-defense gates passed because they don't include unit tests).
