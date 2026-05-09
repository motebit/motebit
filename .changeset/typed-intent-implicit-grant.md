---
"@motebit/protocol": minor
"@motebit/sdk": minor
---

typed-intent-implicit-grant — `UserActionAttestation` widens from a
fixed `kind: "user-drag"` interface to a discriminated union over
`"user-drag" | "user-typed-intent"`. The new arm carries a typed
chat-input submit through perception alongside the existing drag
gesture; producers stay structurally compatible, consumers gain a
second case to discriminate on.

**Why this matters.** The runtime threads
`options.userActionAttestation` through `sendMessageStreaming` so
tools that need consent can distinguish a user-driven turn from
proactive idle work. The first consumer is `request_control` on
the web cloud-browser surface: when the AI's reach for `computer`
fails with `not_in_control` inside a turn the user typed and sent,
the `request_control` flow auto-grants instead of opening the
slab band's Grant/Deny doorbell. Re-confirming what the user can
already see they did would violate the calm-software doctrine
(`CLAUDE.md` § UI). Proactive paths (`generateActivation`,
idle-tick consolidation) never run through `sendMessageStreaming`,
so they never get a typed-intent attestation — the prompt band
fires as before, fail-closed by default.

**`@motebit/protocol` (minor):**

```text
- export interface UserActionAttestation { kind: "user-drag"; ... }
+ export type UserActionAttestation =
+   | { kind: "user-drag"; timestamp; surface; contentHashSha256? }
+   | { kind: "user-typed-intent"; timestamp; surface };
```

Additive new arm; the existing `user-drag` shape is preserved
field-for-field. Exhaustive consumers that switch on `kind` gain
one new case to handle.

**`@motebit/sdk` (minor):** re-exports the widened type through
`* from "@motebit/protocol"`. Surfaces that construct the
attestation pass `kind: "user-typed-intent"` from chat-input
handlers (today: web; sibling stamp on desktop / mobile when
they grow a virtual_browser surface). The minor cascade is
the structural one — the SDK's own surface didn't gain new
exports.

**Audit shape.** Auto-grant emits both control transitions
(`request_control` initiated by motebit, `grant` initiated by
user) synchronously in the same JS task; the band's reactive
subscribers see `handoff_pending → motebit` back-to-back before
the browser repaints, so no visible band flicker. The audit log
reads identically to a band-tap grant; the differentiator
(typed-intent vs band-tap) lives in the surface's chat history
alongside the message timestamp.
