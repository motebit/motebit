# motebit/device-self-registration@1.0

**Status:** Stable
**Authors:** Daniel Hakim
**Date:** 2026-04-15

---

## 1. Overview

A self-attesting registration request lets a fresh device introduce itself to a relay without an out-of-band trust anchor (no shared API token, no operator action, no email confirmation). The device proves it controls a private key by signing a canonical request over its own public key; the relay verifies the signature against the public key carried in the same request and records the binding.

This closes the bootstrap gap in the existing identity surface: `POST /identity` always _generates_ a fresh `motebit_id`, and `POST /device/register` requires the master API token. Neither path lets a client-generated identity (web, mobile, third-party SDK) establish itself with a relay it has never met before.

The pattern is the same one motebit uses everywhere a claim crosses a trust boundary: the cryptographic artifact and the verification recipe are the same shape, the relay is a routing convenience rather than a trust root, and the protocol is designed so an operator running a third-party relay implements identical semantics from this spec alone.

---

## 2. Trust Posture

A self-registered device starts at trust zero. The protocol does not promote a self-attested binding above any other unaccredited identity; trust accrues through signed receipts the device produces or receives over time (`spec/execution-ledger-v1.md`), through credentials issued to it (`spec/credential-v1.md`), and optionally through onchain anchoring (`spec/credential-anchor-v1.md`). Self-registration is the _bootstrap_, not the _trust_.

This is the operational test from `docs/doctrine/protocol-model.md`: registration is cheap because trust is earned, not assigned.

---

## 3. Request Body

#### Wire format (foundation law)

Every conformant relay MUST accept the following JSON shape on the registration endpoint (§5). Every conformant client MUST emit this exact shape. Field names and nested shapes are binding.

```json
{
  "motebit_id": "019d903f-13de-75a4-8341-58319e0a2f16",
  "device_id": "01a04bb5-9c87-7d2c-bc6c-2f4cd3ce11d8",
  "public_key": "a6b17f4cdba075de43979d608b063f89f9f470a1b69b7892cf0ad5ae8575820b",
  "device_name": "web-laptop",
  "owner_id": "self:019d903f-13de-75a4-8341-58319e0a2f16",
  "timestamp": 1776239454545,
  "suite": "motebit-jcs-ed25519-b64-v1",
  "signature": "Tu8R8m1z..."
}
```

| Field         | Type   | Required | Description                                                                                                                                                                                                                                                                            |
| ------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `motebit_id`  | string | yes      | Self-asserted identifier the device is claiming. UUIDv7 in this spec; any opaque string is accepted by the wire format.                                                                                                                                                                |
| `device_id`   | string | yes      | Self-asserted device identifier. Bound to `public_key` for the lifetime of the device.                                                                                                                                                                                                 |
| `public_key`  | string | yes      | 64-character lowercase hex Ed25519 public key (32 bytes). The relay verifies §3's signature against this key — no prior registration required.                                                                                                                                         |
| `device_name` | string | no       | Human-readable label for operator panels and audit logs.                                                                                                                                                                                                                               |
| `owner_id`    | string | no       | Optional owner reference. Sovereign devices that own themselves SHOULD set `"self:<motebit_id>"`. Multi-tenant SDKs MAY set their tenant identifier.                                                                                                                                   |
| `timestamp`   | number | yes      | Epoch milliseconds at request creation. The relay rejects requests where `abs(now - timestamp) > 5 minutes` (§6.1) — this window is the only replay defense the wire format provides.                                                                                                  |
| `suite`       | string | yes      | Cryptosuite identifier (`SuiteId` from `@motebit/protocol`). For this artifact today: `"motebit-jcs-ed25519-b64-v1"` — JCS canonicalization, Ed25519 primitive, base64url signature encoding. Adding a suite is additive (`spec/auth-token-v1.md` §10 cryptosuite agility convention). |
| `signature`   | string | yes      | base64url-encoded Ed25519 signature over the canonical-JSON serialization of the body with `signature` removed (§4).                                                                                                                                                                   |

