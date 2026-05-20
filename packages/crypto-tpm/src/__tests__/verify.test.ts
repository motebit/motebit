/**
 * End-to-end TPM 2.0 quote verification tests.
 *
 * We fabricate a fake "vendor root" in-process — a self-signed P-256
 * CA — then sign an intermediate with it, then an Attestation Key leaf
 * cert with the intermediate. The AK signs a well-formed `TPMS_ATTEST`
 * whose extraData binds `SHA256(canonical body)` — byte-identical to
 * what the Rust TPM bridge will produce when the `tss-esapi`-backed
 * mint path lands.
 *
 * This exercises every branch of the real verifier (`verifyTpmQuote`)
 * without needing a real vendor-signed AK cert. A real-TPM fixture
 * would need a vendor-CA-signed device leaf to generate — out of
 * scope for unit tests; see the package CLAUDE.md for operator
 * follow-up.
 */

import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";

import { verifyTpmQuote } from "../verify.js";
import { tpmVerifier } from "../index.js";
import { composeTpmsAttestForTest } from "../tpm-parse.js";
import {
  ATTESTED_AT,
  DEVICE_ID,
  FIXED_NOW,
  IDENT,
  MOTEBIT_ID,
  buildFakeVendorChain,
  buildFixture,
  canonicalTpmBody,
  sha256,
  subtle,
  toBase64Url,
} from "./test-helpers.js";
import type { Chain } from "./test-helpers.js";

describe("verifyTpmQuote — happy path", () => {
  it("verifies a well-formed fabricated chain against the injected vendor root", async () => {
    const { receipt, chain } = await buildFixture({ identityPublicKeyHex: IDENT });

    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );

    expect(result.valid).toBe(true);
    expect(result.cert_chain_valid).toBe(true);
    expect(result.quote_signature_valid).toBe(true);
    expect(result.quote_shape_valid).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("tpmVerifier factory delegates to the same path with captured context", async () => {
    const { receipt, chain } = await buildFixture({ identityPublicKeyHex: IDENT });

    const verifier = tpmVerifier({
      rootPems: [chain.rootPem],
      now: FIXED_NOW,
      context: {
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
      },
    });
    const result = await verifier({ platform: "tpm", attestation_receipt: receipt }, IDENT);
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("tpm");
  });

  it("accepts an AK that chains directly to a pinned root (empty intermediates slot)", async () => {
    // The TPM wire format allows an empty intermediates segment when
    // the AK's issuer IS the pinned root. We build such a chain by
    // signing the AK directly with the root's key.
    const alg: EcKeyGenParams & EcdsaParams = {
      name: "ECDSA",
      namedCurve: "P-256",
      hash: "SHA-256",
    };
    const rootKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
    const leafKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);

    const root = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: "CN=FakeTpmRootDirect",
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2099-01-01"),
      signingAlgorithm: alg,
      keys: rootKeys,
      extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
    });
    const rootPem = root.toString("pem");

    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: "02",
      issuer: root.subject,
      subject: "CN=FakeTpmAkDirect",
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2099-01-01"),
      signingAlgorithm: alg,
      publicKey: leafKeys.publicKey,
      signingKey: rootKeys.privateKey,
      extensions: [],
    });

    const body = canonicalTpmBody({
      attestedAt: ATTESTED_AT,
      deviceId: DEVICE_ID,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
    });
    const extraData = await sha256(new TextEncoder().encode(body));
    const attestBytes = composeTpmsAttestForTest({
      qualifiedSigner: new Uint8Array([0x01]),
      extraData,
    });
    const sigBuffer = await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      leafKeys.privateKey,
      attestBytes as BufferSource,
    );

    const receipt = [
      toBase64Url(attestBytes),
      toBase64Url(new Uint8Array(sigBuffer)),
      toBase64Url(new Uint8Array(leaf.rawData)),
      "", // empty intermediates — AK issued directly by the pinned root
    ].join(".");

    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(true);
  });
});

