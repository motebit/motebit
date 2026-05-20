/**
 * Shared test helpers for crypto-android-keystore tests.
 *
 * Building a synthetic Android Keystore attestation receipt is a
 * ~100-line affair: generate three P-256 keypairs, self-sign a fake
 * Google attestation root, sign an intermediate, sign a leaf that
 * carries the AOSP Key Attestation extension (OID 1.3.6.1.4.1.11129.2.1.17)
 * with the `attestationChallenge` bound to `SHA-256(canonicalBody)`,
 * then concatenate the leaf and intermediate DER as `${leafB64}.${intB64}`.
 *
 * `verify.test.ts` carried these helpers privately; this file lifts them
 * out so the property-based mutation tests in `properties.test.ts` can
 * reuse the same fixture infrastructure. The sibling pattern matches
 * `packages/crypto-appattest/src/__tests__/test-helpers.ts` per the root
 * CLAUDE.md sibling-boundary rule.
 *
 * **Side effect on import:** registers a WebCrypto provider with
 * `@peculiar/x509`. Test files importing helpers do NOT need to call
 * `x509.cryptoProvider.set` themselves. Production paths never import
 * from here.
 */

import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";

import { ANDROID_KEY_ATTESTATION_OID } from "../google-roots.js";
import { composeKeyDescriptionForTest } from "./compose-key-description-for-test.js";
import { VERIFIED_BOOT_STATE_VERIFIED } from "../asn1.js";

// @peculiar/x509 needs a WebCrypto provider registered. Side effect at
// module load — test files importing the helpers get the provider wired
// automatically.
x509.cryptoProvider.set(new Crypto() as unknown as globalThis.Crypto);

export const subtle = new Crypto().subtle;

// ── Byte utilities ──────────────────────────────────────────────────

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mirror of `buildCanonicalAttestationBody` in `verify.ts`. The verifier
 * re-derives this same string and SHA-256s it; the result must byte-equal
 * the leaf's `attestationChallenge`.
 */
export function canonicalAndroidKeystoreBody(input: {
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
    `,"platform":"android_keystore"` +
    `,"version":"1"}`
  );
}

// ── Chain + fixture ─────────────────────────────────────────────────

export interface BuildChainOptions {
  /**
   * Override the intermediate's basicConstraints. Default `{ ca: true,
   * pathLength: 1 }`. Tests that exercise the non-CA-intermediate branch
   * pass `{ ca: false }`.
   */
  readonly intermediateBasicConstraints?: { ca: boolean; pathLength?: number };
  readonly notBefore?: Date;
  readonly notAfter?: Date;
}

export interface BuiltChain {
  readonly rootPem: string;
  readonly leaf: x509.X509Certificate;
  readonly intermediate: x509.X509Certificate;
}

export async function buildFakeRoot(opts: BuildChainOptions = {}): Promise<{
  rootPem: string;
  rootKeys: CryptoKeyPair;
}> {
  const alg: EcKeyGenParams & EcdsaParams = {
    name: "ECDSA",
    namedCurve: "P-256",
    hash: "SHA-256",
  };
  const rootKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=FakeAndroidAttestationRoot",
    notBefore: opts.notBefore ?? new Date("2024-01-01"),
    notAfter: opts.notAfter ?? new Date("2099-01-01"),
    signingAlgorithm: alg,
    keys: rootKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 2, true)],
  });
  return { rootPem: root.toString("pem"), rootKeys };
}

