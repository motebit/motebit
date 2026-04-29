# motebit/skills-registry@1.0

**Status:** Draft  
**Authors:** Daniel Hakim  
**Created:** 2026-04-29

---

## 1. Purpose

Skills registered with `motebit/skills@1.0` (`spec/skills-v1.md`) are local artifacts. The signing scheme proves who wrote them; it does not, by itself, surface them to other agents. A skill's first reader is its installer. Without a discovery layer, signed skills accumulate in `~/.motebit/skills/` with no path from author to ecosystem.

This spec defines the registry layer: a relay-hosted index of submitted, signature-verified skills that any motebit can fetch, re-verify, and install. The relay is a convenience surface, not a trust root — every byte the relay serves is independently re-verifiable against the embedded `motebit.signature.public_key` (`spec/skills-v1.md` §5).

The registry is a discovery funnel, not a gate. Submission is permissive: any signed skill is accepted. Discovery is curated: a featured-submitters allowlist scopes the default view, and clients can opt into the full set. This mirrors the install/auto-load split in the upstream skills spec — the gate moves to the consuming layer, not the storage layer.

---

## 2. Design Principles

- **Permissive submit, curated discovery.** Any motebit-signed skill submission is accepted. The default `discover` query filters by a featured-submitters allowlist; clients opt into the full set. Curation is a discovery filter, not a submission gate, so the registry can never become an editorial bottleneck.
- **Relay convenience, not trust root.** The registry stores envelopes byte-identical to what was submitted. Every install path independently re-verifies the envelope signature against the embedded `motebit.signature.public_key`. A tampering relay produces installable artifacts that fail verification on the consumer.
- **Submitter-scoped namespace.** Skills are addressed as `<submitter_did>/<name>@<version>`. The submitter component is canonically derived from the envelope signature key — not user-provided — so submitter spoofing is impossible. Multiple submitters can publish skills with the same `name`; clients disambiguate by submitter.
- **Content-addressed identity.** A skill version is uniquely identified by the envelope's `content_hash` (SHA-256 over `JCS(manifest) || 0x0A || lf_body`). Re-submitting the same `(submitter, name, version)` with different bytes is rejected — versions are immutable, semver bumps are how authors update.
- **One spec, one wire format.** The registry consumes the same `SkillEnvelope` (`spec/skills-v1.md` §6) authors already produce. There is no second signing ceremony. A skill that loads on `agentskills.io`-compatible runtimes loads from this registry unchanged.

---

## 3. Naming and Addressing

A skill version is addressed as:

```
<submitter_did>/<name>@<version>
```

Where:

- `<submitter_did>` is the `did:key` derivation of `envelope.signature.public_key` (`spec/identity-v1.md`). The relay computes it from the submitted envelope; the submitter never names themselves.
- `<name>` matches `manifest.name` (slug `[a-z0-9-]+`).
- `<version>` matches `manifest.version` (SemVer).

The triple `(submitter_did, name, version)` is the registry's primary key. Two different submitters MAY publish skills with the same `name` and `version`; clients disambiguate by submitter prefix.

---

## 4. Wire Formats

### 4.1 — SkillRegistryEntry

#### Wire format (foundation law)

A registry index row. Returned in `discover` listings; one row per submitted skill version. The display fields (`description`, `sensitivity`, `platforms`, `category`, `tags`, `author`) are denormalized from `manifest` so the discover query does not need to round-trip the full bundle for each row.

