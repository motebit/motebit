---
"@motebit/relay": patch
---

Commitment bond — phase 1: make the cross-ticket defense's one known limitation a **first-class, named, tested, triggered** decision rather than an implicit property of the conservative live-read.

Choosing the live-read over a stored reservation ledger (the deliberate phase-1 call) leaves exactly one axis where a ledger would be stronger: exposure is recognized only once a ticket's settlement row exists, so two _concurrent_ submissions evaluated before either row is recorded can both pass — a small over-admission window the coverage coefficient `k` absorbs but does not close. Doing the live-read "properly" means owning that bound, not burying it:

- **Doctrine** (`docs/doctrine/commitment-bond.md`): the window is now a named entry in the explicit threat-model non-goals AND a § Status "Known bound" paragraph that states _why it is fund-loss-free in phase 1 by construction_ (no recourse → over-admission costs no one; it only momentarily dilutes the anti-sybil signal while the capital-at-identity-address protection holds), and why the only close is atomic reserve-at-grant (which _is_ the reservation ledger — there is no cheaper middle, because eligibility is a read).
- **Named-with-trigger deferral**: the **precise per-bond reservation ledger** is now a first-class deferred item alongside the recourse half, with the trigger spelled out — it lands WITH recourse, because the window only gains fund-loss teeth once a bond can be _called_ (an under-collateralized call). Building it earlier is the vault before the gold.
- **Code** (`bond-store.ts` `workerInFlightP2pCostMicro`): the comment names the window and points at the doctrine + the pinning test.
- **Test** (`commitment-bond.test.ts`): an adversarial **characterization test** pins the window (two concurrent pre-row evaluations both pass; the defense engages the instant a pending row exists). It is intended to FLIP to "the second rejects" the day the reservation ledger ships — the intended tripwire that the bound exists.

No behavior change — the live-read is unchanged. This closes the honesty loop on the Inc 3 mechanism choice: the limitation is now defended doctrine and a regression-visible test, not an undocumented convenience.
