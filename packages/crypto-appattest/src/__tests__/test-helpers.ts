/**
 * Shared test helpers for crypto-appattest tests.
 *
 * Building a synthetic Apple App Attest receipt is a ~100-line affair:
 * generate three P-256 keypairs, self-sign a root, sign an intermediate +
 * leaf, encode the Apple nonce extension, compose the canonical body,
 * CBOR-encode the attestation object, base64url the parts. The original
 * `verify.test.ts` carried these helpers privately; this file lifts them
 * out so the property-based mutation tests in `properties.test.ts` can
 * reuse the same fixture infrastructure without duplicating the crypto.
 *
 * **Side effect on import:** registers a WebCrypto provider with
 * `@peculiar/x509`. Test files that import from here do NOT need to call
 * `x509.cryptoProvider.set` themselves. This is acceptable because the
 * file is test-only — the production verifier path in `verify.ts` never
 * imports from here.
 *
 * Per `packages/crypto-appattest/CLAUDE.md` rule 2 ("the verifier never
 * reaches the network"), every helper here is synchronous-or-local; no
 * network calls, no filesystem reads. The fixture is fabricated in
 * memory and signed against an in-process root, then handed to the
 * verifier with the matching `rootPem` so the chain validates.
 */

import { encode as cborEncode } from "cbor2";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";

// @peculiar/x509 needs a WebCrypto provider registered. Side effect at
// module load so test files just import the helpers and the provider is
// already wired.
x509.cryptoProvider.set(new Crypto() as unknown as globalThis.Crypto);

/**
 * Exported because some tests (verify.test.ts negative cases that need to
 * build custom chains not satisfied by `buildFakeChain`) reach into the
 * WebCrypto API directly. Production code paths in `verify.ts` never use
 * this export.
 */
export const subtle = new Crypto().subtle;

// ── Byte utilities ──────────────────────────────────────────────────

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const APPLE_NONCE_OID = "1.2.840.113635.100.8.2";

/**
 * Mirror of `CanonicalBody.encode` in
 * `apps/mobile/modules/expo-app-attest/ios/ExpoAppAttestModule.swift`.
 * JCS-canonical (alphabetically-ordered keys, no whitespace, numbers as
 * JSON numbers). The verifier re-derives this same string to byte-
 * compare against the transmitted clientDataHash.
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
    `,"platform":"device_check"` +
    `,"version":"1"}`
  );
}

// DER-encode an Apple-shaped nonce extension payload:
//   SEQUENCE { [1] EXPLICIT { OCTET STRING <32 bytes> } }
export function encodeAppleNonceExtension(nonce32: Uint8Array): Uint8Array {
  if (nonce32.length !== 32) throw new Error("nonce must be 32 bytes");
  const octetString = new Uint8Array([0x04, 32, ...nonce32]); // OCTET STRING 32 bytes
  const contextWrap = new Uint8Array([0xa1, octetString.length, ...octetString]); // [1] EXPLICIT
  const seq = new Uint8Array([0x30, contextWrap.length, ...contextWrap]); // SEQUENCE
  return seq;
}

// ── Chain + fixture ─────────────────────────────────────────────────

export interface Chain {
  rootPem: string;
  intermediate: x509.X509Certificate;
  leaf: x509.X509Certificate;
  leafDer: Uint8Array;
  intermediateDer: Uint8Array;
  leafKeyPair: CryptoKeyPair;
}

export interface BuildChainOptions {
  readonly nonce32: Uint8Array;
  /**
   * Override the intermediate's basicConstraints. Default `{ ca: true,
   * pathLength: 1 }` — what a real CA issues. Tests that exercise the
   * "non-CA intermediate" rejection pass `{ ca: false }`.
   */
  readonly intermediateBasicConstraints?: { ca: boolean; pathLength?: number };
}

