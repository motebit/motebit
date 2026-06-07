---
"@motebit/verifier": minor
"@motebit/verify": patch
---

Surface `ApprovalDecision` verification for browser/library consumers — close the cold-consume gaps an external integrator hit.

A cold consume of the just-shipped governance triad (an outside developer using only public docs + npm) found the approve-band artifact was real but undiscoverable: the docs pointed browser users to `@motebit/verifier`, which didn't expose approval verification, and the `@motebit/verify` README never mentioned it — so the capability looked absent when it was only unsurfaced.

- `@motebit/verifier`: re-export `verifyApprovalDecision` (+ the `ApprovalDecision` type) from the browser-safe `@motebit/crypto` primitive, so consumers already depending on this library can verify a human-consent decision client-side without adding a second dependency.
- `@motebit/verify`: README now documents the `approval-decision` subcommand, the governance triad (approve/deny/auto), the **browser path** (`import { verifyApprovalDecision } from "@motebit/crypto"`), and a `verify` vs `verifier` vs `crypto` disambiguation — plus the honest framing that a verified `ApprovalDecision` is signature-authentic against a _pinned_ approver key, not authority-bound (verifying against the embedded key alone is circular).

Paired with a non-published canonical `ApprovalDecision` fixture (+ published approver key) and a new `developer/governance-triad` doc page covering where a verified decision sits on the binding ladder.
