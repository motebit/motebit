/**
 * End-to-end verification against REAL captured Android Hardware-Backed
 * Keystore Attestation chains.
 *
 * Distinguishing claim vs. `verify.test.ts`:
 *   - `verify.test.ts` exercises every branch of the verifier against
 *     in-process synthetic chains (real ECDSA / real X.509 / real
 *     KeyDescription DER, but root + intermediates fabricated at test
 *     time). Proves the verifier's LOGIC is correct.
 *   - This file exercises the verifier against REAL DEVICE-EMITTED
 *     bytes captured from actual Android hardware (Google-internal
 *     preproduction Pixel 9a), validated against the production-pinned
 *     Google Hardware Attestation roots with NO test-only `rootPems`
 *     override. Proves the verifier AGREES with what real devices emit
 *     in the wild — the moat-provability claim.
 *
 * Both fixtures lift Apache-2.0 testdata from Google's first-party
 * reference verifier (`github.com/android/keyattestation`). The captures
 * are intentionally publishable — Google's signing identity
 * (`com.google.android.attestation`, signing-cert SHA-256
 * `EDk47kU35Z6O55L2VFBPuDRvxrNG0LvEQV/DOfz8jsE=`) is a known shared
 * Google-internal test signer, and the devices are pre-production handsets
 * Google explicitly published for downstream verifier consumption. Net
 * privacy leak beyond what Google ships in their Apache-2.0 testdata: 0
 * bits.
 *
 * Identity-binding (`attestationChallenge === SHA256(motebit canonical
 * body)`) is by design UNSATISFIABLE for a third-party-captured ceremony
 * — crafting a motebit body whose hash equals the captured challenge
 * would require a SHA-256 preimage attack. So `identity_bound` is
 * asserted false; the synthetic suite covers identity-binding semantics.
 *
 * Each fixture pins its own `verify-as-of` clock — Google's intermediate
 * certs have intentionally short validity windows (~14 days for the TEE
 * intermediate), so wall-clock verification fails the moment that window
 * closes. Pinning the timestamp matches Google's own VerifierTest
 * matrix.
 */

import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";

import { verifyAndroidKeystoreAttestation } from "../verify.js";
import {
  SECURITY_LEVEL_STRONG_BOX,
  SECURITY_LEVEL_TRUSTED_ENVIRONMENT,
  VERIFIED_BOOT_STATE_VERIFIED,
} from "../asn1.js";

import teeFixture from "./fixtures/tegu_sdk36_TEE_EC_2026_ROOT.json" with { type: "json" };
import strongBoxFixture from "./fixtures/tegu_sdk36_SB_EC_2026_ROOT.json" with { type: "json" };

x509.cryptoProvider.set(new Crypto() as unknown as globalThis.Crypto);

function fromBase64Url(str: string): Uint8Array {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

describe("verifyAndroidKeystoreAttestation — real Pixel 9a TEE ceremony", () => {
  it("validates a real Google-signed chain against the production-pinned ECDSA P-384 root", async () => {
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: teeFixture.attestation_receipt },
      {
        // No `rootPems` override — chain must validate against the
        // production-pinned `DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS`
        // (Google's RSA-4096 + ECDSA P-384 roots).
        expectedAttestationApplicationId: fromBase64Url(
          teeFixture.attestation_application_id_base64,
        ),
        expectedIdentityPublicKeyHex: "a".repeat(64), // dummy; identity-binding is intentionally not satisfiable here
        now: () => new Date(teeFixture.verify_as_of_iso).getTime(),
      },
    );

    expect(result.cert_chain_valid).toBe(true);
    expect(result.attestation_extension_valid).toBe(true);
    expect(result.attestation_security_level).toBe(SECURITY_LEVEL_TRUSTED_ENVIRONMENT);
    expect(result.verified_boot_state).toBe(VERIFIED_BOOT_STATE_VERIFIED);

    // Identity-binding fails by design (third-party challenge, not
    // SHA-256 of a motebit canonical body). Top-level `valid` is
    // therefore false — the synthetic suite proves identity-binding.
    expect(result.identity_bound).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("identity_bound"))).toBe(
      true,
    );
  });

  it("rejects when the expected attestationApplicationId does not match", async () => {
    const wrongAppId = new TextEncoder().encode("com.evil.spoof::wronghash");
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: teeFixture.attestation_receipt },
      {
        expectedAttestationApplicationId: wrongAppId,
        expectedIdentityPublicKeyHex: "a".repeat(64),
        now: () => new Date(teeFixture.verify_as_of_iso).getTime(),
      },
    );
    expect(result.attestation_extension_valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("attestationApplicationId"))).toBe(true);
  });

  it("rejects when the chain validity window is in the future of the wall clock", async () => {
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: teeFixture.attestation_receipt },
      {
        expectedAttestationApplicationId: fromBase64Url(
          teeFixture.attestation_application_id_base64,
        ),
        expectedIdentityPublicKeyHex: "a".repeat(64),
        now: () => new Date("2099-01-01").getTime(),
      },
    );
    expect(result.cert_chain_valid).toBe(false);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("validity"))).toBe(true);
  });
});

describe("verifyAndroidKeystoreAttestation — real Pixel 9a StrongBox ceremony", () => {
  it("validates a real StrongBox-attested chain + reports STRONG_BOX security level", async () => {
    const result = await verifyAndroidKeystoreAttestation(
      {
        platform: "android_keystore",
        attestation_receipt: strongBoxFixture.attestation_receipt,
      },
      {
        expectedAttestationApplicationId: fromBase64Url(
          strongBoxFixture.attestation_application_id_base64,
        ),
        expectedIdentityPublicKeyHex: "a".repeat(64),
        now: () => new Date(strongBoxFixture.verify_as_of_iso).getTime(),
      },
    );

    expect(result.cert_chain_valid).toBe(true);
    expect(result.attestation_extension_valid).toBe(true);
    expect(result.attestation_security_level).toBe(SECURITY_LEVEL_STRONG_BOX);
    expect(result.verified_boot_state).toBe(VERIFIED_BOOT_STATE_VERIFIED);

    // Same identity-binding caveat as the TEE fixture.
    expect(result.identity_bound).toBe(false);
    expect(result.valid).toBe(false);
  });
});
