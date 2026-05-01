# Settlement rails

External money movement uses three interfaces in `@motebit/protocol` (Layer 0), split by custody as a compile-time discriminant.

## The custody split

- **`SettlementRail`** — base marker. `name`, `custody`, `isAvailable`.
- **`GuestRail extends SettlementRail`** — relay-custody. The relay holds the user's money in a virtual account and the rail moves it across the membrane.
- **`SovereignRail extends SettlementRail`** — agent-custody. The agent's identity key signs and the rail is the agent's own wallet.

`custody: "relay" | "agent"` is the discriminating literal.

**GuestRail types:** `fiat` (Stripe), `protocol` (x402, MPP), `orchestration` (Bridge). There is no `direct_asset` GuestRail — direct onchain transfer is always sovereign. `DepositableGuestRail extends GuestRail` adds `deposit()`; `isDepositableRail()` type-guards the narrowing. Protocol rails are pay-per-request — money moves at the HTTP boundary.

**SovereignRail surface:** `chain`, `asset`, `address`, `getBalance`. Reference implementation: `SolanaWalletRail` in `@motebit/wallet-solana`. Future Ed25519-native chains (Aptos, Sui) satisfy the same interface.

## Doctrine enforced at the type level

`SettlementRailRegistry.register()` accepts only `GuestRail`. The compiler rejects attempts to register a `SovereignRail` at the relay — "relay is a convenience layer, not a trust root" stops being prose and becomes a type error. The negative proof lives in `services/relay/src/__tests__/custody-boundary.test.ts` with a `@ts-expect-error` assertion; if someone widens the registry, that file stops compiling. The `/health/ready` rail manifest advertises only guest rails — sovereign settlement has no mediator to advertise.

`PaymentProof.railType` retains `"direct_asset"` since payment proofs span both custody boundaries — only the rail registration is split.

## Evidence regimes per settlement mode

Custody is one axis. Evidence regime — how deletion claims become structurally verifiable rather than relying on operator promises — is an orthogonal one. The architecture has three deployment surfaces, three evidence regimes:

| Surface                                                                                                               | Audit storage                                                                                                                                                                                                                                                | Evidence mechanism                                                                                                                       | Witness needed?                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Relay-to-relay federation audit**                                                                                   | Relay-side: five operational ledgers (`relay_execution_ledgers`, `relay_settlements`, `relay_credential_anchor_batches`, `relay_revocation_events`, `relay_disputes`) under `append_only_horizon` retention per [`retention-policy.md`](retention-policy.md) | Federation co-witness via `POST /federation/v1/horizon/witness` ([`spec/relay-federation-v1.md`](../../spec/relay-federation-v1.md) §15) | **Yes** — shared state across relays, requires multi-party attestation                                                                |
| **Motebit-to-motebit via relay** (`settlement_mode='p2p'` with relay-mediated discovery + audit)                      | **Dual:** relay records `settlement_mode='p2p'` row in `relay_settlements` (witness-protected at the relay layer, row above) AND each motebit holds its own signed receipt                                                                                   | Federation-witnessed relay-side audit + bilaterally-held signed receipts                                                                 | **At the relay layer** (yes — `relay_settlements` is shared state); at the bilateral layer (no — receipts already self-prove)         |
| **Motebit-to-motebit pure sovereign** (no relay involvement; `http-receipt-exchange.ts` / libp2p / WebRTC transports) | Each motebit's own `event_log`; each side holds its own signed receipt                                                                                                                                                                                       | Bilateral signed receipts ARE the evidence                                                                                               | **No** — no shared log exists to omit from; deletion of one side's local audit doesn't destroy the counterparty's verifiable artifact |

The unifying principle: **witness machinery scales to shared state; bilateral signed receipts replace witness where state is bilateral; the sovereign floor needs no federation overhead because the cryptographic primitives already do the work**.

This is why the federation co-witness machinery shipped in retention-policy phase 4b-3 applies relay-only. The witness mechanism does NOT extend to the per-motebit layer — but not because "agents don't peer" (they absolutely do, via `evaluateSettlementEligibility` in `services/relay/src/task-routing.ts` for P2P settlement, via `sovereign-receipt-exchange.ts` for direct receipt exchange, via P2P disputes recorded as trust-layer objects). The witness mechanism is structurally absent at the bilateral layer because the evidence model is already complete: each motebit holds its own signed receipt, deletion of one side doesn't destroy the counterparty's evidence, no shared log exists to selectively omit from. Imposing federation-style witness overhead on bilateral state would be redundant cryptographic work for no audit gain.

