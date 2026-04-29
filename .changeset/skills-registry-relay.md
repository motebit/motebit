---
"@motebit/relay": patch
---

Skills v1 phase 4.5a — relay-hosted curated skills registry.

Three endpoints under `/api/v1/skills/`:

- `POST /submit` — verify envelope signature, re-derive `body_hash` and per-file hashes, persist byte-identical bundle plus indexed projection. Submitter is canonically derived from `envelope.signature.public_key` (no spoofing). Re-submitting the same `(submitter, name, version)` with different bytes returns 409 `version_immutable`; identical bytes are idempotent.
- `GET /discover` — paginated, default view filters by featured-submitters allowlist (env: `FEATURED_SKILL_SUBMITTERS`). Filters by `q` (name/description/tags substring), `submitter`, `sensitivity`, `platform`. `include_unfeatured=true` opens the full set.
- `GET /:submitter/:name/:version` — returns the byte-identical signed bundle. Consumer-side re-verification is the trust boundary — relay is a convenience surface, never a trust root.

Submit is permissive-by-signature (no bearer token); discover and resolve are public-read. Standard rate-limit tiers apply (write/read).

Tests: 16 new relay tests covering submit happy path + 7 rejection cases + idempotency, discover (curated default, include_unfeatured, pagination, search, submitter filter), resolve (404 + byte-identical round-trip).

Spec: `spec/skills-registry-v1.md`.
