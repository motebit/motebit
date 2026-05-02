# @motebit/treasury-reconciliation

Operator-treasury observability for relay-mediated x402 settlement fees. Compares the relay's recorded-fee accumulation (sum of `relay_settlements.platform_fee` for relay-mediated settlements) against the operator's onchain treasury balance (queried via `eth_call balanceOf(treasury)` on the chain's USDC contract). Persists each reconciliation as an append-only audit record; alerts on negative drift.

Layer 1. BSL-1.1. Type-only dep on `@motebit/evm-rpc` (the `EvmRpcAdapter` interface). Sibling of `@motebit/deposit-detector` — both are "internal-ledger ↔ onchain" reconciliation primitives with the same DB-inverted shape, but they watch structurally different things. See Rule 1 below for why they must not be unified.

## Rules

1. **Never unify with the deposit-detector.** The deposit-detector watches per-agent USDC wallets registered in `relay_agent_wallets` and credits agent virtual accounts. This package watches the operator's x402 fee-collection address (`X402_PAY_TO_ADDRESS`) and audits its onchain accumulation. The two are parallel-but-distinct:
   - Treating the treasury as a "system agent" in `relay_agent_wallets` opens a privilege-escalation surface (any in-database agent_id is potentially exposed to client API paths) and a circular-fee surface (treasury could appear as a settlement counterparty). Both risks are structurally avoided by keeping the treasury OUT of agent-shaped data.
   - The treasury is known to the relay only via the `X402_PAY_TO_ADDRESS` env var + onchain queries. It has no `relay_agents` row, no virtual account, no in-database identity. The reconciliation primitive consumes the treasury's onchain state directly — it never flows through the agent-wallet pipeline.

2. **Conservative one-way invariant for phase 1.** `consistent = (onchainBalance >= recordedFeeSum)`. Positive drift is ALWAYS fine — direct deposits, external operator funding, partial worker payouts not yet swept all produce positive drift. Negative drift is the alert: it means more fees were recorded than arrived onchain (silent leakage). Phase 2 (per-movement ledger via `relay_treasury_movements`) tightens this to a two-sided exact match; deferred until needed.

3. **Errors don't persist.** The store's `persistReconciliation` is called only on successful cycles (recorded-fee-sum query + RPC balance both completed). Error cycles are returned to the caller (with `error` populated) but skip persistence — the audit log is for completed comparisons only. Callers may log errors separately.

4. **Confirmation-lag buffer is required.** Settlements newer than `runAtMs - confirmationLagBufferMs` are excluded from the recorded-fee-sum query because the corresponding x402 facilitator settlements may not have reached the chain's safe horizon yet. Default 5 minutes is generous for L2s with 12-block confirmation depth (~24-30s on Base). Without the buffer, recent settlements would produce false-positive negative drift.

5. **The package writes nothing to onchain state.** Read-only audit. Phase 2 may add anchored reconciliation batches (Solana memo, mirroring credential anchoring), but the algebra in this package stays read-side. Anchoring would be a sibling primitive consuming this package's `ReconciliationResult` records.

## What NOT to add

- **A virtual account for the treasury.** That's the rejected "system-shadow-agent" shape (Rule 1).
- **Settlement-write hooks.** This package observes the relay's settlement records via the store; it does not modify them. Fee recording happens at the settlement-write site (`services/relay/src/tasks.ts`); the reconciler is purely a downstream auditor.
- **Multi-chain logic.** One reconciler instance per `(chain, treasuryAddress, usdcContractAddress)` triple. Multi-chain operators wire multiple instances at the consumer layer.
- **Onchain anchoring of results.** Phase 2; not phase 1.
- **Per-movement ledger.** Phase 2; not phase 1.

## Consumers

- `services/relay` — the relay. Provides `SqliteTreasuryReconciliationStore` (queries `relay_settlements`, persists into `relay_treasury_reconciliations`), wires the loop conditional on mainnet mode (`X402_TESTNET=false`), exposes `GET /api/v1/admin/treasury-reconciliation`.
