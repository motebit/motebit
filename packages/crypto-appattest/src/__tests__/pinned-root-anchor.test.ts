/**
 * Pinned-root trust-anchor tests.
 *
 * The verifier's chain pool is `{x5c[0] (leaf), x5c[1], pinned root}`.
 * An attacker who controls the native client controls `x5c` entirely, so
 * the strongest forgery available is: mint their OWN self-signed CA root,
 * issue a leaf under it carrying a correct Apple nonce extension, and ship
 * that CA root in the `x5c[1]` slot. The chain builder then resolves
 * leaf → attacker CA root, which is self-signed, carries
 * `basicConstraints.cA=true`, has valid signatures, and is in its
 * validity window. Nonce, bundle, and identity bindings are all correct
 * because the attacker computed them honestly.
 *
 * The ONLY check that rejects this receipt is the DER comparison against
 * the pinned root (`verifyCertChain` in `verify.ts`). A positive control
 * (same receipt, verifier pinned to the attacker root) proves the forgery
 * is otherwise well-formed — so a regression that drops the pin turns
 * these tests red, not some unrelated parse failure.
 */

import { describe, expect, it } from "vitest";
import { encode as cborEncode } from "cbor2";
import * as x509 from "@peculiar/x509";

import { verifyAppAttestReceipt } from "../verify.js";
import type { AppAttestVerifyOptions } from "../verify.js";
import {
  APPLE_NONCE_OID,
  ATTESTED_AT,
  BUNDLE,
  DEVICE_ID,
  IDENT,
  MOTEBIT_ID,
  buildFakeChain,
  canonicalAttestationBody,
  concat,
  encodeAppleNonceExtension,
  sha256,
  subtle,
  toBase64Url,
} from "./test-helpers.js";

const NOW = (): number => new Date("2026-04-22").getTime();

const ALG: EcKeyGenParams & EcdsaParams = {
  name: "ECDSA",
  namedCurve: "P-256",
  hash: "SHA-256",
};

/**
 * Build an attacker-rooted receipt whose every binding is correct:
 * a fresh self-signed CA root (P-256, cA=true) issues a leaf carrying
 * the Apple nonce extension over `SHA256(authData || clientDataHash)`,
 * and the attacker root rides in the `x5c[1]` slot.
 */
async function buildAttackerRootedReceipt(): Promise<{
  receipt: string;
  attackerRootPem: string;
}> {
  const rpIdHash = await sha256(new TextEncoder().encode(BUNDLE));
  const authData = concat(rpIdHash, new Uint8Array(10));
  const clientDataHash = await sha256(
    new TextEncoder().encode(
      canonicalAttestationBody({
        attestedAt: ATTESTED_AT,
        deviceId: DEVICE_ID,
        identityPublicKeyHex: IDENT,
        motebitId: MOTEBIT_ID,
      }),
    ),
  );
  const nonce = await sha256(concat(authData, clientDataHash));

  const attackerRootKeys = await subtle.generateKey(ALG, true, ["sign", "verify"]);
  const leafKeys = await subtle.generateKey(ALG, true, ["sign", "verify"]);

  const attackerRoot = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "0a",
    name: "CN=Apple App Attestation Root CA, O=Apple Inc., ST=California",
    notBefore: new Date("2024-01-01"),
    notAfter: new Date("2099-01-01"),
    signingAlgorithm: ALG,
    keys: attackerRootKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 1, true)],
  });

  const nonceBytes = encodeAppleNonceExtension(nonce);
  const nonceBuffer = nonceBytes.buffer.slice(
    nonceBytes.byteOffset,
    nonceBytes.byteOffset + nonceBytes.byteLength,
  ) as ArrayBuffer;
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "0b",
    issuer: attackerRoot.subject,
    subject: "CN=AttackerAppAttestLeaf",
    notBefore: new Date("2024-01-01"),
    notAfter: new Date("2099-01-01"),
    signingAlgorithm: ALG,
    publicKey: leafKeys.publicKey,
    signingKey: attackerRootKeys.privateKey,
    extensions: [new x509.Extension(APPLE_NONCE_OID, false, nonceBuffer)],
  });

  const cbor = cborEncode({
    fmt: "apple-appattest",
    attStmt: {
      x5c: [new Uint8Array(leaf.rawData), new Uint8Array(attackerRoot.rawData)],
      receipt: new Uint8Array([0x01, 0x02]),
    },
    authData,
  });
  const receipt = [
    toBase64Url(new Uint8Array(cbor)),
    toBase64Url(new TextEncoder().encode("attacker-key-id")),
    toBase64Url(clientDataHash),
  ].join(".");

  return { receipt, attackerRootPem: attackerRoot.toString("pem") };
}

function opts(rootPem: string | undefined): AppAttestVerifyOptions {
  return {
    expectedBundleId: BUNDLE,
    expectedIdentityPublicKeyHex: IDENT,
    expectedMotebitId: MOTEBIT_ID,
    expectedDeviceId: DEVICE_ID,
    expectedAttestedAt: ATTESTED_AT,
    ...(rootPem !== undefined ? { rootPem } : {}),
    now: NOW,
  };
}

describe("verifyAppAttestReceipt — pinned root is the only trust anchor", () => {
  it("positive control: the attacker-rooted receipt is well-formed (verifies when pinned to the attacker root)", async () => {
    const { receipt, attackerRootPem } = await buildAttackerRootedReceipt();
    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      opts(attackerRootPem),
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects a valid chain terminating in an attacker-generated CA root when a different root is pinned", async () => {
    const { receipt } = await buildAttackerRootedReceipt();
    const legit = await buildFakeChain(new Uint8Array(32));

    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      opts(legit.rootPem),
    );

    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
    // Every other binding holds — the pin is the sole reason for rejection.
    expect(result.nonce_bound).toBe(true);
    expect(result.bundle_bound).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(result.errors.map((e) => e.message)).toEqual([
      "chain terminal cert DER does not match the pinned root",
    ]);
  });

  it("rejects the attacker-rooted chain against the default pinned Apple App Attest root", async () => {
    const { receipt } = await buildAttackerRootedReceipt();

    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      opts(undefined),
    );

    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
    expect(result.nonce_bound).toBe(true);
    expect(result.bundle_bound).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(result.errors.map((e) => e.message)).toEqual([
      "chain terminal cert DER does not match the pinned root",
    ]);
  });
});
