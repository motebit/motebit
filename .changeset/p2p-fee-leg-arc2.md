---
"@motebit/protocol": minor
---

Arc 2 of the off-ramp arc — P2P fee leg now composes as a direct delegator→treasury leg in the same atomic Solana multi-output tx. `P2pPaymentProof` gains optional `fee_to_address` + `fee_amount_micro` fields. `TxVerificationResult.confirmed` shape (internal to `@motebit/wallet-solana`, which is not published) evolves from single-recipient `{from, to, amountMicro}` to `{from, transfers[]}` to support multi-recipient transactions cleanly.

**Why this stays minor — additive shape, runtime-enforced contract.** The two new fields on `P2pPaymentProof` are declared **optional** at the type level so existing v1.x consumers that construct the type directly keep typechecking. They are functionally required for every post-Arc-2 submission: the relay's `/tasks` endpoint (`services/relay/src/tasks.ts:1664-1669`) returns HTTP 400 "Incomplete payment_proof fields" if either is missing. The contract is enforced at the relay-submission boundary at runtime, not by the type system — a deliberate Path B decision per the project's "save majors for ground-shifts" position.

This is the v1.x position. A future v2.0.0 may promote these fields to required at the type level when an actual ground-shift in the settlement model justifies the major bump; until then the optional shape preserves v1 stability while the runtime check keeps the fee leg structurally present on every submitted P2P settlement. Closes the sibling-doc contradiction the settlement_mode arc surfaced (top-level `CLAUDE.md` "5% applies through both lanes" vs `services/relay/CLAUDE.md` rule 8's pre-Arc-2 "Fee: zero on P2P") without burning the protocol's first major on a fee-leg addition.

## Migration

`P2pPaymentProof` callers (v1.x → v1.x with this minor):

```ts
import { deriveSolanaAddress } from "@motebit/wallet-solana";

const proof: P2pPaymentProof = {
  tx_hash,
  chain,
  network,
  to_address: workerSolanaAddress,
  amount_micro: workerNetMicro,
  // Newly available — populate when submitting to a post-Arc-2 relay.
  // Omitting these typechecks (the fields are optional) but the relay
  // rejects the submission with HTTP 400 at /tasks.
  fee_to_address: deriveSolanaAddress(relayPublicKeyBytes),
  fee_amount_micro: Math.round(workerNetMicro / (1 - platformFeeRate)) - workerNetMicro,
};
```

The delegator's runtime must construct a single atomic Solana transaction with TWO SPL Transfer instructions: one to `to_address` for `amount_micro`, one to `fee_to_address` for `fee_amount_micro`. Both signed by the same delegator keypair. The relay's `p2p-verifier` walks `transfers[]` on the tx and validates both legs match the declared amounts + addresses.

**Rationale.** The atomic multi-output composition is the doctrinally-clean answer to the sibling-doc contradiction surfaced during the settlement_mode arc. The five-iteration discipline converged on Option 2 (delegator-pays-relay-direct) over Options 1 (worker-pays-relay) or 3 (no settlement fee). Option 2 preserves the `endgame_architecture` 5%-at-settlement-checkpoint moat on every settlement while keeping the relay structurally out of the user-funds custody chain. The fee leg is the relay's own service-revenue collection (not held in trust for anyone) — distinguishable from FinCEN money transmission by the same logic that makes a vendor invoice payment legitimate.

Doctrine: [`docs/doctrine/off-ramp-as-user-action.md`](../docs/doctrine/off-ramp-as-user-action.md) "What Arc 1 did NOT close" → Arc 2 shipped section.
