# @motebit/crypto

Protocol cryptography for Motebit — sign and verify all artifacts.

Receipts, credentials, delegations, successions, presentations. Zero runtime dependencies. Apache-2.0 licensed (with explicit patent grant).

## Install

```bash
npm install @motebit/crypto
```

## Verify

```typescript
import { verify } from "@motebit/crypto";

// Identity file
const r1 = await verify(fs.readFileSync("motebit.md", "utf-8"));
if (r1.type === "identity" && r1.valid) {
  console.log(r1.did); // did:key:z...
}

// Execution receipt (object or JSON string)
const r2 = await verify(receipt);
if (r2.type === "receipt" && r2.valid) {
  console.log(r2.signer); // did:key of the signing agent
}

// Verifiable credential
const r3 = await verify(credential);
if (r3.type === "credential" && r3.valid) {
  console.log(r3.issuer); // did:key of the issuer
}
```

## Sign

```typescript
import { signExecutionReceipt, generateKeypair } from "@motebit/crypto";

const { publicKey, privateKey } = await generateKeypair();

const signed = await signExecutionReceipt(receipt, privateKey, publicKey);
// signed.signature is base64url Ed25519 over canonical JSON
```

```typescript
import { signDelegation } from "@motebit/crypto";

const token = await signDelegation(
  {
    delegator_id,
    delegator_public_key,
    delegate_id,
    delegate_public_key,
    scope,
    issued_at,
    expires_at,
  },
  delegatorPrivateKey,
);
```

```typescript
import { issueReputationCredential } from "@motebit/crypto";

const vc = await issueReputationCredential(
  {
    success_rate: 0.95,
    avg_latency_ms: 120,
    task_count: 50,
    trust_score: 0.8,
    availability: 0.99,
    measured_at: Date.now(),
  },
  privateKey,
  publicKey,
  subjectDid,
);
```

## API

### Verification

- **`verify(artifact, options?)`** — Verify any artifact. Detects type automatically. Returns discriminated union.
- **`verifyIdentityFile(content)`** — _(deprecated)_ Legacy identity verification. Use `verify()` instead.
- **`parse(content)`** — Parse a `motebit.md` without verifying.
- **`verifyReceiptVerdict(receipt)`** — Structured `VerificationVerdict` for a signed receipt: independent axes (integrity, identityBinding, authority, revocation, temporalBasis, evidenceBasis) + a first-class `repair`, with no top-level `valid` boolean to over-read. See [`docs/doctrine/verify-family-fail-closed.md`](../../docs/doctrine/verify-family-fail-closed.md).
- **`verifyDelegationTokenVerdict(token, grant, options?)`** — Structured `VerificationVerdict` for a per-tick token against its standing grant. Keeps `authority` and `revocation` orthogonal (a revoked grant reads `authority: "valid"` + `revocation: "revoked"`); `temporalMode: "wall_clock" | "ordering"` selects `temporalBasis` (`local_clock` vs `clockless`) so a clock-rollback is load-bearing in one and irrelevant in the other.
- **`isFullyVerified(verdict)`** — Fail-closed collapse of a verdict to a boolean: `true` only when every load-bearing axis passes (integrity verified, identity bound, authority valid, revocation fresh). Stricter than the legacy per-function booleans by design.

### Signing

- **`signExecutionReceipt(receipt, privateKey, publicKey?)`** — Sign a receipt with Ed25519.
- **`signSovereignPaymentReceipt(input, privateKey, publicKey)`** — Sign a sovereign onchain payment receipt.
- **`signDelegation(delegation, delegatorPrivateKey)`** — Sign a delegation token.
- **`signKeySuccession(oldPrivateKey, newPrivateKey, newPublicKey, oldPublicKey)`** — Sign a key rotation.
- **`signCollaborativeReceipt(receipt, initiatorPrivateKey)`** — Sign a collaborative receipt.
- **`signVerifiableCredential(vc, privateKey, publicKey)`** — Sign a W3C VC (eddsa-jcs-2022).
- **`signVerifiablePresentation(vp, privateKey, publicKey)`** — Sign a W3C VP.

### Remote Command Envelopes (`signed-request-envelope@1.0`)

