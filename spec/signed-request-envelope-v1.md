# motebit/signed-request-envelope@1.0

**Status:** Draft
**Authors:** Daniel Hakim
**Created:** 2026-06-10

---

## 1. Overview

A `SignedRequestEnvelope` authenticates a single request from a registered motebit identity to a service endpoint: the key is the login. The envelope binds the identity (`motebit_id`), a timestamp (`ts`), a digest of the request body (`payload_digest`), and an audience (`aud`) into one Ed25519 signature verified against the identity's **registered** public key — never a key the request self-asserts.

This is the stateless sibling of auth-token@1.0, for a different caller and a different trust root:

|                   | auth-token@1.0                  | signed-request-envelope@1.0            |
| ----------------- | ------------------------------- | -------------------------------------- |
| Authenticates     | an agent **device** to a relay  | a registered **identity** to a service |
| Key resolved from | device registry (`did`)         | identity registry (`motebit_id`)       |
| Audience          | closed `TokenAudience` registry | free-form string (§5)                  |
| Payload           | none (bearer)                   | detached digest, bound by signature    |
| State required    | optional `jti` deny-list        | none (optional `nonce` dedup, §6)      |

The envelope is detached from its payload: the signature covers a SHA-256 digest of the canonical payload, not the payload bytes. Large bodies never enter the signing buffer, and the envelope can travel in a header while the body travels as the body.

---

## 2. Envelope Structure

#### Wire format (foundation law)

Every implementation MUST emit this exact shape. Field names and the canonical-JSON signing order are binding.

```
SignedRequestEnvelope {
  motebit_id:      string      // Requesting identity
  ts:              number      // Unix ms at signing — freshness, not entropy (§4)
  payload_digest:  string      // SHA-256 of canonicalJson(payload), 64-char lowercase hex
  aud:             string      // Audience — free-form string, convention "host/route" (§5)
  nonce:           string      // Optional — UUID v4; present ⇒ replay-once semantics (§6)
  suite:           string      // "motebit-jcs-ed25519-b64-v1" — cryptosuite identifier (see @motebit/protocol SUITE_REGISTRY)
  signature:       string      // Ed25519 by the identity key over canonicalJson(envelope minus signature), base64url
}
```

The `SignedRequestEnvelope` type in `@motebit/protocol` is the binding machine-readable form. JSON Schema: `spec/schemas/signed-request-envelope-v1.json`.

#### Storage (reference convention — non-binding)

Verifiers persist nothing for the stateless mode. A verifier offering replay-once semantics (§6) MAY maintain a short-lived `nonce` dedup set (RAM or SQLite) scoped to the freshness window; the structure is implementation-local.

---

## 3. Signing

```
ALGORITHM: SignRequestEnvelope(payload, identity, aud, now)

INPUT:  payload:   any JSON value (the request body)
        identity:  { motebit_id, Ed25519 private key }
        aud:       audience string for the target endpoint
        now:       Unix ms

OUTPUT: SignedRequestEnvelope

Step 1: payload_digest = hex(SHA-256(canonicalJson(payload)))
Step 2: body = { motebit_id, ts: now, payload_digest, aud,
                 nonce?, suite: "motebit-jcs-ed25519-b64-v1" }
Step 3: signature = base64url(Ed25519.sign(canonicalJson(body), privateKey))
Step 4: Return body + signature
```

`canonicalJson` is JCS (RFC 8785) throughout, as everywhere in the identity family.

---

## 4. Verification

```
ALGORITHM: VerifyRequestEnvelope(envelope, payload, registeredKey, expectedAud, opts)

INPUT:  envelope:       SignedRequestEnvelope
        payload:        the request body as received
        registeredKey:  Ed25519 public key for envelope.motebit_id,
                        resolved from the IDENTITY REGISTRY — never from the request
        expectedAud:    this endpoint's audience string
        opts:           { now = Date.now(), windowMs = 300_000 }

OUTPUT: accept | reject(reason)

Step 1: Structural check — all required fields present, types correct.
        Missing field → reject(malformed)
Step 2: |now − ts| > windowMs → reject(stale)
Step 3: aud ≠ expectedAud → reject(audience_mismatch)
Step 4: hex(SHA-256(canonicalJson(payload))) ≠ payload_digest → reject(payload_mismatch)
Step 5: Ed25519.verify(signature, canonicalJson(envelope minus signature), registeredKey)
        fails → reject(bad_signature)
Step 6: nonce present AND verifier offers replay-once AND nonce already seen
        within window → reject(replayed)
Step 7: Accept
```

