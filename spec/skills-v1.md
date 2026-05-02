# motebit/skills@1.0

## Skill Specification

**Status:** Draft
**Version:** 1.0
**Date:** 2026-04-28

---

## 1. Overview

A **skill** is a directory of procedural knowledge — _how_ an agent combines its tools to accomplish a class of task. Skills do not grant capability; tools do. Skills teach the agent _when_ to invoke a tool, _which order_ to invoke a sequence, _which pitfalls_ to avoid, and _how_ to verify success.

Skills are an open standard (`agentskills.io`, originated by Anthropic in late 2025) with cross-vendor adoption across Claude Code, OpenAI Codex, Cursor, GitHub Copilot, Microsoft Agent Framework, OpenClaw, and Hermes Agent. Motebit conforms to the standard frontmatter and directory layout, then adds sovereign primitives: cryptographic provenance, sensitivity-tiered loading, hardware-attestation gating, and signed invocation receipts.

A motebit skill is verifiable end-to-end:

- Every skill is signed by its author's motebit identity (`did:key` Ed25519).
- Every skill carries a sensitivity tier; medical, financial, and secret skills are fail-closed by default.
- Every skill optionally requires a minimum hardware-attestation score on the loading agent.
- Every skill invocation emits an entry in the agent's execution ledger (phase 3).

**Design principles:**

- **Standard-compliant.** Frontmatter and directory layout match `agentskills.io`. A motebit skill loads on Claude Code, Codex, and Cursor unmodified — only motebit-specific extensions are ignored by non-motebit runtimes.
- **Permission-orthogonal.** Installing a skill does not grant the agent any new tool. Skills teach the use of already-permitted tools.
- **Author-signed.** Skill provenance is cryptographic, not advisory. The signature binds frontmatter + body bytes; tampering invalidates the envelope.
- **Sensitivity-aware.** Skills inherit motebit's privacy doctrine. A `medical`-tier skill never auto-loads on a `none`-tier session.
- **Receipt-emitting.** Skill use produces signed entries in the agent's execution ledger. A user can prove "the obsidian skill ran on date X with these tools."
- **Composable.** A skill MAY reference other skills by name. The loader resolves the chain and emits one combined receipt.

---

## 2. Directory Layout

A skill is a directory keyed by its `name`:

```text
skill-name/
  SKILL.md                  # required — frontmatter + body
  skill-envelope.json       # required — signed manifest envelope (§5)
  scripts/                  # optional — executable code
    <script>.{py,sh,js,ts}
  references/               # optional — supporting documentation
    <ref>.md
  templates/                # optional — file templates
    <template>
  assets/                   # optional — icons, fonts, images
    <asset>
```

Only `SKILL.md` and `skill-envelope.json` are required. The optional subdirectories follow the agentskills.io convention; motebit imposes no naming or content rules on them beyond size limits (§9).

---

## 3. SKILL.md Format

#### Wire format (foundation law)

The parsed frontmatter object is the `SkillManifest` wire type, exported from `@motebit/protocol`. Implementations exchange this object as JSON over network or registry boundaries; the YAML serialization in `SKILL.md` is the on-disk encoding only. `SkillSignature`, `SkillSensitivity`, `SkillHardwareAttestationGate`, and `SkillPlatform` are the supporting types.

`SKILL.md` is YAML frontmatter followed by Markdown body, separated by `---` delimiters:

```markdown
---
name: example-skill
description: One-line description used by the loader to decide relevance.
version: 1.0.0
platforms: [macos, linux]

metadata:
  author: did:key:z6Mk...
  category: software-development
  tags: [git, github, code-review]

motebit:
  spec_version: "1.0"
  sensitivity: none
  hardware_attestation:
    required: false
    minimum_score: 0
  signature:
    suite: motebit-jcs-ed25519-b64-v1
    public_key: 4f3a2b1c... # hex-encoded Ed25519 public key
    value: SGVsbG8... # base64url-encoded Ed25519 signature
---

# Example Skill

## When to Use

Trigger conditions in plain prose. The loader reads `description`; the agent reads
this section to decide whether the skill applies in context.

## Procedure

1. First step.
2. Second step.
3. ...

## Pitfalls

Common failure modes the agent should anticipate.

## Verification

How to confirm the procedure succeeded.
```