The TypeScript binding is `DeviceRegistrationRequest` in `@motebit/protocol`.

#### Storage (reference convention — non-binding)

A successful registration produces two reference-implementation rows:

- An `identities` row keyed by `motebit_id` if none exists (created by the relay).
- A `devices` row keyed by `device_id` carrying the `public_key`, `motebit_id`, `device_name`, `registered_at`, and a relay-generated `device_token` for auxiliary auth flows.

Alternative implementations MAY use any storage; the constraint is only that subsequent §3 lookups by `motebit_id` + `device_id` return the same `public_key` until a key-rotation request explicitly changes it (`spec/auth-token-v1.md` §9).

---

## 4. Signing and Verification

### 4.1 — Request Signing (client)

```
ALGORITHM: SignDeviceRegistrationRequest(body, privateKey)

INPUT:  body:        DeviceRegistrationRequest (§3) with `signature` unset
        privateKey:  Ed25519 private key (32-byte seed)

OUTPUT: DeviceRegistrationRequest with `signature` populated

Step 1: Let `bodyForSig` be `body` with the `signature` key removed (or set to undefined).
Step 2: Compute canonical JSON of `bodyForSig` per RFC 8785 (JSON Canonicalization Scheme).
Step 3: Sign the UTF-8 bytes of the canonical JSON using `Ed25519_Sign(bytes, privateKey)`.
Step 4: base64url-encode the 64-byte signature.
Step 5: Return `body` with `signature` set to the encoded value.
```

The signing routine is the generic suite-dispatched primitive in `@motebit/crypto` (`signWithSuite`); no new cryptographic surface is added.

### 4.2 — Request Verification (relay)

```
ALGORITHM: VerifyDeviceRegistrationRequest(body, now)

INPUT:  body: DeviceRegistrationRequest (§3) with `signature` set
        now:  current relay time (epoch ms)

OUTPUT: { ok: true } if the request is well-formed and the signature verifies,
        { ok: false, reason: <code> } otherwise.

Step 1: Validate field shapes per §3. On any failure return { ok: false, reason: "malformed" }.
Step 2: If abs(now - body.timestamp) > 300_000 ms, return { ok: false, reason: "stale" }.
Step 3: If body.suite is not in @motebit/protocol's SUITE_REGISTRY, return { ok: false, reason: "unsupported_suite" }.
Step 4: Let `pk` be the bytes parsed from `body.public_key` (hex → 32 bytes).
Step 5: Let `sig` be the bytes parsed from `body.signature` (base64url).
Step 6: Compute canonical JSON of `body` with `signature` removed (RFC 8785).
Step 7: If `Ed25519_Verify(canonical_bytes, sig, pk)` is false, return { ok: false, reason: "bad_signature" }.
Step 8: Return { ok: true }.
```

Verification proves the registrant controls the private key corresponding to the public key in the request. It does not prove the registrant owns the `motebit_id` in any social or legal sense — only that they were the first party to bind that identifier to this public key on this relay.

---

## 5. Endpoint

```
POST /api/v1/devices/register-self
Content-Type: application/json
```

The endpoint MUST NOT require an `Authorization` header — the request's signature is the auth. Implementations MUST rate-limit per source IP at minimum (the reference relay reuses the existing `authLimiter` tier, 30 req/min).

### 5.1 — Outcomes

The relay's response semantics:

| Condition                                                                 | Response                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Verification per §4.2 passes; `motebit_id` unknown                        | 201; create identity (with `owner_id` from request, defaulting to `"self:<motebit_id>"`); register device. |
| Verification passes; identity exists; device exists; `public_key` matches | 200; refresh `registered_at`. Idempotent re-registration.                                                  |
| Verification passes; identity exists; device exists; `public_key` differs | 409; key-rotation MUST go through `spec/auth-token-v1.md` §9 (`/api/v1/agents/:motebit_id/rotate-key`).    |
| Verification fails (any §4.2 reason)                                      | 400 with `{ "code": "DEVICE_REGISTRATION_REJECTED", "reason": "<code>" }`.                                 |

