# motebit/auth-token@1.0

**Status:** Stable
**Authors:** Daniel Hakim
**Date:** April 2026

---

## 1. Overview

A signed bearer token authenticates an agent to a relay or service endpoint. The token binds the agent's identity (`motebit_id`), device (`device_id`), and a specific endpoint audience (`aud`) into a short-lived, replay-resistant, self-verifiable credential.

This specification defines the token format, signing procedure, verification procedure, and canonical audience values. The format is transport-agnostic — tokens can be carried in HTTP headers, WebSocket frames, or any other transport that supports string payloads.

---

## 2. Token Structure

A signed token is a string of the form:

```
{base64url(payload)}.{base64url(signature)}
```

where:

- `payload` is a JSON object (§3) encoded as UTF-8 bytes, then base64url-encoded (RFC 4648 §5, no padding).
- `signature` is the Ed25519 signature over the raw UTF-8 payload bytes (not the base64url encoding), base64url-encoded.

The token is split on the first `.` character. The payload precedes the dot; the signature follows it.

---

## 3. Payload Fields

#### Wire format (foundation law)

Every implementation MUST emit this exact JSON object shape inside the signed token. Field names are short (three letters, JWT-style) and cannot be renamed; every verifier on the network reads the same keys.

```json
{
  "mid": "019530a1-...",
  "did": "019530a1-...",
  "iat": 1712959200000,
  "exp": 1712962800000,
  "jti": "c4b28f10-4ac6-4e7e-8bbf-19f3d6a49b0b",
  "aud": "task:submit"
}
```

| Field | Type   | Required | Description                                                                                            |
| ----- | ------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `mid` | string | yes      | The agent's `motebit_id`. Binds the token to a specific identity.                                      |
| `did` | string | yes      | The agent's `device_id`. Binds the token to the device that signed it.                                 |
| `iat` | number | yes      | Issued-at timestamp (epoch milliseconds). When the token was created.                                  |
| `exp` | number | yes      | Expiration timestamp (epoch milliseconds). Tokens with `exp <= now` MUST be rejected.                  |
| `jti` | string | yes      | JWT ID — a unique nonce (UUID v4 recommended). Prevents replay attacks. MUST be unique per token.      |
| `aud` | string | yes      | Audience claim — the endpoint or operation this token authorizes. Prevents cross-endpoint replay (§5). |

All fields are required. A verifier MUST reject tokens missing any field.

The canonical TypeScript binding is `SignedTokenPayload` in `@motebit/crypto`. This type is defined alongside its signing/verifying primitives because the payload is never useful without the signing algorithm. The wire shape above is the protocol law; the `@motebit/crypto` type is its reference implementation.

#### Storage (reference convention — non-binding)

The reference relay does not persist signed tokens — they are short-lived, opaque bearer strings. The relay MAY maintain a `jti` deny-list (RAM or SQLite) for revoked or consumed tokens; the data structure is implementation-local and not part of the wire format. Clients persist tokens in the OS keyring for session continuity; that too is local.

---

## 4. Signing and Verification

### 4.1 — Token Creation

```
ALGORITHM: CreateSignedToken(payload, privateKey)

INPUT:  payload:    SignedTokenPayload (§3)
        privateKey: Ed25519 private key (32-byte seed or 64-byte expanded)

OUTPUT: token string "{base64url_payload}.{base64url_signature}"

Step 1: Serialize payload to JSON string: JSON.stringify(payload)
Step 2: Encode as UTF-8 bytes
Step 3: base64url-encode the UTF-8 bytes → payloadB64
Step 4: Ed25519.sign(utf8_bytes, privateKey) → signature (64 bytes)
Step 5: base64url-encode the signature → sigB64
Step 6: Return "{payloadB64}.{sigB64}"
```

**Note:** The signature covers the raw UTF-8 bytes of the JSON payload, not the base64url encoding. This is deliberate — the verifier decodes base64url first, then verifies against the decoded bytes.

### 4.2 — Token Verification

```
ALGORITHM: VerifySignedToken(token, publicKey)

INPUT:  token:     string "{base64url_payload}.{base64url_signature}"
        publicKey: Ed25519 public key (32 bytes)

OUTPUT: SignedTokenPayload if valid, null otherwise

Step 1:  Split token on first "." → payloadB64, sigB64
Step 2:  base64url-decode payloadB64 → payloadBytes
Step 3:  base64url-decode sigB64 → signature (64 bytes)
Step 4:  Ed25519.verify(signature, payloadBytes, publicKey) → boolean
         If false → return null
Step 5:  JSON.parse(payloadBytes as UTF-8) → payload
Step 6:  If payload.exp <= Date.now() → return null (expired)
Step 7:  If payload.jti is empty or absent → return null (no replay protection)
Step 8:  If payload.aud is empty or absent → return null (no audience binding)
Step 9:  Return payload
```

### 4.3 — Device-Scoped Verification

In relay deployments, the verifier resolves the public key from the device registry:

```
ALGORITHM: VerifySignedTokenForDevice(token, motebitId, deviceRegistry, expectedAudience)

Step 1:  Parse the payload WITHOUT verifying the signature (extract mid, did)
Step 2:  If payload.mid !== motebitId → reject
Step 3:  Look up device by payload.did in deviceRegistry → device record
Step 4:  If no device found or no public_key → reject
Step 5:  VerifySignedToken(token, device.public_key)
Step 6:  If payload.aud !== expectedAudience → reject (cross-endpoint replay)
Step 7:  Accept
```

