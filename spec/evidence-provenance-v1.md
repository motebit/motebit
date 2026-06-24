# motebit/evidence-provenance@1.0

Verifiable-locality extended from **signatures to EVIDENCE**. A
`VerificationVerdict`'s `evidenceBasis` is a list of `EvidenceRef` pointers naming
what a verdict used. This spec defines the optional, re-verifiable **provenance** an
`EvidenceRef` may carry, so the pointer stops being "trust me, I looked" and becomes
locally re-checkable down to the primary record: _is this claim backed by the
document it cites?_ — re-verifiable **presence**, never truth, with no oracle.

Doctrine: [`docs/doctrine/evidence-provenance.md`](../docs/doctrine/evidence-provenance.md).
The law: [`@motebit/crypto`](../packages/crypto) `verifyEvidenceProvenance`. Types:
[`@motebit/protocol`](../packages/protocol) `EvidenceRef` / `EvidenceProvenance` / `DigestRef`.

## 1. Scope

### The boundary (load-bearing)

motebit owns the **shape** and the **re-check law** — NEVER the venue authority.
What counts as a primary record, the document→text **projection**, and domain
identity semantics (e.g. SEC/CIK) are **app-layer**, the consumer's. The subject is
re-verifiable _presence_ of a verbatim span in a content-addressed record, not its
truth. A fabricated figure cannot be placed into the record, because the law only
accepts an exact substring of independently-obtainable bytes — "model proposes, code
disposes."

### Back-compat by absence

`provenance` is OPTIONAL on `EvidenceRef`. A producer that does not retrieve a
primary record emits the bare `{ kind, ref }` exactly as before, so the whole verdict
family stays wire-compatible. Adding provenance is purely additive.

## 2. The carrier — EvidenceRef

An `EvidenceRef` is what a verdict's `evidenceBasis` cites. The bare pair is a
POINTER (what the verdict used); the optional `provenance` makes it re-verifiable.

```
EvidenceRef {
  kind:        string             // e.g. "receipt", "public_key", "revocation_root", "document"
  ref:         string             // the evidence value or locator (hash, hex key, root, slot)
  provenance?: EvidenceProvenance  // §3 — a content-addressed span in a primary record
}
```

## 3. The re-verifiable provenance

### 3.1 — EvidenceProvenance

#### Wire format (foundation law)

The re-verifiable shape. Field names and types are binding. The property holds when
EITHER `projection` is absent (the span is located over the raw bytes directly —
re-verifiable by construction) OR the named recipe is spec'd to byte-determinism (§6,
§7).

```
EvidenceProvenance {
  digest:      { algorithm: DigestAlgorithm, value: string }
                 // content address of the RAW, independently-obtainable bytes
                 // (the raw filing a third party fetches) — NEVER the projected text.
                 // `value` is the lowercase hex digest under `algorithm`.
  projection?: string
                 // opaque, APP-OWNED projection recipe id (e.g. agency.html-text.v1).
                 // Absent ⇒ the span is located over the raw bytes directly. Present ⇒
                 // a re-verifier applies the consumer-injected recipe before confirming
                 // the span; with no injected resolver the check fails closed.
  span:        string
                 // the verbatim span asserted PRESENT in projection(bytes) — the law's subject.
  locator?:    { start: number, end: number }
                 // ADVISORY narrowing of where the span sits. NOT load-bearing: the law
                 // is exact-substring presence, never a second thing a re-verifier reproduces.
  binding?:    string
                 // opaque resolved-identity reference (a motebit_id or a domain token the
                 // consumer resolves). CARRIED, NOT verified by the law — issuer authority
                 // is app-layer (domain-blind).
}
```

`DigestAlgorithm` is a closed registry (`@motebit/protocol`): `sha-256` today. A
content digest is hashed, not signed, so it rides its own role — a new hash is a
registry append, never a wire break (it is NOT a `SuiteId`).

## 4. The re-check law

`verifyEvidenceProvenance(bytes, provenance, { resolveProjection? })` — pure, I/O-free.

**The law:** the named `span` is an exact substring of `projection(bytes)`, where the
bytes content-address to `digest`. It re-verifies PRESENCE; it does NOT assert truth,
and there is no oracle — the bytes either contain the span or they don't.

The result is **structured** (never a bare boolean — same legibility discipline as the
verdict), so a non-present result names WHY:

```
EvidenceProvenanceResult =
  | { present: true }
  | { present: false, reason: "digest_mismatch" | "projection_unresolved" | "span_absent" }
```

