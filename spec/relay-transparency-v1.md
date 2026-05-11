# motebit/relay-transparency@1.0

**Status:** Draft (2b-i — trust-anchor primitive)
**Authors:** Daniel Hakim
**Created:** 2026-05-11

## 1. Purpose

A motebit relay publishes a signed, optionally onchain-anchored declaration of its observability posture at a well-known URL. The declaration commits the operator to one Ed25519 public key and to the operator-defined `content` payload that names retention, processors, jurisdiction, and any other posture claims. Verifiers pin the declaration's key as the trust anchor for every other relay-asserted artifact — content-artifact manifests, state-export bundles, settlement receipts the operator counter-signs.

This spec codifies the **trust-anchor primitive** that motebit's verifiers consume: the wire shape, the hash derivation, the signature suite, and the optional onchain anchor format. It does NOT standardize the cross-operator comparison surface (retention vocabularies, processor field schemas, jurisdiction encoding) — that work lands when a second motebit-compatible operator forces field standardization. See `docs/doctrine/operator-transparency.md` § Stage 2b-ii.

## 2. Design Principles

**Single load-bearing role.** The declaration is the trust anchor for everything else. Other motebit artifacts (state-export manifests, content-artifact provenance) verify against the `relay_public_key` this declaration commits to. The wire shape codifies that role; the operator-comparison vocabulary stays operator-extensible.

**Self-attesting envelope, operator-extensible content.** Verifiers MUST be able to parse the envelope (`spec`, `declared_at`, `relay_id`, `relay_public_key`, `content`, `hash`, `suite`, `signature`) without knowing the operator. The `content` field is intentionally opaque to the protocol — operators populate it with their posture. The protocol commits only to the trust-anchor envelope.

**Additive onchain anchor.** The Memo-program anchor is supplementary evidence; declarations are valid with or without an anchor. A relay that never anchors still participates in the protocol — verifiers fall back to trust-on-first-use over HTTPS. A relay that anchors gives verifiers a second channel (Solana) to cross-check the hash, closing the TOFU savant gap. See §5.

**Disappearance test.** A declaration anchored onchain survives the operator's disappearance. A holder of the original signed JSON can prove it was the operator's claim at a specific time by referencing the onchain memo. Per `docs/doctrine/operator-transparency.md` § "Disappearance test for posture."

## 3. SignedTransparencyDeclaration

### 3.1 — SignedTransparencyDeclaration

#### Wire format (foundation law)

Every implementation MUST emit and accept this exact shape when publishing a declaration. Field names, types, and the canonical-JSON ordering of the signed payload are binding.

```
SignedTransparencyDeclaration {
  spec:               string      // "motebit-transparency/draft-2026-04-14" — bump on breaking schema changes
  declared_at:        number      // ms epoch when the declaration was minted
  relay_id:           string      // MotebitId of the relay (operator's relay identity)
  relay_public_key:   string      // hex-encoded Ed25519 public key (32 bytes / 64 chars)
  content:            object      // operator-defined posture payload (opaque to the protocol)
  hash:               string      // hex-encoded SHA-256 of canonicalJson({spec, declared_at, relay_id, relay_public_key, content})
  suite:              string      // "motebit-jcs-ed25519-hex-v1" — cryptosuite identifier (see @motebit/protocol SUITE_REGISTRY)
  signature:          string      // hex-encoded Ed25519 signature over canonicalJson({spec, declared_at, relay_id, relay_public_key, content})
}
```

The TypeScript type `SignedTransparencyDeclaration` in `@motebit/protocol` is the binding machine-readable form.

#### Canonical-JSON ordering

`canonicalJson` is JCS / RFC 8785 deterministic JSON serialization — same as every other Motebit signed artifact. The signed payload is the five-field object `{spec, declared_at, relay_id, relay_public_key, content}` (the post-sign fields `hash`, `suite`, `signature` are NOT included in the canonical bytes that feed into SHA-256 or Ed25519). Two implementations that hash the same payload MUST produce the same hex string byte-for-byte.

#### content (non-binding shape, operator-defined)

