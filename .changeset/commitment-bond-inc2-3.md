---
"@motebit/wallet-solana": minor
"@motebit/relay": patch
---

Commitment bond — phase 1, Inc 2 (RPC backing verifier) + Inc 3 (additive eligibility). The bond becomes a working anti-sybil **signal**: an agent's own sovereign capital, RPC-verified, never custodied. Structurally inert in prod until a bond reaches the table (the bond-ingestion surface is deferred-with-trigger), so this changes no current behavior — the eligibility branch is byte-identical for every flow that doesn't opt in.

`@motebit/wallet-solana`:

- **`getUsdcBalanceOf(ownerAddress)` on `SolanaRpcAdapter`** — the single authorized read of a counterparty's USDC balance at an ARBITRARY base58 owner (distinct from own-ATA `getUsdcBalance`). The honest floor of the verifier: it reads, never moves — no custody implication. Returns 0 for an uncreated token account; throws `InvalidSolanaAddressError` on a malformed address. `Web3JsRpcAdapter` implements it; the in-memory test adapters across the repo gain the method.

`services/relay` (Inc 2 — verifier infra):

- `bond-store.ts` — verify-then-persist (`recordBondCommitment`: `verifyBondCommitment` + the relay's separate key→`motebit_id` binding, the `verifySovereignBinding` shape) + readers. Stores the EXACT canonical bytes (`commitment_json`) so anyone re-runs `verifyBondCommitment` over the verbatim artifact.
- `bond-verifier.ts` — `startBondVerifierLoop`, a supervised (`superviseInterval`) mirror of `startP2pVerifierLoop`: reads each live bond's bonded-address balance, caches `backed`/`underbacked` + `last_checked_at`. **An RPC error never downgrades a prior reading** — the row ages into "stale" and forces a synchronous re-check at decision time. Migration 38 `relay_bond_commitments`; wired in `index.ts` under the `SOLANA_RPC_URL` gate.

`services/relay` (Inc 3 — additive eligibility):

- `evaluateSettlementEligibility` gains an opt-in `BondEligibilityContext`. A worker with a verified, currently-backed bond qualifies at the cold-start bar — placed AFTER the strict + sovereign branches, tiered WITH sovereign-binding (never below), opt-in only (omitted → byte-identical), never fabricating trust, NEVER recourse. Two orthogonal anti-reuse defenses: the §2 identity-address binding defeats cross-**identity** reuse; subtracting the worker's in-flight (pending) p2p value defeats cross-**ticket** reuse (a conservative live read over the existing settlement state machine — no separate reservation ledger to leak; the precise per-bond ledger is deferred with the recourse half). **Staleness is an adversarial window:** backing is re-verified at acceptance time (fresh cache, else a synchronous `getUsdcBalanceOf`), never accepting a stale "backed".
- `check-bond-surface-honesty` (drift invariant #133) — the cardinal surface rule (sibling of `check-public-fee-claims`): no surface may frame a bond as secured funds / guaranteed recourse. Necessary-not-sufficient, so the doctrine human design-review checkpoint is anchored alongside. Vacuous today by design — the guardrail precedes the first bond surface.

Doctrine: `docs/doctrine/commitment-bond.md`; `services/relay/CLAUDE.md` rule 19; `spec/bond-v1.md` §6 (freshness) + §7 (surface honesty). The recourse half (`BondCall`/`BondDefault`) and the bond-ingestion/submission surface remain deferred-with-trigger.
