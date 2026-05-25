/**
 * Shared test helpers for crypto-webauthn tests.
 *
 * Building a synthetic WebAuthn packed-attestation receipt has two
 * variants: full attestation (with `x5c` chaining to a pinned FIDO root)
 * and self attestation (no `x5c`, signature verified against the
 * credential public key embedded in `authData`). Both compose the
 * receipt as `${attestationObjectB64}.${clientDataJSONB64}` — two
 * segments. `verify.test.ts` carried these builders privately; this
 * file lifts them out so the property-based mutation tests in
 * `properties.test.ts` can reuse the same fixture infrastructure. The
 * sibling pattern matches `packages/crypto-appattest` and
 * `packages/crypto-android-keystore` per the root CLAUDE.md
 * sibling-boundary rule.
 *
 * **Side effect on import:** registers a WebCrypto provider with
 * `@peculiar/x509`. Test files importing helpers do NOT need to call
 * `x509.cryptoProvider.set` themselves. Production paths never import
 * from here.
 */

import { encode as cborEncode } from "cbor2";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";

x509.cryptoProvider.set(new Crypto() as unknown as globalThis.Crypto);

export const subtle = new Crypto().subtle;

// ── Byte utilities ──────────────────────────────────────────────────

export async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
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

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(str: string): Uint8Array {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Mirror of the canonical body the web mint path composes. JCS-canonical
 * (alphabetically-ordered keys, no whitespace). The verifier re-derives
 * this same string to byte-compare against clientDataJSON.challenge.
 */
export function canonicalAttestationBody(input: {
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

export function buildClientDataJSON(challenge: Uint8Array, origin: string): Uint8Array {
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
 * Full-attestation fixtures emit AT=0 (no attested credential data) —
 * the chain-rooted leaf signs over the minimal authData.
 *
 * Self-attestation fixtures set AT=1 and append the credential public
 * key as COSE_Key CBOR.
 */
export async function buildAuthData(opts: {
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

// ── Fixture builders ────────────────────────────────────────────────

export interface FullFixture {
  receipt: string;
  rootPem: string;
}

export async function buildFullAttestationFixture(input: {
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
  // v2: sign returns encoded bytes directly; request DER (replaces .toDERRawBytes()).
  const sigDer = input.forgeBadSignature
    ? p256.sign(new Uint8Array(32), leafPrivBytes, { prehash: false, format: "der" })
    : p256.sign(digest, leafPrivBytes, { prehash: false, format: "der" });

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

export async function buildSelfAttestationFixture(input: {
  rpId: string;
  origin: string;
  identityPublicKeyHex: string;
  motebitId: string;
  deviceId: string;
  attestedAt: number;
}): Promise<{ receipt: string }> {
  const credPriv = p256.utils.randomSecretKey(); // v2 rename of randomPrivateKey
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
  const sigDer = p256.sign(digest, credPriv, { prehash: false, format: "der" });

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

// ── Default test constants ──────────────────────────────────────────

export const RP = "motebit.com";
export const ORIGIN = "https://motebit.com";
export const IDENT = "a".repeat(64);
export const MOTEBIT_ID = "01234567-89ab-cdef-0123-456789abcdef";
export const DEVICE_ID = "dev-1";
export const ATTESTED_AT = 1_745_000_000_000;
