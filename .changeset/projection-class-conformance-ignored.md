---
"@motebit/wire-schemas": minor
---

Evidence-provenance: add the `projectionClass` field to `EvidenceProvenanceSchema` (zod) and the committed `spec/schemas/evidence-provenance-v1.json`, mirroring the `@motebit/protocol` wire-shape addition (parity-checked). `spec-reproducible` | `tool-pinned`, optional; absent ⇒ `spec-reproducible`. See the sibling `projection-class-conformance.md` for the full change.
