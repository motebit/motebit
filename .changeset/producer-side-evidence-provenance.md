---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Producer-side evidence provenance — motebit's own grounded-answer output can now carry re-verifiable provenance down to the retrieved primary source (dogfooding the evidence-provenance protocol motebit owns; agency.computer was the first producer, this makes motebit one too).

Additive wire surface (back-compat by absence):

- `@motebit/protocol`:
  - `Citation.provenance?: EvidenceProvenance` — a `"web"` citation's `text_excerpt` as a content-addressed span in the primary record at `locator`, re-checkable with `verifyEvidenceProvenance`.
  - `ToolResult.source_digest?: DigestRef` — set by a fetch-type tool (`read_url`) ONLY when the returned `data` is a verbatim, raw-byte-addressable span of the raw fetched bytes (`text/*` non-HTML); its presence is the signal.
  - `ExecutionReceipt.source_digest?: DigestRef` — the signature-bound attestation of that raw-source digest, threaded from the tool into the signed receipt.
- `@motebit/crypto`: `SignableReceipt.source_digest?` so the signer types + canonicalizes the field (signed over `canonicalJson(body)` like every other field; back-compat by absence). `verifyEvidenceProvenance` is now also re-exported through `@motebit/encryption` (the verify surface services consume).

The honesty invariant is enforced structurally: the digest is over the RAW served bytes a stranger re-fetches (never extracted text — the not-independent trap), `projection` is absent (raw-byte path), and provenance is attached ONLY when the cited excerpt is re-derivable from those bytes — omitted for HTML/JSON (extracted/reformatted) until a published byte-deterministic recipe lands (Increment 2, deferred). A round-trip e2e proves a stranger re-verifies a real research citation against the raw source, and that a fabricated excerpt fails closed (`span_absent`) — verifiable-locality applied to the agent's own factual answers. Doctrine: `docs/doctrine/evidence-provenance.md`; spec/evidence-provenance-v1.md.