- **`signAgentCommandEnvelope(opts)`** — Sign a remote command targeting an agent: the agent's own identity signs, audience-bound to `agentCommandAudience(motebitId)` (`agent-command/{motebit_id}`), digest-bound to `agentCommandPayload(command, args)`.
- **`verifyAgentCommandEnvelope(opts)`** — Fail-closed verification consumers run before executing a relay-forwarded `command_request`; returns an `AgentCommandVerdict` with an honest rejection reason (missing envelope, foreign identity, bad signature, stale timestamp, audience mismatch, payload tamper).
- **`agentCommandAudience(motebitId)`** / **`agentCommandPayload(command, args?)`** — the shared audience + canonical-payload convention both sides bind to.

### Credential Issuance

- **`issueGradientCredential(snapshot, privateKey, publicKey)`** — Issue an intelligence gradient VC.
- **`issueReputationCredential(snapshot, privateKey, publicKey, subjectDid)`** — Issue a reputation VC.
- **`issueTrustCredential(trustRecord, privateKey, publicKey, subjectDid)`** — Issue a trust VC.
- **`createPresentation(credentials, privateKey, publicKey)`** — Bundle VCs into a signed VP.

### Chain Verification

- **`verifyReceiptChain(receipt, knownKeys)`** — Recursively verify a delegation receipt tree.
- **`verifyReceiptSequence(chain)`** — Verify a flat sequence of receipts.
- **`verifyDelegation(delegation, options?)`** — Verify a delegation token signature.
- **`verifyDelegationChain(chain)`** — Verify a chain of delegations with scope narrowing.
- **`verifyKeySuccession(record, guardianPublicKeyHex?)`** — Verify a key rotation record.
- **`verifySuccessionChain(chain, guardianPublicKeyHex?)`** — Verify a full key rotation chain.
- **`verifyKeyBindingAtTime(identity, signingKeyHex, atTimestampMs, guardianPublicKeyHex?)`** — Sovereign-root identity binding with time-windowing: was this key the motebit's legitimate key _at_ a given time? Verifies the succession chain, then checks the key's active window. Returns `KeyBindingResult`.
- **`identityLogLeaf(motebitId, currentKeyHex)`** — Canonical SHA-256 leaf of the identity-transparency log (the operator's `motebit_id → current key` commitment). Shared convention for the relay producer and the verifier.
- **`verifyIdentityBindingAnchored(identity, signingKeyHex, atTimestampMs, proof, guardianPublicKeyHex?)`** — Anchored binding: sovereign-root binding AND Merkle inclusion of the current key in the transparency log under `proof.anchoredRoot`. Confirming the root is on-chain is the caller's cross-check.
- **`deriveSovereignMotebitId(genesisPublicKeyHex)`** — The sovereign commitment of a genesis key: a deterministic UUIDv8 from `sha256(genesisKey)`. A sovereign-minted motebit's `motebit_id` IS this value, so the id↔key binding is self-certifying (offline, no operator). Second-preimage resistance ~2^122.
- **`verifySovereignBinding(motebitId, genesisPublicKeyHex)`** — True iff `motebitId` is the sovereign commitment to the genesis key. `verifyKeyBindingAtTime` sets `sovereign: true` on its result when this holds.
- **`verifyMigratingKeyBinding(motebitId, presentedKeyHex, identityFile?)`** — Does `presentedKeyHex` legitimately control `motebitId` right now? The migration key↔id check (spec/migration-v1.md §8.2 step 6), fail-closed: a never-rotated sovereign id binds its key directly; a rotated key binds via the identity file's sovereign-rooted succession chain. Composes `verifySovereignBinding` and `verifyKeyBindingAtTime`.

### Settlement anchoring

- **`verifyAgentSettlementAnchor(record, proof, chainVerifier?)`** — Worker-side self-verification of a per-agent settlement Merkle inclusion proof (`spec/agent-settlement-anchor-v1.md`): the held `SettlementRecord` hashes to the anchored leaf, the Merkle path reconstructs to the root, and the relay's batch signature (suite `AGENT_SETTLEMENT_ANCHOR_SUITE`) checks out — all offline, with only the record, the proof, and the relay's public key. SCITT / RFC 6962 shape. The optional `chainVerifier` adds the onchain non-repudiation cross-check.
- **`computeAgentSettlementLeaf(record)`** — The leaf hash for a `SettlementRecord`: `SHA-256(canonicalJson(record))` over the whole signed object (never a field projection), so producer and holder derive the identical leaf from the bytes they each hold.
- **`verifyFederationSettlementAnchor(record, proof, chainVerifier?)`** — Peer-side self-verification of an inter-relay settlement Merkle inclusion proof (`spec/relay-federation-v1.md` §7.6): the held `FederationSettlementRecord` hashes to the anchored leaf, the Merkle path reconstructs to the root, and the relay's batch signature (suite `FEDERATION_SETTLEMENT_ANCHOR_SUITE`) checks out — all offline, with only the record, the proof, and the relay's public key. The federation analogue of `verifyAgentSettlementAnchor`; same SCITT / RFC 6962 shape. The optional `chainVerifier` adds the onchain non-repudiation cross-check.
- **`computeFederationSettlementLeaf(record)`** — The leaf hash for a `FederationSettlementRecord`: `SHA-256(canonicalJson(record))` over the whole signed object (never a field projection), so producer and holder derive the identical leaf from the bytes they each hold.

### Primitives

- **`generateKeypair()`** — Generate an Ed25519 keypair.
- **`ed25519Sign(message, privateKey)`** — Raw Ed25519 sign.
- **`ed25519Verify(signature, message, publicKey)`** — Raw Ed25519 verify.
- **`canonicalJson(obj)`** — Deterministic JSON serialization (JCS/RFC 8785).
- **`hash(data)`** — SHA-256 hex string.
- **`hashLeaf(entry, treeHashVersion?)`** — Merkle leaf hash under a `MerkleTreeVersion`: `SHA-256(entry)` for `merkle-sha256-plain-v1` (default), `SHA-256(0x00 ‖ entry)` for the RFC 6962 §2.1 `merkle-sha256-rfc6962-v2` leaf tag. The single dispatch point every leaf builder routes through; throws on an unimplemented version.
- **`canonicalLeaf(value, treeHashVersion?)`** — JCS-canonicalize `value` then `hashLeaf` it. `canonicalLeaf(x)` (v1 default) is byte-identical to `hash(canonicalJson(x))`.
- **`resolveTreeHashVersion(raw)`** — Verifier-boundary resolver for a proof's wire `tree_hash_version`: `absent ⇒ merkle-sha256-plain-v1`, a known value to itself, an unknown string to `null` so the caller rejects fail-closed (never silent-downgrade). See `docs/doctrine/merkle-tree-hash-versioning.md`.
- **`createSignedToken(payload, privateKey)`** — Create a signed auth token.
- **`verifySignedToken(token, publicKey)`** — Verify a signed auth token.
- **`publicKeyToDidKey(publicKey)`** / **`didKeyToPublicKey(did)`** — did:key conversion.

## What can it do?

| Operation | Artifacts                                                                                  | Format                      |
| --------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| Sign      | Receipts, delegations, credentials, presentations, successions, payment receipts           | Ed25519 over canonical JSON |
| Verify    | Identity files, receipts, credentials, presentations, delegation chains, succession chains | Offline — no network calls  |
| Issue     | Gradient, reputation, and trust credentials                                                | W3C VC 2.0, eddsa-jcs-2022  |

All operations are **offline** — no network calls, no relay lookup, no runtime dependency. Everything needed for signing and verification is in the artifact itself.

## Related

- [`@motebit/verifier`](https://www.npmjs.com/package/@motebit/verifier) — CLI + library that wraps `verify()` for third-party offline verification
- [`@motebit/protocol`](https://www.npmjs.com/package/@motebit/protocol) — wire-format types for the artifacts this package signs and verifies
- [`@motebit/sdk`](https://www.npmjs.com/package/@motebit/sdk) — developer contract for building Motebit-powered agents
- [`create-motebit`](https://www.npmjs.com/package/create-motebit) — scaffold a signed agent identity
- [`motebit`](https://www.npmjs.com/package/motebit) — reference runtime and operator console

## License

Apache-2.0 — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The Apache License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
