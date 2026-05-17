---
"@motebit/wallet-solana": minor
---

Add `OperatorSolanaTransfer` — the operator-side companion to `SolanaWalletRail`. Arc 1 Commit 1 of the off-ramp arc (per the converged five-iteration doctrine: Position B + B-now + Option 2 fee leg + MOTE-as-product + asset-pluggability registry; see future `docs/doctrine/off-ramp-as-user-action.md`).

**What it is.** A thin, custody-neutral USDC sending primitive: the relay's Ed25519 identity key (same key that already funds `SolanaMemoSubmitter` for anchoring) IS a valid Solana keypair by curve coincidence; the relay treasury wallet derives from it. The new class wraps the same `Web3JsRpcAdapter` that backs the sovereign rail — the adapter is custody-neutral by design, so the distinction between agent-custody (`SolanaWalletRail`) and operator-custody (`OperatorSolanaTransfer`) lives at the construction-site type, not at the RPC primitive.

**Why a new class and not just `SolanaWalletRail`.** `SolanaWalletRail` carries `custody: "agent"` and is the agent's sovereign rail (the agent's identity key signs the agent's own transfers). `OperatorSolanaTransfer` is the relay-treasury primitive — the relay signs its own wallet's transfers from its own custody. The deleted `DirectAssetRail` (2026-04-08) was the wrong shape because the relay was signing **on behalf of an agent**; the operator primitive here signs **for the relay itself** — relay's funds, relay's signature, native principal. Doctrinally indistinguishable from the relay paying a vendor invoice from its treasury wallet.

The rail-vs-primitive distinction matters because `SettlementRailRegistry.register()` rejects `SovereignRail` at compile time (sovereign rails are agent-custody, never relay-mediated). The new class is **not** a `SovereignRail` or a `GuestRail`; it carries no `custody` label and never goes through the registry. The negative-proof is pinned in `packages/wallet-solana/src/__tests__/operator-transfer.test.ts` — "carries no custody label — it is not a rail, it is the relay's own primitive."

**Surface:**

- `OperatorSolanaTransfer` class with `address`, `getUsdcBalance()`, `getSolBalance()`, `sendUsdc(toAddress, microAmount)`, `isAvailable()`
- `OperatorSolanaTransferConfig` interface (rpcUrl, identitySeed, optional usdcMint + commitment)
- `createOperatorSolanaTransfer(config)` factory backed by the default `Web3JsRpcAdapter`

**Consumer** (not in changeset scope — `services/relay` is ignored): Path 0 dispatch in `services/relay/src/budget.ts` fires when a user requests withdrawal to a base58-shaped (Solana sovereign) destination AND the operator transfer is configured (via `SOLANA_RPC_URL` env at boot or `operatorSolanaTransfer` config injection for tests). The relay sends USDC directly from its treasury wallet to the user's wallet, signs a `WithdrawalReceipt` with the Solana tx signature as `payout_reference`, and completes the withdrawal. No Bridge, no third-party orchestrator, no `on_behalf_of` header — same-party return of self-deposited custody from the user's perspective; native principal from the relay's perspective.

**Doctrine update**: `packages/wallet-solana/CLAUDE.md` Rule 1 + 2 amended to clarify the operator-vs-agent distinction (`SolanaWalletRail` carries `custody: "agent"`; `OperatorSolanaTransfer` is the relay-treasury primitive that uses the same RPC adapter without the rail-shell — the doctrine boundary is at the construction-site type). The relay still does not sign agent transfers; the operator primitive only signs the relay's own.

**Tests**: 11 new unit tests for `OperatorSolanaTransfer` (construction, address derivation, adapter delegation, error propagation, doctrine-boundary negative-proof) and 6 new integration tests for Path 0 dispatch (fires on base58, records signed receipt, does not fire on EVM destination / absent operator / unreachable RPC / send failure).
