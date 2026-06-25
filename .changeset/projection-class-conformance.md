---
"@motebit/protocol": minor
"@motebit/crypto": minor
"@motebit/verifier": minor
---

Evidence-provenance: a second projection conformance class (`projectionClass`) to keep §7 binary (agency.computer co-design).

A PDF cannot meet §7 (`spec-reproducible`): PDF→text is a genuine inference (glyphs at coordinates, reading order is heuristic; `pdftotext`/`pdf.js`/`pdfminer`/`mupdf` disagree byte-for-byte). Shipping such a recipe under the same `projection` umbrella would soften §7 to "usually real" and a "verified" PDF span would silently re-verify only against the producer's exact library. Rather than corrupt §7, the protocol adds a second, honestly-named assurance class.

`@motebit/protocol`: new closed registry `ProjectionClass` (`spec-reproducible` | `tool-pinned`) + `ALL_PROJECTION_CLASSES` + `isProjectionClass`, mirroring `DigestAlgorithm`'s lighter treatment (not the registered-registry ceremony). New optional `EvidenceProvenance.projectionClass` — ABSENT ⇒ `spec-reproducible`, so the weaker class is opt-in and can never be claimed by omission. Additive, back-compat.

`@motebit/crypto` + `@motebit/verifier`: re-export `ProjectionClass` so a consumer pinning the aggregator reads the class off the SAME surface it consumes (agency-proof-integration contract). `verifyEvidenceProvenance` is UNCHANGED — the class is carried-but-law-advisory (like `binding`/`locator`); it is the assurance level the consumer policies on.

`@motebit/wire-schemas`: `projectionClass` added to the zod schema + the committed `spec/schemas/evidence-provenance-v1.json` (parity-checked).

`tool-pinned` is on-wire (visible per claim, so a consumer can policy-gate it) but its conformance obligations live in `spec/evidence-provenance-v1.md` §7-tool: a content-addressed, world-obtainable, version-pinned tool (reproducible-build preferred) + a committed fixture; the tool digest lives in the app-owned recipe spec (already bound by the immutable-recipe-id rule), never per-span on the wire. No `tool-pinned` recipe ships in-tree yet — this is the class vocabulary + obligations only.