A verifier MUST, fail-closed:

1. Content-address `bytes` under `digest.algorithm`; reject (`digest_mismatch`) unless
   it equals `digest.value`. An unknown algorithm fails closed (its value cannot match).
2. Resolve the projected text (§5).
3. Reject (`span_absent`) unless `span` is an exact substring of the projected text.

`binding` is NOT verified here (issuer authority is app-layer). `locator` is advisory.

## 5. The projection seam (injected)

Because the projection recipe is app-owned, the verifier takes it as an **injected**
function (the same shape as a standing-delegation's revocation seam). motebit never
owns a projection catalog — that would be document-format authority.

- **projection ABSENT** → the span is checked against the raw bytes directly
  (re-verifiable by construction; no shared code).
- **projection PRESENT + resolver injected** → apply the recipe, then check.
- **projection PRESENT + no resolver** → **FAIL CLOSED** (`projection_unresolved`).

**Resolver totality.** The injected resolver is assumed TOTAL for any recipe it
accepts: if it THROWS, the exception **propagates** — a resolver fault is a caller bug,
not an evidence verdict, and is never swallowed into a false `present: false` (which
would let a broken recipe masquerade as "evidence absent" and hide the bug). To signal
"I cannot resolve this recipe," a consumer OMITS the resolver for it and lets the
no-resolver path fail closed — i.e. inject a resolver only for the recipes the
consumer owns, and let every other recipe fall through. Never a throwing resolver as a
not-supported signal.

## 6. The three guardrails

1. **Hash-agility, not a baked-in algorithm.** `digest` is `{ algorithm, value }` —
   `sha-256` today, a new hash is a registry append, never a `contentSha256` field that
   breaks the wire at the first migration.
2. **Domain-blind identity binding.** `binding` references an opaque resolved identity
   the consumer resolves; who is a valid issuer is app-layer, never verified by the law.
3. **Byte-exact reproducibility — the make-or-break.** The `digest` is over the RAW,
   independently-obtainable bytes (a third party fetches the same primary source). The
   `span` is re-checkable iff EITHER `projection` is absent (located over the raw bytes
   directly — re-verifiable by construction, the **default**) OR the named recipe is
   spec'd to **byte-determinism** (§7). A digest over PROJECTED text would be re-checkable
   only by whoever owns the projection — "agency-re-verifiable," not independently — and
   the locality property dies. Same discipline as JCS canonicalization: both sides MUST
   produce byte-identical input or it fails mysteriously.

## 7. Conformance — projection recipes MUST be byte-deterministic

A named `projection` recipe is a real PUBLIC protocol artifact only if an independent
implementer, from its SPEC alone, reproduces its output byte-for-byte. A recipe used in
provenance therefore MUST:

1. be published as a **world-public, content-addressed (pinnable)** spec — the recipe
   algorithm stated to byte-determinism — plus a committed **conformance fixture** (a
   set of `{ html → text }` vectors, the `text` being the EXACT required output);
2. be **immutable** under its id: any change that alters the output for any input is a
   NEW recipe id (`…v2`), never an edit — provenance signs the recipe `id` alongside the
   span, so mutating a recipe would silently invalidate every span ever located against it;
3. be proven byte-deterministic by **two INDEPENDENT implementations** reproducing every
   fixture vector byte-for-byte — no normalization, no tolerance. One implementation
   checked against itself is the nominal-recipe trap; the cross-implementation fixture is
   what removes it.

**Worked exemplar.** `agency.html-text.v1` — published by agency.computer at
`github.com/agency-computer/html-text-spec` @ `01b475be` (world-public): a 5-step
HTML→text algorithm + a fixed entity table + a 7-case fixture including the single-pass-
decode determinism canary (`a&amp;lt;b` → `a&lt;b`, never `a<b`). Validated end to end:
the publisher's CI reproduces all 7 vectors, and an INDEPENDENT motebit implementation
written from the spec alone reproduces all 7 byte-for-byte
([`packages/crypto/src/__tests__/evidence-provenance-conformance.test.ts`](../packages/crypto/src/__tests__/evidence-provenance-conformance.test.ts)) —
two implementations pinned against the same public fixture, both green. That is the
guardrail standing on its own legs rather than either party's word.

## 8. Versioning

`EvidenceProvenance` is additive on `EvidenceRef` (back-compat by absence, §1).
`DigestAlgorithm` agility is a registry append. Projection recipe ids are immutable
(§7.2). The verdict producers populate `provenance` only when they actually retrieve a
primary record; absence is the back-compatible default.
