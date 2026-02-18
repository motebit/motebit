# motebit/identity@1.0

## Agent Identity File Specification

**Status:** Draft
**Version:** 1.0
**Date:** 2026-02-18

---

## 1. Overview

A `motebit.md` is a human-readable, cryptographically signed agent identity file. It declares who an agent is, what it is allowed to do, and how it governs itself. Any tool, platform, or service can verify the file's authenticity without trusting the agent, the user, or any intermediary.

The file is valid Markdown. It can be opened in any text editor, rendered by any Markdown viewer, and committed to any repository. The identity is not a session. It is a persistent, portable, verifiable document that travels with the agent across devices, platforms, and providers.

**Design principles:**

- **Human-readable.** The identity is YAML frontmatter. A person can read it.
- **Machine-verifiable.** The Ed25519 signature covers the exact frontmatter bytes. A program can verify it.
- **Self-contained.** The public key and signature are both in the file. Verification requires no external service.
- **Git-friendly.** The file diffs cleanly. Changes to governance, privacy, or devices produce readable diffs. The signature changes with every edit, providing tamper evidence in version control.

---

## 2. File Structure

A `motebit.md` file consists of two parts:

1. **YAML frontmatter** between `---` delimiters
2. **Signature comment** in the format `<!-- motebit:sig:{algorithm}:{signature} -->`

```
---
{YAML frontmatter}
---
<!-- motebit:sig:Ed25519:{base64url_signature} -->
```

The frontmatter contains the identity specification. The signature covers the frontmatter content — the bytes between the opening `---\n` and the closing `\n---`, exclusive of the delimiters themselves.

Additional Markdown content MAY appear after the signature comment. It is not covered by the signature and has no effect on verification. This allows agents or users to add human-readable notes, documentation, or context below the signed identity.

---

## 3. Frontmatter Fields

### 3.1 — Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec` | string | yes | Specification version. MUST be `"motebit/identity@1.0"` for this version. |
| `motebit_id` | string | yes | Unique agent identifier. SHOULD be a UUID v7 (time-ordered). |
| `created_at` | string | yes | ISO 8601 timestamp of identity creation. |
| `owner_id` | string | yes | Identifier of the entity that owns this agent. Opaque string — format is application-defined. |

### 3.2 — `identity`

Cryptographic identity. The public half of the keypair that signs this file.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `algorithm` | string | yes | Signing algorithm. MUST be `"Ed25519"` for this version. |
| `public_key` | string | yes | Hex-encoded Ed25519 public key (64 hex characters = 32 bytes). |

### 3.3 — `governance`

Declares the agent's operational boundaries — what it may do autonomously, what requires approval, and what is forbidden.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `trust_mode` | string | yes | One of: `"minimal"`, `"guarded"`, `"full"`. Determines baseline permeability of the agent's boundary. |
| `max_risk_auto` | string | yes | Maximum risk level the agent may execute without approval. One of the risk levels defined in §3.3.1. |
| `require_approval_above` | string | yes | Tool calls above this risk level require explicit user approval. |
| `deny_above` | string | yes | Tool calls above this risk level are unconditionally denied. |
| `operator_mode` | boolean | yes | Whether elevated-privilege mode is enabled (typically PIN-gated). |

#### 3.3.1 — Risk Levels

Risk levels form an ordered enumeration from lowest to highest:

| Level | Name | Description |
|-------|------|-------------|
| 0 | `R0_READ` | Read-only operations. No side effects. |
| 1 | `R1_DRAFT` | Content generation, drafts, suggestions. Reversible. |
| 2 | `R2_WRITE` | Write operations. File creation, data modification. |
| 3 | `R3_EXECUTE` | Code execution, system commands, external API calls. |
| 4 | `R4_MONEY` | Financial transactions, purchases, irreversible commitments. |

The governance thresholds MUST satisfy: `max_risk_auto <= require_approval_above <= deny_above`. A verifier SHOULD warn if this constraint is violated.