The `content` field carries the operator's posture — retention windows, processors, jurisdiction, honest gaps, anchor placeholders. The reference implementation's shape lives at `services/relay/src/transparency.ts:DECLARATION_CONTENT` and is documented in human-readable form at `services/relay/PRIVACY.md`. A second operator with a different posture MAY emit a structurally different `content` block; verifiers MUST NOT reject declarations on the basis of unknown `content` fields. Cross-operator comparison fields are deferred to `spec/relay-transparency-v1.md` Stage 2b-ii (when a second motebit-compatible operator forces field standardization).

## 4. Hash Derivation

The signed hash is computed deterministically from the canonical-JSON of the signed payload:

```
signed_bytes = utf8(canonicalJson({
  spec,
  declared_at,
  relay_id,
  relay_public_key,
  content,
}))
hash = sha256_hex(signed_bytes)
```

Verifiers MUST recompute `hash` from the same canonical-JSON serialization, compare byte-for-byte to the declaration's `hash` field, and reject on mismatch before checking the signature. This catches malformed or tampered declarations cheaply.

### 4.1 Verification

To verify a declaration:

1. Parse the JSON. Reject if envelope fields are missing or wrong type.
2. Recompute `signed_bytes` from `{spec, declared_at, relay_id, relay_public_key, content}` (excluding `hash`, `suite`, `signature`).
3. Recompute `hash = sha256_hex(signed_bytes)`. Reject (`hash_mismatch`) if it differs from the declaration's `hash`.
4. Decode `relay_public_key` (hex → 32 bytes) and `signature` (hex → 64 bytes). Reject (`malformed_public_key` / `malformed_signature`) on length or format failure.
5. Verify the signature against `signed_bytes` under the declared `suite` via `verifyBySuite`. Reject (`signature_invalid`) on failure.
6. (Optional, recommended) Cross-check the hash against an onchain anchor (§5). Reject (`anchor_hash_mismatch` / `no_anchor_found`) on failure.

Pass: the declaration commits the operator to `relay_public_key` at `declared_at`. Verifiers cache the key and use it as the trust anchor for every other relay-asserted artifact.

## 5. Onchain Anchor

