---
"@motebit/encryption": minor
"@motebit/render-engine": minor
---

v1.5 detach — `ComputerSessionReceipt` emerges in the scene as a
verifiable artifact. Closes the v1.5 loop end-to-end so the receipt
the runtime signed at session-close becomes something the user can
hold, expand, and hand to a third party.

`@motebit/encryption` aggregator now re-exports
`signComputerSessionReceipt`, `verifyComputerSessionReceipt`,
`hashComputerSessionActions`, and `COMPUTER_SESSION_RECEIPT_SUITE`
from `@motebit/crypto` — sibling-boundary expansion alongside
`signExecutionReceipt` / `verifyReceiptChain` etc. so consumers that
already pull receipt signing from encryption don't need a parallel
import path.

`@motebit/render-engine` adds `buildComputerSessionReceiptArtifact`,
sibling of `buildReceiptArtifact`. Same `.spatial-artifact` +
`.artifact-receipt` CSS hooks; surface stylesheets style both
uniformly. Carries an additional `.artifact-computer-session` class
for the v1.5-specific accent rules.

Card surfaces:

- title `computer session · <embodiment_mode>` (visual disambiguation
  between virtual_browser and desktop_drive sessions at a glance)
- summary line: action count, success/failure split, halt marker
  prepended when `was_halted: true`, sensitivity tier inline when
  elevated above `none`
- collapsible details: receipt_id, session_id, signed by, signature,
  suite, public_key, display dimensions, opened/closed times,
  close_reason, actions_hash, per-failure-reason breakdown
- verify state pulse: pending → verified-locally / unverified, runs
  Ed25519 verify with the embedded public key (zero relay contact)

Privacy invariant. The card surfaces every signed field; the protocol
type already commits to structural facts only — no targets, args, or
observation bytes. Nothing leaks through the artifact that wasn't
already in the wire-format, by construction.

18 new structural-render + verify-transition + interaction tests in
`packages/render-engine/src/__tests__/computer-session-receipt-artifact.test.ts`.