#### 3.3.2 — Trust Modes

| Mode | Semantics |
|------|-----------|
| `minimal` | Maximum restriction. Agent operates with lowest autonomy. Suitable for untrusted or new agents. |
| `guarded` | Default. Agent has moderate autonomy within declared risk bounds. |
| `full` | Agent has maximum autonomy within declared risk bounds. Implies established trust relationship. |

### 3.4 — `privacy`

Declares how the agent handles information sensitivity and retention.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `default_sensitivity` | string | yes | Default sensitivity classification for unclassified information. One of the sensitivity levels defined in §3.4.1. |
| `retention_days` | object | yes | Map of sensitivity level to maximum retention in days. Keys are sensitivity level names, values are positive integers. |
| `fail_closed` | boolean | yes | If `true`, the agent denies access when sensitivity cannot be determined. If `false`, the agent permits access at `default_sensitivity`. SHOULD be `true`. |

#### 3.4.1 — Sensitivity Levels

| Level | Name | Description |
|-------|------|-------------|
| 0 | `none` | Non-sensitive information. |
| 1 | `personal` | Personally identifiable information. |
| 2 | `medical` | Health and medical data. |
| 3 | `financial` | Financial data, account information. |
| 4 | `secret` | Secrets, credentials, cryptographic material. |

### 3.5 — `memory`

Declares the agent's memory behavior.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `half_life_days` | number | yes | Memory decay half-life in days. Memories not reinforced within this period lose half their confidence. Positive number. |
| `confidence_threshold` | number | yes | Minimum confidence for a memory to be retained. Range: 0.0 to 1.0. |
| `per_turn_limit` | number | yes | Maximum number of new memories the agent may create per interaction turn. Positive integer. |

### 3.6 — `devices`

Array of registered devices. MAY be empty. Each device entry:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `device_id` | string | yes | Unique device identifier. |
| `name` | string | yes | Human-readable device name. |
| `public_key` | string | yes | Hex-encoded Ed25519 public key for this device. |
| `registered_at` | string | yes | ISO 8601 timestamp of device registration. |

---

## 4. Signature

### 4.1 — Signing Algorithm

The signature is computed as follows:

1. Serialize the identity data as YAML.
2. Let `frontmatter_bytes` be the UTF-8 encoding of the YAML text (the content between `---\n` and `\n---`, not including the delimiters).
3. Compute `signature = Ed25519_Sign(frontmatter_bytes, private_key)` where `private_key` is the 64-byte Ed25519 private key (also called "secret key" or "seed + public key" depending on library) corresponding to the `identity.public_key` in the frontmatter.
4. Encode the 64-byte signature as base64url (RFC 4648 §5, no padding).
5. Emit the signature as an HTML comment: `<!-- motebit:sig:Ed25519:{base64url_signature} -->`.

### 4.2 — Signature Placement

The signature comment MUST appear on the line immediately following the closing `---` delimiter. There MUST be exactly one signature comment per file.

```
---
{YAML}
---
<!-- motebit:sig:Ed25519:abc123... -->
```

### 4.3 — Verification Algorithm

To verify a `motebit.md` file:

```
function verify(content: string) -> { valid: bool, identity: object | null }

  1. Find the first occurrence of "---\n" in content.
     If not found, return { valid: false, identity: null }.

  2. Let body_start = position after "---\n".
     Find the first occurrence of "\n---" at or after body_start.
     If not found, return { valid: false, identity: null }.

  3. Let raw_frontmatter = content[body_start .. position_of("\n---")].
     Parse raw_frontmatter as YAML into an object `identity`.

  4. Find the substring "<!-- motebit:sig:Ed25519:" in content.
     If not found, return { valid: false, identity: null }.

  5. Extract the base64url string between the prefix and the next " -->".
     Decode it to a 64-byte signature.
     If decoding fails or length != 64, return { valid: false, identity: null }.

  6. Extract identity.identity.public_key.
     Decode the hex string to a 32-byte public key.
     If decoding fails or length != 32, return { valid: false, identity: null }.

  7. Let frontmatter_bytes = UTF8_Encode(raw_frontmatter).

  8. Let valid = Ed25519_Verify(signature, frontmatter_bytes, public_key).

  9. Return { valid, identity: valid ? identity : null }.
```

