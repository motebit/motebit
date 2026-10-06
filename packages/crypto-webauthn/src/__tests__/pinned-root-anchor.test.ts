/**
 * Pinned-root anchor negative test.
 *
 * The chain verifier enforces several independent invariants (CA
 * constraint, per-cert signature, validity window, terminal
 * self-signed). Each existing rejection test trips one of those. None
 * of them isolates the LAST line of defence: the terminal cert's DER
 * must byte-equal a pinned FIDO root. Without that check, anyone can
 * mint their own self-signed "FIDO root", issue a CA + attestation leaf
 * under it, ship the whole chain in `x5c`, and the verifier would walk
 * a perfectly well-formed chain to the attacker's anchor.
 *
 * This file builds exactly that: an attacker-generated root (cA=true,
 * self-signed), an attacker intermediate (cA=true), and a packed leaf,
 * all within validity, all signatures correct, the leaf signing
 * `authData || clientDataHash` over the correct identity-bound
 * challenge. A positive control proves the chain is well-formed (it
 * verifies when the attacker root IS pinned). The negative cases pin a
 * different root set — so the ONLY thing that can reject is the pin.
 */

import { describe, expect, it } from "vitest";
import { encode as cborEncode } from "cbor2";
import * as x509 from "@peculiar/x509";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { verifyWebAuthnAttestation } from "../verify.js";
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
  canonicalAttestationBody,
  concat,
  fromBase64Url,
  sha256Bytes,
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
 * Build a fully well-formed packed attestation whose chain
 * (leaf → intermediate → root) terminates at an attacker-generated,
 * self-signed CA root. The root cert itself is shipped in `x5c`, so
 * the chain builder can reach it without any help from the pinned set.
 */
async function buildAttackerRootedFixture(): Promise<{
  receipt: string;
  attackerRootPem: string;
}> {
  const rootKeys = await subtle.generateKey(ALG, true, ["sign", "verify"]);
  const intermediateKeys = await subtle.generateKey(ALG, true, ["sign", "verify"]);
  const leafKeys = await subtle.generateKey(ALG, true, ["sign", "verify"]);

  const attackerRoot = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "a1",
    name: "CN=Attacker FIDO Root CA, O=Attacker",
    notBefore: new Date("2024-01-01"),
    notAfter: new Date("2099-01-01"),
    signingAlgorithm: ALG,
    keys: rootKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 2, true)],
  });

  const attackerIntermediate = await x509.X509CertificateGenerator.create({
    serialNumber: "a2",
    issuer: attackerRoot.subject,
    subject: "CN=Attacker FIDO Intermediate CA, O=Attacker",
    notBefore: new Date("2024-01-01"),
    notAfter: new Date("2099-01-01"),
    signingAlgorithm: ALG,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [new x509.BasicConstraintsExtension(true, 1, true)],
  });

  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "a3",
    issuer: attackerIntermediate.subject,
    subject: "CN=Attacker Packed Attestation Leaf, O=Attacker",
    notBefore: new Date("2024-01-01"),
    notAfter: new Date("2099-01-01"),
    signingAlgorithm: ALG,
    publicKey: leafKeys.publicKey,
    signingKey: intermediateKeys.privateKey,
    extensions: [],
  });

  // Correct identity-bound challenge — the attacker controls the
  // authenticator, so every non-anchor check is satisfiable.
  const body = canonicalAttestationBody({
    attestedAt: ATTESTED_AT,
    deviceId: DEVICE_ID,
    identityPublicKeyHex: IDENT,
    motebitId: MOTEBIT_ID,
  });
  const challenge = await sha256Bytes(new TextEncoder().encode(body));
  const authData = await buildAuthData({ rpId: RP });
  const clientDataJSON = buildClientDataJSON(challenge, ORIGIN);
  const clientDataHash = await sha256Bytes(clientDataJSON);

  const leafPrivateJwk = await subtle.exportKey("jwk", leafKeys.privateKey);
  const leafPrivBytes = fromBase64Url(leafPrivateJwk.d as string);
  const digest = sha256(concat(authData, clientDataHash));
  const sigDer = p256.sign(digest, leafPrivBytes, { prehash: false, format: "der" });

  const x5c: Uint8Array[] = [
    new Uint8Array(leaf.rawData),
    new Uint8Array(attackerIntermediate.rawData),
    new Uint8Array(attackerRoot.rawData),
  ];
  const attestationObject = cborEncode({
    fmt: "packed",
    attStmt: { alg: -7, sig: sigDer, x5c },
    authData,
  });

  const receipt = [
    toBase64Url(new Uint8Array(attestationObject)),
    toBase64Url(clientDataJSON),
  ].join(".");
  return { receipt, attackerRootPem: attackerRoot.toString("pem") };
}

function verify(receipt: string, rootPems?: ReadonlyArray<string>) {
  return verifyWebAuthnAttestation(
    { platform: "webauthn", attestation_receipt: receipt },
    {
      expectedRpId: RP,
      expectedIdentityPublicKeyHex: IDENT,
      expectedMotebitId: MOTEBIT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedAttestedAt: ATTESTED_AT,
      ...(rootPems !== undefined ? { rootPems } : {}),
      now: NOW,
    },
  );
}

describe("verifyWebAuthnAttestation — pinned-root anchor", () => {
  it("control: the attacker chain is well-formed (verifies when its own root is pinned)", async () => {
    const { receipt, attackerRootPem } = await buildAttackerRootedFixture();
    const result = await verify(receipt, [attackerRootPem]);
    expect(result.errors).toEqual([]);
    expect(result.cert_chain_valid).toBe(true);
    expect(result.signature_valid).toBe(true);
    expect(result.rp_bound).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("rejects a valid chain terminating at an attacker root not in the injected pinned set", async () => {
    const { receipt } = await buildAttackerRootedFixture();
    // An unrelated, legitimately-pinned root (distinct key + DN).
    const { rootPem: pinnedRootPem } = await buildFullAttestationFixture({
      rpId: RP,
      origin: ORIGIN,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
      deviceId: DEVICE_ID,
      attestedAt: ATTESTED_AT,
    });

    const result = await verify(receipt, [pinnedRootPem]);
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
    expect(result.attestation_kind).toBe("full");
    // Everything except the anchor holds — the pin is the sole rejector.
    expect(result.rp_bound).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(
      result.errors.some((e) => e.message.includes("does not match any pinned FIDO root")),
    ).toBe(true);
  });

  it("rejects a valid chain terminating at an attacker root against the default FIDO roots", async () => {
    const { receipt } = await buildAttackerRootedFixture();
    const result = await verify(receipt);
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
    expect(result.rp_bound).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(
      result.errors.some((e) => e.message.includes("does not match any pinned FIDO root")),
    ).toBe(true);
  });
});
