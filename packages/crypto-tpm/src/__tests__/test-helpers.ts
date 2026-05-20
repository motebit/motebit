/**
 * Shared test helpers for crypto-tpm tests.
 *
 * Building a synthetic TPM 2.0 quote receipt is a ~150-line affair:
 * generate three P-256 keypairs, self-sign a fake vendor EK root, sign
 * an intermediate, sign an AK leaf, compose a `TPMS_ATTEST` structure
 * binding `extraData = SHA-256(canonicalBody)`, sign the attest with
 * the AK private key, then concatenate four base64url segments as
 * `${attestB64}.${signatureB64}.${leafDerB64}.${intermediateDerB64}`.
 *
 * `verify.test.ts` carried these helpers privately; this file lifts
 * them out so the property-based mutation tests in `properties.test.ts`
 * can reuse the same fixture infrastructure. Sibling pattern matches
 * `crypto-appattest`, `crypto-android-keystore`, `crypto-webauthn` per
 * the root CLAUDE.md sibling-boundary rule.
 *
 * **Side effect on import:** registers a WebCrypto provider with
 * `@peculiar/x509`. Test files importing helpers do NOT need to call
 * `x509.cryptoProvider.set` themselves. Production paths never import
 * from here.
 */

import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";

import { composeTpmsAttestForTest } from "../tpm-parse.js";

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
 * Mirror of the canonical body composer in `verify.ts`. Must stay
 * byte-identical — drift would allow the verifier's re-derivation step
 * to pass for the wrong reason.
 */
export function canonicalTpmBody(input: {
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
    `,"platform":"tpm"` +
    `,"version":"1"}`
  );
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
  /**
   * Override the intermediate's basicConstraints. Default `{ ca: true,
   * pathLength: 1 }` — what a real CA issues. Tests that exercise the
   * "non-CA intermediate" rejection pass `{ ca: false }`.
   */
  readonly intermediateBasicConstraints?: { ca: boolean; pathLength?: number };
  /**
   * Override cert validity to push it outside a test clock. Defaults
   * keep validity wide so chain checks succeed.
   */
  readonly notBefore?: Date;
  readonly notAfter?: Date;
}

export async function buildFakeVendorChain(opts: BuildChainOptions = {}): Promise<Chain> {
  const alg: EcKeyGenParams & EcdsaParams = {
    name: "ECDSA",
    namedCurve: "P-256",
    hash: "SHA-256",
  };
  const rootKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
  const intermediateKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
  const leafKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);

  const notBefore = opts.notBefore ?? new Date("2024-01-01");
  const notAfter = opts.notAfter ?? new Date("2099-01-01");
  const bc = opts.intermediateBasicConstraints ?? {
    ca: true,
    pathLength: 1 as number | undefined,
  };

  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=FakeTpmVendorRoot",
    notBefore,
    notAfter,
    signingAlgorithm: alg,
    keys: rootKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 2, true)],
  });
  const rootPem = root.toString("pem");

  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    issuer: root.subject,
    subject: "CN=FakeTpmVendorIntermediate",
    notBefore,
    notAfter,
    signingAlgorithm: alg,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [new x509.BasicConstraintsExtension(bc.ca, bc.pathLength, true)],
  });

  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "03",
    issuer: intermediate.subject,
    subject: "CN=FakeTpmAttestationKey",
    notBefore,
    notAfter,
    signingAlgorithm: alg,
    publicKey: leafKeys.publicKey,
    signingKey: intermediateKeys.privateKey,
    extensions: [],
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
  readonly identityPublicKeyHex: string;
  readonly motebitId?: string;
  readonly deviceId?: string;
  readonly attestedAt?: number;
  /**
   * If provided, the body used in the extraData binding names THIS
   * identity hex instead of `identityPublicKeyHex`. Used for "body
   * names A, verifier expects B" negative tests.
   */
  readonly bodyIdentityHex?: string;
  /** Override motebit id in the body (negative test). */
  readonly bodyMotebitId?: string;
  /** Override basicConstraints on the intermediate for CA-constraint tests. */
  readonly intermediateBasicConstraints?: { ca: boolean; pathLength?: number };
  /**
   * If true, emit the `TPMS_ATTEST` with a non-TPM magic value so the
   * shape check rejects.
   */
  readonly tamperMagic?: boolean;
  /**
   * If true, emit the `TPMS_ATTEST` with a non-quote structure tag.
   */
  readonly tamperType?: boolean;
  /**
   * If true, re-sign over a tampered copy of the attest — the recorded
   * signature is still valid over its own bytes, but the on-wire
   * attest bytes diverge, so AK-signature verification fails.
   */
  readonly tamperSignatureSource?: boolean;
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

  const body = canonicalTpmBody({
    attestedAt,
    deviceId,
    identityPublicKeyHex: input.bodyIdentityHex ?? input.identityPublicKeyHex,
    motebitId: input.bodyMotebitId ?? motebitId,
  });
  const extraData = await sha256(new TextEncoder().encode(body));

  const chain = await buildFakeVendorChain(
    input.intermediateBasicConstraints
      ? { intermediateBasicConstraints: input.intermediateBasicConstraints }
      : {},
  );

  const attestBytes = composeTpmsAttestForTest({
    magic: input.tamperMagic ? 0xdeadbeef : undefined,
    type: input.tamperType ? 0x8014 : undefined,
    qualifiedSigner: new Uint8Array([0x00, 0x0b]),
    extraData,
  });

  // Sign SHA-256(attestBytes) with the AK private key using ECDSA.
  // Web Crypto `ECDSA` sign takes the message and hashes internally
  // via the named hash — matching what the real TPM does with its
  // ECDSA-SHA256 signing scheme.
  const signedSource = input.tamperSignatureSource
    ? composeTpmsAttestForTest({
        qualifiedSigner: new Uint8Array([0x99]),
        extraData: new Uint8Array([0x00]),
      })
    : attestBytes;
  const sigBuffer = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    chain.leafKeyPair.privateKey,
    signedSource as BufferSource,
  );
  const signature = new Uint8Array(sigBuffer);

  const receipt = [
    toBase64Url(attestBytes),
    toBase64Url(signature),
    toBase64Url(chain.leafDer),
    toBase64Url(chain.intermediateDer),
  ].join(".");

  return { receipt, chain, motebitId, deviceId, attestedAt };
}

// ── Default test constants ──────────────────────────────────────────

export const IDENT = "a".repeat(64);
export const MOTEBIT_ID = "01234567-89ab-cdef-0123-456789abcdef";
export const DEVICE_ID = "dev-1";
export const ATTESTED_AT = 1_745_000_000_000;
export const FIXED_NOW = (): number => new Date("2026-04-22").getTime();
