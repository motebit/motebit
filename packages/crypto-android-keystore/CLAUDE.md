# @motebit/crypto-android-keystore

Android Hardware-Backed Keystore Attestation adapter. Apache-2.0 (permissive floor), Layer 2. Sibling of `@motebit/crypto-appattest` — the canonical metabolic leaf that `@motebit/crypto`'s dispatcher calls when a `HardwareAttestationClaim` declares `platform: "android_keystore"`. Replaces `@motebit/crypto-play-integrity` as the canonical sovereign-verifiable Android primitive (Play Integrity is per-app-key / network-mediated; that contract cannot satisfy the public-anchor third-party-verifiable invariant motebit requires of every leaf).

Permissive-floor because it answers "how is this artifact verified?" against Google's published Hardware Attestation trust anchors and the AOSP Key Attestation extension schema. X.509 chain validation, DER parsing of the `KeyDescription` extension, constraint enforcement, and `attestationChallenge` identity-binding are deterministic from those public specs plus the pinned roots. Apache-2.0 specifically — the patent grant matters across the Android attestation surface (Google, OEM secure-hardware vendors). Motebit-canonical composition (registered package + signing-cert binding, CLI shape) lives one layer up in `@motebit/verify` (BSL).

## Why this package exists

Android Hardware Keystore Attestation is **X.509-shaped judgment plus an ASN.1 extension carrying the policy-relevant material**, not raw cryptography. Verifying it means:

1. Splitting the receipt into the leaf cert plus the rest of the chain (`{leafCertB64}.{intermediatesJoinedB64}` — leaf-first DER chain).
2. Walking the chain leaf → intermediates → terminal anchor with `@peculiar/x509`'s `X509ChainBuilder`. Every non-leaf must carry `basicConstraints.cA === true`. Every signature must verify under its issuer's public key. Every cert must be within its validity window. The terminal cert's DER must equal one of the **pinned Google attestation roots** in `src/google-roots.ts`.
3. Reading the Android Key Attestation extension (OID `1.3.6.1.4.1.11129.2.1.17`) from the **leaf cert only**. The AOSP spec is explicit that later occurrences of this extension up the chain MUST be ignored — only the leaf's copy carries trustworthy data, because only the leaf is signed by the device's secure-hardware key.
4. Constraining the parsed `KeyDescription`: `attestationVersion ≥ 3`, `attestationSecurityLevel ≥ TRUSTED_ENVIRONMENT` (rejects software-only fallback), `hardwareEnforced.rootOfTrust.verifiedBootState` in the caller's allowlist (default `[VERIFIED]`), `hardwareEnforced.attestationApplicationId` byte-equal to the caller's expected package binding, leaf serial not in the caller-supplied revocation snapshot.
5. Cryptographically binding the leaf's `attestationChallenge` to motebit's Ed25519 identity: re-derive `SHA-256(canonicalJson({ attested_at, device_id, identity_public_key, motebit_id, platform: "android_keystore", version: "1" }))` and byte-compare against the transmitted challenge.

Two pinned roots cover the Feb–Apr 2026 RSA → ECDSA P-384 rotation Google announced; verifiers MUST pin both, since the legacy RSA root stays valid for factory-provisioned devices indefinitely while RKP-provisioned devices switched exclusively to the new ECDSA root after 2026-04-10.

## Rules

1. **Both Google attestation roots are pinned in `src/google-roots.ts`.** Pinning is the self-attesting contract — a verifier that dynamically fetched Google's roots could not be reproduced by a third-party audit. Source of truth: `roots.json` in `android/keyattestation`. Rotations land as additive constants. The Android docs are explicit: "Don't query for roots at runtime. Use formal configuration updates."
2. **The verifier never reaches the network.** Chain verification, DER parsing, constraint enforcement, revocation lookup (against a caller-supplied snapshot), and identity binding are all synchronous and local. Google's attestation status endpoint is consulted only by `@motebit/verify`'s release-time embedding pipeline; the runtime verifier reads the snapshot from its options.
3. **Failures are structured `{ valid: false, errors: [...] }` — never thrown.** Matches `@motebit/crypto::HardwareAttestationVerifyResult` so callers pattern-match one shape across SE / App Attest / TPM / Android Keystore / WebAuthn adapters.
4. **Dispatch is consumer-wired, not global.** Callers pass `androidKeystoreVerifier(...)` into `@motebit/crypto::verify` as `{ hardwareAttestation: { androidKeystore } }`. The permissive-floor package stays pure — no implicit side-effect registration, no global mutable state.
5. **Hand-rolled DER walker over schema-driven parser.** The `KeyDescription` extension carries ~50 optional context-tagged fields; only two (`[704] rootOfTrust`, `[709] attestationApplicationId`) gate canonical motebit verification. A schema-driven parser would have to declare all 50 just to skip past them. `src/asn1.ts` walks the DER directly, scoped to exactly what verification needs — same trade-off `@motebit/crypto-tpm` made for `TPMS_ATTEST` parsing.
6. **Default policy: TRUSTED_ENVIRONMENT, VERIFIED boot, registered package.** Software-only attestations are structurally not third-party meaningful and are rejected. SELF_SIGNED boot state (GrapheneOS / CalyxOS) can be allowlisted by the operator if the deployment chooses to accept user-installed roots-of-trust per the GrapheneOS published attestation compatibility model.
7. **StrongBox is a higher score, not an admission gate.** Don't reject TEE-only attestations; record StrongBox as a positive score for the routing semiring, accept TEE as the floor.

## Consumers

- `apps/mobile/src/mint-hardware-credential.ts` — Android surface; produces a `platform: "android_keystore"` claim via the on-device `KeyStore.getInstance("AndroidKeyStore")` flow + `setAttestationChallenge(SHA256(canonical body))`. (Pivot from the old `expo-play-integrity` mint pending — see the deprecated `@motebit/crypto-play-integrity` package and `docs/doctrine/hardware-attestation.md`.)
- Any verifier (CLI `motebit verify`, relay's VC verification, third-party tools) that wants to accept Android Keystore-attested credentials wires `androidKeystoreVerifier({ expectedAttestationApplicationId })` into `verify()`.
