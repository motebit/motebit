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
import { Crypto } from "@peculiar/webcrypto";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

import { verifyWebAuthnAttestation } from "../verify.js";
import { webauthnVerifier } from "../index.js";

x509.cryptoProvider.set(new Crypto() as unknown as globalThis.Crypto);

const subtle = new Crypto().subtle;

// ── helpers ─────────────────────────────────────────────────────────

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mirror of the canonical body the web mint path composes. JCS-canonical
 * (alphabetically-ordered keys, no whitespace). The verifier re-derives
 * this same string to byte-compare against clientDataJSON.challenge.
 */
function canonicalAttestationBody(input: {
  attestedAt: number;
  deviceId: string;
  identityPublicKeyHex: string;
  motebitId: string;
}): string {
  const esc = (s: string): string => {
    let out = '"';
    for (const ch of s) {
      const code = ch.codePointAt(0)!;
      if (ch === '"') out += '\\"';
      else if (ch === "\\") out += "\\\\";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
      else out += ch;
    }
    return out + '"';
  };
  return (
    `{"attested_at":${input.attestedAt}` +
    `,"device_id":${esc(input.deviceId)}` +
    `,"identity_public_key":${esc(input.identityPublicKeyHex.toLowerCase())}` +
    `,"motebit_id":${esc(input.motebitId)}` +
    `,"platform":"webauthn"` +
    `,"version":"1"}`
  );
}

function buildClientDataJSON(challenge: Uint8Array, origin: string): Uint8Array {
  const obj = {
    type: "webauthn.create",
    challenge: toBase64Url(challenge),
    origin,
  };
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Build `authData` for the packed-attestation fixture. Layout:
 *   rpIdHash(32) || flags(1) || counter(4) || [attestedCredentialData]
 *
 * For full-attestation fixtures we emit AT=0 (no attested credential
 * data) — the chain-rooted leaf signs over the minimal authData.
 *
 * For self-attestation fixtures we set AT=1 and append the credential
 * public key as COSE_Key CBOR.
 */
async function buildAuthData(opts: {
  rpId: string;
  withCredentialPubKey?: { x: Uint8Array; y: Uint8Array };
  counter?: number;
}): Promise<Uint8Array> {
  const rpIdHash = await sha256Bytes(new TextEncoder().encode(opts.rpId));
  const atFlag = opts.withCredentialPubKey ? 0x40 : 0x00;
  const upFlag = 0x01; // user present — always set
  const flags = new Uint8Array([atFlag | upFlag]);
  const counter = new Uint8Array(4);
  new DataView(counter.buffer).setUint32(0, opts.counter ?? 0, false);

  if (!opts.withCredentialPubKey) {
    return concat(rpIdHash, flags, counter);
  }

  // aaguid(16) + credentialIdLen(2) + credentialId(credIdLen) + COSE_Key
  const aaguid = new Uint8Array(16);
  const credId = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  const credIdLen = new Uint8Array([0, credId.length]);
  // COSE_Key: { 1: 2, 3: -7, -1: 1, -2: x, -3: y }
  const coseMap = new Map<number, unknown>();
  coseMap.set(1, 2);
  coseMap.set(3, -7);
  coseMap.set(-1, 1);
  coseMap.set(-2, opts.withCredentialPubKey.x);
  coseMap.set(-3, opts.withCredentialPubKey.y);
  const coseBytes = cborEncode(coseMap);
  return concat(rpIdHash, flags, counter, aaguid, credIdLen, credId, new Uint8Array(coseBytes));
}

interface FullFixture {
  receipt: string;
  rootPem: string;
}

async function buildFullAttestationFixture(input: {
  rpId: string;
  origin: string;
  identityPublicKeyHex: string;
  motebitId: string;
  deviceId: string;
  attestedAt: number;
  /**
   * Override the intermediate's basicConstraints. Default is no
   * intermediate (root directly issues leaf). Tests exercise chain
   * depth via `withIntermediate: { ca: boolean }`.
   */
  withIntermediate?: { ca: boolean };
  /** Use a different body identity than the challenge one. */
  tamperedBodyIdentityHex?: string;
  /** Intentionally wrong signature (to exercise signature rejection). */
  forgeBadSignature?: boolean;
}): Promise<FullFixture> {
  const alg: EcKeyGenParams & EcdsaParams = {
    name: "ECDSA",
    namedCurve: "P-256",
    hash: "SHA-256",
  };
  const rootKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
  const leafKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);

  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=FakeFidoRoot",
    notBefore: new Date("2024-01-01"),
    notAfter: new Date("2099-01-01"),
    signingAlgorithm: alg,
    keys: rootKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 2, true)],
  });

  let issuingKey = rootKeys.privateKey;
  let issuerDn = root.subject;
  let intermediateCert: x509.X509Certificate | null = null;
  if (input.withIntermediate !== undefined) {
    const intermediateKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
    intermediateCert = await x509.X509CertificateGenerator.create({
      serialNumber: "02",
      issuer: root.subject,
      subject: "CN=FakeFidoIntermediate",
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2099-01-01"),
      signingAlgorithm: alg,
      publicKey: intermediateKeys.publicKey,
      signingKey: rootKeys.privateKey,
      extensions: [new x509.BasicConstraintsExtension(input.withIntermediate.ca, 1, true)],
    });
    issuingKey = intermediateKeys.privateKey;
    issuerDn = intermediateCert.subject;
  }

  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "03",
    issuer: issuerDn,
    subject: "CN=FakePackedLeaf",
    notBefore: new Date("2024-01-01"),
    notAfter: new Date("2099-01-01"),
    signingAlgorithm: alg,
    publicKey: leafKeys.publicKey,
    signingKey: issuingKey,
    extensions: [],
  });

  // Build the challenge (bound to the caller's identity).
  const body = canonicalAttestationBody({
    attestedAt: input.attestedAt,
    deviceId: input.deviceId,
    identityPublicKeyHex: input.tamperedBodyIdentityHex ?? input.identityPublicKeyHex,
    motebitId: input.motebitId,
  });
  const challenge = await sha256Bytes(new TextEncoder().encode(body));

  const authData = await buildAuthData({ rpId: input.rpId });
  const clientDataJSON = buildClientDataJSON(challenge, input.origin);
  const clientDataHash = await sha256Bytes(clientDataJSON);

  // Sign authData || clientDataHash with leaf's private key. The leaf
  // is a WebCrypto key; export to raw for signing via noble to produce
  // a DER signature cleanly.
  const leafPrivateJwk = await subtle.exportKey("jwk", leafKeys.privateKey);
  const leafPrivBytes = fromBase64Url(leafPrivateJwk.d as string);
  const signedBytes = concat(authData, clientDataHash);
  const digest = sha256(signedBytes);
  const sigRaw = input.forgeBadSignature
    ? p256.sign(new Uint8Array(32), leafPrivBytes, { prehash: false })
    : p256.sign(digest, leafPrivBytes, { prehash: false });
  const sigDer = sigRaw.toDERRawBytes();

  const x5c: Uint8Array[] = [new Uint8Array(leaf.rawData)];
  if (intermediateCert) x5c.push(new Uint8Array(intermediateCert.rawData));

  const attestationObject = cborEncode({
    fmt: "packed",
    attStmt: { alg: -7, sig: sigDer, x5c },
    authData,
  });

  const receipt = [
    toBase64Url(new Uint8Array(attestationObject)),
    toBase64Url(clientDataJSON),
  ].join(".");
  return { receipt, rootPem: root.toString("pem") };
}

