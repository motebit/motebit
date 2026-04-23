# Hardware attestation

A motebit's identity key is Ed25519, stored in the OS keyring on desktop and in the app-sandboxed equivalent on mobile. That key is **software-custody**: the private bytes are readable by any process running as the user. A self-attesting system that stops there has a clear ceiling — a third party can verify the signature, but not that any piece of hardware has ever seen the key.

Hardware attestation closes that gap without moving the identity. A separate hardware-native keypair — Apple Secure Enclave issues ECDSA P-256, Windows TPM issues RSA/ECDSA, Android StrongBox issues EC, DeviceCheck / Play Integrity issue platform-signed assertions — signs a canonical claim that binds itself to the Ed25519 identity. The identity stays where it is. The hardware signature is **additive evidence** a verifier can rank against.

Same shape as FIDO / WebAuthn attestation: the platform root key is distinct from the user-facing identity, and one attests the other. The pattern is not new; the invariant here is that motebit treats hardware attestation as an additive scoring dimension, never as a gate.

## The hierarchical model

Two keys, one binding:

1. **Identity key** — Ed25519, long-lived, the same key across every surface. Backs every signed artifact the motebit emits. Cryptosuite-agile via the `SuiteId` registry — a future post-quantum migration is a registry addition, not a wire break.

2. **Attestor key** — platform-native (P-256 for Apple SE), ephemeral or platform-scoped. Never signs artifacts other motebits consume. Its only job is to sign a canonical body that says _"this hardware witnessed this identity at this moment."_

The attestor signs a JCS-canonicalized body:

```json
{
  "version": "1",
  "algorithm": "ecdsa-p256-sha256",
  "motebit_id": "...",
  "device_id": "...",
  "identity_public_key": "<Ed25519 hex lowercase>",
  "se_public_key": "<P-256 compressed-point hex lowercase>",
  "attested_at": <unix ms>
}
```

The attestation receipt is `base64url(body) + "." + base64url(ecdsa_der_signature)`. The full `HardwareAttestationClaim` ({`platform`, `key_exported`, `attestation_receipt`}) lives on `credentialSubject.hardware_attestation` of a W3C VC — today embedded in the self-signed `AgentTrustCredential`; in future passes, on any `TrustCredential` a peer issues.

## Verification

`@motebit/crypto`'s `verifyHardwareAttestationClaim(claim, expectedIdentityHex)`:

1. Parse the receipt into `(body, signature)`.
2. Verify the P-256 signature over `SHA-256(body)` against `body.se_public_key`.
3. Assert `body.identity_public_key === expectedIdentityHex`.
4. Return `{ valid, platform, se_public_key, errors }`.

Zero relay contact. Zero external system required. A third party with this package and the credential can check the claim end-to-end — the self-attesting test is cleared by construction.

The `verify()` dispatcher routes any credential whose subject carries `hardware_attestation` through this verifier and lifts the result onto `CredentialVerifyResult.hardware_attestation`. Additive: consumers that ignore the field break nothing.

## Scoring

The rank is algebra, not policy-by-switch. `packages/semiring/src/hardware-attestation.ts` exports `HardwareAttestationSemiring` — `(max, min, 0, 1)` on `[0, 1]`, isomorphic to `BottleneckSemiring`:

- ⊕ **parallel alternatives** → `max`: pick the best-attested of several candidates.
- ⊗ **sequential delegation chain** → `min`: a chain is only as strong as its weakest link.

`scoreAttestation(claim)` encodes the claim:

| Claim                                                                                   | Score                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------ |
| `secure_enclave` / `tpm` / `device_check` / `play_integrity` / `webauthn`, not exported | 1.0                                        |
| Any hardware platform, `key_exported: true`                                             | 0.5                                        |
| `platform: "software"` (explicit no-hardware)                                           | 0.1                                        |
| Absent claim                                                                            | 0.0 (semiring zero, annihilates under `⊗`) |

Scalars not names: product-semiring composition with trust, cost, and latency stays pure arithmetic. `@motebit/market`'s `graph-routing.ts` lifts a market-local `productSemiring(TrustSemiring, HardwareAttestationSemiring)` over the routing graph — every edge carries a `(trust, hwScore)` tuple, `optimalPaths` bottlenecks HW scores across the whole path in one traversal, and the ranker folds the chain bottleneck into trust via `blendedTrust × (1 + chainHwScore × HARDWARE_ATTESTATION_BOOST)` at the scoring boundary. Single-hop candidates recover the prior scalar-at-terminal score; multi-hop chains through a `software` or absent intermediate now score at the weakest link. Swap the encoder for a different policy without touching the algebra.

## The metabolic split

Hardware is glucose. The math is enzyme.