export async function buildFakeChain(opts: BuildChainOptions | Uint8Array): Promise<Chain> {
  const { nonce32, intermediateBasicConstraints } =
    opts instanceof Uint8Array
      ? {
          nonce32: opts,
          intermediateBasicConstraints: { ca: true, pathLength: 1 as number | undefined },
        }
      : {
          nonce32: opts.nonce32,
          intermediateBasicConstraints: opts.intermediateBasicConstraints ?? {
            ca: true,
            pathLength: 1 as number | undefined,
          },
        };

  const alg: EcKeyGenParams & EcdsaParams = {
    name: "ECDSA",
    namedCurve: "P-256",
    hash: "SHA-256",
  };

  const rootKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
  const intermediateKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
  const leafKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);

  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=FakeAppleRoot",
    notBefore: new Date("2024-01-01"),
    notAfter: new Date("2099-01-01"),
    signingAlgorithm: alg,
    keys: rootKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 2, true)],
  });
  const rootPem = root.toString("pem");

  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    issuer: root.subject,
    subject: "CN=FakeAppleIntermediate",
    notBefore: new Date("2024-01-01"),
    notAfter: new Date("2099-01-01"),
    signingAlgorithm: alg,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(
        intermediateBasicConstraints.ca,
        intermediateBasicConstraints.pathLength,
        true,
      ),
    ],
  });

  // Leaf with the Apple nonce extension.
  const nonceBytes = encodeAppleNonceExtension(nonce32);
  const nonceBuffer = nonceBytes.buffer.slice(
    nonceBytes.byteOffset,
    nonceBytes.byteOffset + nonceBytes.byteLength,
  ) as ArrayBuffer;
  const nonceExt = new x509.Extension(APPLE_NONCE_OID, false, nonceBuffer);
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "03",
    issuer: intermediate.subject,
    subject: "CN=FakeAppAttestLeaf",
    notBefore: new Date("2024-01-01"),
    notAfter: new Date("2099-01-01"),
    signingAlgorithm: alg,
    publicKey: leafKeys.publicKey,
    signingKey: intermediateKeys.privateKey,
    extensions: [nonceExt],
  });

  return {
    rootPem,
    intermediate,
    leaf,
    leafDer: new Uint8Array(leaf.rawData),
    intermediateDer: new Uint8Array(intermediate.rawData),
    leafKeyPair: leafKeys,
  };
}

export interface FixtureInput {
  readonly bundleId: string;
  readonly identityPublicKeyHex: string;
  /** motebit_id / device_id / attested_at — participate in the canonical body. */
  readonly motebitId?: string;
  readonly deviceId?: string;
  readonly attestedAt?: number;
  /**
   * If provided, use THIS identity hex in the body instead of
   * `identityPublicKeyHex`. Used to construct "body names A, verifier
   * expects B" negative tests.
   */
  readonly bodyIdentityHex?: string;
  /**
   * If provided, use THIS motebit id in the body instead of `motebitId`.
   * Used for "body names X, verifier expects Y" negative tests.
   */
  readonly bodyMotebitId?: string;
  readonly authDataTail?: Uint8Array;
  readonly intermediateBasicConstraints?: { ca: boolean; pathLength?: number };
}

export async function buildFixture(input: FixtureInput): Promise<{
  receipt: string;
  chain: Chain;
  motebitId: string;
  deviceId: string;
  attestedAt: number;
}> {
  const motebitId = input.motebitId ?? "01234567-89ab-cdef-0123-456789abcdef";
  const deviceId = input.deviceId ?? "dev-1";
  const attestedAt = input.attestedAt ?? 1_745_000_000_000;

  // rpIdHash = SHA256(bundleId)
  const rpIdHash = await sha256(new TextEncoder().encode(input.bundleId));
  const authData = concat(rpIdHash, input.authDataTail ?? new Uint8Array(10));

  // clientDataHash = SHA256(canonical body naming identity key + motebit/device/time)
  const body = canonicalAttestationBody({
    attestedAt,
    deviceId,
    identityPublicKeyHex: input.bodyIdentityHex ?? input.identityPublicKeyHex,
    motebitId: input.bodyMotebitId ?? motebitId,
  });
  const clientDataHash = await sha256(new TextEncoder().encode(body));

  // nonce = SHA256(authData || clientDataHash)
  const nonce = await sha256(concat(authData, clientDataHash));

  const chain = await buildFakeChain({
    nonce32: nonce,
    ...(input.intermediateBasicConstraints !== undefined
      ? { intermediateBasicConstraints: input.intermediateBasicConstraints }
      : {}),
  });

  const cbor = cborEncode({
    fmt: "apple-appattest",
    attStmt: {
      x5c: [chain.leafDer, chain.intermediateDer],
      receipt: new Uint8Array([0x01, 0x02]),
    },
    authData,
  });

  const receipt = [
    toBase64Url(new Uint8Array(cbor)),
    toBase64Url(new TextEncoder().encode("fake-key-id")),
    toBase64Url(clientDataHash),
  ].join(".");

  return { receipt, chain, motebitId, deviceId, attestedAt };
}

// ── Default test constants ──────────────────────────────────────────

export const BUNDLE = "com.motebit.app";
export const IDENT = "a".repeat(64);
export const MOTEBIT_ID = "01234567-89ab-cdef-0123-456789abcdef";
export const DEVICE_ID = "dev-1";
export const ATTESTED_AT = 1_745_000_000_000;
