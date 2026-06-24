# Evidence-provenance conformance corpus

A versioned, pinnable set of vectors for `verifyEvidenceProvenance` — the evidence-axis analog of signature integrity, extending verifiable-locality from a SIGNATURE ("is this artifact authentic?") to EVIDENCE ("is this claim backed by a primary record?"). See [`docs/doctrine/evidence-provenance.md`](../../../docs/doctrine/evidence-provenance.md) and the wire spec [`spec/evidence-provenance-v1.md`](../../evidence-provenance-v1.md).

The corpus is the interop contract: a second implementation, in any language, runs **its** law over the same `input` and asserts the same `expected`. "Done" is both sides emitting identical results with neither author in the room. This is what makes evidence-provenance a **protocol**, not a TypeScript feature — the same property the receipt verifier proves for signatures, now for evidence.

## The law

The named `span` is an exact substring of `projection(bytes)`, where the bytes hash to `provenance.digest`. It re-verifies **PRESENCE** — never truth, with no oracle. The bytes either contain the span or they don't. `binding` (issuer authority) and `locator` are NOT verified here (app-layer / advisory).

The result is structured, not a bare boolean — a non-present result names WHY:

```
{ present: true }
| { present: false, reason: "digest_mismatch" | "projection_unresolved" | "span_absent" }
```

Evaluation order is load-bearing: **digest first** (fail closed before any span check), **then projection**, **then substring**.

## The projection seam (injected, app-owned)

`projection` is an OPAQUE recipe id; motebit owns the law, never a projection catalog (that would be document-format authority). So the projection is an **injected** seam modeled per-case by `input.resolvable_recipes` — the set of recipes the verifier is configured to resolve:

- **`projection` absent** → the span is checked against the raw bytes directly (re-verifiable by construction).
- **`projection` present, in `resolvable_recipes`** → apply the recipe to the raw bytes, then check.
- **`projection` present, NOT in `resolvable_recipes`** → **FAIL CLOSED** (`projection_unresolved`). "Cannot resolve" is signaled by omitting the recipe, never by a throwing resolver (resolver totality).

The one recipe exercised here, `agency.html-text.v1`, is the published, world-public, byte-deterministic HTML→text projection ([github.com/agency-computer/html-text-spec](https://github.com/agency-computer/html-text-spec) @ `01b475be`). A conforming implementation reproduces its output **byte-for-byte** from §2 of that spec — the §7 byte-determinism guarantee, here proven to survive a language boundary (TS ↔ Python), not just two TS impls.

## Cases

Each case is `{ name, description, input: { bytes_utf8, provenance, resolvable_recipes }, expected }`. UTF-8 encode `bytes_utf8` to bytes, build a resolver that handles exactly `resolvable_recipes`, run the law, assert the result deep-equals `expected`.

| name                           | path                                   | expected                                  |
| ------------------------------ | -------------------------------------- | ----------------------------------------- |
| `raw-byte-present`             | raw bytes, projection absent           | `present`                                 |
| `raw-byte-digest-mismatch`     | wrong digest                           | `digest_mismatch` (before any span check) |
| `raw-byte-span-absent`         | digest ok, span not in bytes           | `span_absent`                             |
| `recipe-html-present`          | HTML, `agency.html-text.v1` resolvable | `present`                                 |
| `recipe-projection-unresolved` | HTML, recipe NOT resolvable            | `projection_unresolved`                   |
| `recipe-html-span-absent`      | HTML, recipe applied, span absent      | `span_absent`                             |

## Implementations under test

- **`@motebit/crypto`** `verifyEvidenceProvenance` (the floor primitive; re-exported via `@motebit/verifier` and `@motebit/encryption`).
- **Python reference** ([`examples/python-receipt-verifier/verify_evidence_provenance.py`](../../../examples/python-receipt-verifier/verify_evidence_provenance.py)) — stdlib-only (no signing library needed; evidence-provenance is sha-256 + substring), an independent re-implementation of both the law and the `agency.html-text.v1` projection.

Agreement is enforced by [`scripts/check-evidence-provenance-conformance.ts`](../../../scripts/check-evidence-provenance-conformance.ts): every case must agree across all implementations AND match `expected`; the Python leg is mandatory under `REQUIRE_PYTHON=1` (CI).