**Capability extension for P2P-via-relay specifically:** before phase 4b-3, a relay could selectively delete a `settlement_mode='p2p'` row from `relay_settlements` to hide a problematic delegator-worker pair from cross-relay trust scoring. After phase 4b-3, doing so requires forging or omitting witness signatures from federation peers — which is structurally detectable via `WitnessOmissionDispute` ([`spec/dispute-v1.md`](../../spec/dispute-v1.md) §9.6, verifier in `@motebit/crypto::verifyWitnessOmissionDispute`). The witness machinery covers exactly the P2P audit attack surface that has shared state (the relay-side row); it leaves alone the bilateral artifact (each motebit's own receipt copy) because no attack surface exists there.

**Forward compatibility:** `HorizonSubject` in `@motebit/protocol::retention-policy.ts` already discriminates `motebit | operator` — so if direct motebit-to-motebit federation ever emerges (peer motebits forming witness graphs without a relay intermediary), the same protocol shape extends downward. A future per-motebit horizon cert with co-witness from peer motebits reuses the existing verifier path. The door is open by construction if the evidence regime ever needs to drop one layer; today the bilateral-receipts model means it doesn't.

See also: [`retention-policy.md`](retention-policy.md) decision 9 (witness trigger is structural, not self-declared) and decision 4 sub-note (Path A quorum operationalizes the structural-witness rule for the relay layer).

## SolanaWalletRail (sovereign onchain)

The reference `SovereignRail`. Lives in `packages/wallet-solana` (Layer 1). Declares `custody: "agent"`, `name: "solana-wallet"`, `chain: "solana"`, `asset: "USDC"`.

Solana uses Ed25519 — the same curve we already chose for sovereign identity — so the motebit's identity public key IS its Solana address by mathematical accident. No second key, no custodial provider, no vendor approval. `Keypair.fromSeed(identitySeed)` derives the wallet from the existing 32-byte Ed25519 seed; the resulting address is identical to the motebit identity public key.

The rail delegates to a swappable `SolanaRpcAdapter`. Default `Web3JsRpcAdapter` wraps `@solana/web3.js` + `@solana/spl-token`: derives keypair, resolves Associated Token Accounts, auto-creates destination ATA on first send (payer = self), builds/signs/submits SPL transfers, waits for confirmation. Errors mapped to `InsufficientUsdcBalanceError` and `InvalidSolanaAddressError`.

The agent pays its own SOL fees — sovereign means you pay your own gas. Tests run against the `SolanaRpcAdapter` boundary with no network. This is a **runtime-side** rail (the motebit holds the keys, the relay never signs); the compiler rejects registering it at `SettlementRailRegistry`. The previous custodial implementation (`DirectAssetRail` + `PrivyWalletProvider`) was deleted 2026-04-08 — relay does not sign agent transfers.

## BridgeSettlementRail (orchestration guest)

Wraps Bridge.xyz transfer API behind `GuestRail`. `railType: "orchestration"`, `name: "bridge"`, `supportsDeposit: false`.

Two withdrawal paths:

1. **crypto→crypto with wallet destination** — polls briefly for `payment_processed`, returns confirmed `WithdrawalResult` with `destination_tx_hash` as proof.
2. **crypto→fiat or slow paths** — returns pending `WithdrawalResult` with `confirmedAt: 0` and Bridge transfer ID as reference (same pattern as Stripe pending withdrawals). Completion via webhook.

`BridgeClient` interface is injected (glucose): `createTransfer()`, `getTransfer()`, `isReachable()`. Configurable poll attempts and interval. Lives in `services/relay/src/settlement-rails/bridge-rail.ts`. Registered at relay startup when `BRIDGE_API_KEY` + `BRIDGE_CUSTOMER_ID` env vars are set.

Bridge webhook handler at `POST /api/v1/bridge/webhook` auto-completes pending withdrawals when Bridge reports `payment_processed`: looks up by `payout_reference` (`bridge:{transferId}` via `linkWithdrawalTransfer`), signs receipt, calls `attachProof`.

Env vars: `BRIDGE_API_KEY`, `BRIDGE_CUSTOMER_ID`, optional `BRIDGE_SOURCE_RAIL` (default `base`), `BRIDGE_SOURCE_CURRENCY` (default `usdc`), `BRIDGE_API_BASE_URL`.

## X402SettlementRail (protocol guest)

Wraps x402 facilitator behind `GuestRail`. `custody: "relay"`, `railType: "protocol"`, `name: "x402"`, `supportsDeposit: false`.

x402 is pay-per-request: deposits happen at the HTTP boundary via x402 middleware, not the rail — the base `GuestRail` interface has no `deposit()` method, so no throwing stub needed. `withdraw()` settles via the facilitator client — constructs payment payload, calls `facilitator.settle()`, returns `WithdrawalResult` with tx hash proof. `isAvailable()` checks facilitator `/supported` endpoint. `attachProof()` records x402 tx hash + CAIP-2 network — called by the task submission handler after x402 auto-deposit succeeds, achieving sibling parity with the Stripe webhook → `stripeRail.attachProof()` flow.

Constructor takes `X402FacilitatorClient` (satisfied by `HTTPFacilitatorClient` from `@x402/core/server`). Lives in `services/relay/src/settlement-rails/x402-rail.ts`.

## Settlement proof persistence

`attachProof()` on all rails persists proofs to `relay_settlement_proofs` via an `onProofAttached` callback injected at construction. The relay owns storage; rails are adapters.

Table schema: `(settlement_id, reference, rail_type, rail_name, network, confirmed_at, created_at)`, composite PK `(settlement_id, reference)`. `storeSettlementProof()` is idempotent (`INSERT OR IGNORE`). `getSettlementProofs()` queries by settlement ID. Reconciliation check #6: every completed withdrawal with a `payout_reference` must have a matching proof in `relay_settlement_proofs`.

## Withdrawal through rails

Withdrawals flow through the rail boundary at two points:

1. **Admin-complete** — admin marks a withdrawal completed; accepts optional `rail` and `network` fields. If provided, calls `rail.attachProof()` with the payout reference. Manual/off-rail payouts omit; the signed relay receipt is the audit trail.
2. **Automated x402 withdrawal** — agent requests withdrawal to a wallet address (`/^0x[0-9a-fA-F]{40}$/`) and the x402 rail is available; the relay attempts immediate settlement via `x402Rail.withdraw()`. On success, auto-completes with signed receipt and proof attachment. On failure, falls back to manual pending (fail-safe — funds already held by `requestWithdrawal`).

This achieves full money-flow parity: deposits, proofs, and withdrawals all flow through the rail boundary.

## Credential anchoring

Credential hashes anchored onchain via Merkle batches so agent reputation survives relay death (spec: `credential-anchor-v1.md`). Full credential stays at the relay (aggregation, routing, privacy); only the SHA-256 hash goes onchain.

Three-layer split:

- **Apache-2.0 `@motebit/crypto`** — `computeCredentialLeaf` (leaf hash), `verifyCredentialAnchor` (4-step self-verification).
- **BSL relay** — batch cutting (`cutCredentialBatch`, 50 creds or 1 hour), proof serving (`getCredentialAnchorProof`), anchor loop (`startCredentialAnchorLoop`).
- **Chain submission** — via `ChainAnchorSubmitter` adapter in `@motebit/protocol`; reference implementation `SolanaMemoSubmitter` in `@motebit/wallet-solana` (Memo program v2, relay identity key = Solana signer).

Self-verification algorithm:

1. **Hash check** — `SHA-256(canonicalJson(vc)) === proof.credential_hash`
2. **Merkle inclusion** — siblings reconstruct to `merkle_root`
3. **Relay attestation** — `Ed25519.verify(batch_signature, canonicalJson({batch_id, merkle_root, leaf_count, first_issued_at, last_issued_at, relay_id}), relay_public_key)`
4. **Optional onchain lookup** — via `ChainAnchorVerifier` callback

Steps 1–3 are offline-verifiable. Additive, never gatekeeping: credentials are valid with or without an anchor. Relay endpoint: `GET /api/v1/credentials/:credentialId/anchor-proof`. Admin endpoint: `GET /api/v1/admin/credential-anchoring`. Relay wiring: `SOLANA_RPC_URL` enables chain submission; without it, batches are Ed25519-signed only.