```
SkillRegistryEntry {
  submitter_motebit_id: string      // did:key derived from envelope.signature.public_key
  name:                 string      // slug, matches manifest.name
  version:              string      // SemVer, matches manifest.version
  content_hash:         string      // 64 hex chars; SHA-256 over JCS(manifest) || 0x0A || lf_body
  description:          string      // mirrors manifest.description
  sensitivity:          enum        // SkillSensitivity from skills-v1.md §4
  platforms:            string[]?   // SkillPlatform[]; omitted = all
  category:             string?     // mirrors manifest.metadata.category
  tags:                 string[]?   // mirrors manifest.metadata.tags
  author:               string?     // mirrors manifest.metadata.author (display only — not cryptographic)
  signature_public_key: string      // 64 hex chars; mirrors envelope.signature.public_key
  featured:             boolean     // in the relay's featured-submitters allowlist
  submitted_at:         number      // Unix ms
}
```

The `SkillRegistryEntry` type in `@motebit/protocol` is the binding machine-readable form.

### 4.2 — SkillRegistrySubmitRequest

#### Wire format (foundation law)

The body of `POST /api/v1/skills/submit`. Carries the full signed envelope plus the body and any auxiliary files as base64 strings. The relay re-derives `body_hash` and per-file hashes from these bytes and asserts they match the envelope before persisting. The submitter is NOT named in this payload — it is computed canonically from `envelope.signature.public_key`.

```
SkillRegistrySubmitRequest {
  envelope: SkillEnvelope                        // skills-v1.md §6
  body:     string                               // base64 of LF-normalized SKILL.md body bytes
  files:    Record<string, string>?              // base64 of each auxiliary file; keys are the same paths as envelope.files[].path
}
```

### 4.3 — SkillRegistrySubmitResponse

#### Wire format (foundation law)

The response body of `POST /api/v1/skills/submit` on success. Returns the canonical addressing tuple plus the relay-computed `submitter_motebit_id` so the caller can confirm the relay derived the same did:key it expected.

```
SkillRegistrySubmitResponse {
  skill_id:             string      // "<submitter_motebit_id>/<name>@<version>"
  submitter_motebit_id: string      // did:key, computed from envelope.signature.public_key
  name:                 string
  version:              string
  content_hash:         string      // 64 hex chars
  submitted_at:         number      // Unix ms
}
```

### 4.4 — SkillRegistryListing

#### Wire format (foundation law)

The response body of `GET /api/v1/skills/discover`. A paginated page of `SkillRegistryEntry` rows plus pagination metadata.

```
SkillRegistryListing {
  entries: SkillRegistryEntry[]
  total:   number                    // total rows matching the filter (not just this page)
  limit:   number                    // page size used (default 50, max 200)
  offset:  number                    // page offset used (default 0)
}
```

### 4.5 — SkillRegistryBundle

#### Wire format (foundation law)

The response body of `GET /api/v1/skills/:submitter/:name/:version`. Carries the full signed envelope, the body, and any auxiliary files as base64 strings. This is the same shape as `SkillRegistrySubmitRequest` plus a `submitter_motebit_id` echo so consumers can confirm the resolved address before re-verifying.

```
SkillRegistryBundle {
  submitter_motebit_id: string                   // did:key, echoed from the route param
  envelope:             SkillEnvelope            // skills-v1.md §6
  body:                 string                   // base64 of LF-normalized SKILL.md body bytes
  files:                Record<string, string>?  // base64 of each auxiliary file
  submitted_at:         number                   // Unix ms
  featured:             boolean
}
```

---

## 5. Relay Routes

The registry exposes three routes. Submission is permissive-by-signature; discovery is curated-by-default. All three are unauthenticated at the bearer-token layer — the submission route is authenticated by the envelope signature itself, and discovery and resolve are public-read.

#### Routes (foundation law)

The three routes below are the binding cross-implementation contract for the registry surface.

- `POST /api/v1/skills/submit` — submit a signed envelope (§6).
- `GET /api/v1/skills/discover` — list submitted skills, optionally filtered (§7).
- `GET /api/v1/skills/:submitter/:name/:version` — resolve a specific version's full bundle (§8).

---

## 6. Submission

### 6.1 Verification

On `POST /api/v1/skills/submit`, the relay MUST:

