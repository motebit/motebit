# Off-ramp as user action

User funds exit Motebit by landing in the user's own wallet. Fiat off-ramp is then the user's action via a licensed provider. Motebit coordinates and records settlement; it does not transmit user funds to banks.

The relay's transmitter surface for user funds is **zero on the out-flow direction** after the off-ramp arc (Arc 1). The in-flow direction — delegator-paid worker earnings flowing through operator-custody virtual accounts under `settlement_mode='relay'` — remains scoped to follow-on arcs (Arc 2: P2P fee leg; Arc 3: trust-graduation re-architecture). This doctrine memo is honest about what each commit structurally enforces and what stays open until the next arcs land.

## The three-layer wording

Different readers need different precision. The doctrine ships in three calibrations; all three are true at the same time; the difference is what they emphasize.

### Public-facing positioning (homepage, README, pitch)

> _Motebit coordinates and records settlement; it does not transmit user funds to banks._

True for the out-flow direction. Survives a casual read. Doesn't pretend to claim more than what's structurally enforced.

### Doctrine-memo precision (this file, for engineers + counsel + future contributors)

> _Motebit's transmitter surface for user funds is zero on the out-flow direction (the relay returns self-deposited custody to user-held sovereign wallets via Path 0, or transfers via x402 to user-held EVM wallets via Path 1; Bridge is never used to transmit user funds to third-party banks). The in-flow direction (delegator-paid worker earnings) currently uses `settlement_mode='relay'` operator-held virtual accounts; the agent-of-payee analysis under FIN-2015-G001 remains live for that flow until Arc 2 (P2P fee leg) and Arc 3 (trust-graduation re-architecture) shift worker earnings to direct sovereign-rail P2P settlement._

Three sentences. The first names today's structural truth. The second names today's structural openness. The third names the path to closure. Counsel reading this gets the honest legal landscape; no aspirational claim hides an open question.

### CLAUDE.md operational invariant (one sentence in the Economic Loop principle)

> _Money out lands in the user's wallet via Path 0 (sovereign Solana return-of-custody) or Path 1 (x402 EVM to user-held wallet); off-ramp is the user's action via a licensed provider (Path 3: user-initiated Bridge with user as KYC'd customer, or any other off-ramp the user chooses); the relay's user-funds transmitter surface on the out-flow direction is structurally zero._

The architectural commitment as it lives in the principle index. Engineers writing code in the withdrawal path read this and know the constraint.

## What Arc 1 closed structurally

Two commits, three layers of enforcement:

**Arc 1 Commit 1 — Path 0 (`6e1e2c2f`).** Native Solana sovereign-return withdrawal. When a user requests withdrawal to their own sovereign Solana wallet (base58-shaped destination), the relay's operator-side `OperatorSolanaTransfer` (custody-neutral primitive in `@motebit/wallet-solana`, treasury wallet derived from the relay's identity key by Ed25519 curve coincidence) sends USDC directly from relay treasury to user wallet. No third-party orchestrator, no `on_behalf_of` header. From the user's perspective: same-party return of self-deposited custody. From the relay's perspective: native principal of its own onchain transfer — doctrinally indistinguishable from the relay paying a vendor invoice from its treasury wallet.

**Arc 1 Commit 2 — Bridge user-withdrawal surface deletion (`e18f1ba3`).** `BridgeSettlementRail.withdraw()` removed at the package level; `withdraw()` + `withdrawBatch?()` removed from `GuestRail` base; new `WithdrawableGuestRail extends GuestRail` marker with `isWithdrawableRail` type guard. Bridge declares `supportsWithdraw: false as const`. The user-withdrawal endpoint at `services/relay/src/budget.ts` narrows through `isWithdrawableRail()` before calling `.withdraw(...)`; bare `GuestRail` cannot dispatch. The Path 2 dispatch block and the `/api/v1/bridge/webhook` handler are deleted entirely. The structural impossibility: anywhere in the workspace, `bridgeRail.withdraw(...)` is a compile error because the method does not exist on the type. No env-var flip can re-introduce user-facing Bridge withdrawal.

