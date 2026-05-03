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

| Claim                                                                                                        | Score                                      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `secure_enclave` / `tpm` / `device_check` / `play_integrity` / `android_keystore` / `webauthn`, not exported | 1.0                                        |
| Any hardware platform, `key_exported: true`                                                                  | 0.5                                        |
| `platform: "software"` (explicit no-hardware)                                                                | 0.1                                        |
| Absent claim                                                                                                 | 0.0 (semiring zero, annihilates under `⊗`) |

Hardware platform coverage today: Apple Secure Enclave (desktop macOS + iOS Secure Enclave receipt), Apple App Attest (iOS, Apple-CA-signed chain), Android Hardware-Backed Keystore Attestation (Android, Google-CA-signed chain via `crypto-android-keystore` — the canonical Android sovereign-verifiable primitive), TPM 2.0 (Windows / Linux, endorsement-key chain against pinned vendor roots), W3C WebAuthn (browsers, FIDO-vendor batch root). Scoring is identical across every adapter — all collapse to the same `1.0 / 0.5 / 0.1 / 0.0` scalar under the bottleneck semiring. The scalar answers "hardware-backed?" yes/no; the platform identifier answers "which hardware?" for audit, not for rank. (Google Play Integrity carries the same `1.0` score for backward compatibility with already-minted claims, but the verifier package was removed 2026-05-03 — see § "Three architectural categories" below for the structural-mismatch explanation.)

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

## Three architectural categories — not all "hardware attestation" is the same

A research pass during the 2026-04-25/26 fixture work surfaced that the four
"Apache-2.0 platform leaves" had been treated in doctrine as siblings (same
shape, same contract, same pinned-public-roots model) when they are actually
in three distinct categories. Naming them is load-bearing — categorization
errors at this layer manifest as packages whose npm description claims
something the implementation cannot deliver.

| Category                                                | Examples (motebit packages today)                         | Real-fixture story                                                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Public-batch-anchor verifier**                     | `@motebit/crypto-webauthn`, `@motebit/crypto-appattest`   | Vendor publishes ONE stable batch attestation root that signs millions of devices. Pin once at v1; any captured ceremony rooted at it validates AND leaks no per-device identity. Achievable.        |
| **2. Public-vendor-anchor-but-private-leaves verifier** | `@motebit/crypto-tpm`, `@motebit/crypto-android-keystore` | Vendor publishes the root; device leaves uniquely identify chips. Pinning works; real-device fixtures are privacy-sensitive (EK certs / verifiedBootKey can identify individuals). Capture-gated.    |
| **3. Per-deployer-private-key verifier (NOT a leaf)**   | (formerly scaffolded as `@motebit/crypto-play-integrity`) | No public anchor exists. Verification key is per-app, generated by the platform vendor's developer console, never globally published. Sovereign third-party verification is structurally impossible. |

Categories 1 and 2 are sovereign-verifiable: pin the public root, ship the
verifier, third parties reach the same yes/no answer. Categories 1 vs 2
differ on privacy of the leaf (FIDO Yubico-batch vs TPM-EK), not on the
sovereignty of the verification path. Category 3 is **operator-mediated** —
useful for relay-side anti-fraud signaling, but not a sovereign credential.
Conflating it with categories 1 and 2 produced
`@motebit/crypto-play-integrity@1.0.0` shipping with `GOOGLE_PLAY_INTEGRITY_JWKS = { keys: [] }`,
because there was no Google JWKS to pin — Google designed the Play Integrity
verification path to require either a network call to their API or a per-app
secret. The package was deprecated 2026-04-26 and removed from the monorepo
2026-05-03 in favour of `@motebit/crypto-android-keystore` (category 2 —
Google's published Hardware Attestation roots, real device-attestation
chain). The final published artifact is `@motebit/crypto-play-integrity@1.1.3`
on npm with a registry-level deprecation pointing at the replacement.

If a future motebit deployment wants Play Integrity-as-anti-fraud
(`playProtectVerdict` and friends), it lands at the relay tier as an
explicitly non-canonical operator signal — not in the permissive-floor
crypto-leaf set.

## The three invariants

Every future change to this vertical clears all three:

1. **Hierarchical, never replacement.** The attestor key attests the identity key; it does not replace it. Motebit never migrates the Ed25519 identity to a platform-native curve. Cryptosuite agility is preserved — a post-quantum identity migration is a registry addition; hardware attestation sits orthogonal.

2. **Additive, never gating.** A motebit without a hardware claim still routes, still delegates, still receives trust. The claim is a scoring dimension, not an admission check. `platform: "software"` is a truthful self-report, and `0.1` is the non-zero score distinguishing "explicitly no hardware" from absent.

3. **Self-verifiable.** Every hardware-attestation claim a third party encounters is verifiable with `@motebit/crypto` and the credential subject's public materials. Platform-chain verification (Apple root CA, Android verified-boot) is additive glucose per adapter; v1 treats the attestor public key as the self-asserted root.

## Non-goals in v1

- **Chain-of-trust verification for Secure Enclave.** The SE public key is the self-asserted root in v1. App Attest, Android Keystore, TPM, and WebAuthn adapters already verify the platform's own attestation chain (Apple App Attest root CA; Google Hardware Attestation roots — RSA + ECDSA P-384 — via `@motebit/crypto-android-keystore`'s `DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS`; Infineon, Nuvoton, STMicro, Intel PTT TPM vendor roots via `@motebit/crypto-tpm`'s `DEFAULT_PINNED_TPM_ROOTS`; Apple, Yubico, Microsoft FIDO roots via `@motebit/crypto-webauthn`). The SE chain-of-trust landing is tracked alongside persistent-SE keys.

