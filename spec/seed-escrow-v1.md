# motebit/seed-escrow@1.0

**Status:** Draft
**Authors:** Daniel Hakim
**Created:** 2026-06-10

---

## 1. Purpose

Seed escrow is durability without custody: a holder stores an identity's encrypted Ed25519 seed that it is **structurally unable to open**. The user owns the seed; the unwrap secret lives in hardware the user controls (v1: a WebAuthn passkey's PRF output, which never leaves the authenticator); restore works on any device that holds the unlock credential — relay-optional, exactly as the identity doctrine requires.

This spec defines the `SeedEscrowPayload` — the sibling of `KeyTransferPayload`, for a different movement of the same asset. KeyTransfer moves a key **between parties** under key agreement; SeedEscrow parks a seed **with a custodian** under a secret only the owner's authenticator can reproduce. The payload is deliberately opaque to its custodian by construction: escrow, not custody.

---

## 2. Design Principles

**Escrow, not custody.** The custodian holds ciphertext it cannot decrypt. No plaintext seed, no unwrap secret, and no key material capable of deriving either ever reaches the custodian. A custodian that can open its escrows is in protocol violation.

**Opt-in.** Escrow is an offer, never a requirement. An identity remains fully functional with no escrow placed; the cost is honest — losing every unlock credential with no escrow elsewhere is unrecoverable, by design.

**Fail-closed unwrap.** A successful decryption is not yet a successful restore: the recovered seed MUST re-derive to the expected public key (`identity_pubkey_check`) before anything trusts it.

**Unsigned by design.** The payload carries no signature: its integrity is the AEAD tag, its correctness gate is the pubkey check, and its placement is authenticated by the enclosing transport (signed-request-envelope@1.0 — only the identity can place or replace its own escrow).

---

## 3. Payload Structure

#### Wire format (foundation law)

Every implementation MUST emit this exact shape. Hex encodings follow the identity family (lowercase).

```
SeedEscrowPayload {
  unlock_hint:            string      // Opaque locator for the unwrap secret — for WebAuthn PRF: the credential id (base64url)
  kdf:                    string      // KDF descriptor, closed enum (§4). v1: "webauthn-prf-hkdf-sha256"
  encrypted_seed:         string      // AES-256-GCM ciphertext of the 32-byte Ed25519 seed (64-char hex)
  nonce:                  string      // AES-256-GCM nonce, 12 bytes (24-char hex)
  tag:                    string      // AES-256-GCM authentication tag, 16 bytes (32-char hex)
  identity_pubkey_check:  string      // Ed25519 public key derived from the seed (64-char hex) — verified after unwrap (§5)
}
```

The `SeedEscrowPayload` type in `@motebit/protocol` is the binding machine-readable form. JSON Schema: `spec/schemas/seed-escrow-payload-v1.json`.

**WebCrypto mapping note:** `SubtleCrypto.encrypt` with AES-GCM returns `ciphertext ‖ tag` concatenated. Implementations on WebCrypto split the final 16 bytes into `tag`; the wire format keeps them separate fields so non-WebCrypto implementations are not forced into the concatenation convention.

#### Storage (reference convention — non-binding)

The reference custodian persists `(unlock_hint PRIMARY KEY, motebit_id, payload JSON, placed_at)`. Retrieval is keyed on the opaque `unlock_hint`; the table never holds anything that can open the payload.

---

## 4. KDF Registry

`kdf` is a closed enum. v1 defines exactly one entry; the registry's shape (and whether it becomes its own spec section) is decided when a second unlock method lands — registering, never forking.

### 4.1 — `webauthn-prf-hkdf-sha256`

```
unwrap_secret = WebAuthn PRF extension output (32 bytes)
                — eval input: the application's fixed PRF domain-separation constant
wrap_key      = HKDF-SHA256(ikm = unwrap_secret, salt = empty, info = the
                application's fixed wrap domain-separation constant)
                → AES-256-GCM key (256 bits)
```

**Domain-separation constants are application-scoped and deployment-fixed.** The PRF eval input and the HKDF `info` string are chosen once by the escrowing application (e.g. `"agency.approver.prf.v1"` / `"agency.seed-wrap.v1"`) and MUST never change while any escrow placed under them exists — a change silently orphans every prior escrow. They are not carried in the payload: an escrow is opened by the same application that placed it, and the constants are part of that application's identity, not the wire format.

### Foundation law

- The PRF output MUST be obtained via the WebAuthn PRF extension from a platform authenticator. It never leaves the authenticator boundary except as the extension's output inside the client.
- `kdf` values outside the registry MUST be rejected by custodians and restoring clients alike, fail-closed.

