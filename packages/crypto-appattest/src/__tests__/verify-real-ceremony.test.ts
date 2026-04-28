/**
 * End-to-end verification against a REAL captured Apple App Attest
 * attestation ceremony.
 *
 * Distinguishing claim vs. `verify.test.ts`:
 *   - `verify.test.ts` exercises every branch of the verifier against
 *     in-process synthetic chains (real ECDSA / real CBOR / real X.509,
 *     but root + leaf fabricated at test time). Proves the verifier's
 *     LOGIC is correct.
 *   - This file exercises the verifier against REAL DEVICE-EMITTED bytes
 *     captured from an actual iPhone running the mobile app's mint flow,
 *     validated against the production-pinned `APPLE_APPATTEST_ROOT_PEM`
 *     with NO test-only `rootPem` override. Proves the verifier AGREES
 *     with what real iOS hardware emits in the wild — the moat-provability
 *     claim, second of five platform leaves (after WebAuthn).
 *
 * Identity-binding (`clientDataHash === SHA256(motebit canonical body)`)
 * is by design UNSATISFIABLE for a captured ceremony unless the capture
 * happened to use the exact `(attested_at, device_id, identity_public_key,
 * motebit_id)` tuple the test asserts — which is reasonable for a motebit-
 * team capture but cannot be re-derived deterministically without storing
 * those values alongside the receipt. So `identity_bound` is asserted
 * false (consistent with the WebAuthn / Android Keystore real-ceremony
 * tests); the synthetic suite proves identity-binding semantics.
 *
 * Fixture provenance: see `fixtures/iphone-appattest-real.json` —
 * captured from a motebit-team iPhone via the existing mobile mint flow
 * (apps/mobile/src/mint-hardware-credential.ts).
 *
 * Skip behaviour: the suite skips cleanly when the fixture is the
 * committed placeholder (empty `attestation_object_base64url`). Once
 * real bytes land via `scripts/capture-app-attest-fixture.ts`, the
 * suite runs automatically with no test-side change.
 */

import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";

import { verifyAppAttestReceipt } from "../verify.js";

import fixture from "./fixtures/iphone-appattest-real.json" with { type: "json" };

x509.cryptoProvider.set(new Crypto() as unknown as globalThis.Crypto);

// Skip-until-captured guard. The placeholder fixture has empty strings;
// once a real iPhone capture lands, attestation_object_base64url is a
// CBOR-encoded attestation object well over 100 bytes (typical: ~1.5 KB).
const captured = fixture.attestation_object_base64url.length > 100;
const describeReal = captured ? describe : describe.skip;

describeReal("verifyAppAttestReceipt — real iPhone ceremony", () => {
  const receipt =
    `${fixture.attestation_object_base64url}` +
    `.${fixture.key_id_base64url}` +
    `.${fixture.client_data_hash_base64url}`;

  // The fixture's leaf cert validity window predates "now" by the time CI
  // runs, so chain-validity checks need a clock pinned inside notBefore..
  // notAfter. The capture script writes verify_as_of_iso at capture time.
  const fixedClock = (): number => new Date(fixture.verify_as_of_iso).getTime();

  it("validates chain + nonce + bundle binding against the pinned Apple App Attest root", async () => {
    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      {
        // No `rootPem` override — chain must validate against the
        // production-pinned `APPLE_APPATTEST_ROOT_PEM`.
        expectedBundleId: fixture.bundle_id,
        expectedIdentityPublicKeyHex: "a".repeat(64), // dummy; identity-binding intentionally not satisfiable here
        now: fixedClock,
      },
    );

    expect(result.cert_chain_valid).toBe(true);
    expect(result.nonce_bound).toBe(true);
    expect(result.bundle_bound).toBe(true);

    // Identity-binding fails by design (captured clientDataHash is the
    // hash the mint flow used at capture time, not the dummy public key
    // above). Top-level `valid` is therefore false — the synthetic suite
    // proves identity-binding semantics.
    expect(result.identity_bound).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("identity"))).toBe(true);
  });

  it("rejects when the expected bundleId does not match the captured ceremony", async () => {
    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      {
        expectedBundleId: "com.evil.spoof", // mismatch
        expectedIdentityPublicKeyHex: "a".repeat(64),
        now: fixedClock,
      },
    );
    expect(result.bundle_bound).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("rejects when the pinned root does not include Apple App Attest", async () => {
    // Override the root accept-set with the Apple WebAuthn root (a different
    // Apple CA) — chain termination must NOT match the App Attest root,
    // proving the pinning is load-bearing against real hardware bytes,
    // not just synthetic ones.
    const APPLE_WEBAUTHN_ONLY_PEM = `-----BEGIN CERTIFICATE-----
MIICEjCCAZmgAwIBAgIQaB0BbHo84wIlpQGUKEdXcTAKBggqhkjOPQQDAzBLMR8w
HQYDVQQDDBZBcHBsZSBXZWJBdXRobiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJ
bmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMB4XDTIwMDMxODE4MjEzMloXDTQ1MDMx
NTAwMDAwMFowSzEfMB0GA1UEAwwWQXBwbGUgV2ViQXV0aG4gUm9vdCBDQTETMBEG
A1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTB2MBAGByqGSM49
AgEGBSuBBAAiA2IABCJCQ2pTVhzjl4Wo6IhHtMSAzO2cv+H9DQKev3//fG59G11k
xu9eI0/7o6V5uShBpe1u6l6mS19S1FEh6yGljnZAJ+2GNP1mi/YK2kSXIuTHjxA/
pcoRf7XkOtO4o1qlcaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUJtdk
2cV4wlpn0afeaxLQG2PxxtcwDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2cA
MGQCMFrZ+9DsJ1PW9hfNdBywZDsWDbWFp28it1d/5w2RPkRX3Bbn/UbDTNLx7Jr3
jAGGiQIwHFj+dJZYUJR786osByBelJYsVZd2GbHQu209b5RCmGQ21gWSw2PdMsSn
1LabATR4H7iIgXPxz8m8KiS1hXiz
-----END CERTIFICATE-----
`;
    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      {
        expectedBundleId: fixture.bundle_id,
        expectedIdentityPublicKeyHex: "a".repeat(64),
        rootPem: APPLE_WEBAUTHN_ONLY_PEM,
        now: fixedClock,
      },
    );
    expect(result.cert_chain_valid).toBe(false);
    expect(result.valid).toBe(false);
  });
});
