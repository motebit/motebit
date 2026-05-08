---
"@motebit/protocol": minor
"@motebit/crypto": minor
"@motebit/runtime": minor
---

v1.5 — `ComputerSessionReceipt` closes the asymmetry where delegation
has signed receipt chains but virtual_browser / desktop_drive sessions
emit only lifecycle events. Every computer-use session now crystallizes
at close into one signed artifact a third party with the signer's
public key can verify without contacting any relay — the moat thesis
("accumulated trust") applied to the embodiment that previously had
none.

`@motebit/protocol` (Apache-2.0, permissive floor) adds three types
under `computer-use.ts`:

- `ComputerSessionActionRecord` — per-action structural roll-up
  (`kind` + timing + outcome + `failure_reason`). Carries no targets,
  args, or observation bytes — privacy invariant of the session-level
  receipt is compositional with the audit invariant of per-action
  `ToolInvocationReceipt`s.
- `SignableComputerSessionReceipt` — body before signing (counts,
  outcomes_summary, failure_breakdown by `ComputerFailureReason`,
  was_halted, max_sensitivity envelope, opened/closed timestamps,
  display dimensions, embodiment_mode, JCS-canonicalized SHA-256
  `actions_hash`).
- `ComputerSessionReceipt` — signed; `suite:
"motebit-jcs-ed25519-b64-v1"` + `signature` (base64url).

`@motebit/crypto` adds `signComputerSessionReceipt`,
`verifyComputerSessionReceipt`, and `hashComputerSessionActions` —
sibling pattern to `signToolInvocationReceipt` / `hashToolPayload`.
Same JCS+Ed25519+base64url pipeline; same fail-closed verifier rules.

`@motebit/runtime` extends `ComputerSessionManager`:

- Per-action structural ledger appended on every `executeAction`
  call (including halt-rejected calls — `was_halted: true` +
  `user_preempted` failures land in the receipt honestly).
- Sensitivity envelope lifts off `governance.classifyObservation`'s
  output; uses an explicit `sensitivity_level` when the classifier
  supplies one, falls back to inferring `"financial"` from
  `strip_bytes` (the conservative floor of the medical/financial/secret
  bytes-strip trio per CLAUDE.md). High-water mark, never decays.
- New `summarize(sessionId, deps)` produces the unsigned body. Caller
  injects the receipt-id generator, the embodiment_mode (apps stamp
  per-dispatcher per v1.1), and the `hashActions` function (typically
  wired to `@motebit/crypto`'s `hashComputerSessionActions`). Closed
  sessions remain summarizable via a bounded post-close retention
  buffer (FIFO, capacity 64).
- `halt()` now stamps `was_halted: true` on every active session;
  sticky across `resume()` so the receipt commits to "the user paused
  at least once," not to terminal halt state.

Wiring the signed receipt into the audit-event stream and surfacing it
on the slab as a detachable artifact is the next slice (the runtime
piece is the gate; UI follows). 14 crypto sign/verify tests + 11
runtime summarize tests + all 41 prior session-manager tests pass.
