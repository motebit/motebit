# Next Session: Rail-Agnostic Settlement Completeness

## Context

Last session shipped 14 commits (6,294 lines): onchain revocation, discovery, migration, dispute, p2p settlement with policy-based eligibility, withdrawal hold, async payment verifier, trust downgrade, CLI commands, E2E tests, and a full sibling boundary audit. 792 tests pass, all coverage thresholds met.

The p2p settlement path exists but three gaps prevent the relay from being truly optional in practice:

## What to Build

### 1. Settlement capabilities in discovery responses

`settlement_address` and `settlement_modes` exist on `agent_registry` (migration v8) but `GET /api/v1/discover/:motebitId` doesn't return them. When Agent A discovers Agent B, the response should include what settlement rails B accepts — not just capabilities and public key.

**Files:** `services/api/src/discovery.ts` (resolveAgent function, the SELECT query and AgentResolutionResult construction). `packages/protocol/src/discovery.ts` (AgentResolutionResult type — add optional `settlement_address` and `settlement_modes` fields).

**Why:** Without this, a delegator can't know whether to attempt p2p before submitting. Discovery is the protocol's capability advertisement layer — settlement acceptance belongs there.

### 2. Auto-sweep: relay balance → sovereign wallet

When a motebit's relay virtual account balance exceeds a configurable threshold, automatically transfer the excess to the motebit's declared `settlement_address` (Solana wallet) via `SolanaWalletRail.send()`.

**Design:**

- New config: `sweep_threshold` and `sweep_target` on agent_registry or relay_config
- Background loop (pattern: `startCredentialAnchorLoop`) polls accounts above threshold
- Calls the existing `requestWithdrawal` + rail settlement path
- Respects the dispute window hold (only sweeps `available_for_withdrawal`)
- Logs sweep events for audit

**Files:** New `services/api/src/sweep.ts`. Wire in `services/api/src/index.ts` alongside other background loops. Extend `services/api/src/agents.ts` registration to accept `sweep_threshold`.

**Why:** This proves the relay is a utility, not a jail. If the agent's money automatically flows to its own wallet, the relay can't hold it hostage. The sweep is the operational proof of sovereignty.

### 3. Proof of solvency

Before starting an expensive p2p task, the worker needs to know the delegator can pay. A signed attestation proving the delegator has sufficient balance (either in relay virtual account or onchain wallet).

**Design:**

- New endpoint: `GET /api/v1/agents/:motebitId/solvency-proof?amount=<micro>`
- Relay signs: `{ motebit_id, balance_available, amount_requested, attested_at, relay_id }`
- Worker verifies signature against relay's public key (from /.well-known/motebit.json)
- For p2p: delegator could also provide an onchain balance proof (SPL token account query)
- Proof has short TTL (5 minutes) to prevent stale attestations

**Files:** New endpoint in `services/api/src/accounts.ts` or `services/api/src/budget.ts`. Protocol type `SolvencyProof` in `packages/protocol/src/settlement-mode.ts`.

**Why:** p2p settlement means the relay doesn't escrow. The worker has no guarantee of payment before starting work. Solvency proof is the trust primitive that makes high-value p2p tasks viable.

## Patterns to Follow

- Background loops: `startCredentialAnchorLoop` pattern (setInterval, emergency freeze check, try-catch, structured logging)
- Protocol types: MIT in `@motebit/protocol`, type-only files excluded from coverage
- Relay endpoints: register via module function, wire in index.ts
- Auth: admin endpoints behind bearer auth, agent endpoints use device token or master token
- Rate limiting: add to middleware.ts (read/write/expensive tiers)
- Tests: E2E tests prove the full path, unit tests prove the policy logic
- Sibling audit: after all three features, audit auth/rate-limit/serialization siblings

## Verification

After all three:

1. `pnpm run typecheck` — 90/90
2. `pnpm --filter @motebit/api test -- --run --coverage` — all pass, thresholds met
3. Discovery response includes settlement capabilities
4. Sweep loop moves excess balance to sovereign wallet
5. Solvency proof is verifiable with relay's public key

## Non-goals

- Onchain escrow program (Solana Anchor) — future session
- Multi-chain settlement — Solana only for now
- Automated trust-based rail selection at routing time — the evaluator exists, the automatic trigger doesn't (delegator must explicitly submit with payment_proof)

Check memory: `architecture_rail_agnostic_actor.md` has the canonical economic model. `feedback_settlement_architecture.md` has the engineering constraints (policy-based eligibility, verification state, explicit address model).
