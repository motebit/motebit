/**
 * End-to-end verification against a REAL captured WebAuthn `packed`
 * attestation ceremony.
 *
 * Distinguishing claim vs. `verify.test.ts`:
 *   - `verify.test.ts` exercises every branch of the verifier against
 *     in-process synthetic chains (real ECDSA / real CBOR / real X.509,
 *     but root + leaf fabricated at test time). Proves the verifier's
 *     LOGIC is correct.
 *   - This file exercises the verifier against REAL DEVICE-EMITTED bytes
 *     captured from an actual YubiKey 5 series authenticator during a
 *     registration ceremony. Proves the verifier AGREES with what real
 *     hardware emits in the wild — the moat-provability claim.
 *
 * The leaf chains to `Yubico U2F Root CA Serial 457200631`, which is
 * already pinned as `YUBICO_FIDO_ROOT_PEM` in `fido-roots.ts`. No
 * test-only `rootPems` override is supplied — chain validation runs
 * against the production accept-set.
 *
 * Identity-binding (clientDataJSON.challenge === SHA256(motebit canonical
 * body)) is by design UNSATISFIABLE for a third-party-captured ceremony:
 * the captured challenge is whatever webauthn.firstyear.id.au's server
 * generated, not a SHA-256 preimage of motebit's identity-naming body.
 * Crafting a motebit body whose hash equals the captured challenge would
 * require a SHA-256 preimage attack. So `identity_bound` is asserted
 * false; the synthetic suite covers identity-binding semantics.
 *
 * Fixture provenance: see `fixtures/yubico-packed-webauthn-rs.json` —
 * lifted from the kanidm/webauthn-rs reference implementation's test
 * suite (real bytes captured against William Brown's webauthn-rs
 * compatibility test site).
 */

import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";

import { verifyWebAuthnAttestation } from "../verify.js";

import fixture from "./fixtures/yubico-packed-webauthn-rs.json" with { type: "json" };

x509.cryptoProvider.set(new Crypto() as unknown as globalThis.Crypto);

describe("verifyWebAuthnAttestation — real YubiKey ceremony", () => {
  const receipt = `${fixture.attestation_object_base64url}.${fixture.client_data_json_base64url}`;

  // The fixture's leaf cert validity window predates "now" — clock pinned
  // inside the leaf's notBefore..notAfter range so chain-validity checks
  // exercise their happy path against real hardware bytes.
  const fixedClock = (): number => new Date("2024-06-01T00:00:00Z").getTime();

  it("validates chain + signature + RP binding against the pinned Yubico root", async () => {
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        // No `rootPems` override — chain must validate against the
        // production-pinned `DEFAULT_FIDO_ROOTS` (Apple, Yubico, Microsoft).
        expectedRpId: fixture.rp_id,
        expectedIdentityPublicKeyHex: "a".repeat(64), // dummy; identity-binding is intentionally not satisfiable here
        now: fixedClock,
      },
    );

    expect(result.cert_chain_valid).toBe(true);
    expect(result.signature_valid).toBe(true);
    expect(result.rp_bound).toBe(true);
    expect(result.attestation_kind).toBe("full");

    // Identity-binding fails by design (third-party ceremony, challenge
    // is not SHA256 of a motebit canonical body). Top-level `valid` is
    // therefore false — the synthetic suite proves identity-binding.
    expect(result.identity_bound).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("identity_bound"))).toBe(
      true,
    );
  });

  it("rejects when the expected RP ID does not match the captured ceremony", async () => {
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: "other.example.com", // mismatch
        expectedIdentityPublicKeyHex: "a".repeat(64),
        now: fixedClock,
      },
    );
    expect(result.rp_bound).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("rejects when the pinned root does not include Yubico", async () => {
    // Override the root accept-set with only the Apple root — chain
    // termination must NOT match, proving the pinning is load-bearing
    // against real hardware bytes (not just synthetic ones).
    const APPLE_ONLY_PEM = `-----BEGIN CERTIFICATE-----
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
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: fixture.rp_id,
        expectedIdentityPublicKeyHex: "a".repeat(64),
        rootPems: [APPLE_ONLY_PEM],
        now: fixedClock,
      },
    );
    expect(result.cert_chain_valid).toBe(false);
    expect(result.valid).toBe(false);
  });
});
