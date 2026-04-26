/**
 * Mobile path for minting a hardware-attested `AgentTrustCredential`.
 *
 * Sibling of:
 *   - `apps/desktop/src/mint-hardware-credential.ts` — macOS via Rust /
 *     Tauri.
 *   - `apps/cli/src/subcommands/attest.ts` — Node process, software
 *     claim only.
 *
 * All three delegate the VC envelope + eddsa-jcs-2022 signing to
 * `composeHardwareAttestationCredential` from `@motebit/encryption` —
 * the single source of truth. Only the hardware_attestation claim
 * varies per surface.
 *
 * Mobile's cascade (strongest proof first, per OS):
 *   iOS:
 *     1. Apple App Attest (`platform: "device_check"`) — chain-verified
 *        against the pinned Apple root by `@motebit/crypto-appattest`.
 *        Strongest signal: the Apple CA attests the hardware keypair
 *        binding on top of the Secure Enclave's custody.
 *     2. Secure Enclave (`platform: "secure_enclave"`) — in-process
 *        ECDSA-P256 receipt verifiable by `@motebit/crypto`. Proves
 *        hardware custody but not Apple-signed provenance.
 *     3. Software (`platform: "software"`) — truthful "no hardware
 *        channel" sentinel. Safe to ship; scored lower by the semiring.
 *   Android:
 *     1. Android Hardware-Backed Keystore Attestation
 *        (`platform: "android_keystore"`) — X.509 chain
 *        chain-verified against the pinned Google Hardware
 *        Attestation roots (RSA + ECDSA P-384) by
 *        `@motebit/crypto-android-keystore`. The Android analogue of
 *        App Attest — Google's CA attests the hardware keypair binding
 *        on top of the TEE / StrongBox custody. Replaces the old
 *        Play Integrity path, which Google designed as per-app-key /
 *        network-mediated and could not satisfy motebit's
 *        public-anchor third-party-verifiability invariant. See
 *        `docs/doctrine/hardware-attestation.md` § "Three architectural
 *        categories".
 *     2. Software — same truthful sentinel.
 *
 * Each step's failure degrades to the next — errors are never
 * surfaced to the user, and a false hardware claim is never emitted.
 *
 * Kept pure — no AsyncStorage reads, no React state, no network.
 * Deterministic given a fixed `now()`; tests inject a clock.
 */

import {
  composeHardwareAttestationCredential,
  type HardwareAttestationCredentialSubject,
  type VerifiableCredential,
} from "@motebit/encryption";
// @motebit/sdk re-exports every @motebit/protocol type; apps consume
// the product vocabulary rather than reaching past it to the Layer 0 permissive floor.
// Enforced by `check-app-primitives`.
import type { HardwareAttestationClaim } from "@motebit/sdk";

import { Platform } from "react-native";

import {
  androidKeystoreAvailable,
  androidKeystoreMint,
  type NativeAndroidKeystore,
} from "../modules/expo-android-keystore/src/ExpoAndroidKeystoreModule";
import {
  appAttestAvailable,
  appAttestMint,
  type NativeAppAttest,
} from "../modules/expo-app-attest/src/ExpoAppAttestModule";
import {
  seAvailable,
  seMintAttestation,
  type NativeSecureEnclave,
} from "../modules/expo-secure-enclave/src/ExpoSecureEnclaveModule";

export interface MintHardwareCredentialOptions {
  /** Ed25519 identity public key, lowercase hex (64 chars). */
  readonly identityPublicKeyHex: string;
  /** Ed25519 private key bytes (32 bytes). */
  readonly privateKey: Uint8Array;
  /**
   * Derived from the private key; supplied by caller to avoid a
   * duplicate derivation. Mirrors the desktop signature so the two
   * surfaces feel identical at the call site.
   */
  readonly publicKey: Uint8Array;
  readonly motebitId: string;
  readonly deviceId: string;
  /** Injected for test determinism. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Injectable Secure Enclave native module. Tests pass a fake
   * implementing `{ seAvailable, seMintAttestation }`; production uses
   * the default-loaded Expo module.
   */
  readonly native?: NativeSecureEnclave;
  /**
   * Injectable App Attest native module. Tests pass a fake
   * implementing `{ appAttestAvailable, appAttestMint }`; production
   * uses the default-loaded Expo module.
   */
  readonly nativeAppAttest?: NativeAppAttest;
  /**
   * Injectable Android Keystore native module. Tests pass a fake
   * implementing `{ androidKeystoreAvailable, androidKeystoreMint }`;
   * production uses the default-loaded Expo module.
   */
  readonly nativeAndroidKeystore?: NativeAndroidKeystore;
  /**
   * Platform override (defaults to `Platform.OS`). Tests pin
   * `"ios"` / `"android"` explicitly so the cascade branch under test
   * is deterministic without spinning up a React Native runtime.
   */
  readonly platform?: "ios" | "android" | "web" | "windows" | "macos";
}

