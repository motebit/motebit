/**
 * End-to-end WebAuthn packed-attestation verification tests.
 *
 * Full attestation path: we fabricate a fake "FIDO root" in-process — a
 * self-signed P-256 CA — then sign a leaf with it. The leaf public key
 * signs `authData || clientDataHash` and the DER signature is shipped
 * in `attStmt.sig` with `attStmt.alg = -7` (ES256). The CBOR
 * attestation object is shaped like the browser emits (`packed` fmt).
 *
 * Self attestation path: no x5c — authData's attestedCredentialData
 * carries the credential public key as COSE_Key bytes. That same key
 * signs `authData || clientDataHash` and ships in `attStmt.sig`.
 *
 * The clientDataJSON is shaped as the browser emits (`type`, `origin`,
 * `challenge`), and the `challenge` is the byte-identical JCS canonical
 * body the web mint path composes — matching that encoding here is the
 * contract; if it drifts, the verifier's re-derivation step would
 * succeed for the wrong reason.
 *
 * This exercises every branch of the real verifier without needing a
 * real vendor-signed leaf.
 */

import { describe, expect, it } from "vitest";
import { encode as cborEncode } from "cbor2";
import * as x509 from "@peculiar/x509";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

import { verifyWebAuthnAttestation } from "../verify.js";
import { webauthnVerifier } from "../index.js";
import {
  ATTESTED_AT,
  DEVICE_ID,
  IDENT,
  MOTEBIT_ID,
  ORIGIN,
  RP,
  buildAuthData,
  buildClientDataJSON,
  buildFullAttestationFixture,
  buildSelfAttestationFixture,
  canonicalAttestationBody,
  concat,
  fromBase64Url,
  sha256Bytes,
  subtle,
  toBase64Url,
} from "./test-helpers.js";
import type { FullFixture } from "./test-helpers.js";

// ── Tests ────────────────────────────────────────────────────────────

describe("verifyWebAuthnAttestation — full attestation happy path", () => {
  it("verifies a well-formed fabricated chain against the injected root", async () => {
    const { receipt, rootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });

    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: () => new Date("2026-04-22").getTime(),
      },
    );

    expect(result.valid).toBe(true);
    expect(result.cert_chain_valid).toBe(true);
    expect(result.signature_valid).toBe(true);
    expect(result.rp_bound).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(result.attestation_kind).toBe("full");
    expect(result.errors).toEqual([]);
  });

  it("verifies a chain with intermediate + root both pinned", async () => {
    const { receipt, rootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
      withIntermediate: { ca: true },
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(true);
    expect(result.cert_chain_valid).toBe(true);
  });
});

describe("verifyWebAuthnAttestation — self attestation happy path", () => {
  it("verifies a self-attested receipt (no x5c; credential key signs challenge)", async () => {
    const { receipt } = await buildSelfAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(true);
    expect(result.signature_valid).toBe(true);
    expect(result.rp_bound).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(result.attestation_kind).toBe("self");
    // cert_chain_valid is trivially true for self attestation (no chain required).
    expect(result.cert_chain_valid).toBe(true);
  });
});

