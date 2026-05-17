---
"@motebit/protocol": major
---

Arc 2 of the off-ramp arc — P2P fee leg now composes as a direct delegator→treasury leg in the same atomic Solana multi-output tx. `P2pPaymentProof` gains required `fee_to_address` + `fee_amount_micro` fields. `TxVerificationResult.confirmed` shape evolves from single-recipient `{from, to, amountMicro}` to `{from, transfers[]}` to support multi-recipient transactions cleanly. New `ConfirmedTransferLeg` type exported alongside.

**Why this is a major bump.** Two breaking shape changes:

1. `P2pPaymentProof.fee_to_address` and `P2pPaymentProof.fee_amount_micro` are required (not optional). Pre-Arc-2 callers that constructed `P2pPaymentProof` without these fields will fail to typecheck. The wire-format change is the structural enforcement: a delegator's P2P task submission cannot omit the fee leg because the type system rejects it. Closes the sibling-doc contradiction the settlement_mode arc surfaced (`CLAUDE.md` "5% applies through both lanes" vs `services/relay/CLAUDE.md` rule 8's pre-Arc-2 "Fee: zero on P2P").

2. `TxVerificationResult.confirmed` variant changed from `{from, to, amountMicro, slot, asset}` to `{from, transfers: ConfirmedTransferLeg[], slot, asset}`. Consumers that read `result.amountMicro` or `result.to` now read `result.transfers[i].amountMicro` / `result.transfers[i].to`. Multi-recipient transactions are now first-class (no longer rejected as `not_found`); single-payer is still required (multi-payer remains ambiguous). The only authorized consumer of this surface (`services/relay/src/p2p-verifier.ts`) was updated in the same arc.

## Migration

`P2pPaymentProof` before:

```ts
const proof: P2pPaymentProof = {
  tx_hash,
  chain,
  network,
  to_address: workerSolanaAddress,
  amount_micro: workerNetMicro,
};
```

After:

```ts
import { deriveSolanaAddress } from "@motebit/wallet-solana";

const proof: P2pPaymentProof = {
  tx_hash,
  chain,
  network,
  to_address: workerSolanaAddress,
  amount_micro: workerNetMicro,
  // NEW — required after Arc 2. Treasury address derives from the
  // relay's published Ed25519 public key.
  fee_to_address: deriveSolanaAddress(relayPublicKeyBytes),
  fee_amount_micro: Math.round(workerNetMicro / (1 - platformFeeRate)) - workerNetMicro,
};
```

The delegator's runtime must construct a single atomic Solana transaction with TWO SPL Transfer instructions: one to `to_address` for `amount_micro`, one to `fee_to_address` for `fee_amount_micro`. Both signed by the same delegator keypair. The relay's `p2p-verifier` walks `transfers[]` on the tx and validates both legs match the declared amounts + addresses.

`TxVerificationResult` before:

```ts
const r = await adapter.getTransaction(sig);
if (r.status === "confirmed") {
  console.log(r.from, "→", r.to, ":", r.amountMicro);
}
```

After:

```ts
const r = await adapter.getTransaction(sig);
if (r.status === "confirmed") {
  for (const leg of r.transfers) {
    console.log(r.from, "→", leg.to, ":", leg.amountMicro);
  }
}
```

**Rationale.** The atomic multi-output composition is the doctrinally-clean answer to the sibling-doc contradiction surfaced during the settlement_mode arc. The five-iteration discipline converged on Option 2 (delegator-pays-relay-direct) over Options 1 (worker-pays-relay) or 3 (no settlement fee). Option 2 preserves the `endgame_architecture` 5%-at-settlement-checkpoint moat on every settlement while keeping the relay structurally out of the user-funds custody chain. The fee leg is the relay's own service-revenue collection (not held in trust for anyone) — distinguishable from FinCEN money transmission by the same logic that makes a vendor invoice payment legitimate.

Doctrine: [`docs/doctrine/off-ramp-as-user-action.md`](../docs/doctrine/off-ramp-as-user-action.md) "What Arc 1 did NOT close" → Arc 2 shipped section.
