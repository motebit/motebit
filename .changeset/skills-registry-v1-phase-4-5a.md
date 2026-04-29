---
"@motebit/protocol": minor
---

Add `motebit/skills-registry@1.0` wire types — the relay-hosted index of submitted, signature-verified skill envelopes.

Five new exported types: `SkillRegistryEntry` (one row in the index), `SkillRegistrySubmitRequest` and `SkillRegistrySubmitResponse` (POST /api/v1/skills/submit), `SkillRegistryListing` (GET /api/v1/skills/discover, paginated), `SkillRegistryBundle` (GET /api/v1/skills/:submitter/:name/:version, full payload).

Spec: [`spec/skills-registry-v1.md`](https://raw.githubusercontent.com/motebit/motebit/main/spec/skills-registry-v1.md). The submitter component of every addressing tuple is canonical — derived from `envelope.signature.public_key` by the relay, never user-provided. Submission is permissive-by-signature; discovery is curated-by-default with full opt-in. The relay stores submitted bundles byte-identical so consumers re-verify offline against the embedded signature key — relay is a convenience surface, not a trust root.

Why this lands here, not in a new package: registry types are wire format, not runtime logic. They follow the same layering as `SkillEnvelope` and `SkillManifest` — protocol types in `@motebit/protocol`, zod schemas in `@motebit/wire-schemas`, runtime in `services/relay` and `apps/cli`. No new package boundaries.

Backwards-compatible. Pure additive change.