Optional additional checks:

- **JTI blacklist:** If the relay maintains a token blacklist (e.g., after key rotation), check `jti` against the blacklist before accepting.
- **Agent revocation:** If the relay maintains an identity revocation list, check `motebitId` before accepting.

---

## 5. Audience Values

The `aud` field MUST contain exactly one of the canonical audience values. Tokens are valid only at the endpoint matching their audience. This prevents an attacker who intercepts a sync token from replaying it to submit tasks.

| Audience          | Endpoint / Operation                           | Description                            |
| ----------------- | ---------------------------------------------- | -------------------------------------- |
| `sync`            | WebSocket sync connection, HTTP sync endpoints | Multi-device data synchronization      |
| `task:submit`     | `POST /agent/{id}/task`                        | Submit a task for delegation           |
| `task:query`      | `GET /agent/{id}/task/{taskId}`                | Poll for task result                   |
| `admin:query`     | `GET /api/v1/admin/*`                          | Operator console queries               |
| `rotate-key`      | `POST /api/v1/agents/{id}/rotate-key`          | Key rotation endpoint                  |
| `pair`            | `POST /api/v1/pair/*`                          | Multi-device pairing flow              |
| `register-device` | `POST /api/v1/agents/{id}/register`            | Device registration                    |
| `market:query`    | `GET /api/v1/market/*`                         | Market discovery and candidate queries |

Implementations MAY define additional audience values for custom endpoints. Custom values SHOULD use a namespaced format (e.g., `custom:my-endpoint`) to avoid collision with canonical values.

---

## 6. Token Lifetime

The recommended default lifetime is **5 minutes** (`exp = iat + 300_000`).

- Short lifetimes limit the replay window if a token is intercepted.
- Long-running connections (WebSocket sync) SHOULD mint fresh tokens periodically, not extend `exp`.
- Tokens MUST NOT be reused across requests — each request SHOULD carry a freshly minted token with a unique `jti`.

---

## 7. Transport

### 7.1 — HTTP Bearer

Tokens are carried in the `Authorization` header with the `Bearer motebit:` prefix:

```
Authorization: Bearer motebit:{token}
```

The `motebit:` prefix distinguishes agent-signed tokens from other bearer token formats (e.g., relay master tokens, OAuth tokens). The relay strips the prefix before verification.

### 7.2 — WebSocket Post-Connect

For WebSocket connections, the token is sent as a post-connect frame:

```json
{ "type": "auth", "token": "{token}" }
```

The relay validates the token and responds:

```json
{ "type": "auth_result", "ok": true }
```

or

```json
{ "type": "auth_result", "ok": false }
```

Fail-closed: rejection or 5-second timeout disconnects the WebSocket.

### 7.3 — MCP Bearer

When calling a remote agent's MCP endpoint, the token is carried as:

```
Authorization: Bearer motebit:{token}
```

The receiving MCP server extracts the `motebit:` prefix, verifies the Ed25519 signature, and resolves the caller's identity from `mid` and `did`. This enables identity-aware tool policy (e.g., restricting tool access based on the caller's trust level).

---

## 8. Security Considerations

### 8.1 — Replay Prevention

Three layers prevent replay:

1. **Expiry (`exp`):** Tokens expire after 5 minutes (default). The window is bounded.
2. **Nonce (`jti`):** Each token has a unique identifier. Relays MAY maintain a short-lived JTI blacklist to reject exact replays within the expiry window.
3. **Audience (`aud`):** A token for `sync` cannot be replayed against `task:submit`. Each endpoint validates its own audience.

### 8.2 — Cross-Endpoint Replay

Without audience binding, an attacker intercepting a read-only `admin:query` token could replay it to `task:submit` (a write operation). The `aud` field eliminates this class of attack.

### 8.3 — Clock Skew

Implementations SHOULD allow a small clock skew tolerance (recommended: 60 seconds) when checking `exp`. This accommodates clock drift between agents and relays in distributed deployments.

### 8.4 — Token Scope

Signed tokens authenticate the agent — they do not authorize specific operations. Authorization is handled by the relay's policy layer (trust level checks, delegation scope, budget validation). The token proves "I am agent X from device Y"; the relay decides what agent X is allowed to do.

---

## 9. Reference Implementation

- Token creation: `@motebit/crypto` — `createSignedToken(payload, privateKey)`
- Token verification: `@motebit/crypto` — `verifySignedToken(token, publicKey)`
- Device-scoped verification: `services/relay/src/auth.ts` — `verifySignedTokenForDevice()`
- Type definition: `@motebit/crypto` — `SignedTokenPayload` interface

---

## 10. Conformance

An implementation conforms to this specification if:

1. Tokens contain all six required fields (§3).
2. Signatures cover the raw UTF-8 bytes of the JSON payload (§4.1 Step 4).
3. Verification rejects tokens with missing `jti` or `aud` (§4.2 Steps 7-8).
4. Audience binding is enforced at each endpoint (§5).
5. The `motebit:` prefix is used in HTTP `Authorization` headers (§7.1).

A conforming relay MUST reject tokens that fail any of these checks. Fail-closed.
