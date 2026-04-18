---
"@motebit/wire-schemas": minor
---

Publish `settlement-record-v1.json` — the per-task settlement bookkeeping
artifact. After an executor returns an ExecutionReceipt and the relay
confirms it, settlement happens and a SettlementRecord is emitted as
proof of payment.

This is the "got paid" artifact in the marketplace participation loop.
A worker (motebit or otherwise) uses it to:

- Reconcile their earnings against expected fees
- Audit platform-fee transparency: `platform_fee_rate` is recorded
  per-settlement, so a relay that quietly changes its default fee
  cannot retroactively rewrite past settlements
- Trace on-chain payments via `x402_tx_hash` + `x402_network` (CAIP-2)
- Confirm the relay's `receipt_hash` matches their local copy of the
  receipt that earned the payment — closing the bookkeeping loop
  without trusting the relay's word

Money math is integer micro-units throughout (1 USD = 1,000,000) — the
schema uses `z.number()` with the convention documented; no floating-
point drift in payment amounts.

Drift defense #23 waiver count: 19 → 18.

Six wire formats now shipped:

- AgentResolutionResult (discovery response)
- AgentServiceListing (capabilities + pricing + SLA)
- DelegationToken (signed authorization)
- AgentTask (task envelope)
- ExecutionReceipt (signed proof of work)
- SettlementRecord (proof of payment)

Together they cover the full marketplace participation loop AND the
economic settlement that closes it. A non-motebit worker can now
discover, advertise, receive authorization, execute, emit proof,
and verify their payment — all using only published JSON Schemas.
