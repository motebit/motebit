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

## Cross-cuts

- [`identity-binding-verification.md`](identity-binding-verification.md) — the integrity-vs-binding split that makes the embedded-key fallback legible.
- [`merkle-tree-hash-versioning.md`](merkle-tree-hash-versioning.md) — the Merkle / transparency-log infrastructure the epoch-accumulator endgame of offline revocation freshness would build on.
- [`memory-never-confers-authority.md`](memory-never-confers-authority.md) — why the internal R4 path is already structurally fail-closed.
- [`agency-proof-integration.md`](agency-proof-integration.md) — the reciprocal API obligation that makes a unilateral break a doctrine violation.
- [`release-versioning.md`](release-versioning.md) — majors are promises; the reshape rides a deliberate major.
- [`deprecation-lifecycle.md`](deprecation-lifecycle.md) — the migration contract the boolean forms follow when the reshape ships.
- [`evals-as-attestations.md`](evals-as-attestations.md) — the deferral-with-named-triggers pattern this memo follows.
