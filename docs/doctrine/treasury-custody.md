# Treasury custody — two phases, one decision deferred

A motebit relay that holds USDC settlement fees has two structurally different custody questions, with different blast radii. Conflating them produces either over-built phase-1 setups (hot custody for funds you only receive) or under-built phase-2 setups (manual sweeps that don't scale to real volume). Naming them separately lets phase 1 ship today and phase 2 wait for evidence.

## The two phases

### Phase 1 — receive path

The relay's x402 path receives USDC. Clients pay TO `X402_PAY_TO_ADDRESS`; the deposit detector observes via `eth_getLogs` and credits virtual accounts atomically. **No relay-side hot key is required for phase 1** — the private key for the receive address never touches the running service.

The minimum-viable phase 1 is a **hardware wallet** (Ledger / Trezor) generating the receive address. The address is public; the seed phrase and private key stay offline. The service holds only the public address as a Fly.io secret. A relay compromise loses inbound observability, not funds.

This is the same shape every reputable exchange uses for the cold side of their custody split — receive into a cold address, spend from a separate hot system. It's tried-and-true precisely because the receive path doesn't need anything more.

### Phase 2 — outbound automation

Phase 2 is required when the relay needs to **send** USDC autonomously: programmatic withdrawals, automated sweeps, automated escrow release for dispute resolution, multi-leg settlement. This is the real custody decision, with the highest blast radius of any infrastructure choice motebit will make.

There are three honest shapes, each with concrete operational tradeoffs:

| Shape                                                                                              | Sovereignty                                                                    | Operational cost                                                  | Compliance posture                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **MPC-as-a-service** (Privy KMS, Fireblocks)                                                       | Weakest — vendor holds key share, KYC at vendor                                | Lowest — vendor SDK, vendor SLA                                   | Vendor's compliance regime; faster acceptance from regulated counterparties |
| **Multi-sig** (Safe / Gnosis Safe with N-of-M signers)                                             | Medium — keys distributed across ops team / cold devices                       | Medium — Safe UI for proposed transactions, signers verify in-app | Self-custodial; transparent onchain                                         |
| **Program-mediated authority** (Solana program PDA + relay as authority signer; or EVM equivalent) | Strongest — relay holds an authority key whose scope is bounded by the program | Highest — program audit, key rotation, monitoring                 | Self-custodial; program logic is the constraint                             |

The codebase's `GuestRail` / `SovereignRail` type-level split (per [`settlement-rails.md`](settlement-rails.md)) doesn't pre-bind phase 2 to any of these — the rail registry is agnostic to how custody is implemented. The decision is operational, not architectural.

## When phase 2 opens

Phase 2 stays deferred — explicitly, not by accident — until one of these triggers fires:

- **Volume.** Monthly receipt volume exceeds the manual-sweep cadence the operator can sustain. A receive-only treasury that needs a manual hardware-wallet signature once a quarter is fine; once a week is operational drag; once a day is broken.
- **External operator.** A real third-party operator runs a relay (per [`protocol-model.md`](protocol-model.md)) and needs an outbound path of their own. Their phase 2 choice may differ from motebit's own.
- **Protocol shape.** A protocol shape (e.g., automated escrow release for a dispute resolution per `spec/dispute-v1.md`) requires the relay to sign a USDC transaction without operator-in-the-loop.

Phase 2 is not "the next milestone after phase 1." It's "the milestone after volume, partner, or protocol forces it."

## What phase 1 ships

Concrete shape, in order:

1. **Confirmation horizon** in the deposit detector. Per [`packages/deposit-detector/CLAUDE.md`](../../packages/deposit-detector/CLAUDE.md) rule 6: `confirmations` is required, mainnet chains use 12 (Base / Optimism / Arbitrum / Ethereum) or 64 (Polygon), testnets use 1. The cycle never crosses the safe horizon. Drift gate `check-deposit-detector-confirmations` (`docs/drift-defenses.md` #72) enforces every USDC chain has a positive depth.
2. **Hardware-wallet-generated receive address** as `X402_PAY_TO_ADDRESS`.
3. **CDP facilitator credentials.** The default `https://x402.org/facilitator` is Coinbase's free _testnet_ facilitator — Base Sepolia only, rejects mainnet networks at route-registration time with `Facilitator does not support scheme "exact" on network "..."`. Mainnet x402 settlement requires Coinbase's CDP facilitator at `https://api.cdp.coinbase.com/platform/v2/x402`, authenticated with JWT-per-request via API key + secret. Operator generates the credentials at `portal.cdp.coinbase.com → Payments → x402 → API Keys`, sets `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` as Fly secrets. The relay's `services/relay/src/x402-facilitator.ts` is the single canonical constructor — branches on env shape, fails fast with `X402ConfigError` if mainnet mode is requested without CDP credentials. Free tier: 1,000 transactions/month.
4. **Mainnet env flip:** `X402_NETWORK=eip155:8453`, `X402_TESTNET=false`. Reversible — flip `X402_TESTNET=true` to fall back to Sepolia anytime, no code changes; the CDP credentials and mainnet address stay set, the relay just routes through testnet semantics.
5. **Smoke transaction** ($1 USDC) from a test EOA to the new address; verify the funds arrive onchain (Basescan or equivalent) and no `x402.facilitator.init_failed` in the boot log. Note: a direct USDC transfer to the treasury does NOT fire the deposit-detector's `deposit.detected` log — the deposit-detector watches per-agent USDC wallets (registered in `relay_agent_wallets`), not the operator's fee-collection address. Treasury accumulation flows through the x402 facilitator settlement path, which is a structurally different code path (see [`packages/treasury-reconciliation/CLAUDE.md`](../../packages/treasury-reconciliation/CLAUDE.md) Rule 1 for the architectural distinction).

6. **Reconciliation loop.** Background task (default cadence: 15 min, configurable via `MOTEBIT_TREASURY_RECONCILIATION_INTERVAL_MS`) compares `SUM(relay_settlements.platform_fee)` for relay-mediated settlements against `eth_call balanceOf(treasury)` on the chain's USDC contract. Persists each result to `relay_treasury_reconciliations` (append-only audit log); alerts on negative drift via `treasury.reconciliation.drift` structured log. Surface via `GET /api/v1/admin/treasury-reconciliation` (master-token gated). Only runs when `X402_TESTNET=false` AND `X402_PAY_TO_ADDRESS` is set AND the chain has a registered USDC contract + RPC URL — testnet skips silently.

   **Conservative phase-1 invariant:** `consistent = onchainBalance >= recordedFeeSum`. Positive drift is fine — it covers direct deposits (e.g., the smoke transaction in step 5), external operator funding, and partial worker payouts not yet swept. Negative drift is the load-bearing alert: it means more fees were recorded than arrived onchain, the silent-leakage failure mode the primitive exists to catch.

   **Known limitation: manual sweeps produce false-positive negative drift.** When the operator manually sweeps the treasury (cold signing via the hardware wallet), `onchainBalance` drops below `recordedFeeSum` until either (a) new x402 fees accumulate above the post-sweep balance, or (b) the operator funds the treasury back. The reconciliation loop will fire `treasury.reconciliation.drift` warnings until that happens. Phase 2's per-movement `relay_treasury_movements` ledger fixes this by tracking inflows + outflows explicitly; phase 1 accepts the false-positive in exchange for one-sided simplicity. **Operationally: when sweeping the treasury manually, expect drift alerts until the next cycle catches up; verify the math against the swept amount + fee sum before treating any alert as a real leak.**

7. **Operator-runnable validation surface.** Two probes complement the runtime telemetry above, both backed by the same `/api/v1/admin/treasury-reconciliation` endpoint:
   - **Read-only probe in `motebit doctor`** (free, runs on every doctor invocation; degrades to "skipped — operator-only check" without `MOTEBIT_API_TOKEN`). Reports `healthy` / `stale` / `loop disabled` / `negative drift` per the same logic as the runtime alert, with a stale threshold of 30 min (2× the default cadence). Catches "loop quietly stopped firing" — the silent failure mode the loop itself can't surface, since a dead loop emits no logs.
   - **End-to-end probe `motebit smoke reconciliation`** (master-token required, exits non-zero on stale or negative-drift verdicts). Designed for CI / cron / post-deploy verification: deterministic exit codes, canonical `verdict=...` output for grep, no side effects. Five terminal verdicts: `healthy`, `stale`, `drift`, `no_cycles_yet` (recent boot), `loop_disabled` (testnet relay or mainnet without `X402_PAY_TO_ADDRESS`).

   The smoke is the read-side validation. A future companion (`motebit smoke x402`) will exercise the write side — a paid task settlement on Base mainnet that gives the reconciliation primitive its first non-zero `recorded_fee_sum_micro` to observe. Until that ships, mainnet operators verify the loop's plumbing by running the read-side smoke after deploy and confirming `verdict=no_cycles_yet → verdict=healthy` after the first cycle interval elapses.

Operator-specific details (which hardware wallet, which Fly.io secrets, which exact address) live in the operator's private `docs/ops/SECRETS.md` (gitignored per the operator-transparency split). The doctrine here is shape-only.

A note on what's NOT phase 1: the CDP facilitator is itself a relay-shaped guest service (Coinbase's, not motebit's). Using it does not weaken the protocol-vs-platform claim — the x402 _protocol_ is open and chain-agnostic; CDP is one of multiple compatible facilitator implementations (community + self-hosted alternatives exist). Phase 2 doesn't change the facilitator decision; phase 2 is the _outbound_ custody question (sweeping the treasury), independent of which facilitator handles inbound x402 settlements.

## Why naming the phases separately matters

Without the split, every conversation about "mainnet custody" defaults to the highest-risk axis (phase 2's hot-custody decision) and stalls there. Founders defer mainnet activation indefinitely because they're trying to solve phase 2 before they have phase 2's evidence.

With the split, phase 1 ships when the operator acquires a hardware wallet — independent of, and prior to, the phase 2 decision. Phase 1's signal (real volume, real partners, real protocol shapes) feeds the phase 2 decision when it actually opens. The hard decision waits for the data that informs it.

This is the same pattern as [`agility-as-role.md`](agility-as-role.md) — name the role, defer the instance until evidence forces it. Phase 1 is the role's minimum viable shape; phase 2 is the instance the role's evidence will pick.

## Related doctrine

- [`settlement-rails.md`](settlement-rails.md) — the `GuestRail` / `SovereignRail` custody split at the type level. Phase 2's choice slots into this registry without changing the abstraction.
- [`operator-transparency.md`](operator-transparency.md) — what the relay declares in `/.well-known/motebit-transparency.json`. Custody posture is one of those declarations; the phase determines what's true to declare.
- [`agility-as-role.md`](agility-as-role.md) — the broader role/instance pattern this doctrine instantiates.
