---
"@motebit/verify": minor
---

`motebit-verify approval-decision <file>` — verify a signed human-consent decision (the "approve" governance band) offline through the canonical public CLI.

Completes the governance triad's public verification surface. The auto band (`ToolInvocationReceipt`) and deny band (`ExecutionReceipt{status:"denied"}`) were already verifiable through the receipt path; the approve band's `ApprovalDecision` was only checkable via the low-level `@motebit/crypto` primitive. This adds the consumer-facing verb so a third party can verify proof-of-permission-before-action with one install and the signer's public key — no relay, no account.

The decision carries the approver's embedded `public_key`, so verification is self-contained offline. `--producer-key <hex>` pins which approver is expected (rejects `producer_key_mismatch`); `--expect-verdict approved|denied` asserts the outcome and fails loud otherwise. Pure wiring around `@motebit/crypto`'s `verifyApprovalDecision` (no new crypto in the aggregator); a subcommand rather than auto-detection so the artifact stays contained without expanding the core detector union. Paired with a new `developer/governance-triad` doc page covering how to verify each of the three bands.
