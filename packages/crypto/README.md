# @motebit/crypto

Protocol cryptography for Motebit — sign and verify all artifacts.

Receipts, credentials, delegations, successions, presentations. Zero runtime dependencies. MIT licensed.

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

### Signing

- **`signExecutionReceipt(receipt, privateKey, publicKey?)`** — Sign a receipt with Ed25519.
- **`signSovereignPaymentReceipt(input, privateKey, publicKey)`** — Sign a sovereign onchain payment receipt.
- **`signDelegation(delegation, delegatorPrivateKey)`** — Sign a delegation token.
- **`signKeySuccession(oldPrivateKey, newPrivateKey, newPublicKey, oldPublicKey)`** — Sign a key rotation.
- **`signCollaborativeReceipt(receipt, initiatorPrivateKey)`** — Sign a collaborative receipt.
- **`signVerifiableCredential(vc, privateKey, publicKey)`** — Sign a W3C VC (eddsa-jcs-2022).
- **`signVerifiablePresentation(vp, privateKey, publicKey)`** — Sign a W3C VP.

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

### Primitives

- **`generateKeypair()`** — Generate an Ed25519 keypair.
- **`ed25519Sign(message, privateKey)`** — Raw Ed25519 sign.
- **`ed25519Verify(signature, message, publicKey)`** — Raw Ed25519 verify.
- **`canonicalJson(obj)`** — Deterministic JSON serialization (JCS/RFC 8785).
- **`hash(data)`** — SHA-256 hex string.
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

## License

MIT — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The MIT License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