### 4.4 — Tamper Detection

The signature covers the exact bytes of the frontmatter. Any modification — changing a field value, adding a field, removing whitespace, reordering keys — invalidates the signature. This provides:

- **Integrity:** the frontmatter has not been modified since signing.
- **Authenticity:** the file was signed by the holder of the private key corresponding to the embedded public key.
- **Non-repudiation:** the signer cannot deny having produced the signature (assuming the private key was not compromised).

The signature does NOT provide:

- **Trust in the signer.** Verification confirms the file is self-consistent (signed by the key it declares). It does not confirm that the signer is trustworthy. Trust establishment is application-defined.
- **Freshness.** The signature does not include a timestamp or nonce. A valid signature remains valid indefinitely. Applications requiring freshness SHOULD check `created_at` or implement their own expiry logic.

---

## 5. Example

A complete, valid `motebit.md` file:

```markdown
---
spec: "motebit/identity@1.0"
motebit_id: "019474a3-7e8b-7f1c-9d2e-4b8a1c3d5e6f"
created_at: "2026-02-18T00:00:00.000Z"
owner_id: "user_01HQXK9V3M"
identity:
  algorithm: "Ed25519"
  public_key: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
governance:
  trust_mode: "guarded"
  max_risk_auto: "R1_DRAFT"
  require_approval_above: "R1_DRAFT"
  deny_above: "R4_MONEY"
  operator_mode: false
privacy:
  default_sensitivity: "personal"
  retention_days:
    none: 365
    personal: 90
    medical: 30
    financial: 30
    secret: 7
  fail_closed: true
memory:
  half_life_days: 7
  confidence_threshold: 0.3
  per_turn_limit: 5
devices:
  - device_id: "dev-macbook-01"
    name: "MacBook Pro"
    public_key: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
    registered_at: "2026-02-18T00:00:00.000Z"
---
<!-- motebit:sig:Ed25519:dGhpcyBpcyBhIHBsYWNlaG9sZGVyIHNpZ25hdHVyZQ -->
```

Note: The signature above is illustrative. A real file would contain a valid Ed25519 signature that passes verification against the declared public key.

---

## 6. File Conventions

| Convention | Value |
|------------|-------|
| **Filename** | `motebit.md` |
| **Placement** | Project root, or `~/.motebit/identity.md` for user-global identity |
| **Encoding** | UTF-8, no BOM |
| **Line endings** | LF (`\n`). Verifiers MUST normalize CRLF to LF before signature verification. |
| **MIME type** | `text/markdown` |

### 6.1 — Discovery

Tools and services SHOULD discover agent identity by searching for `motebit.md` in the following order:

1. The current working directory
2. Parent directories (walking up to filesystem root)
3. `~/.motebit/identity.md` (user-global fallback)

This mirrors the discovery pattern of `.env`, `.gitignore`, and `package.json`.

### 6.2 — `.gitignore` Considerations

A `motebit.md` file does NOT contain secrets. The private key is never included in the file — only the public key. The file is safe to commit to version control. In fact, committing it is recommended: it provides a verifiable audit trail of governance changes over time.

---

## 7. Updates

When a field in the identity changes (e.g., a new device is registered, governance settings are adjusted), the file MUST be re-signed:

1. Parse the existing file.
2. Apply the updates to the parsed identity.
3. Preserve the `spec` and `identity` fields (the keypair does not change).
4. Re-serialize the updated identity as YAML.
5. Re-sign the new frontmatter bytes with the same private key.
6. Emit the updated file with the new signature.

