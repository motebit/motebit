---
name: motebit-spec-writer
description: Draft motebit/<name>@<version> specifications with the
  foundation-law markers, wire-format triple-sync, and drift-gate discipline the
  repo already uses. Read existing specs, mirror the template, ship the protocol
  type + zod schema + JSON Schema in one pass.
version: 1.0.0
platforms:
  - macos
  - linux
  - windows
metadata:
  author: motebit dogfood
  category: protocol-engineering
  tags:
    - spec
    - protocol
    - motebit
    - drift-defense
motebit:
  spec_version: "1.0"
  sensitivity: none
  hardware_attestation:
    required: false
    minimum_score: 0
  signature:
    suite: motebit-jcs-ed25519-b64-v1
    public_key: 06d8b0b2d5a9776b1d650197fe6aa59da68050b8296ec2c0ff8da499217fd9e5
    value: 68jvbaFsouSbB0uElurmtfmVxCiFDPpKEpwy1EFo4kJPIeJFq-rgwGvHdsmmNQLNF6Il8zYA6-1Xb3tExUbtDg
---
# Motebit Spec Writer

## When to Use

The user asks to draft a new `motebit/<name>@<version>` specification, or
to extend an existing one with new wire formats, routes, or foundation-law
clauses. Also fires on "convert this prose proposal into a real spec"
turns where the input is informal and the output must conform to the
motebit spec template.

## Procedure

1. **Read 2-3 existing specs first.** Skim `spec/skills-v1.md`,
   `spec/migration-v1.md`, `spec/dispute-v1.md`. The template is
   conventional — observed structure, not enforced — but every
   committed spec follows it. Land in the same shape.
2. **Write the header verbatim**:

       # motebit/<name>@1.0

       **Status:** Draft
       **Authors:** <name>
       **Created:** <YYYY-MM-DD>

       ---

   Status progresses Draft → Stable → Frozen. New work starts Draft.
3. **Standard section order**: Purpose → Design Principles → domain-
   specific sections (Wire Formats, Routes, Lifecycle, Verification,
   Failure Modes, Storage, Phased Adoption, References). Skip
   sections that don't apply but never re-order what's there.
4. **Wire-format types use the foundation-law marker.** Every binding
   on-the-wire shape ships under a `#### Wire format (foundation law)`
   subsection with the JSON-shaped block immediately below. The marker
   is what `check-spec-coverage` parses to assert each declared type
   exports from `@motebit/protocol`. Without the exact heading, the
   gate can't see your type.
5. **Routes use the foundation-law list.** Relay endpoints declared by
   the spec ship under a `#### Routes (foundation law)` heading,
   formatted as a markdown list:

       - `POST /api/v1/foo` — description.
       - `GET /api/v1/foo/:id` — description.

   `check-spec-routes` cross-references this list against
   `@spec motebit/<name>@<version>` annotations on Hono handlers in
   `services/relay/src/`. Orphan annotations and unimplemented routes
   both fail the gate.
6. **Mark MUST / SHOULD / MAY consistently.** Foundation-law clauses
   use MUST (binding cross-implementation contract). Convention
   clauses use SHOULD (interoperable defaults, alternative impls may
   differ). Optional polish uses MAY.
7. **Phased Adoption table.** End every spec with a phase table that
   names what ships now and what's deferred. Each phase MUST be
   additive — earlier-phase artifacts MUST install / verify under any
   future phase without re-signing or re-issuing.

## Pitfalls

- **Don't ship a wire-format type without the protocol export.**
  `check-spec-coverage` (drift gate #19) iterates every spec for
  `#### Wire format (foundation law)` blocks and asserts each typename
  exports from `@motebit/protocol`. Adding a type to a spec without
  a corresponding interface in `packages/protocol/src/<spec>.ts` is a
  hard CI failure. The fix: add the TypeScript type AND re-export it
  from `packages/protocol/src/index.ts` in the same PR.
- **Don't ship a wire-format type without the zod + JSON Schema
  artifacts.** Wire types triple-sync: protocol type → zod schema in
  `packages/wire-schemas/src/` → committed JSON Schema in
  `spec/schemas/`. The build script `pnpm --filter @motebit/wire-
  schemas build-schemas` regenerates the JSON; the drift test pins
  committed-vs-regenerated. Forgetting any of the three breaks the
  triple-sync (gate `check-spec-wire-schemas`).
- **Don't drift the API surface without a changeset.** Adding a new
  exported type to `@motebit/protocol` is a minor bump. Run
  `pnpm --filter @motebit/protocol run api:extract` to refresh
  `packages/protocol/etc/protocol.api.md` and add a changeset under
  `.changeset/` marking the package `minor`.
- **Don't ship "open standards" claims without backing.** Specs are
  Apache-2.0 (the permissive floor). Reference implementations can be
  BSL. Wire formats and verification math must be implementable from
  the spec alone — no relay calls, no proprietary keys.
- **Don't conflate spec convention with spec law.** Section headings,
  phase numbering, JSDoc tone — convention. Wire formats, foundation-
  law clauses, route paths — law. Editing a wire-format field is a
  major-version bump or a backwards-compatible additive change with a
  new spec version.
- **Don't ship architectural drift in the prose.** Before writing
  "the relay verifies X," grep `services/relay/src/` to confirm it
  actually does. `feedback_doctrine_sibling_audit` — structural
  prose claims must match the shipped code.

## Verification

- `pnpm check` — runs all 54 drift gates green
- `pnpm --filter @motebit/protocol build` — protocol typechecks with
  the new exports
- `pnpm --filter @motebit/wire-schemas build-schemas` — JSON schemas
  regenerate from zod sources without diff in `spec/schemas/`
- `pnpm --filter @motebit/protocol run api:extract` — baseline
  refresh succeeds; `check-api-surface` is green
- The new spec opens cleanly when an LLM consumes
  `apps/docs/public/llms-full.txt` (regenerate via
  `pnpm --filter @motebit/docs run regenerate-llms` if the spec
  count changed)
- For any new relay routes: `check-spec-routes` is green; every
  `@spec` annotation in the relay matches the foundation-law list
- A third-party implementer can build an interoperating implementation
  from the spec alone (no relay calls, no proprietary keys, no
  motebit-internal artifacts referenced)
