# Commitment bond — an anti-sybil staked signal (NOT collateral, NOT recourse)

The relay's revenue rests on a coordination moat — trusted, dispute-grade history — but its
recourse today is dispute-resolution-only with no capital behind it: `executeFundAction`
(`services/relay/src/disputes.ts`) **no-ops on a P2P / zero-locked dispute**, exactly where money
moved sovereignly and the relay has nothing to redistribute. The honest cure for that hole is
verifiable-reputation recourse, not seizure — motebit is SPL-transfers-only (no escrow program) and
the doctrine forbids the relay holding agent funds (the deleted `DirectAssetRail` "relay signs on
behalf of an agent" must not return, see [`settlement-rails.md`](settlement-rails.md)). A hard,
seizure-based guarantee is therefore impossible without custody; enforcement-by-verifiable-reputation
is the doctrine-pure answer, the same game theory as the whole relay (you route through us because it
lowers risk; your reputation is your asset).

That recourse only **bites with volume + real disputes**, so the arc stages. **Phase 1 (this doctrine)
ships the volume _enabler_ only: the commitment bond as an anti-sybil signal.** The recourse half is a
deliberate, triggered follow-on (§ Status), not a gap.

## What it is — and is NOT

A commitment bond is a **drainable onchain balance + (eventually) a reputation threat**. Phase 1 ships
only the balance + its anti-sybil signal — **no teeth yet** (the call/default that makes a default
_cost_ something is deferred). So in phase 1 the bond is **not** collateral, **not** escrow, **not**
secured funds, **not** recourse, **not** a deterrent against a capitalized single-shot fraudster. It is
an **anti-sybil costly signal** — the same justification class as sovereign-binding
([`identity-binding-verification.md`](identity-binding-verification.md) § "Binding strength feeds
settlement") and additive scoring ([`hardware-attestation.md`](hardware-attestation.md)): both raise the
cost of a disposable identity. That, and only that, justifies a _modest_ cold-start relaxation. Honest
naming is load-bearing — "recourse" / "make-whole" / "secured" would imply a guarantee phase 1 cannot
deliver, and **manufacturing false confidence is the worst failure mode for a trust layer.**

## The identity-address binding — what makes the anti-sybil claim true

The whole justification rests on this: a `BondCommitment`'s `bonded_address` MUST equal the agent's own
sovereign identity address — `deriveSolanaAddress(bonded_public_key)`, where `bonded_public_key` is the
agent's identity key (the existing `verifySovereignBinding` shape; in motebit the identity key _is_ the
Solana wallet). A bond is thus proof-of-funds at the agent's OWN sovereign wallet, so **one wallet cannot
back many identities** — each identity's address is distinct and must independently hold the capital.
Without this, a sybil farm posts one bond and claims it backs thousands of fakes, and the anti-sybil
property collapses. (Fallback for any future non-identity bonded address: aggregate exposure across all
commitments sharing an address — phase 1 takes the stricter identity-address path.) This is the floor:
a bond that isn't bound to identity is anti-nothing.

## Additive, never a gate; never a new settlement mode

The bond is an eligibility **input** (like identity-binding), enforced in `evaluateSettlementEligibility`
as a branch placed AFTER the strict and sovereign-binding branches — additive, never a gate, byte-
identical for unbonded agents, never fabricating trust (real history still required, it only lowers the
floor). The relaxation is **tiered WITH sovereign-binding, never below** — phase 1's anti-sybil
justification supports no more. The bond is NOT a `SettlementMode`: the `["relay","p2p"]` registry is
closed; routing between modes is forbidden ([`settlement-rails.md`](settlement-rails.md)). A bond reduces
the bar for the same p2p path ([`agility-as-role.md`](agility-as-role.md) — the bond is the instance, the
mode is the role).

## Capital-light, zero-custody

Capital stays agent-held and sovereign. The relay **verifies** the bond by polling Solana RPC (the
read-only, never-custody move — sibling of the p2p-verifier), never holds or seizes it. The relay's
user-funds transmitter surface stays structurally zero ([`off-ramp-as-user-action.md`](off-ramp-as-user-action.md)).
The agent can drain its bond at any time — draining drops bonded eligibility, and (in the deferred
recourse phase) draining after a call is itself the verifiable bad act.

## The cardinal surface-honesty rule (a gate + a human checkpoint)

Any counterparty- or operator-facing surface that shows bond status MUST present it as a **soft
anti-sybil signal**, never as secured funds or guaranteed recourse. Forbidden framings near bond UI:
"secured", "guaranteed", "escrow", "protected", "your money back", "covered", "recourse". Required
reading: _"this agent staked a credible, withdrawable commitment — a signal, not your money back."_
Enforced by `check-bond-surface-honesty` (the prose-vs-truth shape of `check-public-fee-claims` and
[`felt-interior.md`](felt-interior.md)'s honesty gate). **The word-list gate is necessary-not-sufficient**
— it cannot catch a compliant-but-misleading _layout_ (a big "$1000" over a tiny "signal, not recourse").
So any bond surface additionally requires a **human design-review sign-off** before ship — a recorded
checkpoint, the sibling of "sigil distinctness is necessary-not-sufficient, the fingerprint stays primary"
([`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md)).

## No global score (load-bearing)

Permitted: bond _size_ (an objective onchain measurement), a _boolean local_ predicate ("this bond
covers this ticket", computed at transaction time), first-person bilateral trust (the existing
`agent_trust` graph). Forbidden: summing into "reputation = N", or sorting Discover by bond/default count.
Bond annotation is informational on the card, never a sort key — the same global-score refusal as
[`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md), applied to capital.

## Staleness is an adversarial window

A "backed" read is eventually-consistent and can be stale. The spec bounds max staleness; every surface
shows an explicit **as-of timestamp**; and eligibility **re-verifies backing at task-acceptance time**
(a fresh read within the staleness bound, else a synchronous balance check) — never accept on a stale
"backed". A counterparty must never believe a stale read is real-time.

## Threat model & non-goals (phase 1, explicit)

**Protects against:** sybil-floor evasion — a bonded agent has demonstrably tied up real, onchain,
ticket-sized capital at its own sovereign identity address, so it is not a cheap throwaway and capital
cannot be reused across identities. Cohort protected: marketplace-active, reputation-invested agents on
mid-value tickets. **Does NOT** (these wait for the deferred recourse half / hard-guarantee fork):
provide recourse (a wronged counterparty gets nothing back in phase 1); deter a capitalized single-shot
fraudster (defraud once + drain faces zero protocol consequence until the call/default ships); protect
against drain-and-default, exit-scam, or a closed high-value pair going dark; nor tightly bound
_concurrent_ cross-ticket exposure — the live-read recognizes a ticket's exposure only once its
settlement row exists, so concurrent submissions before that can momentarily over-admit against one bond
(fund-loss-free in phase 1 — no recourse means no loss; closed by the deferred reservation ledger, see
§ Status "Known bound"). We ship phase 1 knowing it filters sybils and signals seriousness — nothing
more, and surfaces must say so.

## Status

**Phase 1 (this arc, eligibility-unlock):** Inc 0 doctrine (this file); Inc 1 the `BondCommitment` wire
type (`@motebit/protocol`) + `sign/verifyBondCommitment` (`@motebit/crypto`, the identity-address binding
enforced) + `check-bond-address-binding`; Inc 2 the `getUsdcBalanceOf` arbitrary-address read
(`@motebit/wallet-solana`) + the supervised `startBondVerifierLoop` (relay) + the as-of/staleness
bound; Inc 3 the additive bonded branch in `evaluateSettlementEligibility` (tiered-with-sovereign) +
accept-time re-verification + the cross-ticket exposure defense + `check-bond-surface-honesty`; Inc 4 the
bond-ingestion surface (POST/GET `/api/v1/agents/:id/bond`, artifact-verified, no new audience) + the
decision-time re-verification adapter wired into the live submission gate.

**The cross-ticket reuse defense is a conservative LIVE READ, not a stored reservation ledger.** The
predicate (`backing − k·in_flight ≥ k·ticket`) is computed by summing the worker's PENDING p2p
settlements (`workerInFlightP2pCostMicro`) — strictly conservative (over-counts, never under, because it
counts ALL of the worker's in-flight p2p value, not only bond-admitted tickets), self-releasing through
the existing settlement state machine, zero new money-path write-surface. The identity-address binding
(§Inc 1) handles cross-IDENTITY reuse; this handles cross-TICKET reuse within one identity.

**Known bound (named — the one axis a reservation ledger would strengthen):** exposure is recognized only
once a ticket's settlement row exists, so two _concurrent_ submissions evaluated before either's row is
recorded can both pass — a small over-admission window the conservative coefficient `k` absorbs but does
not close. **This is fund-loss-free in phase 1 _by construction_:** there is no recourse, so over-admitting
a concurrent ticket costs no one anything — it only momentarily dilutes the anti-sybil _signal_, while the
load-bearing protection (real capital tied at the identity address) still holds. The window gains teeth
only when a bond can be _called_ (under-collateralized calls), which is exactly the recourse half — so the
precise close is deferred to land WITH it, below. Pinned by an adversarial characterization test
(`commitment-bond.test.ts`) so the bound is regression-visible, not silent. Atomic reserve-at-grant is the
only close, and that IS the reservation ledger; there is no cheaper middle (eligibility is a read, so a
race-closing marker is itself a write at grant time).

**Deferred — precise per-bond reservation ledger (named-with-trigger):** an atomic reserve-at-grant /
reaped-release ledger keyed per bond, closing the concurrent-submission window above and attributing
exposure to bond-admitted tickets only (vs. the conservative all-in-flight sum). **Trigger:** the recourse
half — the window is fund-loss-free until a bond can be called, and the ledger's precision is what keeps a
_called_ bond honestly collateralized. Building it before recourse is the vault before the gold.

**Deferred — recourse half (named-with-trigger):** the `BondCall`/`BondDefault` wire types + production —
the call on the `executeFundAction` P2P no-op, the agent-signed voluntary settlement, the `BondDefault`
public append-only feed (de-list-never-de-identify, sibling of `AgentRevocationFeed`), recourse render,
recourse gate. **Trigger:** real settlement volume + disputes appear (the call/default bites only then,
and it upgrades phase-1's anti-sybil signal into actual reputation-backed deterrence).

**Deferred — hard-guarantee fork:** an onchain escrow program (agent-posted, still not relay-custodied)
or an underwriter `GuestRail`. **Trigger:** observed called-bond default rate breaks the game theory, OR
an exposed cohort (exit-scam-prone / closed high-value pairs) becomes material. Adding custody
pre-emptively re-introduces the forbidden transmitter surface.

## Related

[`identity-binding-verification.md`](identity-binding-verification.md),
[`hardware-attestation.md`](hardware-attestation.md),
[`settlement-rails.md`](settlement-rails.md),
[`off-ramp-as-user-action.md`](off-ramp-as-user-action.md),
[`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md),
[`agility-as-role.md`](agility-as-role.md),
[`felt-interior.md`](felt-interior.md).