### Foundation law

- The verifier MUST resolve the public key from its registry by `motebit_id`. Verifying against a key carried in or alongside the request defeats the design — possession of the registered key IS the account.
- Steps 1–5 are mandatory for every verifier. Step 6 is mandatory only for verifiers that advertise replay-once semantics.
- Default freshness window: ±300 seconds. Implementations SHOULD allow ~60s additional skew tolerance in distributed deployments.

---

## 5. Audience Values

`aud` is a **free-form string**, deliberately not the `TokenAudience` registry of auth-token@1.0 — request audiences are finer-grained than relay operations and owned by each service.

Convention: `"{host}/{route}"`, e.g. `"app.agency.computer/api/monitors"`. The verifier compares for exact equality, fail-closed. A service MAY use coarser audiences (one per service) at the cost of intra-service replay surface; it MUST NOT accept an envelope whose `aud` it does not recognize as its own.

---

## 6. Replay Semantics

Two modes, chosen by the signer:

- **`nonce` absent (default):** within the freshness window, a replay re-presents an identical signed request. For idempotent operations over an authenticated channel this is accepted behavior — the verifier stays stateless, and the replay re-executes the same operation. Services MUST NOT expose non-idempotent operations to nonce-less envelopes.
- **`nonce` present:** the signer requests replay-once semantics. A verifier that advertises them maintains a dedup set scoped to the freshness window and rejects a seen nonce. State is opt-in on both sides — the protocol never mandates storage for verifiers that don't need it.

---

## 7. Transport

Transport-agnostic. Two conventions:

### 7.1 — Body wrapper

```json
{ "envelope": { ...SignedRequestEnvelope }, "payload": { ... } }
```

### 7.2 — Header + body

```
X-Motebit-Envelope: base64url(JSON(SignedRequestEnvelope))
```

with the payload as the raw request body. The verifier MUST parse the body it received and digest `canonicalJson` of the parsed payload (not the raw transport bytes) — so JSON whitespace and key-order differences introduced in transit do not break verification.

---

## 8. Security Considerations

**Registered-key binding.** The single trust move: an attacker who controls the transport and the request contents still cannot authenticate without the registered private key, and a request cannot self-assert a key the registry never anchored.

**Cross-service replay.** Without `aud`, an envelope intercepted at one service replays at any other accepting the same shape. Exact-match audience binding eliminates the class (the same argument as auth-token@1.0 §8.2, applied to identities).

**Detached digest.** Signing a digest rather than the body keeps multi-megabyte payloads out of the signing buffer and lets envelopes travel in headers. The digest is collision-resistant (SHA-256) and computed over canonical JSON on both ends, so equivalent JSON serializations verify and any semantic change to the payload breaks Step 4.

**Freshness vs. replay.** `ts` bounds the replay window; it does not eliminate replay. Services with non-idempotent operations MUST require `nonce` (§6) or design the operation to be idempotent.

---

## 9. Reference Implementation

- Signing: `@motebit/crypto` — `signRequestEnvelope(payload, fields, identityPrivateKey)`
- Verification: `@motebit/crypto` — `verifyRequestEnvelope(envelope, registeredPublicKey, options)`; re-exported by `@motebit/verifier`
- Consumer precedent: agency (`apps/app/lib/signed-request.ts`) — in production since 2026-06 with the inline-payload predecessor of this shape; collapses to a re-export when the primitives publish.

---

## 10. Conformance

An implementation conforms to this specification if:

1. Envelopes contain all required fields with `payload_digest` computed over canonical JSON (§2, §3).
2. The signature covers `canonicalJson(envelope minus signature)` (§3 Step 3).
3. Verification resolves the key from the registry, never the request (§4 foundation law).
4. Verification performs Steps 1–5 in order, fail-closed (§4).
5. Audience comparison is exact-match (§5).
6. Replay-once semantics, where offered, honor `nonce` dedup within the freshness window (§6).