describe("webauthnVerifier factory", () => {
  it("delegates to the underlying verifier with threaded context", async () => {
    const { receipt, rootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const verifier = webauthnVerifier({
      expectedRpId: RP,
      rootPems: [rootPem],
      now: () => new Date("2026-04-22").getTime(),
    });
    const result = await verifier({ platform: "webauthn", attestation_receipt: receipt }, IDENT, {
      expectedMotebitId: MOTEBIT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedAttestedAt: ATTESTED_AT,
    });
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("webauthn");
    expect(result.attestation_detail?.attestation_kind).toBe("full");
  });

  it("factory handles minimal config with no optional overrides", async () => {
    const verifier = webauthnVerifier({ expectedRpId: RP });
    const result = await verifier({ platform: "webauthn" }, IDENT);
    expect(result.valid).toBe(false);
    expect(result.platform).toBe("webauthn");
  });
});

describe("verifyWebAuthnAttestation — rejections", () => {
  it("rejects missing attestation_receipt", async () => {
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn" },
      { expectedRpId: RP, expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("missing");
  });

  it("rejects receipt that isn't 2 parts", async () => {
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: "onlyone" },
      { expectedRpId: RP, expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("2 base64url parts");
  });

  it("rejects a malformed base64url segment", async () => {
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: "$$$.$$$" },
      { expectedRpId: RP, expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
  });

  it("rejects malformed CBOR", async () => {
    const bogus = new Uint8Array([0xff, 0xfe, 0xfd]);
    const fakeClientData = buildClientDataJSON(new Uint8Array(32), ORIGIN);
    const receipt = [toBase64Url(bogus), toBase64Url(fakeClientData)].join(".");
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      { expectedRpId: RP, expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("cbor"))).toBe(true);
  });

  it("rejects wrong fmt (e.g. apple)", async () => {
    const { receipt } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedFmt: "apple", // force mismatch
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("fmt"))).toBe(true);
  });

  it("rejects wrong rpId (rpIdHash mismatch)", async () => {
    const { receipt, rootPem } = await buildFullAttestationFixture({
      rpId: "other.example.com",
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.rp_bound).toBe(false);
    expect(result.errors.some((e) => e.message.includes("rpIdHash"))).toBe(true);
  });

  it("rejects when the pinned root does not match the chain", async () => {
    const { receipt } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    // Fabricate an INDEPENDENT root and pin it instead.
    const other = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [other.rootPem],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
  });

  it("rejects non-CA intermediate (basicConstraints.cA=false)", async () => {
    const { receipt, rootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
      withIntermediate: { ca: false },
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.message.toLowerCase().includes("ca") ||
          e.message.toLowerCase().includes("constraint") ||
          e.message.toLowerCase().includes("basicconstraints"),
      ),
    ).toBe(true);
  });

  it("rejects tampered challenge (body names identity A, verifier expects B)", async () => {
    const keyA = "a".repeat(64);
    const keyB = "b".repeat(64);
    const { receipt, rootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: keyA,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: keyB, // different!
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
  });

  it("rejects when expectedMotebitId is omitted (identity_bound fail-closed)", async () => {
    const { receipt, rootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
    expect(result.errors.some((e) => e.message.includes("expectedMotebitId"))).toBe(true);
  });

  it("rejects when expectedDeviceId is omitted", async () => {
    const { receipt, rootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
    expect(result.errors.some((e) => e.message.includes("expectedDeviceId"))).toBe(true);
  });

  it("rejects when expectedAttestedAt is omitted", async () => {
    const { receipt, rootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        rootPems: [rootPem],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
    expect(result.errors.some((e) => e.message.includes("expectedAttestedAt"))).toBe(true);
  });

  it("rejects when expectedIdentityPublicKeyHex is empty", async () => {
    const { receipt, rootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: "",
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
  });

  it("rejects invalid signature (tampered)", async () => {
    const { receipt, rootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
      forgeBadSignature: true,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.signature_valid).toBe(false);
  });

  it("rejects validity window outside leaf notAfter", async () => {
    const { receipt, rootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: () => new Date("2100-06-01").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("validity"))).toBe(true);
  });

  it("rejects when rootPems is empty", async () => {
    const { receipt } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        rootPems: [],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
  });

  it("rejects when authData is shorter than 32 bytes", async () => {
    const tinyAuthData = new Uint8Array(10);
    const fakeClientData = buildClientDataJSON(new Uint8Array(32), ORIGIN);
    const attestationObject = cborEncode({
      fmt: "packed",
      attStmt: { alg: -7, sig: new Uint8Array([0x30, 0x02, 0x02, 0x00]), x5c: [] },
      authData: tinyAuthData,
    });
    const receipt = [
      toBase64Url(new Uint8Array(attestationObject)),
      toBase64Url(fakeClientData),
    ].join(".");
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("authdata"))).toBe(true);
  });

  it("rejects packed with missing alg", async () => {
    const authData = await buildAuthData({ rpId: RP });
    const fakeClientData = buildClientDataJSON(new Uint8Array(32), ORIGIN);
    const attestationObject = cborEncode({
      fmt: "packed",
      attStmt: { sig: new Uint8Array([0x30, 0x02, 0x02, 0x00]), x5c: [] },
      authData,
    });
    const receipt = [
      toBase64Url(new Uint8Array(attestationObject)),
      toBase64Url(fakeClientData),
    ].join(".");
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("alg"))).toBe(true);
  });

  it("rejects non-ES256 alg (e.g. RS256 / -257)", async () => {
    const authData = await buildAuthData({ rpId: RP });
    const fakeClientData = buildClientDataJSON(new Uint8Array(32), ORIGIN);
    const attestationObject = cborEncode({
      fmt: "packed",
      attStmt: { alg: -257, sig: new Uint8Array([0x30, 0x02, 0x02, 0x00]), x5c: [] },
      authData,
    });
    const receipt = [
      toBase64Url(new Uint8Array(attestationObject)),
      toBase64Url(fakeClientData),
    ].join(".");
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("not supported"))).toBe(true);
  });

  it("rejects packed with missing sig", async () => {
    const authData = await buildAuthData({ rpId: RP });
    const fakeClientData = buildClientDataJSON(new Uint8Array(32), ORIGIN);
    const attestationObject = cborEncode({
      fmt: "packed",
      attStmt: { alg: -7, x5c: [] },
      authData,
    });
    const receipt = [
      toBase64Url(new Uint8Array(attestationObject)),
      toBase64Url(fakeClientData),
    ].join(".");
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("sig"))).toBe(true);
  });

  it("rejects when root PEM is malformed", async () => {
    const { receipt } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: ["-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----"],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
  });

  it("rejects clientDataJSON with missing challenge field", async () => {
    const { receipt: goodReceipt, rootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });
    // Swap clientDataJSON for one missing `challenge`.
    const attObjB64 = goodReceipt.split(".")[0]!;
    const tamperedClientData = new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.create", origin: ORIGIN }),
    );
    const receipt = `${attObjB64}.${toBase64Url(tamperedClientData)}`;
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: receipt },
      {
        expectedRpId: RP,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
  });
});