### 3.1 Frontmatter fields

| Field                                        | Type     | Required    | Origin         | Description                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | -------- | ----------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                       | string   | Yes         | agentskills.io | Globally unique within an installation. Slug form: `[a-z0-9-]+`.                                                                                                                                                                                                                   |
| `description`                                | string   | Yes         | agentskills.io | One-line. Read by the loader to decide skill relevance for a given turn.                                                                                                                                                                                                           |
| `version`                                    | string   | Yes         | agentskills.io | SemVer.                                                                                                                                                                                                                                                                            |
| `platforms`                                  | string[] | No          | agentskills.io | OS gate: `[macos, linux, windows, ios, android]`. Empty/omitted = all.                                                                                                                                                                                                             |
| `metadata.author`                            | string   | No          | agentskills.io | Free-form display string per agentskills.io (e.g. `"Jane Doe"`, `"@janedoe"`). NOT cryptographically verified. The cryptographic author is `motebit.signature.public_key`. SDKs SHOULD lint-warn (not reject) when a `did:key`-shaped value here disagrees with the signature key. |
| `metadata.category`                          | string   | No          | agentskills.io | Free-form. UI grouping only — never load-bearing.                                                                                                                                                                                                                                  |
| `metadata.tags`                              | string[] | No          | agentskills.io | Free-form. UI filtering only.                                                                                                                                                                                                                                                      |
| `motebit.spec_version`                       | string   | Yes         | motebit        | `"1.0"`. Gates compatibility for future bumps.                                                                                                                                                                                                                                     |
| `motebit.sensitivity`                        | enum     | No          | motebit        | One of `none \| personal \| medical \| financial \| secret`. Defaults to `none` per §4.                                                                                                                                                                                            |
| `motebit.hardware_attestation.required`      | boolean  | No          | motebit        | Default `false`. If `true`, loading agent must present an HA credential.                                                                                                                                                                                                           |
| `motebit.hardware_attestation.minimum_score` | number   | No          | motebit        | Default `0`. Range `[0, 1]`. §6.                                                                                                                                                                                                                                                   |
| `motebit.signature`                          | object   | No          | motebit        | Cryptographic provenance block. Whole block is optional (§10, §11); when present, the three sub-fields below are all required.                                                                                                                                                     |
| `motebit.signature.suite`                    | string   | Conditional | motebit        | Required iff `motebit.signature` is present. Cryptosuite ID. v1: `"motebit-jcs-ed25519-b64-v1"`.                                                                                                                                                                                   |
| `motebit.signature.public_key`               | string   | Conditional | motebit        | Required iff `motebit.signature` is present. Hex-encoded Ed25519 public key (32 bytes → 64 hex chars).                                                                                                                                                                             |
| `motebit.signature.value`                    | string   | Conditional | motebit        | Required iff `motebit.signature` is present. Base64url-encoded Ed25519 signature over the canonical form (§5).                                                                                                                                                                     |

### 3.2 Body sections

Section headings (`When to Use`, `Procedure`, `Pitfalls`, `Verification`) are **conventional, not normative**. The loader injects the entire body verbatim. Authors who diverge from convention reduce cross-runtime portability but do not violate the spec.

---

## 4. Sensitivity Tiers

Skills inherit motebit's privacy doctrine (`CLAUDE.md` § Fail-closed privacy). Each skill SHOULD declare exactly one tier in `motebit.sensitivity` describing the data the skill's procedure will cause the agent to touch. Skills with no declared tier default to `none`.

