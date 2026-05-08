---
"@motebit/runtime": minor
"@motebit/web": patch
"@motebit/desktop": patch
---

v1.5 — `ComputerSessionManager` learns to summarize. Companion to the
published-side changesets adding `ComputerSessionReceipt` to
`@motebit/protocol` and `signComputerSessionReceipt` /
`verifyComputerSessionReceipt` / `hashComputerSessionActions` to
`@motebit/crypto`.

Runtime additions:

- Per-action structural ledger (`ComputerSessionActionRecord[]`)
  appended on every `executeAction` call. Halt-rejected calls land
  in the ledger as `failure / user_preempted` so the receipt commits
  to the user's pause history honestly.
- Sensitivity envelope tracked on the session — lifts off
  `governance.classifyObservation`'s output (uses explicit
  `sensitivity_level` when supplied, else infers `"financial"` from
  `strip_bytes`). High-water mark, never decays.
- `summarize(sessionId, deps)` returns the unsigned body of a
  `ComputerSessionReceipt`. Caller injects the receipt-id generator,
  the embodiment_mode (apps stamp per-dispatcher per v1.1), and a
  `hashActions` function (typically wired to `@motebit/crypto`).
  Bounded post-close retention (FIFO, 64) keeps closed sessions
  summarizable.
- `halt()` stamps `was_halted: true` on every active session; sticky
  across `resume()` so the receipt commits to "user paused at least
  once," not to terminal halt state.
- v1.5 wiring slice: `runtime.signComputerSessionReceiptBody(body)`
  signs with the runtime's identity key and returns the signed
  receipt; `runtime.hashComputerSessionActions(actions)` is a
  re-export of the crypto helper so apps don't need a direct
  `@motebit/crypto` dep just for the digest.

App wiring (`@motebit/web` + `@motebit/desktop`):

- Both surfaces' `computer-tool.ts` accept new optional
  `signSessionReceipt` and `hashSessionActions` deps. When wired,
  every `closeSession` now also emits a
  `ComputerSessionSummarized` audit event with the signed
  `ComputerSessionReceipt` payload — fail-soft: a signing failure
  does not prevent the close-event append.
- `apps/web/src/web-app.ts` and `apps/desktop/src/desktop-tools.ts`
  pass the runtime's `signComputerSessionReceiptBody` and
  `hashComputerSessionActions` through to the registration. The
  runtime owns identity keys; apps own session managers + audit
  sinks; signing happens at the seam.
- New `EventType.ComputerSessionSummarized` on the audit-event
  stream.
