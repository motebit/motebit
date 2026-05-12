---
"motebit": minor
---

Add `/welcome` onboarding slash command — Phase 1 of the onboarding arc.

A calm one-message tour that names the three thesis pillars (persistent sovereign identity, accumulated trust, governance at the boundary) and points to universal slash commands every surface ships (`/trust`, `/memories`, `/forget`, `/help`). The thesis is now visible at multiple surfaces but discoverable only by typing slash commands the user doesn't yet know exist; `/welcome` is the forcing function that makes the architecture's accumulated state legible at first encounter rather than only on the third slash command the user thinks to type.

`cmdWelcome` lives in `@motebit/runtime`'s shared command dispatcher, so the same tour fires on web/desktop/mobile/CLI. Surface-specific suggestions (`/cookies` on web, `/computer` on web+desktop) can be layered by each surface's slash handler as overlay — same pattern `/trust` uses for the web cookies dimension.

Phase 2 (deferred): auto-fire `/welcome` on first-conversation via the existing `contextPack.firstConversation` flag. Today's ship is the on-demand discovery affordance.

Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md` § trust-accumulation visibility arc.
