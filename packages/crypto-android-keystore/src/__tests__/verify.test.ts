/**
 * End-to-end Android Hardware-Backed Keystore Attestation
 * verification tests.
 *
 * We fabricate a fake "Google attestation root" in-process — a
 * self-signed P-256 CA — then sign an intermediate with it, then a
 * leaf cert carrying the AOSP Key Attestation extension with the
 * intermediate. The leaf's `attestationChallenge` field is set to
 * `SHA256(canonicalBody)` — byte-identical to what the Kotlin
 * `expo-android-keystore` mint path will produce when the on-device
 * `setAttestationChallenge` flow lands.
 *
 * This exercises every branch of the real verifier
 * (`verifyAndroidKeystoreAttestation`) without needing a real
 * Google-signed device leaf. Real-device captures (the moat-claim
 * fixture, mirroring the WebAuthn pass) ship as a follow-up.
 */

import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";

import { androidKeystoreVerifier } from "../index.js";
import {
  ANDROID_KEY_ATTESTATION_OID,
  GOOGLE_ANDROID_KEYSTORE_ROOT_ECDSA_PEM,
} from "../google-roots.js";
import {
  SECURITY_LEVEL_SOFTWARE,
  SECURITY_LEVEL_STRONG_BOX,
  SECURITY_LEVEL_TRUSTED_ENVIRONMENT,
  VERIFIED_BOOT_STATE_SELF_SIGNED,
  VERIFIED_BOOT_STATE_UNVERIFIED,
  VERIFIED_BOOT_STATE_VERIFIED,
} from "../asn1.js";
import { verifyAndroidKeystoreAttestation } from "../verify.js";
import { composeKeyDescriptionForTest } from "./compose-key-description-for-test.js";

x509.cryptoProvider.set(new Crypto() as unknown as globalThis.Crypto);

