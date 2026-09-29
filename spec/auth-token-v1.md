# motebit/auth-token@1.3

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

| Field    | Type   | Required | Description                                                                                                                                                                                                                 |
| -------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mid`    | string | yes      | The agent's `motebit_id`. Binds the token to a specific identity.                                                                                                                                                           |
| `did`    | string | yes      | The agent's `device_id`. Binds the token to the device that signed it.                                                                                                                                                      |
| `iat`    | number | yes      | Issued-at timestamp (epoch milliseconds). When the token was created.                                                                                                                                                       |
| `exp`    | number | yes      | Expiration timestamp (epoch milliseconds). Tokens with `exp <= now` MUST be rejected.                                                                                                                                       |
| `jti`    | string | yes      | JWT ID — a unique nonce (UUID v4 recommended). Prevents replay attacks. MUST be unique per token.                                                                                                                           |
| `aud`    | string | yes      | Audience claim — the endpoint or operation this token authorizes. Prevents cross-endpoint replay (§5).                                                                                                                      |
| `sub`    | string | no       | Subject claim (JWT `sub`) — the object the token is ABOUT when that is not the bearer (e.g. the relay task id on `task:dispatch`). Audience-specific; a verifier for an audience that defines it MUST require it.           |
| `digest` | string | no       | Hex SHA-256 of the subject's content when the token authorizes a specific payload (e.g. the admitted prompt on `task:dispatch`). Audience-specific; a verifier for an audience that defines it MUST require and compare it. |

The six core fields (`mid`, `did`, `iat`, `exp`, `jti`, `aud`) are required. A verifier MUST reject tokens missing any of them. `sub` and `digest` are optional, audience-specific claims (1.1): absent on every audience that does not define them, and REQUIRED by the verifier of an audience that does (§5, `task:dispatch`). Unknown additional claims MUST be ignored, not rejected — the signature covers them either way.

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

| Audience                | Endpoint / Operation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Description                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`                  | `GET /ws/sync/{id}`, `GET /sync/{id}/clock`, `GET /sync/{id}/pull`, `POST /sync/{id}/push`, `GET /sync/{id}/conversations`, `POST /sync/{id}/conversations`, `GET /sync/{id}/messages`, `POST /sync/{id}/messages`, `GET /sync/{id}/plans`, `POST /sync/{id}/plans`, `GET /sync/{id}/plan-steps`, `POST /sync/{id}/plan-steps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Multi-device data synchronization (WebSocket upgrade and HTTP sync); the path's motebit must be the token's                                                                                                                                                                                                                                    |
| `device:auth`           | `GET /api/v1/agents/{id}/roster`, `POST /api/v1/agents/{id}/roster`, `POST /pairing/initiate`, `GET /pairing/{pairingId}`, `POST /pairing/{pairingId}/approve`, `POST /pairing/{pairingId}/deny`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Per-device auth on relay calls: the device-pairing routes (initiating/approving device) and the machine roster (`spec/machine-roster-v1.md` §11). The roster routes also require the token to verify under a registered DEVICE row's key (never the agent-registry fallback) and name the path's motebit                                       |
| `pair`                  | _(reserved — no endpoint)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Reserved for the multi-device pairing flow. No relay route verifies it: the pairing routes take `device:auth` (row above), and a token minted for `pair` is refused there                                                                                                                                                                      |
| `rotate-key`            | `POST /api/v1/agents/{id}/rotate-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Key rotation endpoint                                                                                                                                                                                                                                                                                                                          |
| `push:register`         | `POST /api/v1/agents/push-token`, `DELETE /api/v1/agents/push-token`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Push-notification token registration and removal (no other method on that path)                                                                                                                                                                                                                                                                |
| `task:submit`           | `POST /agent/{id}/task`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Submit a task for delegation                                                                                                                                                                                                                                                                                                                   |
| `task:query`            | `GET /agent/{id}/task/{taskId}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Poll for task result                                                                                                                                                                                                                                                                                                                           |
| `task:result`           | `POST /agent/{id}/task/{taskId}/result`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Worker posts signed execution receipt                                                                                                                                                                                                                                                                                                          |
| `task:dispatch`         | `motebit_task` on a worker (agent-mcp-surface §5.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Relay-signed task ADMISSION artifact: `mid` = worker, `sub` = relay task id, `digest` = SHA-256(prompt); minted after submission clears the relay's settlement gates; verified by the worker, never accepted by the relay; never a transport bearer (1.3)                                                                                      |
| `admin:query`           | `POST /api/v1/agents/register`, `POST /api/v1/agents/heartbeat`, `DELETE /api/v1/agents/deregister`, `POST /api/v1/agents/accept-migration`, `GET /api/v1/agents/{id}`, `POST /api/v1/agents/{id}/approvals`, `GET /api/v1/agents/{id}/approvals/{approvalId}`, `POST /api/v1/agents/{id}/approvals/{approvalId}/vote`, `GET /api/v1/agents/{id}/bond`, `POST /api/v1/agents/{id}/bond`, `POST /api/v1/agents/{id}/command`, `GET /api/v1/agents/{id}/graph`, `GET /api/v1/agents/{id}/path-to/{targetId}`, `GET /api/v1/agents/{id}/routing-explanation`, `GET /api/v1/agents/{id}/trust-closure`, `POST /api/v1/agents/{id}/migrate`, `POST /api/v1/agents/{id}/migrate/cancel`, `POST /api/v1/agents/{id}/migrate/depart`, `GET /api/v1/agents/{id}/migration/attestation`, `GET /api/v1/agents/{id}/migration/export`, `POST /api/v1/agents/{id}/revoke`, `POST /api/v1/agents/{id}/revoke-credential`, `POST /api/v1/agents/{id}/revoke-tokens`, `PATCH /api/v1/agents/{id}/sweep-config`, `POST /api/v1/agents/{id}/revoke-listing`, `POST /api/v1/agents/{id}/restore-listing` | A service's self-signed registration family (the worker authenticates to its relay as itself — no operator secret), agent-registry reads, and per-agent operations not named in another row. Also the relay's default for any other `/api/v1/agents/*` path. `/api/v1/admin/*` is operator-only and takes the master bearer, not this audience |
| `proposal`              | `GET /api/v1/proposals`, `POST /api/v1/proposals`, `GET /api/v1/proposals/{proposalId}`, `POST /api/v1/proposals/{proposalId}/respond`, `POST /api/v1/proposals/{proposalId}/step-result`, `POST /api/v1/proposals/{proposalId}/withdraw`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Collaborative proposal lifecycle                                                                                                                                                                                                                                                                                                               |
| `receipts:read`         | `GET /api/v1/agents/{id}/receipts`, `GET /api/v1/agents/{id}/receipts/{taskId}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A motebit reading its own receipts, listed or by task                                                                                                                                                                                                                                                                                          |
| `market:listing`        | `GET /api/v1/agents/{id}/listing`, `POST /api/v1/agents/{id}/listing`, `GET /api/v1/agents/{id}/p2p-eligibility`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Service-listing reads and writes, and the p2p-eligibility pre-flight                                                                                                                                                                                                                                                                           |
| `market:query`          | `GET /api/v1/market/candidates`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Market candidate discovery (device-authable; `/market/revenue` is operator-only)                                                                                                                                                                                                                                                               |
| `credentials`           | `GET /api/v1/agents/{id}/credentials`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Read the agent's own credentials. Submission (`credentials/submit`) is self-authenticating and takes no token; `revoke-credential` is `admin:query`                                                                                                                                                                                            |
| `credentials:present`   | `POST /api/v1/agents/{id}/presentation`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Verifiable-presentation submission                                                                                                                                                                                                                                                                                                             |
| `account:balance`       | `GET /api/v1/agents/{id}/balance`, `GET /api/v1/agents/{id}/settlements`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Read virtual-account balance and the caller's own per-peer settlement summary                                                                                                                                                                                                                                                                  |
| `account:deposit`       | _(reserved — no endpoint)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Reserved for a future funded deposit-initiation endpoint (see note)                                                                                                                                                                                                                                                                            |
| `account:withdraw`      | `POST /api/v1/agents/{id}/withdraw`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Withdraw request                                                                                                                                                                                                                                                                                                                               |
| `account:withdrawals`   | `GET /api/v1/agents/{id}/withdrawals`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | List withdrawal history                                                                                                                                                                                                                                                                                                                        |
| `account:checkout`      | `POST /api/v1/agents/{id}/checkout`, `POST /api/v1/subscriptions/{id}/cancel`, `POST /api/v1/subscriptions/{id}/resubscribe`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Stripe checkout session create; subscription cancel / resubscribe (own identity only, #846)                                                                                                                                                                                                                                                    |
| `proxy:token`           | `POST /api/v1/agents/{id}/proxy-token`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Mint a cloud-inference billing token carrying the agent's balance; a least-privilege audience so a generic read token cannot be replayed to mint a spending credential                                                                                                                                                                         |
| `browser-sandbox-grant` | `POST /api/v1/browser-sandbox/token`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Motebit-signed sandbox grant request                                                                                                                                                                                                                                                                                                           |
| `browser-sandbox`       | Sandbox dispatcher (relay-signed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Relay-signed sandbox dispatcher token                                                                                                                                                                                                                                                                                                          |
| `runtime:attach`        | Local runtime-host socket only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Frontend-to-coordinator attach handshake (never accepted by a relay)                                                                                                                                                                                                                                                                           |
| `mcp:call`              | Any HTTP request to a motebit MCP server (§7.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Caller-signed MCP bearer: `sub` = the target server's `motebit_id` (REQUIRED), `jti` accepted once, minted fresh per request; verified by the MCP server, never accepted by a relay (1.2); the relay's own forward bearer, signed by the relay key (1.3)                                                                                       |

<!-- relay-public-routes:begin (generated from RELAY_PUBLIC_ROUTES) -->

Routes in the same families that take no token (public reads, and requests that authenticate themselves): `GET /api/v1/agents/discover`, `GET /api/v1/agents/revocations`, `POST /api/v1/agents/bootstrap`, `GET /api/v1/agents/{id}/succession`, `GET /api/v1/agents/{id}/solvency-proof`, `POST /api/v1/agents/{id}/credentials/submit`, `POST /api/v1/agents/{id}/devices/{deviceId}/hardware-attestation`, `GET /agent/{id}/capabilities`, `POST /pairing/claim`, `GET /pairing/{pairingId}/status`, `POST /pairing/{pairingId}/update-key`.

<!-- relay-public-routes:end -->

This table mirrors the closed `TokenAudience` registry in `@motebit/protocol` (`packages/protocol/src/audience.ts`, `ALL_TOKEN_AUDIENCES`); the registry is the canonical membership. The route → audience column has its own machine-readable form, `RELAY_ROUTE_AUDIENCES` in `@motebit/protocol` (`packages/protocol/src/relay-route-audience.ts`): every relay route that accepts a device-signed token, with the audience it verifies, resolved by `relayRouteAudience(method, path)`. The reference relay proves each entry against its own middleware in a conformance test, and `check-audience-route-parity` checks every client call site in the reference implementation against it. Where this prose and that table disagree, the table is what the relay does. Earlier revisions of this table listed `register-device`, which never existed in the registry — device registration uses `device:auth`. `account:deposit` remains a registered audience but currently maps to no endpoint: the self-declared `POST /api/v1/agents/{id}/deposit` route was removed as a treasury-drain vector (it credited spendable balance from a client-supplied amount), and the audience is held reserved for a future _funded_ deposit-initiation endpoint. Balance is credited only by verified server-side funding (onchain deposit-detector, Stripe webhook).

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

The token MUST have `aud` = `mcp:call` and `sub` = the target server's `motebit_id`, and the caller MUST mint a fresh token (fresh `jti`) for every HTTP request, including each request of one MCP session. The receiving MCP server MUST accept the token only if all of the following hold, and MUST answer 401 otherwise:

1. `aud` is `mcp:call`. A token minted for any other audience (`task:submit`, `sync`, a relay route) is refused.
2. `sub` equals the server's own `motebit_id`. A token minted for server A is refused at server B.
3. The signature verifies under the caller's key (resolved from `mid`) and the token has not expired (§4.2). The token's window is short: the server refuses a token whose `exp` is more than 120 seconds past its own clock (`MCP_CALL_MAX_TOKEN_WINDOW_MS`), or whose `iat` is more than 60 seconds in its future (`MCP_CALL_CLOCK_SKEW_MS` ). The reference clients mint with a 60-second lifetime (`REFERENCE_MCP_CALL_TOKEN_TTL_MS`, a reference default, not law), which leaves a minute of clock skew either way.
4. `jti` is at most 128 characters (`MCP_CALL_MAX_JTI_LENGTH`) and has not been accepted before within the token's lifetime. The server keeps a replay record until `exp`, keyed by a fixed-size digest of (`mid`, `jti`), so its memory per token does not grow with the claims. The record is bounded overall and per caller (the reference server: 100,000 live tokens, 1,000 per caller), so one identity cannot starve others. A record that cannot take a new entry refuses the token, never forgetting a live one, with a reason that says which bound was hit: `token already used`, `too many live tokens for this caller`, or `replay store at capacity — retry shortly`. Only a token that passed every other check takes a slot.

The server then resolves the caller's identity from `mid` and `did`, which enables identity-aware tool policy (e.g., restricting tool access based on the caller's trust level). An accepted `mcp:call` token proves "this caller meant this server, once"; it never makes the caller the server's owner (agent-mcp-surface §3.5).

A 401 SHOULD carry a machine-readable reason (the reference server returns `{ "error": "invalid motebit token", "reason": "..." }`) so a client minting the pre-1.2 shape fails loudly.

A client obtains the target's `motebit_id` from something it already trusts (a relay listing, a pinned configuration). On first contact without one, the reference client reads it from the server's unauthenticated `GET /health` (trust on first use) and pins it after `motebit_identity` confirms it. What first contact exposes: a server that answers `/health` with another server's id (a victim's) receives a fresh token bound to that victim for **every** HTTP request the client makes to it — at least one per request of the connect sequence (`initialize`, `notifications/initialized`, `tools/list`, the `motebit_identity` call), and one more for each request after that while the session lasts. `motebit_identity` does not detect a server that lies consistently: it proves no possession of the victim's key. Each such token is valid at the victim, once, until it expires (at most `MCP_CALL_MAX_TOKEN_WINDOW_MS`), and authenticates the attacker there as the client. Binding the target to an id the client already trusts closes this: a pinned `motebitId`, or the `motebit_id` a relay listing named. With either, a lying server receives only tokens bound to the id the client expected, which the victim refuses.

The relay's own bearer on a forwarded task is an `mcp:call` token too (1.3): `mid` = the relay's `motebit_id`, `sub` = the worker's `motebit_id`, minted fresh for every HTTP request of the forward, signed by the relay key. The worker applies rules 1–4 above, except that in rule 3 the signature is verified under the worker's PINNED relay public key rather than a key resolved from `mid`; a token that verifies there authenticates the caller as the relay. A `task:dispatch` token (§5) MUST NOT be accepted as a transport bearer by any server, whoever presents it: it is an admission record the relay also hands to a submitter that presents the task itself, so possession of it proves only that someone was given it — never that the caller is the relay (#981). A server SHOULD refuse it with a reason rather than fall through to the caller path. The dispatch token travels only as the `motebit_task` `dispatch_token` argument (agent-mcp-surface §5.1).

---

## 8. Security Considerations

### 8.1 — Replay Prevention

Three layers prevent replay:

1. **Expiry (`exp`):** Tokens expire after 5 minutes (default). The window is bounded.
2. **Nonce (`jti`):** Each token has a unique identifier. Relays MAY maintain a short-lived JTI blacklist to reject exact replays within the expiry window. An MCP server MUST (§7.3): an `mcp:call` token is accepted once.
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

## Change Log

- **1.3 (2026-09-29)** — Breaking for relays and MCP servers that trust a relay (#981): the relay authenticates to a worker with a relay-signed `mcp:call` token bound to that worker, fresh per request (§7.3), and a `task:dispatch` token is never a transport bearer. Before 1.3 a worker accepted the dispatch token as the relay's bearer, and a submitter holding one (`presenter: "submitter"`, or any task the relay did not route) was served as the relay. A 1.3 worker refuses a pre-1.3 relay's forward (401 with a reason); a 1.3 relay's forward is refused by a pre-1.3 worker (its bearer is not a dispatch token, and the relay's `mid` is not a caller key the worker can resolve). Deploy relay and workers together.
- **1.2 (2026-09-29)** — Breaking for MCP servers and clients (#957): the `mcp:call` audience (§5) and the MCP bearer rules (§7.3). An MCP server accepts a caller token only when `aud` is `mcp:call`, `sub` is its own `motebit_id`, the signature and expiry hold, and its `jti` has not been accepted before; clients mint one such token per HTTP request. Before 1.2 an MCP server accepted a signed token of ANY audience, bound to no server, as often as it was presented, so a token a motebit signed for the relay or for one server authenticated it at every motebit MCP server until it expired. There is no compatibility window: a pre-1.2 client (minting `task:submit`, one token per session) is refused with a 401 whose `reason` names the fix. A 1.2 client still authenticates to a pre-1.2 server, which checks no audience. Relay routes are unchanged.
- **1.1 (2026-09-12)** — Additive: optional, audience-specific `sub` and `digest` claims (§3); `task:dispatch` row in the audience table (§5) — the relay-signed task admission artifact (`docs/doctrine/task-admission.md`). Wire-compatible: existing audiences carry neither claim; verifiers that do not know a claim ignore it.
- **1.0** — Initial.