/**
 * Mint a hardware-attested self-signed `AgentTrustCredential` on
 * mobile. Cascades App Attest → Secure Enclave → software. The VC
 * envelope + eddsa-jcs-2022 signing is always delegated to
 * `composeHardwareAttestationCredential` — the single source of truth
 * shared with the CLI and desktop.
 */
export async function mintHardwareCredential(
  opts: MintHardwareCredentialOptions,
): Promise<VerifiableCredential<HardwareAttestationCredentialSubject>> {
  const attestation = await mintAttestationClaim(opts);
  const now = (opts.now ?? Date.now)();
  return composeHardwareAttestationCredential({
    publicKey: opts.publicKey,
    publicKeyHex: opts.identityPublicKeyHex,
    privateKey: opts.privateKey,
    hardwareAttestation: attestation,
    now,
  });
}

/**
 * Build a fresh `HardwareAttestationClaim` for the caller's Ed25519
 * identity. Tries App Attest first (strongest proof, Apple-CA-attested),
 * then Secure Enclave (hardware custody, no chain), then a truthful
 * software sentinel. Never throws in the routine path — the fallback
 * IS the failure mode, by design, exactly as on desktop.
 */
export async function mintAttestationClaim(
  opts: MintHardwareCredentialOptions,
): Promise<HardwareAttestationClaim> {
  const attestedAt = (opts.now ?? Date.now)();
  const platform = opts.platform ?? Platform.OS;

  if (platform === "android") {
    // Android path: Hardware-Backed Keystore Attestation first, then
    // software. Neither App Attest nor Secure Enclave exists on
    // Android (both are iOS-only); calling them would waste a round-
    // trip and rely on the stub rejection path.
    //
    // Replaced the old Play Integrity cascade — Play Integrity is
    // structurally not third-party verifiable (per-app key,
    // Google-API-mediated). Android Keystore Attestation is the
    // sovereign-verifiable Android primitive.
    if (await androidKeystoreAvailable(opts.nativeAndroidKeystore)) {
      try {
        const result = await androidKeystoreMint(
          {
            motebitId: opts.motebitId,
            deviceId: opts.deviceId,
            identityPublicKeyHex: opts.identityPublicKeyHex.toLowerCase(),
            attestedAt,
          },
          opts.nativeAndroidKeystore,
        );
        return {
          platform: "android_keystore",
          key_exported: false,
          // Wire format: `{leafCertB64}.{intermediatesJoinedB64}` —
          // leaf-first DER chain with comma-joined intermediates and
          // the root cert dropped (the verifier supplies it from
          // pinned anchors). `@motebit/crypto-android-keystore`
          // splits on `.`, walks the chain against
          // `DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS`, parses the leaf
          // KeyDescription extension, and byte-compares the
          // attestationChallenge against `SHA-256(canonical body)`
          // re-derived from the caller's identity fields.
          attestation_receipt: result.receipt,
        };
      } catch {
        // Every AndroidKeystoreError reason degrades to software.
        // Never surface an error; never emit a false hardware claim.
      }
    }
    return softwareFallback();
  }

  // iOS (default) path — unchanged cascade: App Attest → Secure Enclave
  // → software.
  // 1. App Attest — strongest available signal.
  if (await appAttestAvailable(opts.nativeAppAttest)) {
    try {
      const result = await appAttestMint(
        {
          motebitId: opts.motebitId,
          deviceId: opts.deviceId,
          identityPublicKeyHex: opts.identityPublicKeyHex.toLowerCase(),
          attestedAt,
        },
        opts.nativeAppAttest,
      );
      return {
        platform: "device_check",
        key_exported: false,
        // Wire format: attObj.keyId.clientDataHash — three base64url
        // segments the verifier in @motebit/crypto-appattest splits on
        // `.`. This is DISTINCT from the Secure Enclave receipt (two
        // segments); the platform discriminator tells the verifier
        // which split to use.
        attestation_receipt: `${result.attestation_object_base64}.${result.key_id_base64}.${result.client_data_hash_base64}`,
      };
    } catch {
      // Every AppAttestError reason degrades to the next tier. Never
      // surface an error to the user; never emit a false hardware
      // claim.
    }
  }

  // 2. Secure Enclave — hardware custody without Apple attestation
  //    chain.
  if (await seAvailable(opts.native)) {
    try {
      const result = await seMintAttestation(
        {
          motebitId: opts.motebitId,
          deviceId: opts.deviceId,
          identityPublicKeyHex: opts.identityPublicKeyHex.toLowerCase(),
          attestedAt,
        },
        opts.native,
      );
      return {
        platform: "secure_enclave",
        key_exported: false,
        attestation_receipt: `${result.body_base64}.${result.signature_der_base64}`,
      };
    } catch {
      // Matches `apps/desktop/src/secure-enclave-attest.ts` — every
      // SE error reason degrades the same way.
    }
  }

  // 3. Software — truthful "no hardware channel" sentinel.
  return softwareFallback();
}

function softwareFallback(): HardwareAttestationClaim {
  return {
    platform: "software",
    key_exported: false,
  };
}