| Concern               | Layer            | Example                                                                                   |
| --------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| Platform adapter      | glucose (absorb) | `security-framework` Rust crate for Apple SE; `tpm2-tss` for TPM; DeviceCheck SDK for iOS |
| Canonical body format | enzyme (build)   | `version: "1"`, `algorithm: "ecdsa-p256-sha256"`, JCS canonicalization                    |
| Verifier function     | enzyme (build)   | `verifyHardwareAttestationClaim` in `@motebit/crypto`                                     |
| Ranking algebra       | enzyme (build)   | `HardwareAttestationSemiring`                                                             |
| Claim placement       | enzyme (build)   | `TrustCredentialSubject.hardware_attestation?` in the spec                                |

New platform adapter lands as **one** entry in the `platform` union, **one** new claim-minting path in the relevant surface, **zero** changes to the verifier or the rank. The rank is closed under platform additions.

## The three invariants

Every future change to this vertical clears all three:

1. **Hierarchical, never replacement.** The attestor key attests the identity key; it does not replace it. Motebit never migrates the Ed25519 identity to a platform-native curve. Cryptosuite agility is preserved — a post-quantum identity migration is a registry addition; hardware attestation sits orthogonal.

2. **Additive, never gating.** A motebit without a hardware claim still routes, still delegates, still receives trust. The claim is a scoring dimension, not an admission check. `platform: "software"` is a truthful self-report, and `0.1` is the non-zero score distinguishing "explicitly no hardware" from absent.

3. **Self-verifiable.** Every hardware-attestation claim a third party encounters is verifiable with `@motebit/crypto` and the credential subject's public materials. Platform-chain verification (Apple root CA, Android verified-boot) is additive glucose per adapter; v1 treats the attestor public key as the self-asserted root.

## Non-goals in v1

- **iOS / Android platform adapters.** DeviceCheck and Play Integrity land in subsequent passes, each behind the same result shape. Mobile surfaces today inherit `platform: "software"` claims from the CLI-shape path.

- **Windows / Linux TPM.** `tpm2-tss-rs` integration is a separate pass. Desktop-on-non-Apple-Silicon currently emits `platform: "software"`.

- **Chain-of-trust verification.** The SE public key is the self-asserted root in v1. Future adapters verify the platform's own attestation chain (Apple root CA, Google verified-boot chain).

- **Revocation channel.** Claims expire with their parent credential's `validFrom` + expiry. No separate revocation path.

- **Migrating Ed25519 identity → P-256.** Explicitly rejected. Hierarchical attestation preserves cryptosuite-agility; migration would force every federation peer to re-verify every historical receipt.

## Where it shows up

Live consumers today:

- `packages/crypto/src/hardware-attestation.ts` — verifier, pure MIT algebra.
- `packages/crypto/src/index.ts` — `verify()` dispatcher lifts `hardware_attestation` onto `CredentialVerifyResult`.
- `packages/semiring/src/hardware-attestation.ts` — `HardwareAttestationSemiring` + `scoreAttestation`.
- `packages/market/src/graph-routing.ts` — `HARDWARE_ATTESTATION_BOOST` applied to the trust edge during agent ranking.
- `packages/market/src/scoring.ts` — `CandidateProfile.hardware_attestation?` field.
- `packages/encryption/src/hardware-attestation-credential.ts` — canonical VC composer; CLI + desktop both delegate.
- `packages/crypto-webauthn/src/verify.ts` — browser-platform-authenticator packed-attestation verifier; pinned FIDO roots (Apple, Yubico, Microsoft) + self-attestation path.
- `apps/web/src/mint-hardware-credential.ts` — Web surface; cascades WebAuthn → software via `navigator.credentials.create`.
- `apps/desktop/src-tauri/src/secure_enclave.rs` — Rust SE bridge (macOS-gated).
- `apps/desktop/src/secure-enclave-bridge.ts` — typed TS wrapper with `SecureEnclaveError` taxonomy.
- `apps/desktop/src/secure-enclave-attest.ts` — high-level `mintAttestationClaim` with software fallback.
- `apps/desktop/src/mint-hardware-credential.ts` — `mintHardwareCredential` — desktop surface.
- `apps/cli/src/subcommands/attest.ts` — `motebit attest` — software-claim surface.
- `apps/cli/src/subcommands/doctor.ts` — `detectSecureEnclaveAvailability()` diagnostic.
- `packages/verifier/src/lib.ts` — `formatHuman` surfaces `hardware: <platform> ✓/✗`.

## Cross-references

- [`self-attesting-system.md`](self-attesting-system.md) — the three-test check hardware attestation clears by construction.
- [`protocol-model.md`](protocol-model.md) — MIT primitives (`HardwareAttestationClaim` type, `BottleneckSemiring`) vs BSL policy (`scoreAttestation` encoding).
- [`security-boundaries.md`](security-boundaries.md) — software-custody threat model the attestor key mitigates.
- `spec/credential-v1.md §3.4` — wire-format contract.
