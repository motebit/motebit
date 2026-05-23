---
"@motebit/sdk": major
---

`@motebit/sdk` re-exports the entire `@motebit/protocol` surface via `export * from "@motebit/protocol"` (`src/index.ts:1`), so the `@motebit/protocol@2.0.0` breaking changes flow through the sdk's public surface unchanged. The sdk majors in lockstep to keep that honest.

**Why this is a major bump.** Three protocol breaking changes are observable through `@motebit/sdk` imports, not just `@motebit/protocol`:

1. `GuestRail.withdraw()` / `withdrawBatch?()` removed (now on the `WithdrawableGuestRail` marker only). `import { GuestRail } from "@motebit/sdk"; rail.withdraw(...)` no longer compiles.
2. `P2pPaymentProof` gains required `fee_to_address` + `fee_amount_micro`, and `TxVerificationResult.confirmed` reshapes from `{ from, to, amountMicro }` to `{ from, transfers: ConfirmedTransferLeg[] }`. Constructing or reading these via the sdk re-export breaks.
3. `SettlementRecord` gains a required `settlement_mode` field. Constructing one (directly or through `signSettlement(Omit<SettlementRecord, ...>, ...)`) imported from the sdk fails to typecheck.

The sdk's _own_ contract — the provider-mode resolver, presets, config vocabularies, model registry — is unchanged. But per `packages/sdk/CLAUDE.md` rule 2, the sdk stays at its current major only "as long as the re-export surface stays compatible." These protocol changes break that surface, so shipping them as a minor would silently break any consumer importing the protocol types from `@motebit/sdk@^1`. The major bump versions the break honestly.

## Migration

Identical to `@motebit/protocol@2.0.0` — the re-exported types are the same symbols. Narrow `GuestRail` through `isWithdrawableRail()` before calling `withdraw()`; supply `fee_to_address` / `fee_amount_micro` when constructing `P2pPaymentProof`; read `TxVerificationResult.confirmed.transfers[]` instead of `.to` / `.amountMicro`; supply `settlement_mode` when constructing a `SettlementRecord`.