const subtle = new Crypto().subtle;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mirror of `buildCanonicalAttestationBody` in `verify.ts`. */
function canonicalAndroidKeystoreBody(input: {
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

interface BuildChainOptions {
  /**
   * Override the intermediate's basicConstraints. Default `{ ca: true,
   * pathLength: 1 }`. Tests that exercise the non-CA-intermediate
   * branch pass `{ ca: false }`.
   */
  readonly intermediateBasicConstraints?: { ca: boolean; pathLength?: number };
  readonly notBefore?: Date;
  readonly notAfter?: Date;
}

interface BuiltChain {
  readonly rootPem: string;
  readonly leaf: x509.X509Certificate;
  readonly intermediate: x509.X509Certificate;
}

async function buildFakeRoot(opts: BuildChainOptions = {}): Promise<{
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

async function buildChainWithKeyDescription(input: {
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
  const bc = opts.intermediateBasicConstraints ?? { ca: true, pathLength: 1 as number | undefined };

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

function buildReceipt(chain: BuiltChain): string {
  const leafB64 = toBase64Url(new Uint8Array(chain.leaf.rawData));
  const intB64 = toBase64Url(new Uint8Array(chain.intermediate.rawData));
  return `${leafB64}.${intB64}`;
}

// ── Test fixtures ────────────────────────────────────────────────────

const RP_PACKAGE = "com.motebit.mobile";
const RP_SIGNING_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const APP_ID_BYTES = new TextEncoder().encode(`${RP_PACKAGE}::${RP_SIGNING_HASH}`);
const VERIFIED_BOOT_KEY = new Uint8Array(32).fill(0xab);

const IDENT = "a".repeat(64);
const MOTEBIT_ID = "01234567-89ab-cdef-0123-456789abcdef";
const DEVICE_ID = "dev-1";
const ATTESTED_AT = 1_745_000_000_000;
const FIXED_CLOCK = (): number => new Date("2026-04-22").getTime();

async function buildHappyPathFixture(): Promise<{ receipt: string; rootPem: string }> {
  const body = canonicalAndroidKeystoreBody({
    attestedAt: ATTESTED_AT,
    deviceId: DEVICE_ID,
    identityPublicKeyHex: IDENT,
    motebitId: MOTEBIT_ID,
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

// ── Tests ────────────────────────────────────────────────────────────

describe("verifyAndroidKeystoreAttestation — happy path", () => {
  it("validates a well-formed fabricated chain end-to-end", async () => {
    const { receipt, rootPem } = await buildHappyPathFixture();
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: receipt },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(true);
    expect(result.cert_chain_valid).toBe(true);
    expect(result.attestation_extension_valid).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(result.attestation_security_level).toBe(SECURITY_LEVEL_TRUSTED_ENVIRONMENT);
    expect(result.verified_boot_state).toBe(VERIFIED_BOOT_STATE_VERIFIED);
    expect(result.errors).toEqual([]);
  });

  it("accepts STRONG_BOX security level", async () => {
    const body = canonicalAndroidKeystoreBody({
      attestedAt: ATTESTED_AT,
      deviceId: DEVICE_ID,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
    });
    const challenge = await sha256(new TextEncoder().encode(body));
    const kd = composeKeyDescriptionForTest({
      attestationChallenge: challenge,
      attestationSecurityLevel: SECURITY_LEVEL_STRONG_BOX,
      keyMintSecurityLevel: SECURITY_LEVEL_STRONG_BOX,
      rootOfTrust: {
        verifiedBootKey: VERIFIED_BOOT_KEY,
        deviceLocked: true,
        verifiedBootState: VERIFIED_BOOT_STATE_VERIFIED,
      },
      attestationApplicationId: APP_ID_BYTES,
    });
    const { rootPem, rootKeys } = await buildFakeRoot();
    const chain = await buildChainWithKeyDescription({ rootPem, rootKeys, keyDescriptionDer: kd });
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: buildReceipt(chain) },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(true);
    expect(result.attestation_security_level).toBe(SECURITY_LEVEL_STRONG_BOX);
  });

  it("accepts SELF_SIGNED boot state when allowlist includes it (GrapheneOS pattern)", async () => {
    const body = canonicalAndroidKeystoreBody({
      attestedAt: ATTESTED_AT,
      deviceId: DEVICE_ID,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
    });
    const challenge = await sha256(new TextEncoder().encode(body));
    const kd = composeKeyDescriptionForTest({
      attestationChallenge: challenge,
      rootOfTrust: {
        verifiedBootKey: VERIFIED_BOOT_KEY,
        deviceLocked: true,
        verifiedBootState: VERIFIED_BOOT_STATE_SELF_SIGNED,
      },
      attestationApplicationId: APP_ID_BYTES,
    });
    const { rootPem, rootKeys } = await buildFakeRoot();
    const chain = await buildChainWithKeyDescription({ rootPem, rootKeys, keyDescriptionDer: kd });
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: buildReceipt(chain) },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        verifiedBootStateAllowlist: [VERIFIED_BOOT_STATE_VERIFIED, VERIFIED_BOOT_STATE_SELF_SIGNED],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(true);
    expect(result.verified_boot_state).toBe(VERIFIED_BOOT_STATE_SELF_SIGNED);
  });
});

describe("androidKeystoreVerifier factory", () => {
  it("delegates to the underlying verifier with threaded context", async () => {
    const { receipt, rootPem } = await buildHappyPathFixture();
    const verifier = androidKeystoreVerifier({
      expectedAttestationApplicationId: APP_ID_BYTES,
      rootPems: [rootPem],
      now: FIXED_CLOCK,
    });
    const result = await verifier(
      { platform: "android_keystore", attestation_receipt: receipt },
      IDENT,
      {
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
      },
    );
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("android_keystore");
    expect(result.attestation_detail?.attestation_security_level).toBe(
      SECURITY_LEVEL_TRUSTED_ENVIRONMENT,
    );
  });

  it("factory with minimal config still routes through verifier", async () => {
    const verifier = androidKeystoreVerifier({
      expectedAttestationApplicationId: APP_ID_BYTES,
    });
    // No receipt → short-circuits before chain validation.
    const result = await verifier({ platform: "android_keystore" }, IDENT);
    expect(result.valid).toBe(false);
    expect(result.platform).toBe("android_keystore");
  });
});

describe("verifyAndroidKeystoreAttestation — rejections", () => {
  it("rejects missing attestation_receipt", async () => {
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore" },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("missing");
  });

  it("rejects receipt without 2 base64url segments", async () => {
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: "onlyone" },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("2 base64url parts");
  });

  it("rejects malformed base64url", async () => {
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: "$$$.$$$" },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
      },
    );
    expect(result.valid).toBe(false);
  });

  it("rejects when chain doesn't terminate at any pinned root", async () => {
    const { receipt } = await buildHappyPathFixture();
    const otherRoot = await buildFakeRoot();
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: receipt },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [otherRoot.rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
  });

  it("rejects when rootPems is empty", async () => {
    const { receipt } = await buildHappyPathFixture();
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: receipt },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        rootPems: [],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
  });

  it("rejects non-CA intermediate", async () => {
    const body = canonicalAndroidKeystoreBody({
      attestedAt: ATTESTED_AT,
      deviceId: DEVICE_ID,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
    });
    const challenge = await sha256(new TextEncoder().encode(body));
    const kd = composeKeyDescriptionForTest({
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
      keyDescriptionDer: kd,
      options: { intermediateBasicConstraints: { ca: false } },
    });
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: buildReceipt(chain) },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
  });

  it("rejects software-only attestationSecurityLevel", async () => {
    const body = canonicalAndroidKeystoreBody({
      attestedAt: ATTESTED_AT,
      deviceId: DEVICE_ID,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
    });
    const challenge = await sha256(new TextEncoder().encode(body));
    const kd = composeKeyDescriptionForTest({
      attestationChallenge: challenge,
      attestationSecurityLevel: SECURITY_LEVEL_SOFTWARE,
      keyMintSecurityLevel: SECURITY_LEVEL_SOFTWARE,
      rootOfTrust: {
        verifiedBootKey: VERIFIED_BOOT_KEY,
        deviceLocked: true,
        verifiedBootState: VERIFIED_BOOT_STATE_VERIFIED,
      },
      attestationApplicationId: APP_ID_BYTES,
    });
    const { rootPem, rootKeys } = await buildFakeRoot();
    const chain = await buildChainWithKeyDescription({ rootPem, rootKeys, keyDescriptionDer: kd });
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: buildReceipt(chain) },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.attestation_extension_valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("attestationSecurityLevel"))).toBe(true);
  });

  it("rejects UNVERIFIED boot state under default allowlist", async () => {
    const body = canonicalAndroidKeystoreBody({
      attestedAt: ATTESTED_AT,
      deviceId: DEVICE_ID,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
    });
    const challenge = await sha256(new TextEncoder().encode(body));
    const kd = composeKeyDescriptionForTest({
      attestationChallenge: challenge,
      rootOfTrust: {
        verifiedBootKey: VERIFIED_BOOT_KEY,
        deviceLocked: false,
        verifiedBootState: VERIFIED_BOOT_STATE_UNVERIFIED,
      },
      attestationApplicationId: APP_ID_BYTES,
    });
    const { rootPem, rootKeys } = await buildFakeRoot();
    const chain = await buildChainWithKeyDescription({ rootPem, rootKeys, keyDescriptionDer: kd });
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: buildReceipt(chain) },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("verifiedBootState"))).toBe(true);
  });

  it("rejects mismatched attestationApplicationId (wrong package)", async () => {
    const body = canonicalAndroidKeystoreBody({
      attestedAt: ATTESTED_AT,
      deviceId: DEVICE_ID,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
    });
    const challenge = await sha256(new TextEncoder().encode(body));
    const kd = composeKeyDescriptionForTest({
      attestationChallenge: challenge,
      rootOfTrust: {
        verifiedBootKey: VERIFIED_BOOT_KEY,
        deviceLocked: true,
        verifiedBootState: VERIFIED_BOOT_STATE_VERIFIED,
      },
      attestationApplicationId: new TextEncoder().encode("com.evil.spoof::deadbeef"),
    });
    const { rootPem, rootKeys } = await buildFakeRoot();
    const chain = await buildChainWithKeyDescription({ rootPem, rootKeys, keyDescriptionDer: kd });
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: buildReceipt(chain) },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("attestationApplicationId"))).toBe(true);
  });

  it("rejects tampered identity (challenge bound to different identity)", async () => {
    const keyA = "a".repeat(64);
    const keyB = "b".repeat(64);
    // Compose with key A
    const body = canonicalAndroidKeystoreBody({
      attestedAt: ATTESTED_AT,
      deviceId: DEVICE_ID,
      identityPublicKeyHex: keyA,
      motebitId: MOTEBIT_ID,
    });
    const challenge = await sha256(new TextEncoder().encode(body));
    const kd = composeKeyDescriptionForTest({
      attestationChallenge: challenge,
      rootOfTrust: {
        verifiedBootKey: VERIFIED_BOOT_KEY,
        deviceLocked: true,
        verifiedBootState: VERIFIED_BOOT_STATE_VERIFIED,
      },
      attestationApplicationId: APP_ID_BYTES,
    });
    const { rootPem, rootKeys } = await buildFakeRoot();
    const chain = await buildChainWithKeyDescription({ rootPem, rootKeys, keyDescriptionDer: kd });
    // Verify with key B — different identity
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: buildReceipt(chain) },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: keyB, // different!
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
  });

  it("rejects when expected* identity-binding fields are missing", async () => {
    const { receipt, rootPem } = await buildHappyPathFixture();
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: receipt },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        // omit expectedMotebitId / expectedDeviceId / expectedAttestedAt
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
    expect(result.errors.some((e) => e.message.includes("expectedMotebitId"))).toBe(true);
  });

  it("rejects when expectedIdentityPublicKeyHex is empty", async () => {
    const { receipt, rootPem } = await buildHappyPathFixture();
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: receipt },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: "",
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
  });

  it("rejects revoked leaf serial", async () => {
    const { receipt, rootPem } = await buildHappyPathFixture();
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: receipt },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        revocationSnapshot: {
          entries: {
            "1234abcd": { status: "REVOKED", reason: "KEY_COMPROMISE" },
          },
        },
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("revoked"))).toBe(true);
  });

  it("rejects leaf without Key Attestation extension", async () => {
    // Build a chain where the leaf has no extension
    const alg: EcKeyGenParams & EcdsaParams = {
      name: "ECDSA",
      namedCurve: "P-256",
      hash: "SHA-256",
    };
    const { rootPem, rootKeys } = await buildFakeRoot();
    const root = new x509.X509Certificate(rootPem);
    const intermediateKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
    const leafKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
    const intermediate = await x509.X509CertificateGenerator.create({
      serialNumber: "02",
      issuer: root.subject,
      subject: "CN=FakeAndroidAttestationIntermediate",
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2099-01-01"),
      signingAlgorithm: alg,
      publicKey: intermediateKeys.publicKey,
      signingKey: rootKeys.privateKey,
      extensions: [new x509.BasicConstraintsExtension(true, 1, true)],
    });
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: "deadbeef",
      issuer: intermediate.subject,
      subject: "CN=Android Keystore Key (no attestation extension)",
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2099-01-01"),
      signingAlgorithm: alg,
      publicKey: leafKeys.publicKey,
      signingKey: intermediateKeys.privateKey,
      extensions: [],
    });
    const receipt = `${toBase64Url(new Uint8Array(leaf.rawData))}.${toBase64Url(new Uint8Array(intermediate.rawData))}`;
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: receipt },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.attestation_extension_valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("Key Attestation extension"))).toBe(true);
  });

  it("rejects leaf with malformed Key Attestation extension bytes", async () => {
    const { rootPem, rootKeys } = await buildFakeRoot();
    const chain = await buildChainWithKeyDescription({
      rootPem,
      rootKeys,
      keyDescriptionDer: new Uint8Array([0xff, 0xfe, 0xfd]), // not a valid SEQUENCE
    });
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: buildReceipt(chain) },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("parse"))).toBe(true);
  });

  it("rejects attestationVersion below minimum (default 3)", async () => {
    const body = canonicalAndroidKeystoreBody({
      attestedAt: ATTESTED_AT,
      deviceId: DEVICE_ID,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
    });
    const challenge = await sha256(new TextEncoder().encode(body));
    const kd = composeKeyDescriptionForTest({
      attestationChallenge: challenge,
      attestationVersion: 2, // pre-Android-7
      rootOfTrust: {
        verifiedBootKey: VERIFIED_BOOT_KEY,
        deviceLocked: true,
        verifiedBootState: VERIFIED_BOOT_STATE_VERIFIED,
      },
      attestationApplicationId: APP_ID_BYTES,
    });
    const { rootPem, rootKeys } = await buildFakeRoot();
    const chain = await buildChainWithKeyDescription({ rootPem, rootKeys, keyDescriptionDer: kd });
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: buildReceipt(chain) },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("attestationVersion"))).toBe(true);
  });

  it("rejects when rootOfTrust is absent from hardwareEnforced", async () => {
    const body = canonicalAndroidKeystoreBody({
      attestedAt: ATTESTED_AT,
      deviceId: DEVICE_ID,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
    });
    const challenge = await sha256(new TextEncoder().encode(body));
    const kd = composeKeyDescriptionForTest({
      attestationChallenge: challenge,
      // omit rootOfTrust
      attestationApplicationId: APP_ID_BYTES,
    });
    const { rootPem, rootKeys } = await buildFakeRoot();
    const chain = await buildChainWithKeyDescription({ rootPem, rootKeys, keyDescriptionDer: kd });
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: buildReceipt(chain) },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("rootOfTrust"))).toBe(true);
  });

  it("rejects when chain is outside cert validity window", async () => {
    const { receipt, rootPem } = await buildHappyPathFixture();
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: receipt },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
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

  it("rejects when root PEM is malformed", async () => {
    const { receipt } = await buildHappyPathFixture();
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: receipt },
      {
        expectedAttestationApplicationId: APP_ID_BYTES,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: ["-----BEGIN CERTIFICATE-----\nnot-valid-base64\n-----END CERTIFICATE-----"],
        now: FIXED_CLOCK,
      },
    );
    expect(result.valid).toBe(false);
  });
});

describe("DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS — production roots (chain-shape sanity)", () => {
  it("real Google ECDSA root parses + has the expected shape", () => {
    // Sanity: confirm the production-pinned ECDSA root is well-formed
    // when used as a verifier root. Real-fixture coverage (a real
    // device-emitted leaf chaining to it) is a separate follow-up.
    const cert = new x509.X509Certificate(GOOGLE_ANDROID_KEYSTORE_ROOT_ECDSA_PEM);
    expect(cert.subject).toContain("Key Attestation CA1");
    expect(cert.publicKey.algorithm).toMatchObject({
      name: "ECDSA",
      namedCurve: "P-384",
    });
  });
});
