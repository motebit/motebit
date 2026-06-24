---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Producer-side evidence provenance — motebit's own grounded-answer output now carries re-verifiable provenance down to the retrieved primary source (dogfooding the evidence-provenance protocol motebit owns; agency.computer was the first producer, this makes motebit one too). Covers both the raw-byte path (`text/*`) and the recipe path (HTML).

Additive wire surface (back-compat by absence):

- `@motebit/protocol`:
  - `Citation.provenance?: EvidenceProvenance` — a `"web"` citation's `text_excerpt` as a content-addressed span in the primary record at `locator`, re-checkable with `verifyEvidenceProvenance`.
  - `ToolResult.source_digest?: DigestRef` — set by a fetch-type tool (`read_url`) whose returned `data` is re-derivable from the raw fetched bytes; its presence is the signal. `ToolResult.source_projection?: string` — the byte-deterministic projection recipe id whose output `data` is, set alongside `source_digest` on the recipe path (HTML → `"agency.html-text.v1"`); ABSENT on the raw-byte path (`text/*`).
  - `ExecutionReceipt.source_digest?: DigestRef` + `ExecutionReceipt.source_projection?: string` — the signature-bound attestation of the raw-source digest (and the recipe id, when extracted), threaded from the tool into the signed receipt.
- `@motebit/crypto`: `SignableReceipt.source_digest?` + `SignableReceipt.source_projection?` so the signer types + canonicalizes the fields (signed over `canonicalJson(body)` like every other field). `verifyEvidenceProvenance` is also re-exported through `@motebit/encryption` (the verify surface services consume).

The honesty invariant is enforced structurally: the digest is over the RAW served bytes a stranger re-fetches (never extracted text — the not-independent trap). On the raw-byte path `projection` is absent and the span is located over the raw bytes directly. On the recipe path, `read_url` ADOPTS the world-public, content-addressed, immutable recipe `agency.html-text.v1` (the Metabolic Principle — a deterministic HTML→text transform is a solved commodity, not a motebit enzyme; one resolver re-checks both motebit's and agency's HTML citations) and names it in `source_projection`, so a re-verifier re-fetches the raw HTML, re-applies the published recipe, then locates the span. The `@motebit/crypto` verifier stays domain-blind — it injects the resolver, owns no recipe catalog. The production recipe impl (`projectAgencyHtmlTextV1`, exported from `@motebit/tools`) is conformance-tested byte-for-byte against the published fixture; a separate independent impl in `@motebit/crypto` is the §7 byte-determinism guard.

Behavior change (read_url HTML): extraction is now the byte-deterministic `agency.html-text.v1` recipe — it decodes only the structural entities (`&amp;`/`&lt;`/`&gt;`/`&quot;`/`&apos;`/`&nbsp;` + numeric forms) and passes presentational entities (`&copy;`, `&mdash;`, …) through verbatim, trading cosmetic richness for cross-language re-verifiability. JSON output stays projection-absent (no provenance) until a JSON recipe lands. The browser `proxyUrl` path returns pre-stripped data without provenance — a known coverage gap (the edge proxy is not a producer of signed citations).

Round-trip e2e proves a stranger re-verifies a real research citation against the raw source on BOTH paths, that the HTML path fails closed without the recipe (`projection_unresolved`), and that a fabricated excerpt fails closed (`span_absent`) — verifiable-locality applied to the agent's own factual answers. Doctrine: `docs/doctrine/evidence-provenance.md`; spec/evidence-provenance-v1.md.