async function buildSelfAttestationFixture(input: {
  rpId: string;
  origin: string;
  identityPublicKeyHex: string;
  motebitId: string;
  deviceId: string;
  attestedAt: number;
}): Promise<{ receipt: string }> {
  const credPriv = p256.utils.randomPrivateKey();
  const credPubUncompressed = p256.getPublicKey(credPriv, false);
  // Uncompressed: 0x04 || x(32) || y(32)
  const credX = credPubUncompressed.slice(1, 33);
  const credY = credPubUncompressed.slice(33, 65);

  const body = canonicalAttestationBody({
    attestedAt: input.attestedAt,
    deviceId: input.deviceId,
    identityPublicKeyHex: input.identityPublicKeyHex,
    motebitId: input.motebitId,
  });
  const challenge = await sha256Bytes(new TextEncoder().encode(body));

  const authData = await buildAuthData({
    rpId: input.rpId,
    withCredentialPubKey: { x: credX, y: credY },
  });
  const clientDataJSON = buildClientDataJSON(challenge, input.origin);
  const clientDataHash = await sha256Bytes(clientDataJSON);
  const signedBytes = concat(authData, clientDataHash);
  const digest = sha256(signedBytes);
  const sigRaw = p256.sign(digest, credPriv, { prehash: false });
  const sigDer = sigRaw.toDERRawBytes();

  const attestationObject = cborEncode({
    fmt: "packed",
    attStmt: { alg: -7, sig: sigDer }, // no x5c → self attestation
    authData,
  });
  const receipt = [
    toBase64Url(new Uint8Array(attestationObject)),
    toBase64Url(clientDataJSON),
  ].join(".");
  return { receipt };
}

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

// ── Tests ────────────────────────────────────────────────────────────

const RP = "motebit.com";
const ORIGIN = "https://motebit.com";
const IDENT = "a".repeat(64);
const MOTEBIT_ID = "01234567-89ab-cdef-0123-456789abcdef";
const DEVICE_ID = "dev-1";
const ATTESTED_AT = 1_745_000_000_000;

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