| Tier        | Auto-load                       | Examples                                                |
| ----------- | ------------------------------- | ------------------------------------------------------- |
| `none`      | Yes                             | Code formatting, ASCII art, public-data analysis        |
| `personal`  | Yes (with session consent flag) | Calendar, contacts, notes                               |
| `medical`   | **Never auto**                  | Symptom triage, prescription lookup, clinical workflows |
| `financial` | **Never auto**                  | Transaction analysis, tax workflows, credentials        |
| `secret`    | **Never auto**                  | Private keys, secret material, infra credentials        |

The `SkillSelector` (§7) MUST NOT auto-load `medical`, `financial`, or `secret` skills regardless of session tier. These require explicit per-turn opt-in (`/skill <name> use`) or operator-mode session promotion.

**Sensitivity describes data, not provenance.** An unsigned skill with `sensitivity: none` content is still `none`-tier content. Provenance (whether the skill's instructions are trusted) is a separate axis (§7.1).

---

## 5. Signature Scheme

### 5.1 Canonical form

The bytes signed are the concatenation:

```text
canonical_manifest_json || 0x0A || lf_normalized_body_bytes
```

Where:

- `canonical_manifest_json` is **JCS-canonicalized JSON** (RFC 8785) of the parsed frontmatter with `motebit.signature.value` removed (the rest of `motebit.signature` — `suite`, `public_key` — IS included).
- `0x0A` is a single LF byte separator.
- `lf_normalized_body_bytes` is the body (everything after the closing `---`), with CRLF and CR converted to LF, no BOM, UTF-8 encoded.

### 5.2 Cryptosuite

v1 uses `motebit-jcs-ed25519-b64-v1` — the same suite used for execution receipts, tool invocation receipts, agent settlement anchors, and migration artifacts. JCS canonicalization (RFC 8785), Ed25519 primitive, hex-encoded public key, base64url-encoded signature. Suite agility is preserved via the `suite` field; future suites (including post-quantum) are registry additions per `architecture_cryptosuite_agility`.

Skills do NOT use the W3C `eddsa-jcs-2022` DataIntegrityProof suite (which credentials, identity files, and presentations use). That suite carries `proofHash + docHash` ceremony intended for VC interoperability with third-party W3C-aware verifiers. Skills are motebit-internal protocol artifacts — installed locally, verified by motebit runtimes — and use the simpler concat-bytes scheme (§5.1) consistent with motebit's other internal signed artifacts.

### 5.3 Verification

```ts
verifySkillEnvelope(envelope, opts?) -> Result<void, VerifyError>
```

Verification:

1. Parse `SKILL.md` frontmatter; extract `motebit.signature.{suite, public_key, value}`.
2. Reconstruct the canonical bytes (§5.1).
3. Verify `value` against `public_key` over the canonical bytes using the named `suite`.
4. If `metadata.author` is set, assert it matches `did:key` derivation of `public_key`.

Verification is offline. No relay, no registry, no external service.

---

## 6. Skill Envelope (`skill-envelope.json`)

#### Wire format (foundation law)

The envelope JSON is the `SkillEnvelope` wire type, exported from `@motebit/protocol`. `SkillEnvelopeFile` and `SkillEnvelopeSkillRef` are the supporting types.

The envelope is a content-addressed wrapper for distribution and install:

```json
{
  "spec_version": "1.0",
  "skill": {
    "name": "example-skill",
    "version": "1.0.0",
    "content_hash": "sha256:abc123..."
  },
  "manifest": {
    /* parsed frontmatter object */
  },
  "body_hash": "sha256:def456...",
  "files": [
    { "path": "scripts/run.sh", "hash": "sha256:..." },
    { "path": "templates/pr.md", "hash": "sha256:..." }
  ],
  "signature": {
    "suite": "eddsa-jcs-2022",
    "public_key": "z6Mk...",
    "value": "z3hY9..."
  }
}
```

The envelope's `signature.value` is over the JCS-canonicalized envelope with `signature.value` removed. Installing a skill verifies the envelope signature, then re-derives `content_hash` and `body_hash` from the unpacked tree and asserts equality. Any mismatch aborts the install with no partial state.

---

## 7. Loading Semantics

### 7.1 Trust gate (provenance)

Provenance is gated **separately** from sensitivity. A skill is **trusted for auto-load** if and only if one of:

- `motebit.signature` is present and `verifySkillEnvelope` succeeds (cryptographic provenance), OR
- The operator has explicitly promoted the skill via `motebit skills trust <name>` (manual provenance attestation).

Manual trust promotion logs an audit event (`type: "skill_trust_grant"`, with operator identity, skill name, content hash, and timestamp) but does NOT manufacture cryptographic provenance. The skill remains marked `[unverified]` in display surfaces; only the auto-load eligibility changes.

This mirrors `mcp_trusted_servers` governance (`CLAUDE.md` § MCP trust pinning), where `/mcp add` (record) and `/mcp trust` (act) are separate operations. Untrusted skills install permissively and remain on disk inert; the selector never auto-loads them, and they fire only via explicit per-turn invocation (`/skill <name> use`) or session-wide promotion (`motebit skills trust <name>`). Install is a record; auto-load is an act; gating happens at the act layer.

### 7.2 Selector

The `SkillSelector` is invoked per turn. Inputs: `(user_turn, session_sensitivity_tier, hardware_attestation_score, installed_skills)`. Output: ordered list of skills to inject.

Selection algorithm (v1):

1. Filter to **enabled AND trusted** skills (§7.1).
2. Filter by `platforms` (current OS).
3. Filter by sensitivity (skill tier ≤ session tier; `medical | financial | secret` never auto, regardless of session tier).
4. Filter by hardware attestation (`hardware_attestation.minimum_score` ≤ session score).
5. Rank remaining skills by relevance to the user turn (BM25 over `description` initially; richer ranking deferred to phase 2).
6. Return top-K (default K=3, configurable).

### 7.3 Injection

Selected skill bodies are injected verbatim as additional system context, preceded by a header indicating origin and signature status:

```text
[skill: example-skill@1.0.0 — verified by did:key:z6Mk...]
<body>
```

A skill that fails signature verification at load time is not injected. The selector logs the failure to the audit trail and surfaces it in `/skills` with a `[unverified]` badge.

### 7.4 Receipt emission (phase 3)

#### Wire format (foundation law)

The per-skill audit detail is the `SkillLoadPayload` wire type, exported from `@motebit/protocol`. Each skill the selector pulls into context produces one `EventLogEntry` with `event_type: "skill_loaded"` (`EventType.SkillLoaded`) and the payload below; the load timestamp and signing motebit identity live on the event-log envelope, not the payload.

```json
{
  "skill_id": "example-skill@1.0.0",
  "skill_name": "example-skill",
  "skill_version": "1.0.0",
  "skill_signature": "SGVsbG8...",
  "provenance": "verified",
  "score": 4.27,
  "run_id": "run-2026-04-28-...",
  "session_sensitivity": "none"
}
```

| Field                 | Type   | Required | Description                                                                                                                                                                                                                                                                        |
| --------------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skill_id`            | string | Yes      | `"name@version"` — convenient composite ID for log queries.                                                                                                                                                                                                                        |
| `skill_name`          | string | Yes      | Slug. Matches `SkillManifest.name`.                                                                                                                                                                                                                                                |
| `skill_version`       | string | Yes      | SemVer. Matches `SkillManifest.version`.                                                                                                                                                                                                                                           |
| `skill_signature`     | string | Yes      | Base64url envelope `signature.value`. Empty string when the manifest is `trusted_unsigned`. Pins the audit entry to exact bytes — re-signing produces a new value, so a stale ledger entry's signature failing to resolve in the current registry is itself a useful audit signal. |
| `provenance`          | enum   | Yes      | `"verified"` or `"trusted_unsigned"`. Display-grade copy of the runtime's `SkillProvenanceStatus`.                                                                                                                                                                                 |
| `score`               | number | Yes      | BM25 relevance score against the user's turn. Higher = more relevant. The selector's threshold is `0.0001` (§7.2).                                                                                                                                                                 |
| `run_id`              | string | No       | Run identifier the load was keyed to. Matches `runId` on `runtime.sendMessage`. Optional because future proactive-cycle loads may not have an explicit run context.                                                                                                                |
| `session_sensitivity` | enum   | Yes      | Session sensitivity tier in effect when the skill loaded.                                                                                                                                                                                                                          |

The event-log envelope (`event_id`, `motebit_id`, `timestamp`, `tombstoned`) follows the existing `EventLogEntry` shape. The runtime emits one event per selected skill, immediately after the selector returns and before the AI loop receives the system prompt. Failure to emit (storage error, signing key absent) is logged and the AI loop proceeds — the audit trail is best-effort, never blocking.

---

## 8. Hardware Attestation Gating

A skill MAY require a minimum hardware-attestation score by setting `motebit.hardware_attestation.required: true` and `minimum_score: <0..1>`. The loading agent's HA credential is evaluated against the threshold using the `HardwareAttestationSemiring` (`docs/doctrine/hardware-attestation.md`).

If the agent's score is below the threshold:

- **At install:** reject with explicit error pointing to `motebit attest`.
- **At load:** skip silently in selector; surface in `/skills` with `[gated: hw-attestation]` badge.

Hardware-attested skills enable use cases like "this medical workflow only loads on a Secure-Enclave-backed device" without requiring the loading agent to know which platform it's on.

---

## 9. Size Limits

| Resource            | Default limit | Rationale                                   |
| ------------------- | ------------- | ------------------------------------------- |
| SKILL.md body       | 50 KB         | Token budget; avoid context blow-up.        |
| `scripts/` total    | 1 MB          | Distribution sanity.                        |
| `references/` total | 5 MB          | Reference docs are not loaded into context. |
| `assets/` total     | 5 MB          | Display only.                               |
| Frontmatter         | 8 KB          | Pre-parse safety.                           |

Limits are configurable per-installation (`~/.motebit/config.json` → `skills.limits`). Exceeding a limit at install rejects the skill with a loud error; no silent truncation.

---

## 10. Failure Modes (User Experience)

| Failure                                                                        | Behavior                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsigned skill installed (no `motebit.signature`)                              | Permitted. Tagged `[unsigned]` everywhere the skill surfaces. NEVER auto-loaded by the selector (§7.1) until the operator promotes via `motebit skills trust <name>`. The provenance gate at load time is the safety boundary; install is a filesystem record and is not gated.  |
| Signature verification fails at install                                        | Reject install. The skill never enters the registry; `/skills` does not surface it. Surface a clear error pointing to the verification failure mode (suite mismatch, key mismatch, value mismatch).                                                                              |
| Signature verification fails at load (re-verify of previously-installed skill) | Refuse to inject. Surface in `/skills` with `[unverified]` badge. Selector treats as untrusted (§7.1). Operator can `motebit skills remove <name>` or `motebit skills trust <name>` if the failure is known-acceptable (e.g., key rotation pending).                             |
| Sensitivity tier > session tier                                                | Skip silently in selector. Visible in `/skills` with `[gated: <tier>]` badge.                                                                                                                                                                                                    |
| Hardware attestation requirement not met                                       | Reject at install (with `motebit attest` pointer) or skip at load (with badge).                                                                                                                                                                                                  |
| Duplicate `name` on install                                                    | Reject second install. `--force` overwrites and records a supersession entry in the install log.                                                                                                                                                                                 |
| Malformed frontmatter or body                                                  | Refuse install; surface line+column; never partial-register.                                                                                                                                                                                                                     |
| Network install fails mid-fetch                                                | Pin by `content_hash` before extract; retry idempotent; partial state never registered.                                                                                                                                                                                          |
| Body exceeds size limit                                                        | Reject at install with explicit limit + actual size. No silent truncate.                                                                                                                                                                                                         |
| Platform mismatch (`platforms: [macos]` on Linux)                              | Skip in selector. Visible in `/skills` with `[gated: platform]` badge.                                                                                                                                                                                                           |
| Skill `scripts/` execution requested at runtime                                | Phase 2: routed through the canonical operator approval-queue (same store the existing tool-approval flow uses) at `RiskLevel.R3_EXECUTE`. CLI-driven via `motebit skills run-script <skill> <script> [args...]`; AI-callable scripts as registered tools deferred to phase 2.5. |
| Deletion certificate emit fails on `remove`                                    | Block remove; do not orphan files; surface error.                                                                                                                                                                                                                                |

---

## 11. Compatibility with `agentskills.io`

A motebit-signed skill loads unmodified on any agentskills.io-compliant runtime. Non-motebit runtimes ignore the `motebit.*` frontmatter namespace and the `skill-envelope.json` file. The body and standard frontmatter remain interoperable.

A non-motebit skill (no `motebit.signature`) installs permissively. Sensitivity is whatever the author declared (default `none`) — the unsigned status does not bump the tier (§4). The skill is tagged `[unsigned]` everywhere it surfaces and is **never auto-loaded** by the selector (§7.1) until the operator promotes it via `motebit skills trust <name>`. Demand for signing is created through ongoing UX asymmetry — signed skills auto-load, accumulate signed receipts (phase 3), rank higher in discovery, and propagate as first-class to other agentskills.io runtimes that adopt the upstream `author_signature` extension — not through install-time friction. Authors who want first-class status on motebit sign because signing is positive-sum, not because the runtime refuses unsigned installs.

---

## 12. Reference Storage Convention (Non-Binding)

The reference CLI stores installed skills under `~/.motebit/skills/`:

```text
~/.motebit/skills/
  installed.json                   # registry index
  <skill-name>/
    SKILL.md
    skill-envelope.json
    scripts/
    ...
```

`installed.json` is a flat array of `{ name, version, enabled, installed_at, source, content_hash }`. The CLI is the canonical reader/writer; alternative runtimes MAY store skills elsewhere. The wire-format contract is `SKILL.md` + `skill-envelope.json`; storage layout is implementation-private.

---

## 13. Phased Adoption

| Phase             | Ships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 (this spec)** | Frontmatter, envelope, signature scheme, sensitivity tiers, trust gate, install/list/enable/disable/remove/verify/trust/untrust, drift defenses. Install is permissive; auto-load is provenance-gated.                                                                                                                                                                                                                                                                                                                  |
| 2                 | `SkillSelector` wired into the runtime context-injection path; per-turn relevance ranking. Script execution governance: `scripts/` are stored at install but never auto-executed (the directory IS the quarantine); each invocation is gated through the canonical operator approval-queue (same `SqliteApprovalStore` the existing tool-approval flow uses) at `RiskLevel.R3_EXECUTE`. CLI surface: `motebit skills run-script <skill> <script> [args...]`. AI-callable scripts as registered tools land in phase 2.5. |
| 3                 | Signed `SkillLoadReceipt` in `execution-ledger-v1`; per-invocation receipts.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4                 | Sibling-surface skill browsers (desktop / mobile / web), `motebit/awesome-skills` curated registry.                                                                                                                                                                                                                                                                                                                                                                                                                     |

Each phase is additive. Phase 1 skills install and verify under any future phase without re-signing.

---

## 14. References

- [`agentskills.io` specification](https://agentskills.io/specification) — origin standard.
- [`docs/doctrine/hardware-attestation.md`](../docs/doctrine/hardware-attestation.md) — HA scoring semiring used for §8 gating.
- [`docs/doctrine/proactive-interior.md`](../docs/doctrine/proactive-interior.md) — consolidation cycle that consumes phase-3 receipts.
- [`spec/credential-v1.md`](./credential-v1.md) — sibling signature scheme (`eddsa-jcs-2022`); skills reuse the suite.
- [`spec/execution-ledger-v1.md`](./execution-ledger-v1.md) — receipt archive; skill receipts extend the schema in phase 3.
- [`spec/identity-v1.md`](./identity-v1.md) — `did:key` derivation for `metadata.author` and `motebit.signature.public_key`.