## The three withdrawal paths in code today

| Path                                            | Trigger                                                                          | Custody model                                                                                                                                                                                                          | Doctrinal status                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Path 0** (Arc 1 Commit 1)                     | Destination is base58 (Solana sovereign wallet)                                  | Relay treasury → user wallet, native principal. Same-party return when source is self-deposit cache.                                                                                                                   | Structurally clean. The doctrinally-preferred default.                                                  |
| **Path 1** (pre-existing, narrowed in Commit 2) | Destination is EVM 0x-shaped (user's own EVM wallet)                             | x402 transfer from relay's operator wallet on Base → user's EVM wallet.                                                                                                                                                | Structurally clean. Same shape as Path 0 on a different chain.                                          |
| **Path 3** (`offramp.ts`, pre-existing)         | User clicks "Withdraw to bank" → surface POSTs to `POST /api/v1/offramp/session` | User signs from own Solana wallet to Bridge deposit address; Bridge converts and ACHes to user's bank account. **`on_behalf_of` is the USER's `bridgeCustomerId`** (the user is Bridge's KYC'd customer, not Motebit). | Structurally clean. The relay is a session broker — passes deposit instructions, never custodies funds. |

Notably absent: the deleted Path 2 (relay-initiated Bridge transfer with Motebit as the customer of record). That path turned Motebit into a money transmitter by FinCEN's `31 CFR 1010.100(ff)(5)` definition — accepting USDC from one party (the relay's own balance held on behalf of a user) and transmitting to a third party (the user's external address) with Motebit-as-orchestrator. Surface deletion closed it.

## What Arc 1 did NOT close — the honest open scope

**The in-flow direction for worker earnings.** When a delegator pays the relay's x402 facilitator for an agent's work, the worker-agent's earnings accumulate in their virtual account under `settlement_mode='relay'`. The relay holds those funds in operator custody until the worker requests withdrawal. **That flow is still active** — Arc 1 did not change the worker-earnings settlement path.

Under FinCEN's definition, accepting funds from one party (the delegator) and holding them on behalf of another (the worker) is still potentially money transmission, regardless of how the relay later returns those funds to the worker's sovereign wallet (Path 0 makes the return clean, but the in-flow custody question persists). The cleanest reading is that Motebit acts as **agent of payee** under FIN-2015-G001 for this flow — a narrow exemption that requires specific structural elements (documented agency relationship, exclusive payee designation, etc.) and that state money-transmitter laws often don't follow. The exemption is plausible but unverified.

**Arc 2 (the P2P fee leg arc) and Arc 3 (the trust-graduation re-architecture) are what close this question structurally.** When delegator-paid worker earnings flow direct delegator→worker via sovereign P2P (worker's wallet is the destination, relay records audit only with `settlement_mode='p2p'`) and the 5% fee is its own settlement leg from the delegator to the relay's treasury (composed in a single multi-output Solana transaction), the relay's in-flow custody surface for worker earnings collapses to zero. At that point the doctrine sentence "Motebit's transmitter surface for user funds is zero" becomes structurally true on **both** the in-flow and out-flow directions — and the agent-of-payee analysis dissolves rather than getting answered (the category no longer applies because Motebit never custodies the worker's earnings).

Until Arcs 2+3, the open question is honest. The Bridge-product-compliance-counsel memo (`bridge_product_compliance_counsel_pending`) remains live for the in-flow scope. Counsel review is still recommended for the worker-earnings path; the Bridge compliance email itself is unaffected because Bridge is now structurally treasury-only on the relay's side.

## Why surface deletion is the right enforcement shape

The off-ramp arc's load-bearing discipline: **enforcement must match the doctrine's strength.** A doctrine that says "Motebit is not a transmitter of user funds" is too strong for a procedural off-switch (`BRIDGE_CUSTOMER_ID` absent). It needs a structural off-switch (`BridgeSettlementRail.withdraw` does not exist).

Three shapes were considered and rejected during the five-iteration doctrine development that produced this arc:

- **Doctrine-only deletion** — procedural; next contributor reads the doctrine but the code still allows the call.
- **Drift gate without surface deletion** — catches at CI but not at IDE; mid-edit you still write the offending code; gate has to know what to look for, which is brittle.
- **Type-level fence at the single dispatch site** — better, but still leaves the offending method present on the rail; future refactors can re-route through it.

The chosen shape — **surface deletion + marker interface** — makes the impossibility complete. The method does not exist anywhere in the codebase. Code that doesn't exist yet, code in other consumers, code that gets added next year — none of it can call `bridgeRail.withdraw(...)` because the method is not on the type. The absence IS the negative-proof. Same shape as `runtime-invariants-over-prompt-rules` applied to a type-level surface instead of a runtime invariant.

## The settlement-asset registry (sub-phase, deferred)

The off-ramp arc's converged doctrine includes one more structural commitment: **settlement is asset-pluggable**. USDC is the bootstrap stablecoin. A `SettlementAsset` closed union (`"USDC"` only at land) with a bespoke coverage test should ship as sub-phase A of this arc — a typed vocabulary consumers can reference, promoted to the 8th registered registry per [`registry-pattern-canonical`](./registry-pattern-canonical.md) when a second asset (PYUSD, USDP, etc.) arrives as a real consumer (sub-phase B).

The registry membership IS the protocol-vs-product wall: if `"MOTE"` is ever added to `ALL_SETTLEMENT_ASSETS`, it's protocol; if it isn't, it's a motebit-cloud product overlay that converts to/from a protocol-level asset at its boundaries. A future MOTE stablecoin (Bridge-issued via Open Issuance, deferred per memory `feedback_no_mote_stablecoin`) is **not** an architectural endpoint — it's a candidate motebit-cloud convenience product, evaluated against asset-pluggability when its compliance, market, and economic case can stand on its own.

Sub-phase A is bounded scope (eight-artifact registry-pattern set + closed union + bespoke coverage test); land as sibling commit or immediate follow-on per the arc plan.

## The remaining open obligations after Arc 1 closes

1. **Arc 2 — P2P fee leg.** Compose worker-payment + treasury-fee in a single signed multi-output Solana transaction at the delegator side. `relay_settlements` rows under `settlement_mode='p2p'` write `platform_fee` accurately (currently zero per `services/relay/CLAUDE.md` rule 8 — that rule amends in Arc 2). The sibling-doc contradiction the settlement-mode arc surfaced ("5% on both lanes" vs "Fee: zero on P2P") resolves toward Option 2 (delegator-pays-relay-direct).
2. **Arc 3 — Trust-graduation re-architecture.** `evaluateSettlementEligibility` gates _delegation acceptance_, not _custody routing_. P2P becomes the only worker-earnings path. New workers declare `settlement_address` from day one (one-checkbox onboarding using identity-key-derived Solana address).
3. **`SettlementAsset` sub-phase A** (closed union with bespoke coverage; promotes to 8th registered registry on second-asset consumer).
4. **Counsel meeting** — agenda shifts from "validate agent-of-payee structure" (was needed pre-Arcs 2+3) to "validate that the structural-zero-transmitter-surface architecture is read the same way by external compliance reviewers" once Arcs 2+3 land. Cheaper meeting, stronger position walking in.

## Cross-references

- [`settlement-rails.md`](./settlement-rails.md) — custody split (`GuestRail` vs `SovereignRail`), the "Lanes for external readers" section
- [`protocol-primacy.md`](./protocol-primacy.md) — the constitutional invariant this arc applies to the out-flow direction
- [`treasury-custody.md`](./treasury-custody.md) — Bridge stays for treasury per this doctrine; Path 3 (`offramp.ts`) uses Bridge with USER as customer
- [`registry-pattern-canonical.md`](./registry-pattern-canonical.md) — the eight-artifact set sub-phase A would adopt
- [`runtime-invariants-over-prompt-rules.md`](./runtime-invariants-over-prompt-rules.md) — same discipline applied to type-level enforcement
- Memory: `bridge_compliance_response_sent`, `bridge_product_compliance_counsel_pending`, `feedback_no_mote_stablecoin`, `feedback_intelligence_commodity`