The relay MUST NOT return `200` (or `201`) without persisting both the identity (if newly created) and the device. The response IS the operator's commitment that the binding is recorded.

### 5.2 — Response Body

On success (201 or 200):

```json
{
  "motebit_id": "019d903f-13de-75a4-8341-58319e0a2f16",
  "device_id": "01a04bb5-9c87-7d2c-bc6c-2f4cd3ce11d8",
  "registered_at": 1776239454547,
  "created": true
}
```

`created` is `true` if the relay created the identity row in this request (first-time registration), `false` if the identity already existed and only the device was refreshed.

---

## 6. Security Considerations

### 6.1 — Replay window

The 5-minute timestamp window (§4.2 step 2) is the only replay defense at the wire level. This is intentional: registration is idempotent for the same `(motebit_id, public_key)` pair, so a replayed registration packet does no harm. The window exists to prevent an attacker from capturing a registration packet on a cleartext network and replaying it weeks later to take over a `motebit_id` whose original device has gone offline (without the captured private key, the attacker can never produce a _new_ signature, but a long-replayed registration on a stale relay state could still hijack the binding before the legitimate device re-registers).

### 6.2 — Sybil cost

Self-registration is uncapped at the wire level — anyone can register any `motebit_id` they have no prior claim to. The design assumption is that `motebit_id`s are opaque UUIDv7s that no one is squatting on, and that _trust_ — accumulated via signed receipts, credentials, and onchain anchors — is what makes a registration economically meaningful. A Sybil flood produces zero-trust registrations the relay routes nothing to.

Operators concerned about registration spam SHOULD apply IP-based rate limiting (the reference relay uses `authLimiter`'s 30/min tier) and MAY add proof-of-work or operator approval for higher-trust onboarding paths. Both are policy layered on top of the protocol; the protocol itself is permissive by design.

### 6.3 — Key-conflict semantics (409)

When `motebit_id` is already registered to a different `public_key`, the relay MUST return 409 rather than silently accept the new key. Acceptance would let any party with the request canonicalization recipe overwrite an established binding. Key rotation is a deliberate, signed operation defined separately in `spec/auth-token-v1.md` §9 — it requires a signature from the _currently registered_ public key, attesting to the new one. Self-registration is for the binding's _first_ moment only.

### 6.4 — Trust anchoring

Self-registration produces a verifiable binding (`pk` ↔ `motebit_id`) on a single relay. To anchor that binding across relays or onchain, the device SHOULD subsequently submit a `spec/credential-anchor-v1.md` anchor for its identity credential. Operators of federated relays SHOULD treat self-registration on a peer relay as a low-trust signal until corroborated by signed receipts or anchored credentials they can independently verify.

---

## 7. Versioning

This spec is versioned as `motebit/device-self-registration@1.0`. The wire format and verification recipe are stable. Additive changes (new optional fields the relay MAY interpret) preserve compatibility; renaming fields, changing the canonicalization recipe, or changing the signature scope is a wire-format break and SHALL be released as a new major version.

The cryptosuite identifier in the request body (`suite`) is the post-quantum migration path: a future suite (e.g., `motebit-jcs-mldsa44-b64-v1`) is added by registering it in `@motebit/protocol`'s `SUITE_REGISTRY` and the relay's verification dispatcher; no new spec is required.

---

## 8. Reference Implementation

- **Type:** `DeviceRegistrationRequest` in `@motebit/protocol`.
- **Helper:** `registerDeviceWithRelay({ motebitId, deviceId, publicKey, privateKey, syncUrl })` in `@motebit/core-identity`. Composes §4.1 signing with the §5 POST and surfaces the §5.1 outcome as a typed result.
- **Endpoint:** `POST /api/v1/devices/register-self` in `services/api/src/sync-routes.ts`.
- **Web bootstrap:** `apps/web/src/web-app.ts` invokes `registerDeviceWithRelay` once per page load before `startSync`. Idempotent.