1. Validate the request body against `SkillRegistrySubmitRequest` (§4.2).
2. Verify `envelope.signature` per `spec/skills-v1.md` §5.3. Failure → 400 `verification_failed`.
3. Decode `body` (base64) → assert `SHA-256(body_bytes) == envelope.body_hash`. Failure → 400 `body_hash_mismatch`.
4. For each entry in `envelope.files`: decode `files[path]` → assert `SHA-256(file_bytes) == entry.hash`. Failure → 400 `file_hash_mismatch`.
5. Derive `submitter_motebit_id = publicKeyToDidKey(envelope.signature.public_key)`.
6. If `(submitter_motebit_id, manifest.name, manifest.version)` already exists with a DIFFERENT `content_hash`, reject 409 `version_immutable`. Re-submission with the same `content_hash` is idempotent (returns the existing entry).
7. Persist the byte-identical request payload (envelope + body + files) plus the indexed entry.

### 6.2 Foundation Law

- Submission MUST require a structurally valid `motebit.signature` block on the envelope. Unsigned skills (`spec/skills-v1.md` §11) are NOT accepted — registry submission is the asymmetry mechanism that drives signing.
- The relay MUST NOT modify any byte of the submitted envelope, body, or files. The stored bundle is byte-identical to what was submitted, so consumers can re-verify against the original signature.
- The relay MUST NOT condition acceptance on the `manifest.metadata.author` field, the `motebit.sensitivity` field, or any non-cryptographic metadata. Submission is permissive.
- Versions are immutable. A re-submission of `(submitter, name, version)` with different bytes is rejected; authors bump SemVer to release new content.

### 6.3 Convention

- The relay SHOULD apply its standard write-tier rate limit (`services/relay/CLAUDE.md` rule 4) to the submission endpoint.
- The relay MAY drop submissions whose total payload exceeds an implementation-defined limit (the reference relay uses 16 MB); this is honest fail-closed.

---

## 7. Discovery

### 7.1 Query

`GET /api/v1/skills/discover`. Query parameters (all optional):

| Param                | Type    | Description                                                                                  |
| -------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `q`                  | string  | Free-text search over `name`, `description`, `tags`. Case-insensitive substring.             |
| `submitter`          | string  | Filter by `submitter_motebit_id` (exact match, did:key form).                                |
| `sensitivity`        | string  | Filter by `manifest.motebit.sensitivity` (exact match).                                      |
| `platform`           | string  | Filter to entries whose `platforms` includes this value, OR entries with no `platforms` set. |
| `include_unfeatured` | boolean | If `true`, return all matching entries; if absent or `false`, restrict to `featured = true`. |
| `limit`              | number  | Page size. Default 50, max 200.                                                              |
| `offset`             | number  | Page offset. Default 0.                                                                      |

The default response is a curated view: featured submitters only, alphabetical by `name`. Clients that want full transparency pass `include_unfeatured=true`.

### 7.2 Foundation Law

- The relay MUST honor `include_unfeatured=true` and return every matching entry, regardless of curation state. Curation MUST NOT hide entries — it MUST only re-rank or scope the default view.
- The relay MAY rank, sort, or order entries in implementation-defined ways. The reference relay sorts alphabetically by `name`, then by `version` descending; v2 ranking is a post-1.0 addition.

### 7.3 Convention

- A direct resolve (`GET /api/v1/skills/<submitter>/<name>/<version>`) bypasses the curated view entirely. Clients with a known address never need to discover.
- The featured allowlist is implementation-defined. The reference relay reads `FEATURED_SKILL_SUBMITTERS` (comma-separated `did:key` list) from the environment.

---

## 8. Resolution

### 8.1 Path

`GET /api/v1/skills/:submitter/:name/:version`. Returns `SkillRegistryBundle` (§4.5) with `Content-Type: application/json`. 404 if the triple does not exist.

The submitter component MUST be the canonical did:key form (`did:key:z…`). URL-encoding rules apply.