export async function buildChainWithKeyDescription(input: {
  rootPem: string;
  rootKeys: CryptoKeyPair;
  keyDescriptionDer: Uint8Array;
  options?: BuildChainOptions;
}): Promise<BuiltChain> {
  const alg: EcKeyGenParams & EcdsaParams = {
    name: "ECDSA",
    namedCurve: "P-256",
    hash: "SHA-256",
  };
  const opts = input.options ?? {};
  const intermediateKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
  const leafKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);

  const notBefore = opts.notBefore ?? new Date("2024-01-01");
  const notAfter = opts.notAfter ?? new Date("2099-01-01");
  const bc = opts.intermediateBasicConstraints ?? {
    ca: true,
    pathLength: 1 as number | undefined,
  };

  const root = new x509.X509Certificate(input.rootPem);

  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    issuer: root.subject,
    subject: "CN=FakeAndroidAttestationIntermediate",
    notBefore,
    notAfter,
    signingAlgorithm: alg,
    publicKey: intermediateKeys.publicKey,
    signingKey: input.rootKeys.privateKey,
    extensions: [new x509.BasicConstraintsExtension(bc.ca, bc.pathLength, true)],
  });

  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "1234abcd",
    issuer: intermediate.subject,
    subject: "CN=Android Keystore Key",
    notBefore,
    notAfter,
    signingAlgorithm: alg,
    publicKey: leafKeys.publicKey,
    signingKey: intermediateKeys.privateKey,
    extensions: [new x509.Extension(ANDROID_KEY_ATTESTATION_OID, false, input.keyDescriptionDer)],
  });

  return { rootPem: input.rootPem, leaf, intermediate };
}

export function buildReceipt(chain: BuiltChain): string {
  const leafB64 = toBase64Url(new Uint8Array(chain.leaf.rawData));
  const intB64 = toBase64Url(new Uint8Array(chain.intermediate.rawData));
  return `${leafB64}.${intB64}`;
}

// ── Default test constants ──────────────────────────────────────────

export const RP_PACKAGE = "com.motebit.mobile";
export const RP_SIGNING_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const APP_ID_BYTES = new TextEncoder().encode(`${RP_PACKAGE}::${RP_SIGNING_HASH}`);
export const VERIFIED_BOOT_KEY = new Uint8Array(32).fill(0xab);

export const IDENT = "a".repeat(64);
export const MOTEBIT_ID = "01234567-89ab-cdef-0123-456789abcdef";
export const DEVICE_ID = "dev-1";
export const ATTESTED_AT = 1_745_000_000_000;
export const FIXED_CLOCK = (): number => new Date("2026-04-22").getTime();

/**
 * Build a well-formed Android Keystore receipt + matching root PEM. The
 * happy-path shape — leaf carries the AOSP extension with the challenge
 * bound to `SHA-256(canonicalBody)` over the default test identity.
 */
export async function buildHappyPathFixture(input?: {
  identityPublicKeyHex?: string;
  bodyIdentityHex?: string;
  motebitId?: string;
  bodyMotebitId?: string;
  deviceId?: string;
  attestedAt?: number;
}): Promise<{ receipt: string; rootPem: string }> {
  const identityPublicKeyHex = input?.identityPublicKeyHex ?? IDENT;
  const motebitId = input?.motebitId ?? MOTEBIT_ID;
  const deviceId = input?.deviceId ?? DEVICE_ID;
  const attestedAt = input?.attestedAt ?? ATTESTED_AT;

  const body = canonicalAndroidKeystoreBody({
    attestedAt,
    deviceId,
    identityPublicKeyHex: input?.bodyIdentityHex ?? identityPublicKeyHex,
    motebitId: input?.bodyMotebitId ?? motebitId,
  });
  const challenge = await sha256(new TextEncoder().encode(body));
  const keyDescription = composeKeyDescriptionForTest({
    attestationChallenge: challenge,
    rootOfTrust: {
      verifiedBootKey: VERIFIED_BOOT_KEY,
      deviceLocked: true,
      verifiedBootState: VERIFIED_BOOT_STATE_VERIFIED,
    },
    attestationApplicationId: APP_ID_BYTES,
  });
  const { rootPem, rootKeys } = await buildFakeRoot();
  const chain = await buildChainWithKeyDescription({
    rootPem,
    rootKeys,
    keyDescriptionDer: keyDescription,
  });
  return { receipt: buildReceipt(chain), rootPem };
}