The previous signature becomes invalid. If the file is tracked in version control, the diff shows exactly what changed and the new signature confirms the change was authorized by the key holder.

---

## 8. Security Considerations

### 8.1 — Private Key Storage

The private key MUST NOT appear in the `motebit.md` file. It SHOULD be stored in the operating system's secure keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) or equivalent hardware-backed storage. Applications MUST NOT store private keys in plaintext configuration files.

### 8.2 — Key Rotation

This version of the specification does not define a key rotation mechanism. If a private key is compromised, a new keypair MUST be generated and a new `motebit.md` file created with a new `motebit_id`. The old identity is abandoned, not revoked — there is no centralized revocation authority by design.

Future versions MAY introduce key rotation via a signed succession record.

### 8.3 — Signature Scope

The signature covers only the YAML frontmatter. Content after the signature comment is unsigned and MUST NOT be trusted for identity or governance decisions. Verifiers SHOULD ignore post-signature content when making authorization decisions.

### 8.4 — YAML Parsing

Implementations SHOULD use a restricted YAML parser that handles only the data types present in this specification: strings, numbers, booleans, arrays, and nested objects. Full YAML parsing (anchors, aliases, tags, multi-document streams) is NOT required and MAY introduce security risks.

### 8.5 — Threat Model

| Threat | Mitigation | Residual Risk |
|--------|-----------|---------------|
| **Frontmatter tampering** | Ed25519 signature covers exact YAML bytes; any modification invalidates | None — cryptographic guarantee |
| **Private key theft** | Key stored in OS keychain or encrypted at rest; never in the identity file | Physical/OS-level compromise |
| **Identity impersonation** | Public key is self-certifying; verification requires matching keypair | No PKI — trust is application-defined |
| **Key compromise** | Generate new keypair + new `motebit_id`; old identity is abandoned | No revocation broadcast mechanism |
| **Replay of old identity file** | `created_at` timestamp allows freshness checks; applications define policy | Verifier must enforce freshness |
| **YAML injection** | Restricted parser; no anchors/aliases/tags; only spec-defined types | Full YAML parsers may be vulnerable |
| **Signature stripping** | Verifiers MUST reject files without a valid signature comment | Applications that skip verification |
| **Post-signature content injection** | Signature scope is frontmatter only; post-signature content is untrusted | Applications must not trust unsigned content |

**Trust boundary:** A valid `motebit.md` proves the holder has the private key. It does NOT prove the holder is trustworthy, authorized, or human. Trust is accumulated at the application layer through history, reputation, and governance — not by the identity file alone.

---

## 9. Interoperability

### 9.1 — MCP Integration

When an agent presents a `motebit.md` to an MCP (Model Context Protocol) server, the server can verify the identity and use the `governance` section to determine which tools to expose:

- Tools at or below `max_risk_auto` may be exposed without additional gating.
- Tools above `require_approval_above` should be gated behind user confirmation.
- Tools above `deny_above` should not be exposed.

The `trust_mode` provides additional signal for servers that implement graduated access.

### 9.2 — Multi-Agent Verification

When two agents interact, each can verify the other's `motebit.md`. Mutual verification establishes that both agents have valid, self-consistent identities — but does not establish trust. Trust accumulation is application-defined and outside the scope of this specification.

### 9.3 — Service Authentication

A service may require agents to prove ownership of their declared identity by signing a challenge with the private key corresponding to `identity.public_key`. The challenge-response protocol is outside the scope of this specification, but the cryptographic primitive (Ed25519 sign/verify) is the same.

---

## 10. Versioning

The `spec` field declares which version of this specification the file conforms to. Implementations SHOULD reject files with unrecognized spec versions rather than attempting best-effort parsing.

Future versions will use semantic versioning: `motebit/identity@{major}.{minor}`. Minor versions add optional fields and are backward-compatible. Major versions may change required fields or signature mechanics and are not backward-compatible.

---

*motebit/identity@1.0 — Draft Specification, 2026.*