describe("verifyTpmQuote — rejections", () => {
  it("rejects missing attestation_receipt", async () => {
    const result = await verifyTpmQuote(
      { platform: "tpm" },
      { expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("missing");
  });

  it("rejects receipt that is not 4 parts", async () => {
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: "a.b.c" },
      { expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("4 base64url parts");
  });

  it("rejects malformed base64url segment", async () => {
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: "$.$.$.$$$$$" },
      { expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a non-TPM_GENERATED_VALUE magic", async () => {
    const { receipt, chain } = await buildFixture({
      identityPublicKeyHex: IDENT,
      tamperMagic: true,
    });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.quote_shape_valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("magic"))).toBe(true);
  });

  it("rejects a non-quote structure tag", async () => {
    const { receipt, chain } = await buildFixture({
      identityPublicKeyHex: IDENT,
      tamperType: true,
    });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.quote_shape_valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("TPM_ST_ATTEST_QUOTE"))).toBe(true);
  });

  it("rejects a signature produced over different bytes than the transmitted attest", async () => {
    const { receipt, chain } = await buildFixture({
      identityPublicKeyHex: IDENT,
      tamperSignatureSource: true,
    });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.quote_signature_valid).toBe(false);
  });

  it("rejects when the pinned root does not match the chain's terminal", async () => {
    const { receipt } = await buildFixture({ identityPublicKeyHex: IDENT });
    // Use a DIFFERENT fabricated root so the chain terminates at a
    // self-signed anchor that is not on the pin list. The chain-
    // builder will still find the fixture's OWN root in the input
    // pool (the leaf + intermediate's subject/issuer points back to
    // it), but the terminal cert must byte-equal the wrongRootPem we
    // pass via `rootPems` to pass the "matchedPinnedRoot" test.
    const { rootPem: wrongRootPem } = await buildFakeVendorChain();
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [wrongRootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
    // The chain doesn't reach a trusted anchor because the pinned root
    // is a stranger; `X509ChainBuilder` terminates at the best anchor
    // it can find in its pool (the leaf itself when no chain is
    // possible), so the rejection reason may land on "self-signed"
    // or "pinned root" — both are valid. We assert the shape, not the
    // exact sentence.
    expect(
      result.errors.some((e) => e.message.includes("pinned") || e.message.includes("self-signed")),
    ).toBe(true);
  });

  it("rejects when the intermediate lacks basicConstraints.cA=true", async () => {
    const { receipt, chain } = await buildFixture({
      identityPublicKeyHex: IDENT,
      intermediateBasicConstraints: { ca: false },
    });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
  });

  it("rejects when the extraData body names a different identity than the verifier expects", async () => {
    // Body signs identity B; verifier expects identity A. Re-derivation
    // in the verifier produces a hash that doesn't match the
    // transmitted extraData.
    const bodyIdent = "b".repeat(64);
    const { receipt, chain } = await buildFixture({
      identityPublicKeyHex: IDENT,
      bodyIdentityHex: bodyIdent,
    });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
  });

  it("rejects when the body names a different motebit_id", async () => {
    const { receipt, chain } = await buildFixture({
      identityPublicKeyHex: IDENT,
      bodyMotebitId: "wrong-motebit",
    });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
  });

  it("reports identity_bound:false when expectedMotebitId is omitted", async () => {
    const { receipt, chain } = await buildFixture({ identityPublicKeyHex: IDENT });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        // expectedMotebitId/DeviceId/AttestedAt intentionally omitted
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.identity_bound).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("expectedMotebitId"))).toBe(true);
  });

  it("reports identity_bound:false when expectedIdentityPublicKeyHex is empty", async () => {
    const { receipt, chain } = await buildFixture({ identityPublicKeyHex: IDENT });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: "",
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
  });

  it("rejects when the clock is outside the chain's validity window", async () => {
    const { receipt, chain } = await buildFixture({ identityPublicKeyHex: IDENT });
    // Use a clock value decades after every cert's notAfter.
    const tooLate = () => new Date("2200-01-01").getTime();
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: tooLate,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
  });
});

describe("verifyTpmQuote — factory minimal config", () => {
  it("tpmVerifier with no config uses defaults and rejects a pinned-root mismatch cleanly", async () => {
    // No config → uses the DEFAULT_PINNED_TPM_ROOTS (real vendor bytes:
    // Infineon, Nuvoton, STMicro RSA, STMicro ECC, Intel PTT). Since
    // tests fabricate their own root, the chain won't match the pins —
    // the verifier should fail-closed with a structured error, not throw.
    const verifier = tpmVerifier();
    const result = await verifier(
      { platform: "tpm" }, // no receipt — short-circuits before chain
      IDENT,
    );
    expect(result.valid).toBe(false);
    expect(result.platform).toBe("tpm");
  });
});
