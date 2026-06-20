# Verify-family fail-closed: deferred with named triggers

The cold third-party-adoption audit (PR #183, June 2026) proposed flipping two fail-open defaults in the published verify family to fail-closed. The flip is a breaking major across the pinned verify API. This memo records the decision — **deferred with named triggers, not declined** — so the next audit doesn't re-litigate it from scratch, and so the eventual major ships as a deliberate API reshape rather than a reactive patch.

## The two fail-open defaults

1. **`verifyStandingDelegation` does not check revocation unless the caller injects the seam.** The function ([`packages/crypto/src/artifacts.ts`](../../packages/crypto/src/artifacts.ts)) is I/O-free by contract — it structurally cannot fetch the revocation feed — so revocation is an injected `isRevoked` callback. Omitting it means a revoked grant verifies `true`. The JSDoc is loud about this, but the return type is a bare boolean whose `true` means less than it reads.

2. **`verifyReceiptChain` falls back to the receipt's own embedded key.** When the caller's `knownKeys` map lacks the signer's `motebit_id`, verification proceeds against the `public_key` embedded in the receipt itself, recorded as `keySource: "embedded"`. That proves byte-integrity only — never that the key belongs to the claimed `motebit_id`. This is the integrity-vs-binding split per [`identity-binding-verification.md`](identity-binding-verification.md): an attacker can mint a key, sign anything, and embed the key. The result labels itself honestly, but only a consumer who reads the label is protected.

## Why this is not a live vulnerability internally

The one place where fail-open would mean money moves on a revoked grant is already fail-closed and gated. `verifyGrantForTurn` ([`packages/runtime/src/grant-verifier.ts`](../../packages/runtime/src/grant-verifier.ts)) builds `isRevoked` from the held revocation set and wires it into both grant and token verification, and `check-money-authority` ensures R4 auto-execution accepts grants through that path only (per [`memory-never-confers-authority.md`](memory-never-confers-authority.md)).

The exposure is **external consumers** calling `verifyStandingDelegation(grant)` bare, or treating an `"embedded"`-keySource receipt as identity-verified. It is an API-footgun problem — a boolean that overpromises — not a hole in motebit's own money path.

## Why the flip was deferred

- **The pinned verify API is a reciprocal obligation.** An external consumer (agency.computer) codes against it under the `check-api-surface` semver guarantee per [`agency-proof-integration.md`](agency-proof-integration.md). Majors are promises per [`release-versioning.md`](release-versioning.md); breaking the verify family inside a remediation batch would have violated the discipline the audit was enforcing.
- **Fail-closed-by-default here is not a flag flip.** The functions are I/O-free; they cannot check revocation themselves. A genuine fail-closed default means an API reshape — either `isRevoked` becomes a required parameter, or the bare boolean becomes a structured verdict (`{ valid, revocation_checked, key_source }`) so a naked `true` cannot be over-read. That is a design decision deserving its own arc, not a hardening patch.
- **Honest-labeling mitigations already shipped.** `keySource` on receipt verification, `revocation_unchecked` / `not_yet_valid` on credential verification, and fail-closed suite-dispatch all landed in or before PR #183. The current state is _labeled_ fail-open, not silent fail-open.

## The v-next shape

When the trigger fires, the verify family's bare booleans become structured verdicts. A verify function returns what it actually established — signature validity, revocation-checked-or-not, key-source — and the type system forces the consumer to confront each axis. `isRevoked` stays an injected seam (the I/O-free contract holds); what changes is that _not wiring it_ becomes visible in the return type instead of silently collapsing into `true`. Existing boolean forms follow the four-field `@deprecated` contract per [`deprecation-lifecycle.md`](deprecation-lifecycle.md).

## Offline revocation freshness — the pure-P2P case

The `verifyStandingDelegation` seam above is "inject `isRevoked`, or a revoked grant reads `true`." That presumes the caller _can_ build `isRevoked`. The harder case surfaced in the cold-start / pure-P2P thread (June 2026, agency.computer discussion): a worker holding a long-lived standing delegation, **offline**, with no path to the revocation feed. How does an offline party prove a negative — that a grant has _not_ been revoked — without a real-time freshness oracle?

It can't. The strong form is information-theoretically unclosable: you cannot prove a real-time negative without touching reality, and any scheme that claims to has hidden an oracle somewhere. So the doctrine does not try to _close_ it — it shrinks, converts, and bounds it:

1. **Shrink (shipped, with a sharp limit — corrected June 2026 after an external review).** The long-lived grant never _acts_; it only authorizes minting short-TTL per-tick tokens (`max_token_ttl_ms`). But be precise about what the token TTL bounds: it bounds a **stolen, replayed** token (it self-expires) and the **online** path (the relay refuses to mint under a revoked grant, enforcing `cadence_ms` and revocation at mint time). It does **not** bound a malicious _delegate_ that is itself offline — minting is a local signature under the grant, so the delegate can manufacture a fresh sequence of short-TTL tokens from stale standing authority. That exposure's hard ceiling is **grant expiry** (`expires_at`), not one token TTL — a coarser dial the delegator still chooses, plus key removal or reconnect-learns-revocation. So the invariant the section needs is not "grants can't act" but the stronger: _a party that cannot obtain fresh authorization must not be able to manufacture an unbounded sequence of apparently-fresh execution tokens from stale standing authority._ The offline pure-P2P path does not yet guarantee that — it wants an adversarial test (revoke-then-self-mint-offline) and an explicit revocation-freshness axis on the structured verdict (the v-next shape below), so a self-minted-under-stale-grant token can't read `valid: true`.

2. **Convert the negative into a positive (designed).** The practical case closes OCSP-stapling-style: the _delegate_ — the party that wants to be trusted — carries a recent signed "grant not revoked as of `T`" staple and presents it with the token. The offline verifier never proves a negative; it checks a recent signed _positive_ against its own clock and its own max-staleness tolerance (first-person freshness — the same shape as first-person time and first-person trust). The freshness burden sits on whoever was last online and wants the trust, not on the offline verifier. The relay is the freshness oracle here — **coordination, not custody**, in-grain with the economic model. It is the move the whole system makes: you don't prove global trustworthiness, you carry signed receipts; you don't prove not-revoked, you carry a recent signed still-valid.

3. **Bound the blast radius — cumulatively, not per-turn (partly shipped).** Freshness _required_ scales with what's crossing the boundary. Stale-but-signed authority clears low-value, low-sensitivity actions; anything high-value, or crossing a high-sensitivity metabolic membrane, demands a fresh staple or a live check — which is exactly the R4 fail-closed rule already shipped (`verifyGrantForTurn` against the held revocation set; no config disables it, per [`memory-never-confers-authority.md`](memory-never-confers-authority.md)). The trap (named by the same June 2026 review): a hostile actor **decomposes** one high-value action into a hundred individually-low-value ones, so per-turn nominal value is the wrong unit — the membrane must evaluate _cumulative_ blast radius (spend windows, action-count and capability-class ceilings, counterparty/destination limits, monotonic nonce/sequence + replay protection, aggregate exposure). And the offline sting that couples this to move 1: a cumulative counter that relies on the **adversary tallying its own spend** doesn't bind offline. So offline, the real cumulative ceilings are the grant's total scope and what each _counterparty_ independently enforces against tokens it sees — not a self-reported running total. Pure-offline P2P serves the low-stakes majority unbothered; the high-stakes minority is precisely the set where a coordination touch is already acceptable.

The endgame of move 2 is epoch-root revocation accumulators — periodic signed revocation-set roots with non-membership proofs — over the existing Merkle / transparency-log infrastructure ([`merkle-tree-hash-versioning.md`](merkle-tree-hash-versioning.md)); freshness then equals how recent a root the verifier holds. Heavier than the staple; deferred until the staple proves insufficient.

**Shipped:** the token-TTL bound plus the R4 fail-closed gate. **Designed, deferred-with-triggers:** the signed freshness staple and the epoch-accumulator endgame. The trigger is a specialization of trigger #2 below — **a second external consumer that needs high-value, pure-P2P, offline revocation**. Internally there is no exposure (R4 is gated); the seam bites only a hypothetical offline high-value external path, and the consumer who needs it forces the staple's shape exactly when they arrive — the consumer-forces-need / producer-forces-shape pattern. We keep it on the books as an open seam with a named trigger rather than ship a freshness oracle that would quietly become the gatekeeper this family exists to refuse.

## Named triggers for the major

Ship the verify-family reshape when **any one** of the following holds:

1. **A planned major lands on `@motebit/crypto` or `@motebit/verifier` for any other reason** — bundle the reshape into it; never burn a major on this alone while the API has one external consumer.
2. **A second external verify consumer onboards** — the coordination cost of the break is lowest before the third consumer exists, and the footgun surface doubles with each consumer.
3. **Any real-world misread downstream** — an `"embedded"` keySource presented as identity-verified, or an unchecked revocation treated as valid, observed in any consumer. One incident converts the footgun from theoretical to demonstrated and the deferral ends immediately.

Until a trigger fires, the verify family stays as-is: boolean returns, loud JSDoc, honest labels, internal money path fail-closed and gated.

## The VerificationVerdict arc

When a trigger fires, this is the shape of the reshape — recorded now so it ships as a coordinated arc, not a scramble. It is the executable-legibility build named in [`agentic-era-engineering.md`](agentic-era-engineering.md): the moat explaining itself through a verdict instead of a boolean.

**Step zero is coordination, not code.** The verify family is a pinned API an external consumer (agency.computer) builds against under the `check-api-surface` guarantee ([`agency-proof-integration.md`](agency-proof-integration.md)). The reshape is a breaking major; the first move is to coordinate the break with the consumer — which is itself trigger #2 firing. A unilateral ship would violate the reciprocal obligation the whole verify family rests on.

**Fired 2026-06-19.** agency.computer confirmed as consumer #2 and is building on the verify surface the same week (a fail-closed approval-bindability audit + the monitor's grant/token/revocation chain), so the reshape is no longer deferred. Determination: no `@motebit/crypto` or `@motebit/verifier` major is imminent (101 changesets queued for the next release, none touching the verify packages), so this is a **dedicated coordinated major**, cut on conformance-corpus readiness rather than a calendar — and sequenced **additive-first**: the structured shape lands alongside the booleans (a minor) so the consumer integrates immediately, and the boolean removal is the breaking major, gated on their green integration. Coordinating before consumer #2 finishes hardening around the boolean is cheaper than after — the migration only grows.

**The verdict (co-designed with consumer #2).** Bare booleans become one structured `VerificationVerdict`, canonical across `@motebit/verifier`, the `motebit-verify` CLI, receipt.computer, relay verification, and external consumers. It states what was _established_ and what remains _unknown_ on independent axes — integrity, identity-binding (the existing sovereign / anchored / pinned rung, mapped verbatim), authority, revocation, temporal-basis (clockless / local-clock / ledger-anchored), evidence-basis — plus a **first-class** repair instruction (not optional: a verdict that teaches the fix at the failing axis is the legibility-on-contact lever — "learn the one axis you hit," not the whole verifier). Governing rule: **no unknown, unchecked, stale, or integrity-only result may silently read `true`.** Revocation is not a bare label but a freshness _basis_ the offline/P2P consumer dials its own tolerance against:

```ts
revocation: { status: "fresh" | "stale" | "unchecked" | "revoked"; freshness?: { asOf, basis } } // basis: "ledger" | "stapled" | …
```

so the `revoke-then-self-mint-offline` case reads stale-by-how-much-against-what, never a bare "stale" — producer shapes the freshness mechanism (what evidence we can emit), consumer holds the tolerance. integrity / identity-binding / authority / revocation are load-bearing for consumer #2 today; temporal-basis and evidence-basis are emerging — neither may silently default to a passing value before a consumer branches on it.

**The hostile conformance corpus.** The arc ships with adversarial fixtures, not only happy paths: expired grants, stale revocation roots, embedded-key-only receipts, wrong identities, replay, clock-rollback, decomposed low-value sequences (the cumulative blast-radius trap), and revoke-then-self-mint-offline (the shrink-limit trap). Consumer #2 contributes from its own seams — a revoked grant whose tick still tries to self-mint, an embedded-key-only (sovereign-but-not-pinned) receipt, and clock-rollback against a clockless ordering basis. The corpus _is_ the contract: integration is done when both sides produce identical verdicts across every case, with zero motebit-side tribal knowledge.

**The migration, the adapter, and the gate.** Boolean forms follow the four-field `@deprecated` contract ([`deprecation-lifecycle.md`](deprecation-lifecycle.md)); a backward-compatible adapter carries existing consumers across the major — and the adapter is **fail-closed by construction** (consumer #2's sharpest constraint): it derives the old `true` only when every load-bearing axis is in its good state, and `unchecked` / `stale` / `unknown` derive `false`, never a silent `true`. The adapter is exactly where the footgun would sneak back, so it inherits the verdict's governing rule. A new drift gate requires every authority-sensitive call site to confront the verdict axes it depends on — the structural analog of `check-money-authority`, widened from the money path to all of verification.

**The proof it's legible.** The arc is done when one independent consumer completes verification end-to-end with no repository-specific tribal knowledge. That is the executable-legibility test: a stranger consumes the guarantee correctly without the founder translating.

**Why the verdict — three folds, proven in the field.** Consumer #2's parity run (an independent stranger verifier against the committed corpus, June 2026) converged 6/7 and, in the process, demonstrated the reshape's whole value on real vectors rather than in argument. Each axis the verdict keeps separate is a fold its consumer's boolean surface _structurally cannot_ make:

- **authority vs revocation** (revoked-self-mint vector) — the consumer's monitor-tick verifier collapses both into one boolean; the verdict reads `authority: "valid"` + `revocation: "revoked"`, so a dead grant can't ride a well-formed tick to a pass.
- **the authority sub-state** (clock-rollback / wall-clock vector) — the installed primitive returns a generic "signature or expiry invalid" string; the verdict distinguishes `not_yet_valid` / `expired` / `valid`, a distinction the old surface can't emit.
- **identityBinding vs integrity** (the integrity-failed receipts) — `verifyArtifact` reports the key→`motebit_id` binding _only_ when the whole artifact verifies (`sovereign` is absent once `valid` is false); the verdict runs `verifySovereignBinding` independent of the signature, so it reads `identityBinding: "sovereign"` even on a tampered or hash-inconsistent receipt ("the binding is real, the bytes just aren't").

Three axes, three folds, each a partial-gate silent-true (a check read as more than it established) caught by separating what the boolean fused. The corpus didn't just check parity — it proved the thesis on the bytes.

## Cross-cuts

- [`identity-binding-verification.md`](identity-binding-verification.md) — the integrity-vs-binding split that makes the embedded-key fallback legible.
- [`merkle-tree-hash-versioning.md`](merkle-tree-hash-versioning.md) — the Merkle / transparency-log infrastructure the epoch-accumulator endgame of offline revocation freshness would build on.
- [`memory-never-confers-authority.md`](memory-never-confers-authority.md) — why the internal R4 path is already structurally fail-closed.
- [`agency-proof-integration.md`](agency-proof-integration.md) — the reciprocal API obligation that makes a unilateral break a doctrine violation.
- [`release-versioning.md`](release-versioning.md) — majors are promises; the reshape rides a deliberate major.
- [`deprecation-lifecycle.md`](deprecation-lifecycle.md) — the migration contract the boolean forms follow when the reshape ships.
- [`evals-as-attestations.md`](evals-as-attestations.md) — the deferral-with-named-triggers pattern this memo follows.
