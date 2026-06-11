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

## Named triggers for the major

Ship the verify-family reshape when **any one** of the following holds:

1. **A planned major lands on `@motebit/crypto` or `@motebit/verifier` for any other reason** — bundle the reshape into it; never burn a major on this alone while the API has one external consumer.
2. **A second external verify consumer onboards** — the coordination cost of the break is lowest before the third consumer exists, and the footgun surface doubles with each consumer.
3. **Any real-world misread downstream** — an `"embedded"` keySource presented as identity-verified, or an unchecked revocation treated as valid, observed in any consumer. One incident converts the footgun from theoretical to demonstrated and the deferral ends immediately.

Until a trigger fires, the verify family stays as-is: boolean returns, loud JSDoc, honest labels, internal money path fail-closed and gated.

## Cross-cuts

- [`identity-binding-verification.md`](identity-binding-verification.md) — the integrity-vs-binding split that makes the embedded-key fallback legible.
- [`memory-never-confers-authority.md`](memory-never-confers-authority.md) — why the internal R4 path is already structurally fail-closed.
- [`agency-proof-integration.md`](agency-proof-integration.md) — the reciprocal API obligation that makes a unilateral break a doctrine violation.
- [`release-versioning.md`](release-versioning.md) — majors are promises; the reshape rides a deliberate major.
- [`deprecation-lifecycle.md`](deprecation-lifecycle.md) — the migration contract the boolean forms follow when the reshape ships.
- [`evals-as-attestations.md`](evals-as-attestations.md) — the deferral-with-named-triggers pattern this memo follows.