The onchain anchor closes the trust-on-first-use gap on the first fetch of `/.well-known/motebit-transparency.json` (§7). Without it, the first fetch trusts HTTPS + DNS + CAs — a DNS hijack, malicious ISP, or compromised CA could substitute a different declaration whose self-signature verifies (against the attacker's key). With it, a verifier with the relay's pinned anchor address — published out-of-band, like Apple's App Attest root cert — cross-checks the declaration's hash against a memo at that address. The anchor is a second channel the network provider cannot tamper with.

### 5.1 Foundation Law

The protocol requires only that the declaration's `hash` is committed to a publicly readable, append-only data store under the relay's identity. The specific chain, transaction format, and program are implementation details.

Required properties:

- **Public readability:** any party can look up the anchor at a known address
- **Immutability:** the anchor cannot be modified or deleted after publication
- **Attribution:** the transaction is signed by the relay's identity key (or its delegate)

### 5.2 Reference Implementation: Solana Memo

The reference implementation uses the Solana Memo Program (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) — the same primitive `motebit/credential-anchor@1.0` §6.2 uses for credential Merkle roots.

**Memo format:**

```
motebit:transparency:v1:{declaration_hash_hex}
```

The `{declaration_hash_hex}` is the same hex string the declaration carries in its `hash` field — 64 lowercase hex characters (Ed25519 public-key length coincidence is incidental; the hash is SHA-256).

**Transaction:**

- Signer: relay's Ed25519 keypair (identity key = Solana address, per the curve coincidence in `spec/settlement-v1.md` §6.1)
- Program: Memo v2
- Data: the memo string above, UTF-8 encoded

The signer's Solana address is the **anchor address** — a verifier with that address pinned can scan its signature history for transparency anchors. See `@motebit/state-export-client::lookupTransparencyAnchor` for the reference verifier algorithm.

### 5.3 Alternative Implementations

Compliant alternatives include any append-only ledger that meets §5.1's three properties. Chain-agnostic memo prefix (`motebit:transparency:v1:`) lets verifiers identify motebit anchors regardless of chain. New chain bindings declare their own anchor-address format alongside this spec.

## 6. Key Succession

Relay key rotation follows `spec/identity-v1.md` §3.8. When the relay rotates its key, the next declaration carries the new `relay_public_key`. Verifiers MUST follow the succession chain:

1. Fetch the declaration. Verify under the declared key.
2. (Optional) Fetch the succession record for the relay's `relay_id`. Verify the new key is reachable from the old key via signed transitions.
3. Trust the new key from the moment the succession record commits.

A relay whose declaration's `relay_public_key` does not appear in its succession chain (or whose chain is broken) MUST be rejected. The motebit-canonical succession verifier is `@motebit/crypto::verifySuccessionChain`.

## 7. Relay API

### 7.1 Public Declaration

```
GET /.well-known/motebit-transparency.json
→ 200 application/json
   {
     "spec": "motebit-transparency/draft-2026-04-14",
     "declared_at": 1715472000000,
     "relay_id": "motebit-mainnet-relay-1",
     "relay_public_key": "...",
     "content": { ... operator-defined ... },
     "hash": "...",
     "suite": "motebit-jcs-ed25519-hex-v1",
     "signature": "..."
   }
```

The endpoint MUST NOT require authentication. The endpoint MUST be served at the well-known URI; a relay that does not expose this URI is not compliant.

### 7.2 Admin View (operator-internal)

```
GET /api/v1/admin/transparency
→ 200 application/json — same shape as §7.1 plus diagnostic fields (anchor placeholder, last-anchored timestamps)
```

Master-token gated. Used by the operator to inspect the live declaration without parsing the well-known JSON.

## 8. Security Considerations

**Trust-anchor pinning.** Verifiers SHOULD pin the relay's anchor address out-of-band (motebit-canonical docs, published keyring, third-party witness). Passing the anchor address from the declaration itself would be circular trust — the attacker could substitute both the declaration and a pointer to their own anchor.

**Self-signature is necessary but not sufficient.** A declaration that verifies under its own embedded key is consistent with itself — not committed to the operator. The onchain anchor (§5) commits the operator to one specific key by writing the hash from a known address. Without the anchor, the verifier is in TOFU mode and SHOULD log the trust-anchor uncertainty.

**Hash bound to envelope only.** The signed payload is the five-field envelope, not the `content` block alone. Operators MUST NOT publish a declaration whose `content` is signed separately from the envelope — verifiers reject any declaration where `hash` does not match the canonical-JSON of the full envelope.

**Suite agility.** `suite` is a closed registry in `@motebit/protocol::SuiteId`. Post-quantum migration is a new suite entry and a new dispatch arm in `@motebit/crypto::suite-dispatch.ts`; the wire format does not change.

## 9. Relationship to Other Specs

- `spec/identity-v1.md` — succession (§6 here references §3.8 there)
- `spec/credential-anchor-v1.md` — sibling onchain-anchor primitive (Merkle batches vs single-declaration hash); both use the Memo program
- `spec/discovery-v1.md` — `/.well-known/motebit.json` precedent for relay-published signed metadata
- `spec/migration-v1.md` — verifiers compare destination relays' transparency declarations before migration; cross-operator comparison fields (Stage 2b-ii) extend the declaration with comparable posture vocabulary
- `docs/doctrine/operator-transparency.md` — doctrine (this spec is the wire codification of doctrine § "What an operator publishes")

## 10. Stage 2b-ii (deferred)

The operator-comparison vocabulary (`content` field standardization for retention windows, processors, jurisdiction encoding) is not in scope for this spec. Lands when a second motebit-compatible operator forces field standardization. Until then, operators MAY use the reference relay's `DECLARATION_CONTENT` shape (`services/relay/src/transparency.ts`) as a convention or publish their own. Verifiers MUST NOT reject declarations on `content` shape difference — only on envelope failure.

---

_motebit/relay-transparency@1.0 — Draft Specification, 2026._
