# Evidence provenance — verifiable locality, from signatures to evidence

> **Layer:** law (a digest mismatch is never reported present; fail-closed projection) — enforced by `packages/crypto/src/__tests__/evidence-provenance.test.ts`

**Status:** [doctrine-status.md § evidence-provenance](../ops/doctrine-status.md#evidence-provenancemd)

The `VerificationVerdict`'s `evidenceBasis: EvidenceRef[]` was an emerging axis: a list of `{ kind, ref }` POINTERS naming what a verdict used, but not independently re-checkable. This arc (co-designed with agency.computer, 2026-06, the second verify-family consumer — the same consumer-forces-need / producer-forces-shape loop as the [VerificationVerdict reshape](verify-family-fail-closed.md)) makes that pointer **resolve to a re-verifiable provenance**, extending the system's deepest property — _verify the claim without trusting the claimant_ — from a SIGNATURE ("is this artifact authentic?") to EVIDENCE ("is this claim backed by a primary record?").

## The law

`verifyEvidenceProvenance(bytes, provenance, { resolveProjection? })` (`@motebit/crypto`, pure, I/O-free): **the named `span` is an exact substring of `projection(bytes)`, where the bytes content-address to `digest`.** It re-verifies PRESENCE — never TRUTH, with no oracle. The bytes either contain the span or they don't. "Model proposes, code disposes": a fabricated figure cannot be placed into the record, because the verifier only accepts an exact substring of content-addressed bytes — the [runtime-invariants-over-prompt-rules](runtime-invariants-over-prompt-rules.md) pattern applied to evidence.

The shape (`@motebit/protocol`, additive, back-compat by absence — a producer that doesn't retrieve emits bare `{ kind, ref }` as before):

```
EvidenceRef       = { kind, ref, provenance? }
EvidenceProvenance = { digest: { algorithm, value }, projection?, projectionClass?, span, locator?, binding? }
```

## The boundary (load-bearing)

motebit owns the **shape** and the **re-check law**; NEVER the venue authority. Deciding what counts as a primary record, the document→text projection, and domain identity semantics (e.g. SEC/CIK) are **app-layer**, the consumer's. The subject is re-verifiable _presence_, not _truth_.

## The three guardrails (and the keystone)

1. **Hash-agility, not a baked-in algorithm.** `digest` is `{ algorithm, value }` (a `DigestAlgorithm` role — a content digest is hashed, not signed, so it rides its own role, not `SuiteId`). A new hash is a registry append, not a wire break ([agility-as-role](agility-as-role.md)).
2. **Domain-blind identity binding.** `binding?` references an opaque resolved identity (a `motebit_id` or a domain token the consumer resolves) — it is CARRIED, not verified by the law. Who is a valid issuer is app-layer.
3. **Byte-exact reproducibility — the make-or-break.** The `digest` is over the RAW, independently-obtainable bytes (a third party fetches the same primary source). The `span` is re-checkable iff EITHER `projection` is absent (located over the raw bytes directly — re-verifiable _by construction_, the **default**) OR the named recipe is spec'd to byte-determinism: a third party reimplements it from its spec to byte identity, proven by a conformance fixture that pits TWO INDEPENDENT implementations against each other (one impl checked against itself is the nominal-recipe trap). Same discipline as JCS canonicalization — both sides must produce byte-identical input or it fails mysteriously.

**Keystone — projection is an injected seam.** Because the projection recipe is app-owned (guardrail 1's twin), `verifyEvidenceProvenance` takes it as an INJECTED function — the same shape as `verifyStandingDelegation`'s `isRevoked`. Projection absent → motebit does it fully (raw bytes). Projection present + resolver → apply, then check. Projection present + no resolver → **fail closed** (`projection_unresolved`). This keeps the verifier pure and domain-blind; the recipe implementation never enters motebit's tree. `locator?` is advisory (the law is substring presence), never a second thing a re-verifier must reproduce.

The injected resolver is assumed **total** for any recipe it accepts: a resolver that THROWS propagates the exception — a resolver fault is a caller bug, NOT an evidence verdict, and is never swallowed into a false `present:false` (which would let a broken recipe masquerade as "evidence absent" and hide the bug). The signal for "I cannot resolve this recipe" is to OMIT the resolver for it and let the no-resolver path fail closed (`projection_unresolved`), never a throwing resolver — i.e. inject a resolver only for the recipes the consumer owns, and let every other recipe fall through. (Contract clarified from agency.computer's adoption, 2026-06 — the consumer-forces-shape loop hardening the prose against the real package.)

## Two projection conformance classes — keeping §7 binary (agency.computer co-design, 2026-06)

§7's whole value is that it is **binary**: a recipe either is independently reimplementable from prose or it is not a real protocol artifact. PDF→text breaks this — a PDF is a graphics format, "the text" (reading order, columns, tables) is a genuine INFERENCE, and `pdftotext`/`pdf.js`/`pdfminer`/`mupdf` disagree byte-for-byte; there is no honest §7 recipe for it. If such a recipe shipped under the same `projection` umbrella, §7 would go soft ("usually real"), and a "verified" PDF span would silently re-verify only against the producer's exact library — the quiet falsehood §7 exists to forbid.

The fix is NOT to keep PDF out; it is to make the weaker assurance **visibly weaker, per claim**. `projectionClass` (a closed `ProjectionClass` registry, on-wire) declares HOW a present projection is re-verified and BY WHOM:

- **`spec-reproducible`** (§7.1, the strong rung, the **default**) — reimplementable from the published spec to byte identity, proven by a TWO-independent-implementation fixture. `agency.html-text.v1` is the exemplar.
- **`tool-pinned`** (§7-tool, the lesser rung) — byte-reproducible only by running the recipe's **content-addressed, world-obtainable, version-pinned tool** (a build digest, reproducible-build preferred) against a committed fixture (ONE implementation, the pinned one). A real but lesser assurance; never §7.1.

Four load-bearing decisions, all derivable from the existing doctrine:

1. **On-wire, as a closed enum — not a naming convention.** The class is the metadata that says how re-checkable the span is; a consumer must see it at the point of the claim, fail-closed, without a catalog lookup (else a tool-pinned span is silently read as §7-grade — the exact undetected-until-a-stranger-disagrees failure). Encoding it in the recipe id would force motebit to PARSE the app-owned id namespace — a domain-authority leak (the id stays opaque per guardrail 1's twin). On-wire also makes the weak class pay a **visibility cost**, which is what stops it being chosen out of laziness.
2. **Absent ⇒ `spec-reproducible`.** The strong rung is the default, so the weaker class is **opt-in** and can never be claimed by omission; every span emitted before the class existed keeps the strong reading (back-compat). A `tool-pinned` recipe that omits the field over-claims §7.1 and is caught by the missing two-impl fixture.
3. **The tool digest is OFF-wire.** It lives in the app-owned recipe spec, already bound by the immutable-recipe-id rule (a new tool digest is a new recipe id, §7-tool.3). Carrying it per-span would be redundant and would pull an app-owned implementation detail onto motebit's protocol surface.
4. **World-obtainable tool is the honesty line.** A content-addressed digest of a producer-PRIVATE build is not a lesser class — it IS the §6 "agency-re-verifiable only" footgun. `tool-pinned` is honest only because anyone can obtain and re-run the pinned tool; reproducible-build recovers byte-reproducibility one level down (reproduce the binary from pinned source).

**Boundary preserved.** motebit owns the class VOCABULARY and the conformance obligations (shape + law); it never owns the recipe catalog (which tool, which digest — app-owned) and never adjudicates whether `tool-pinned` is good enough for a given use. Like `binding` and `locator`, the class is CARRIED but NOT verified by the law — `verifyEvidenceProvenance` applies the injected recipe regardless; the class is the assurance level the CONSUMER policies on. The honest ladder is exactly these two rungs plus the null (a projection nobody can re-run collapses to the bare `EvidenceRef` pointer — there is no "advisory projection" third rung). Lighter closed-union treatment (`ALL_PROJECTION_CLASSES` + `isProjectionClass`, mirroring `DigestAlgorithm`), NOT the registered-registry ceremony — crystallize the eight-artifact set when a third class (e.g. a TEE-attested tool run) or a second independent consumer arrives.

## Conformance and deferrals

**The verifier owns no recipe.** `verifyEvidenceProvenance` stays domain-blind (injected resolver). A recipe implementation lives in a PRODUCER (motebit's research citations use `projectAgencyHtmlTextV1` from `@motebit/tools`, which is both the producer transform and an injectable resolver), never in the verifier. motebit ADOPTS the world-public `agency.html-text.v1` rather than publishing a near-identical recipe of its own — the Metabolic Principle: a deterministic HTML→text transform is solved glucose, not a motebit enzyme, and one resolver re-checks both parties' HTML citations.

**Byte-determinism is demonstrated, not asserted.** The §7 guardrail is proven by a TEST-only independent reimplementation written from the recipe spec alone (`packages/crypto/src/__tests__/evidence-provenance-conformance.test.ts`), which must reproduce the published fixture byte-for-byte — motebit acting as the second implementer the guardrail requires. A recipe's world-public reachability IS the property: the guardrail only means anything if any third party can re-fetch the recipe and re-derive a span. v1's immutability (any output change is a new id) makes a vendored fixture a frozen, zero-maintenance proof.

**Verify in any language.** A language-neutral corpus ([`spec/conformance/evidence-provenance/corpus.json`](../../spec/conformance/evidence-provenance/corpus.json)) is verified by BOTH `@motebit/crypto`'s `verifyEvidenceProvenance` and a stdlib-only Python reference ([`examples/python-receipt-verifier/verify_evidence_provenance.py`](../../examples/python-receipt-verifier/verify_evidence_provenance.py) — evidence-provenance needs no signing library, just sha-256 + substring), and `check-evidence-provenance-conformance` (the evidence-axis sibling of `check-receipt-conformance`) asserts both agree with each other and with `expected`.

**Deferred-with-trigger:**

- JSON output stays projection-absent until a JSON recipe lands; the browser `proxyUrl` path (edge runtime, not a signed-citation producer) carries no provenance.
- The first `tool-pinned` recipe and its conformance fixture land when agency (or motebit) needs to cite a PDF primary record. Until then motebit ships the class vocabulary and conformance obligations only.
