---
"motebit-monorepo": patch
---

Add `check-spec-wire-schemas` (drift defense #23) — a hard CI gate that
asserts every wire-format type declared in `spec/*.md` has a matching
`<TypeName>Schema` export from `@motebit/wire-schemas`.

Closes the loop between the spec corpus and the published JSON Schemas:

- Invariant #9 (`check-spec-coverage`) already enforces spec → TypeScript
  type in `@motebit/protocol`.
- Invariant #22 enforces TypeScript ↔ zod ↔ committed JSON Schema for
  schemas that exist.
- Invariant #23 (this gate) enforces that every spec wire-format type
  HAS a schema in the first place.

Without #23 a future spec author could ship a new wire-format section,
add the TS type to `@motebit/protocol`, and silently skip the schema —
the protocol's "third parties join without bundling motebit" claim
quietly rotting one type at a time.

Initial waiver list documents 21 known gaps as TODOs; the list shrinks
monotonically as schemas ship. Stale-waiver detection (entries in
`WAIVERS` no longer referenced by any spec) ensures debt cleanup
can't accidentally mask future drift.

Adversarially verified: planting a fake type in a spec file produces a
specific file:line error with actionable resolution steps; planting a
ghost waiver produces a stale-waiver report.
