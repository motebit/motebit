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

import { androidKeystoreVerifier } from "../index.js";
import { GOOGLE_ANDROID_KEYSTORE_ROOT_ECDSA_PEM } from "../google-roots.js";
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
import {
  APP_ID_BYTES,
  ATTESTED_AT,
  DEVICE_ID,
  FIXED_CLOCK,
  IDENT,
  MOTEBIT_ID,
  VERIFIED_BOOT_KEY,
  buildChainWithKeyDescription,
  buildFakeRoot,
  buildHappyPathFixture,
  buildReceipt,
  canonicalAndroidKeystoreBody,
  sha256,
  subtle,
  toBase64Url,
} from "./test-helpers.js";

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