### 8.2 Verification at the consumer

The consumer (CLI, surface, third-party tool) MUST re-verify the envelope signature against the embedded `envelope.signature.public_key` before installing. The relay MUST NOT be trusted as a verification authority. Failure to re-verify is a security violation of `spec/skills-v1.md` §5.3.

The consumer SHOULD also assert that the URL path's `submitter` matches `publicKeyToDidKey(envelope.signature.public_key)`; mismatch indicates a relay returned a bundle from a different submitter than the one requested.

---

## 9. Failure Modes (User Experience)

| Failure                                                 | Response                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| Submission body fails schema validation                 | 400 `bad_request` with field path                                   |
| Submission envelope signature invalid                   | 400 `verification_failed`                                           |
| Submission body bytes do not hash to envelope           | 400 `body_hash_mismatch`                                            |
| Submission file bytes do not hash to envelope           | 400 `file_hash_mismatch`                                            |
| Submission has no `motebit.signature` block             | 400 `unsigned_skill_rejected`                                       |
| Submission re-publishes existing version with new bytes | 409 `version_immutable`                                             |
| Submission re-publishes identical version               | 200 (idempotent) — returns existing entry                           |
| Submission payload exceeds relay-configured size cap    | 413 `payload_too_large`                                             |
| Resolve path triple not present                         | 404 `not_found`                                                     |
| Discover with no matches                                | 200, `entries: [], total: 0`                                        |
| Discover with empty featured allowlist (default view)   | 200, `entries: [], total: 0`. Hint: pass `include_unfeatured=true`. |
| Relay tampers with stored bytes                         | Out of band — consumer-side re-verify fails closed.                 |

---

## 10. Storage (reference convention — non-binding)

The reference relay persists submissions in two SQLite columns per row: an indexed projection (the `SkillRegistryEntry` fields) for discovery queries, and `bundle_json` (the byte-identical submission payload) for resolution. Alternative implementations MAY split the storage differently or stream bundles from object storage; only the wire shapes above are protocol-binding.

```
relay_skill_registry (
  submitter_motebit_id  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  version               TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  description           TEXT NOT NULL,
  sensitivity           TEXT NOT NULL,
  platforms_json        TEXT,
  category              TEXT,
  tags_json             TEXT,
  author                TEXT,
  signature_public_key  TEXT NOT NULL,
  featured              INTEGER NOT NULL DEFAULT 0,
  submitted_at          INTEGER NOT NULL,
  bundle_json           TEXT NOT NULL,
  PRIMARY KEY (submitter_motebit_id, name, version)
)
```

---

## 11. Phased Adoption

| Phase             | Ships                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 (this spec)** | Submit / discover / resolve endpoints, env-driven featured allowlist, CLI install via relay, drift defenses. Submission permissive-by-signature; discovery curated-by-default with full opt-in. |
| 2                 | Web surface (`apps/web`) consumes `discover` for the public registry view; surface installs proxy through a future browser-side install primitive.                                              |
| 3                 | Admin endpoints to flip `featured` per-entry (replaces env-only allowlist); ranking primitives (BM25 over `name`/`description`/`tags`); semiring-shaped relevance ordering.                     |
| 4                 | Federation: peer relays exchange registry index deltas. Clients query their nearest relay; cross-relay resolves are transparent.                                                                |

Each phase is additive. v1 entries are accepted unchanged under any future phase.

---

## 12. References

- [`spec/skills-v1.md`](./skills-v1.md) — wire format the registry transports verbatim.
- [`spec/identity-v1.md`](./identity-v1.md) — `did:key` derivation for `submitter_motebit_id`.
- [`spec/discovery-v1.md`](./discovery-v1.md) — sibling registry; `discover` here is for skills, not agents.
- [`spec/credential-v1.md`](./credential-v1.md) — sibling permissive-submit / curated-display pattern.