- **Real TPM fixture coverage.** The TPM verifier currently has synthetic coverage only. Real EK-backed TPM captures are not lifted from third-party fixtures by default because EK certificates can identify individual chips. A real-device fixture should come from owned hardware or a vendor-approved public vector, with privacy reviewed before committing. The same shape worked for `@motebit/crypto-webauthn` because Yubico deliberately reuses one batch attestation root across millions of devices, so a captured ceremony rooted at it leaks no per-device identity; TPM EK chains are the architectural opposite.

- **TPM `tss-esapi` linking in the Rust build graph.** `apps/desktop/src-tauri/src/tpm.rs` ships a `not_supported`-on-every-platform stub until an operator wires the `tss-esapi` crate plus `libtss2-*` system dependencies into the desktop build. The TS cascade treats the `not_supported` reason as expected and falls through to the software sentinel, so the ship is non-regressive.

- **Revocation channel.** Claims expire with their parent credential's `validFrom` + expiry. No separate revocation path.

- **Migrating Ed25519 identity → P-256.** Explicitly rejected. Hierarchical attestation preserves cryptosuite-agility; migration would force every federation peer to re-verify every historical receipt.

## Where it shows up

Live consumers today:

- `packages/crypto/src/hardware-attestation.ts` — verifier, pure permissive-floor (Apache-2.0) algebra.
- `packages/crypto/src/index.ts` — `verify()` dispatcher lifts `hardware_attestation` onto `CredentialVerifyResult`.
- `packages/semiring/src/hardware-attestation.ts` — `HardwareAttestationSemiring` + `scoreAttestation`.
- `packages/market/src/graph-routing.ts` — `HARDWARE_ATTESTATION_BOOST` applied to the trust edge during agent ranking.
- `packages/market/src/scoring.ts` — `CandidateProfile.hardware_attestation?` field.
- `packages/encryption/src/hardware-attestation-credential.ts` — canonical VC composer; CLI + desktop + mobile + web all delegate.
- `packages/crypto-appattest/` — Apple App Attest chain verifier (pinned Apple root).
- `packages/crypto-android-keystore/` — Android Hardware-Backed Keystore Attestation verifier (pinned Google attestation roots — RSA + ECDSA P-384). The canonical sovereign-verifiable Android primitive.
- `packages/crypto-play-integrity/` — REMOVED 2026-05-03. Was a Google Play Integrity JWT verifier (pinned Google JWKS, ES256 / RS256 dispatch). Structurally miscategorized as a sovereign-verifiable leaf — Google publishes no global JWKS; replaced by `crypto-android-keystore`. Final published artifact is `@motebit/crypto-play-integrity@1.1.3` on npm with a registry-level deprecation; the source tree is gone.
- `packages/crypto-tpm/src/verify.ts` — TPM 2.0 quote verifier; pinned vendor roots (Infineon, Nuvoton, STMicro, Intel PTT).
- `packages/crypto-tpm/src/tpm-parse.ts` — minimal `TPMS_ATTEST` marshaling; hand-rolled over dep explosion.
- `packages/crypto-webauthn/src/verify.ts` — browser-platform-authenticator packed-attestation verifier; pinned FIDO roots (Apple, Yubico, Microsoft) + self-attestation path.
- `apps/mobile/modules/expo-app-attest/` — iOS native App Attest bridge.
- `apps/mobile/modules/expo-play-integrity/` — Android native Play Integrity bridge.
- `apps/mobile/src/mint-hardware-credential.ts` — mobile surface; per-OS cascade (App Attest → SE on iOS; Play Integrity on Android; software sentinel everywhere).
- `apps/web/src/mint-hardware-credential.ts` — Web surface; cascades WebAuthn → software via `navigator.credentials.create`.
- `apps/desktop/src-tauri/src/secure_enclave.rs` — Rust SE bridge (macOS-gated).
- `apps/desktop/src-tauri/src/tpm.rs` — Rust TPM bridge (Windows / Linux; `not_supported` pending `tss-esapi` link).
- `apps/desktop/src/secure-enclave-bridge.ts` — typed TS wrapper with `SecureEnclaveError` taxonomy.
- `apps/desktop/src/secure-enclave-attest.ts` — high-level `mintAttestationClaim` with software fallback.
- `apps/desktop/src/tpm-bridge.ts` — typed TS wrapper with `TpmError` taxonomy mirroring SE shape.
- `apps/desktop/src/tpm-attest.ts` — high-level `mintTpmAttestationClaim`; returns `null` to defer to the cascade.
- `apps/desktop/src/mint-hardware-credential.ts` — `mintHardwareCredential` — desktop surface; cascade SE → TPM → software.
- `apps/cli/src/subcommands/attest.ts` — `motebit attest` — software-claim surface.
- `apps/cli/src/subcommands/doctor.ts` — `detectSecureEnclaveAvailability()` diagnostic.
- `packages/verifier/src/lib.ts` — `formatHuman` surfaces `hardware: <platform> ✓/✗`.

## Cross-references

- [`self-attesting-system.md`](self-attesting-system.md) — the three-test check hardware attestation clears by construction.
- [`protocol-model.md`](protocol-model.md) — permissive-floor primitives (`HardwareAttestationClaim` type, `BottleneckSemiring`) vs BSL policy (`scoreAttestation` encoding).
- [`security-boundaries.md`](security-boundaries.md) — software-custody threat model the attestor key mitigates.
- `spec/credential-v1.md §3.4` — wire-format contract.
