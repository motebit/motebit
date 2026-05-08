---
"@motebit/runtime": minor
---

Co-browse Slice 2c — runtime orchestrator for user-driven input
forwarding. Wires the Slice 2c protocol primitives into the cloud-
browser dispatcher and the session manager.

**`ComputerSessionManager.forwardUserInput(sessionId, event)`** —
new method, sibling of `executeAction`. Symmetric outcome envelope
(`UserInputForwardResult`) carrying both the structured wire result
AND the redacted audit payload the caller emits to the event log.
Gate ordering:

1. session-validity → `session_closed`
2. co-browse-machine presence → `not_supported` (forwarding has no
   policy plane on `desktop_drive`)
3. control state → `not_in_user_state` (any kind ≠ user rejects)
4. dispatcher capability → `not_supported` (dispatcher omits
   `forwardInput`)
5. transport call → `transport_error` on dispatcher throw

Every branch builds the audit payload up front so the caller
always has something to emit, even on rejection. Raw text/keys/
pixel coordinates stay in the wire `event` only as long as the
dispatcher needs them — never land in the returned audit.

**`ComputerPlatformDispatcher.forwardInput?(event)`** — new
optional interface method. `CloudBrowserDispatcher.forwardInput`
implements it (POST `/sessions/:id/forward-input` via the existing
`request<T>` HTTP helper). Tauri-based desktop dispatchers omit
the method by design.

**Redaction helpers** (`co-browse-input.ts`) — pure functions
exported for the orchestrator AND for any future consumer that
needs to redact input events at a different layer:

- `classifyCharacter(key)` → `CharacterClass`. Single-character
  Unicode-category-driven; multi-char unrecognized keys collapse
  to `unknown` (privacy guard against IME composition leaks).
- `classifyKeyRole(key, modifiers)` → `KeyRole`. Any non-shift
  modifier turns the press into `shortcut`; shift alone keeps
  printable input as `printable` (capital letters / symbols are
  printable, not shortcuts).
- `pasteAuditDetail(text)` → `{length, line_count, looks_like_url}`.
  `looks_like_url` is `^https?://...` matching only — conservative
  by design (false positives mis-categorize sensitive content).
- `buildUserInputAuditDetail(event, displayWidth, displayHeight)`
  → `UserInputForwardedDetail`. The orchestrator's redaction
  entrypoint; click coordinates normalize to [0, 1] against the
  cloud viewport.

**Visual-continuity-lost path.** Each per-event forward returns
`transport_error` and emits an audit on dispatcher throw; the
broader screencast-drop disconnect (revert-to-user via
`coBrowseControl.disconnect()`) stays at the surface layer where
the screencast bus lives. Two different time-scales: per-event
forward fault vs sustained visibility loss; the surface owns the
sustained signal.

37 new tests — redaction helper unit coverage (every character
class, every key role, paste-content-never-logged, mutation-after-
forward-cannot-taint-audit), gate-enforcement integration
(every state × every rejection reason), surface-determinism
structural checks (no raw `text` / `key` / pixel fields on the
audit type union).