---

## 5. Escrow and Restore

### 5.1 — Placement

```
ALGORITHM: PlaceEscrow(seed, prfSecret, credentialId)

Step 1: wrap_key = KDF per §4 (prfSecret)
Step 2: nonce = 12 random bytes
Step 3: ct, tag = AES-256-GCM.encrypt(wrap_key, nonce, seed)
Step 4: payload = { unlock_hint: credentialId, kdf, encrypted_seed: hex(ct),
                    nonce: hex(nonce), tag: hex(tag),
                    identity_pubkey_check: hex(Ed25519.publicKey(seed)) }
Step 5: Place with the custodian over an authenticated transport
        (signed-request-envelope@1.0), signed by the identity the seed derives
```

### 5.2 — Restore

```
ALGORITHM: RestoreFromEscrow(payload, authenticator)

Step 1: Fetch payload from the custodian by unlock_hint
Step 2: Run the WebAuthn ceremony against the credential in unlock_hint,
        requesting the PRF extension → prfSecret
Step 3: wrap_key = KDF per §4 (prfSecret)
Step 4: seed = AES-256-GCM.decrypt(wrap_key, payload.nonce,
                                   payload.encrypted_seed, payload.tag)
        AEAD failure → reject (wrong credential, corrupted payload, or tampering)
Step 5: hex(Ed25519.publicKey(seed)) ≠ payload.identity_pubkey_check
        → reject and DISCARD the seed (decryption succeeded but this is not
          the expected identity — never adopt it)
Step 6: The identity is restored; the client re-derives and proceeds
```

### Foundation law

- Step 5 is mandatory. An AEAD success without the pubkey check is not a restore.
- The custodian MUST accept placement and replacement only from the identity whose seed the payload claims to hold (authenticated placement, §5.1 Step 5).
- The custodian MUST NOT condition retrieval on anything beyond presentation of the `unlock_hint` — the hint is an unguessable opaque locator, the payload is ciphertext, and the real gate is the authenticator. Retrieval MUST NOT be publicly enumerable.
- Escrow placement failure MUST NOT block the identity's normal operation. Escrow is durability, never a dependency.

---

## 6. Security Considerations

**Custodian compromise.** The worst case is disclosure of ciphertext plus an opaque credential id. The unwrap secret derives from authenticator hardware; without the physical authenticator the payload is AES-256-GCM ciphertext under a key the attacker cannot reproduce.

**Wrong-passkey unwrap.** A different credential's PRF output produces a different wrap key; AEAD authentication fails closed at §5.2 Step 4. No oracle distinguishes "wrong passkey" from "corrupted payload" — both are rejection.

**Identity substitution.** A malicious custodian could return a *different* valid payload (an attacker's seed) hoping the client adopts it. `identity_pubkey_check` defeats this only if the client compares against its own expected key when it has one; a fresh-device restore trusts the check field as the binding between payload and identity, then verifies the restored identity against the registry before first use.

**Loss.** All unlock credentials gone + no other escrow = the seed is unrecoverable. This is stated, not mitigated — mitigation (multiple credentials, each with its own escrow row) is the application's recovery posture.

---

## 7. Reference Implementation

- Placement + restore: agency (`apps/app/lib/passkey.ts`, `seed_escrow` table) — in production since 2026-06 with the WebCrypto `ct ‖ tag` convention (§3 mapping note).
- `@motebit/protocol` type + schema: published with this spec. No signing primitives required — the payload is unsigned by design (§2).

---

## 8. Conformance

An implementation conforms to this specification if:

1. Payloads contain all six fields with the §3 encodings.
2. The custodian can demonstrate it holds no material capable of decrypting any payload it stores (§2, §6).
3. Restore performs AEAD verification AND the pubkey check, in order, fail-closed (§5.2).
4. Placement is authenticated to the identity the seed derives (§5.1).
5. Unknown `kdf` values are rejected (§4).

---

## 9. Relationship to Other Specs

| Spec | Relationship |
| --- | --- |
| identity@1.0 | The escrowed seed is the identity's Ed25519 root. `identity_pubkey_check` is its public half. |
| migration-v1 (`KeyTransferPayload`) | Sibling artifact: transfer moves a key between parties under key agreement; escrow parks a seed with a custodian under an authenticator-held secret. Deliberate deltas: no X25519 ephemeral, `kdf` as a registry, same post-decryption verification posture. |
| signed-request-envelope@1.0 | The authenticated transport for placement and replacement. |
