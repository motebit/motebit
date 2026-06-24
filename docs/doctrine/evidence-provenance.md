# Evidence provenance — verifiable locality, from signatures to evidence

The `VerificationVerdict`'s `evidenceBasis: EvidenceRef[]` was an emerging axis: a list of `{ kind, ref }` POINTERS naming what a verdict used, but not independently re-checkable. This arc (co-designed with agency.computer, 2026-06, the second verify-family consumer — the same consumer-forces-need / producer-forces-shape loop as the [VerificationVerdict reshape](verify-family-fail-closed.md)) makes that pointer **resolve to a re-verifiable provenance**, extending the system's deepest property — _verify the claim without trusting the claimant_ — from a SIGNATURE ("is this artifact authentic?") to EVIDENCE ("is this claim backed by a primary record?").

## The law

`verifyEvidenceProvenance(bytes, provenance, { resolveProjection? })` (`@motebit/crypto`, pure, I/O-free): **the named `span` is an exact substring of `projection(bytes)`, where the bytes content-address to `digest`.** It re-verifies PRESENCE — never TRUTH, with no oracle. The bytes either contain the span or they don't. "Model proposes, code disposes": a fabricated figure cannot be placed into the record, because the verifier only accepts an exact substring of content-addressed bytes — the [runtime-invariants-over-prompt-rules](runtime-invariants-over-prompt-rules.md) pattern applied to evidence.

The shape (`@motebit/protocol`, additive, back-compat by absence — a producer that doesn't retrieve emits bare `{ kind, ref }` as before):

```
EvidenceRef       = { kind, ref, provenance? }
EvidenceProvenance = { digest: { algorithm, value }, projection?, span, locator?, binding? }
```

## The boundary (load-bearing)

motebit owns the **shape** and the **re-check law**; NEVER the venue authority. Deciding what counts as a primary record, the document→text projection, and domain identity semantics (e.g. SEC/CIK) are **app-layer**, the consumer's. The subject is re-verifiable _presence_, not _truth_.

## The three guardrails (and the keystone)

1. **Hash-agility, not a baked-in algorithm.** `digest` is `{ algorithm, value }` (a `DigestAlgorithm` role — a content digest is hashed, not signed, so it rides its own role, not `SuiteId`). `sha-256` today; a new hash is a registry append, not a wire break ([agility-as-role](agility-as-role.md)).
2. **Domain-blind identity binding.** `binding?` references an opaque resolved identity (a `motebit_id` or a domain token the consumer resolves) — it is CARRIED, not verified by the law. Who is a valid issuer is app-layer.
3. **Byte-exact reproducibility — the make-or-break.** The `digest` is over the RAW, independently-obtainable bytes (a third party fetches the same primary source). The `span` is re-checkable iff EITHER `projection` is absent (located over the raw bytes directly — re-verifiable _by construction_, the **default**) OR the named recipe is spec'd to byte-determinism: a third party reimplements it from its spec to byte identity, proven by a conformance fixture that pits TWO INDEPENDENT implementations against each other (one impl checked against itself is the nominal-recipe trap). Same discipline as JCS canonicalization — both sides must produce byte-identical input or it fails mysteriously.

**Keystone — projection is an injected seam.** Because the projection recipe is app-owned (guardrail 1's twin), `verifyEvidenceProvenance` takes it as an INJECTED function — the same shape as `verifyStandingDelegation`'s `isRevoked`. Projection absent → motebit does it fully (raw bytes). Projection present + resolver → apply, then check. Projection present + no resolver → **fail closed** (`projection_unresolved`). This keeps the verifier pure and domain-blind; the recipe implementation never enters motebit's tree. `locator?` is advisory (the law is substring presence), never a second thing a re-verifier must reproduce.

The injected resolver is assumed **total** for any recipe it accepts: a resolver that THROWS propagates the exception — a resolver fault is a caller bug, NOT an evidence verdict, and is never swallowed into a false `present:false` (which would let a broken recipe masquerade as "evidence absent" and hide the bug). The signal for "I cannot resolve this recipe" is to OMIT the resolver for it and let the no-resolver path fail closed (`projection_unresolved`), never a throwing resolver — i.e. inject a resolver only for the recipes the consumer owns, and let every other recipe fall through. (Contract clarified from agency.computer's adoption, 2026-06 — the consumer-forces-shape loop hardening the prose against the real package.)

## Status

**Shipped:** the additive `EvidenceProvenance`/`EvidenceRef` vocabulary in `@motebit/protocol` (graduated from `@motebit/crypto`'s free `{kind,ref}`), `verifyEvidenceProvenance` with the injected projection seam in `@motebit/crypto`, the hostile corpus (span-absent, digest-mismatch, projection-unresolved-fail-closed, raw-byte-happy, projection-applied, projection-divergence, binding-carried-not-verified), and the law re-exported through `@motebit/verifier` so a consumer pinning the aggregator re-checks evidence from the same surface as the verdict family (the agency-proof-integration contract — consume the verifier, never fork it; not reaching past it into `@motebit/crypto`).

**Shipped — the make-or-break guardrail, now empirically proven.** agency.computer published `agency.html-text.v1` as a frozen, **world-public**, citable spec — a scoped public repo carrying only the recipe (`github.com/agency-computer/html-text-spec` @ `01b475be`; raw spec + fixture return 200 unauthenticated, verified). World-public reachability is not incidental: it IS the property — the byte-determinism guardrail only means anything if ANY third party (not just agency's partner) can re-fetch the recipe and re-derive a span. motebit then stood up the **real cross-implementation conformance case** (`packages/crypto/src/__tests__/evidence-provenance-conformance.test.ts`): a second implementation written from §2 of the spec ALONE — their reference `projection.ts` deliberately NOT read — reproduces all 7 vectors **byte-for-byte**, including the single-pass-decode canary (`a&amp;lt;b` → `a&lt;b`). So the byte-exact-reproducibility crux (guardrail 3) is no longer asserted, it is demonstrated: the recipe is a genuine public protocol artifact, not an agency-private convenience. **Boundary preserved:** the conformance impl is a TEST-only independent reimplementation (motebit acting as the second implementer the guardrail requires); the shipped `verifyEvidenceProvenance` still owns no recipe (domain-blind, injected resolver), and v1's immutability (`§5` — any output change is a new id) makes the vendored fixture a frozen, zero-maintenance proof.

**Deferred:** the wire spec formalizing the provenance shape (now unblocked by the published recipe — sequenced next). The verdict producers do not yet populate `provenance` on motebit's side — it is consumer-populated until a motebit producer retrieves a primary record.
