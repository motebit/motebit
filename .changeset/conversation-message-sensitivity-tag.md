---
"@motebit/sdk": minor
---

ConversationMessage carries an optional `sensitivity` tier; runtime filters trimmed history at AI-context construction time.

Closes the read side of the fifth (and final) egress-write boundary in the
sensitivity-floor arc. Each variant of the `ConversationMessage` discriminated
union (`user` / `assistant` / `tool`) now carries an optional
`sensitivity?: SensitivityLevel` field, and the runtime's
`ConversationManager.trimmed()` filters messages tagged above the current
effective session tier before the conversation is handed to the AI loop.

Untagged messages (legacy data persisted before the v1 floor, fixtures
without a runtime) flow through unchanged for backward compat.

Closes the cross-device leak shape: a Secret-effective turn on device A
persists user/assistant messages at Secret (write-side floor, shipped in
the prior commit); cross-device sync surfaces them to device B whose
session is at None tier; the pre-call AI gate sees None × None and passes;
trimmed history would carry the persisted-at-Secret messages into BYOK
without this filter. The read-side filter closes the bypass — tagged
messages above the current effective tier are excluded from trimmed
history regardless of what the gate permits, because trimmed history is
itself an egress shape.

```text
ConversationManager.trimmed():
  1. compute effective = getEffectiveSensitivity?() ?? None
  2. filter messages: keep msg if msg.sensitivity == null OR
       rankSensitivity(msg.sensitivity) <= rankSensitivity(effective)
  3. trim filtered history into the token budget
```

The filter is dynamic — driven by the runtime's `getEffectiveSessionSensitivity`
getter at each call — not a static `CONTEXT_SAFE_SENSITIVITY` constant. A
session whose tier elevates mid-conversation regains access to its own
elevated messages; a session at None excludes Secret messages even if
they are load-bearing for the current turn. Same posture the pre-call AI
gate enforces upstream.

Doctrine: `motebit-computer.md` §"Mode contract" — fifth boundary of the
egress-shape arc, now both write and read closed.
