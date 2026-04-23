/**
 * End-to-end Play Integrity verification tests.
 *
 * We fabricate a pinned JWKS from an in-process P-256 keypair (ES256
 * arm) or an in-process RSA keypair (RS256 arm), sign a realistic
 * Play Integrity payload with the matching private key, and exercise
 * every verifier branch without needing a real Google-signed fixture.
 *
 * The payload's `nonce` is derived from the byte-identical JCS
 * canonical body the Kotlin `expo-play-integrity` module composes at
 * mint time — if that encoding drifts, the verifier's re-derivation
 * step would succeed for the wrong reason and these tests would stop
 * catching real breakage.
 */

import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { generateKeyPairSync, createSign } from "node:crypto";

import { canonicalJson, toBase64Url } from "@motebit/crypto";

import { verifyPlayIntegrityToken } from "../verify.js";
import { playIntegrityVerifier } from "../index.js";
import type { GoogleJwk, GoogleJwks } from "../google-jwks.js";

// ── helpers ─────────────────────────────────────────────────────────

const PACKAGE = "com.motebit.mobile";
const IDENT = "a".repeat(64);
const MOTEBIT_ID = "01234567-89ab-cdef-0123-456789abcdef";
const DEVICE_ID = "android-dev-1";
const ATTESTED_AT = 1_745_000_000_000;

function deriveExpectedNonce(input: {
  attestedAt: number;
  deviceId: string;
  identityPublicKeyHex: string;
  motebitId: string;
}): string {
  const bodyJson = canonicalJson({
    attested_at: input.attestedAt,
    device_id: input.deviceId,
    identity_public_key: input.identityPublicKeyHex.toLowerCase(),
    motebit_id: input.motebitId,
    platform: "play_integrity",
    version: "1",
  });
  return toBase64Url(sha256(new TextEncoder().encode(bodyJson)));
}

/** Build an ES256 JWT from a raw P-256 key pair. */
function signEs256Jwt(input: {
  kid: string;
  payload: Record<string, unknown>;
  privateKey: Uint8Array;
}): string {
  const header = { alg: "ES256", kid: input.kid, typ: "JWT" };
  const headerB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(input.payload)));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const digest = sha256(signingInput);
  const sig = p256.sign(digest, input.privateKey, { prehash: false });
  // Raw (r, s) concat — 64 bytes total.
  const sigBytes = sig.toCompactRawBytes();
  return `${headerB64}.${payloadB64}.${toBase64Url(sigBytes)}`;
}

interface Es256KeyPair {
  privateKey: Uint8Array;
  jwk: GoogleJwk;
}

function makeEs256KeyPair(kid: string): Es256KeyPair {
  const privateKey = p256.utils.randomPrivateKey();
  const publicKey = p256.getPublicKey(privateKey, false); // uncompressed 0x04||x||y
  const x = publicKey.slice(1, 33);
  const y = publicKey.slice(33, 65);
  const jwk: GoogleJwk = {
    kty: "EC",
    alg: "ES256",
    kid,
    crv: "P-256",
    x: toBase64Url(x),
    y: toBase64Url(y),
  };
  return { privateKey, jwk };
}

/** Build an RS256 JWT via node:crypto. */
function signRs256Jwt(input: {
  kid: string;
  payload: Record<string, unknown>;
  privateKeyPem: string;
}): string {
  const header = { alg: "RS256", kid: input.kid, typ: "JWT" };
  const headerB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(input.payload)));
  const signer = createSign("RSA-SHA256");
  signer.update(`${headerB64}.${payloadB64}`);
  signer.end();
  const sigBytes = signer.sign(input.privateKeyPem);
  return `${headerB64}.${payloadB64}.${toBase64Url(sigBytes)}`;
}

function b64UrlFromB64(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Rs256KeyPair {
  privateKeyPem: string;
  jwk: GoogleJwk;
}

function makeRs256KeyPair(kid: string): Rs256KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwkExport = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const jwk: GoogleJwk = {
    kty: "RSA",
    alg: "RS256",
    kid,
    n: b64UrlFromB64(jwkExport.n),
    e: b64UrlFromB64(jwkExport.e),
  };
  return { privateKeyPem, jwk };
}

interface FixturePayload {
  readonly nonce?: string;
  readonly packageName?: string;
  readonly deviceIntegrity?: string | { readonly deviceRecognitionVerdict?: readonly string[] };
  readonly timestampMillis?: number;
}

function buildPayload(overrides: FixturePayload = {}): Record<string, unknown> {
  return {
    nonce:
      overrides.nonce ??
      deriveExpectedNonce({
        attestedAt: ATTESTED_AT,
        deviceId: DEVICE_ID,
        identityPublicKeyHex: IDENT,
        motebitId: MOTEBIT_ID,
      }),
    packageName: overrides.packageName ?? PACKAGE,
    apkPackageName: overrides.packageName ?? PACKAGE,
    deviceIntegrity: overrides.deviceIntegrity ?? {
      deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"],
    },
    timestampMillis: overrides.timestampMillis ?? ATTESTED_AT,
  };
}

// ── ES256 happy path ────────────────────────────────────────────────

describe("verifyPlayIntegrityToken — ES256 happy path", () => {
  it("verifies a well-formed ES256 JWT against the injected JWKS", async () => {
    const kp = makeEs256KeyPair("kid-es256-a");
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload(),
      privateKey: kp.privateKey,
    });
    const jwks: GoogleJwks = { keys: [kp.jwk] };
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: jwks,
      },
    );
    expect(result.valid).toBe(true);
    expect(result.signature_valid).toBe(true);
    expect(result.nonce_bound).toBe(true);
    expect(result.package_bound).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(result.device_integrity_level).toContain("MEETS_DEVICE_INTEGRITY");
    expect(result.errors).toEqual([]);
  });

  it("accepts legacy string-shaped deviceIntegrity", async () => {
    const kp = makeEs256KeyPair("kid-legacy");
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload({ deviceIntegrity: "MEETS_DEVICE_INTEGRITY" }),
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(true);
    expect(result.device_integrity_level).toBe("MEETS_DEVICE_INTEGRITY");
  });

  it("playIntegrityVerifier factory delegates to the same path with context", async () => {
    const kp = makeEs256KeyPair("kid-factory");
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload(),
      privateKey: kp.privateKey,
    });
    const verifier = playIntegrityVerifier({
      expectedPackageName: PACKAGE,
      pinnedJwks: { keys: [kp.jwk] },
    });
    const result = await verifier({ platform: "play_integrity", attestation_receipt: jwt }, IDENT, {
      expectedMotebitId: MOTEBIT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedAttestedAt: ATTESTED_AT,
    });
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("play_integrity");
  });

  it("playIntegrityVerifier factory accepts a minimal config with no optional overrides", async () => {
    // Hits the `undefined`-branches of pinnedJwks / requiredDeviceIntegrity
    // spreads in the factory. Since no pinnedJwks override is given, the
    // verifier defaults to the empty production pin and the token can't
    // be routed — but that is the point: we exercise the branch, not the
    // outcome.
    const verifier = playIntegrityVerifier({ expectedPackageName: PACKAGE });
    const result = await verifier(
      { platform: "play_integrity" }, // no receipt — short-circuits before signature check
      IDENT,
    );
    expect(result.valid).toBe(false);
    expect(result.platform).toBe("play_integrity");
  });

  it("accepts a no-kid JWT when exactly one key with matching alg is pinned", async () => {
    const kp = makeEs256KeyPair("kid-ignored");
    // Sign with no kid in the header by rebuilding the flow manually.
    const headerNoKid = { alg: "ES256", typ: "JWT" };
    const payload = buildPayload();
    const headerB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(headerNoKid)));
    const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig = p256.sign(sha256(signingInput), kp.privateKey, { prehash: false });
    const jwt = `${headerB64}.${payloadB64}.${toBase64Url(sig.toCompactRawBytes())}`;

    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.signature_valid).toBe(true);
  });
});

// ── RS256 happy path ────────────────────────────────────────────────

describe("verifyPlayIntegrityToken — RS256 happy path", () => {
  it("verifies a well-formed RS256 JWT", async () => {
    const kp = makeRs256KeyPair("kid-rsa-a");
    const jwt = signRs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload(),
      privateKeyPem: kp.privateKeyPem,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(true);
    expect(result.signature_valid).toBe(true);
  });
});

// ── rejections ──────────────────────────────────────────────────────

describe("verifyPlayIntegrityToken — rejections", () => {
  it("rejects missing attestation_receipt", async () => {
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity" },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("missing");
  });

  it("rejects a JWT that isn't 3 segments", async () => {
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: "onlyone" },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("3 base64url segments"))).toBe(true);
  });

  it("rejects a JWT with malformed base64url", async () => {
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: "$$$.$$$.$$$" },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
      },
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a JWT whose header is not JSON", async () => {
    const badHeader = toBase64Url(new TextEncoder().encode("not-json"));
    const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(buildPayload())));
    const sigB64 = toBase64Url(new Uint8Array(64));
    const jwt = `${badHeader}.${payloadB64}.${sigB64}`;
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("header"))).toBe(true);
  });

  it("rejects a JWT whose payload is missing `nonce`", async () => {
    const kp = makeEs256KeyPair("kid-no-nonce");
    const { nonce: _nonce, ...payloadWithoutNonce } = buildPayload();
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: payloadWithoutNonce,
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("nonce"))).toBe(true);
  });

  it("rejects a JWT whose kid is not in the pinned JWKS", async () => {
    const kp = makeEs256KeyPair("kid-present");
    const jwt = signEs256Jwt({
      kid: "kid-MISSING",
      payload: buildPayload(),
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.signature_valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("kid"))).toBe(true);
  });

  it("rejects a JWT signed by a key not in the pinned JWKS (tampered)", async () => {
    const attacker = makeEs256KeyPair("kid-pinned");
    // Build the victim JWK with SAME kid but different key material — the
    // kid lookup succeeds but the signature verify fails.
    const victim = makeEs256KeyPair("kid-pinned");
    const jwt = signEs256Jwt({
      kid: "kid-pinned",
      payload: buildPayload(),
      privateKey: attacker.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [victim.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.signature_valid).toBe(false);
  });

  it("rejects nonce mismatch (body names motebit A, verifier expects motebit B)", async () => {
    const kp = makeEs256KeyPair("kid-nonce-miss");
    // Build nonce from motebit-A, then verify expecting motebit-B.
    const nonceForA = deriveExpectedNonce({
      attestedAt: ATTESTED_AT,
      deviceId: DEVICE_ID,
      identityPublicKeyHex: IDENT,
      motebitId: "motebit-A",
    });
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload({ nonce: nonceForA }),
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: "motebit-B",
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
    expect(result.nonce_bound).toBe(false);
  });

  it("rejects when expectedIdentityPublicKeyHex is empty", async () => {
    const kp = makeEs256KeyPair("kid-empty-hex");
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload(),
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: "",
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
    expect(result.errors.some((e) => e.message.includes("expectedIdentityPublicKeyHex"))).toBe(
      true,
    );
  });

  it("rejects when expectedMotebitId is omitted (fail-closed on missing context)", async () => {
    const kp = makeEs256KeyPair("kid-no-motebit");
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload(),
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        // expectedMotebitId intentionally omitted
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
    expect(result.errors.some((e) => e.message.includes("expectedMotebitId"))).toBe(true);
  });

  it("rejects when expectedDeviceId is omitted", async () => {
    const kp = makeEs256KeyPair("kid-no-device");
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload(),
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        // expectedDeviceId omitted
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
    expect(result.errors.some((e) => e.message.includes("expectedDeviceId"))).toBe(true);
  });

  it("rejects when expectedAttestedAt is omitted", async () => {
    const kp = makeEs256KeyPair("kid-no-at");
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload(),
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        // expectedAttestedAt omitted
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
    expect(result.errors.some((e) => e.message.includes("expectedAttestedAt"))).toBe(true);
  });

  it("rejects wrong package name", async () => {
    const kp = makeEs256KeyPair("kid-pkg");
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload({ packageName: "com.other.app" }),
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.package_bound).toBe(false);
    expect(result.errors.some((e) => e.message.includes("packageName"))).toBe(true);
  });

  it("rejects when payload has no packageName", async () => {
    const kp = makeEs256KeyPair("kid-no-pkg");
    const { packageName: _pkg, apkPackageName: _apk, ...rest } = buildPayload();
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: rest,
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.package_bound).toBe(false);
  });

  it("rejects below-floor device integrity", async () => {
    const kp = makeEs256KeyPair("kid-basic");
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload({
        deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] },
      }),
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.device_integrity_level).toBe("MEETS_BASIC_INTEGRITY");
    expect(result.errors.some((e) => e.message.startsWith("device_integrity:"))).toBe(true);
  });

  it("accepts relaxed device-integrity floor when explicitly configured", async () => {
    const kp = makeEs256KeyPair("kid-relaxed");
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload({
        deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] },
      }),
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
        requiredDeviceIntegrity: "MEETS_BASIC_INTEGRITY",
      },
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a missing deviceIntegrity field", async () => {
    const kp = makeEs256KeyPair("kid-no-integrity");
    const { deviceIntegrity: _d, ...rest } = buildPayload();
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: rest,
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.device_integrity_level).toBeNull();
  });

  it("rejects mismatched alg between header and JWK (e.g. header=RS256, JWK=ES256)", async () => {
    const kp = makeEs256KeyPair("kid-alg-mismatch");
    // Hand-roll a JWT whose header claims RS256 but is actually signed
    // with the ES256 private key — signature verify must fail-closed.
    const header = { alg: "RS256", kid: kp.jwk.kid, typ: "JWT" };
    const payload = buildPayload();
    const headerB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(header)));
    const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig = p256.sign(sha256(signingInput), kp.privateKey, { prehash: false });
    const jwt = `${headerB64}.${payloadB64}.${toBase64Url(sig.toCompactRawBytes())}`;
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] }, // JWK is ES256
      },
    );
    expect(result.valid).toBe(false);
    expect(result.signature_valid).toBe(false);
  });

  it("rejects a JWT with unknown alg", async () => {
    const kp = makeEs256KeyPair("kid-unknown-alg");
    const header = { alg: "HS256", kid: kp.jwk.kid, typ: "JWT" };
    const headerB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(header)));
    const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(buildPayload())));
    const jwt = `${headerB64}.${payloadB64}.${toBase64Url(new Uint8Array(32))}`;
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.signature_valid).toBe(false);
  });

  it("rejects when the pinned JWKS is empty (default production pin)", async () => {
    const kp = makeEs256KeyPair("kid-orphan");
    const jwt = signEs256Jwt({
      kid: kp.jwk.kid,
      payload: buildPayload(),
      privateKey: kp.privateKey,
    });
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        // no pinnedJwks override — hits the default empty production pin
      },
    );
    expect(result.valid).toBe(false);
    expect(result.signature_valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("kid"))).toBe(true);
  });

  it("rejects an ES256 signature of wrong length", async () => {
    const kp = makeEs256KeyPair("kid-sig-len");
    // Craft a JWT whose signature is 16 bytes instead of 64.
    const header = { alg: "ES256", kid: kp.jwk.kid, typ: "JWT" };
    const headerB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(header)));
    const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(buildPayload())));
    const jwt = `${headerB64}.${payloadB64}.${toBase64Url(new Uint8Array(16))}`;
    const result = await verifyPlayIntegrityToken(
      { platform: "play_integrity", attestation_receipt: jwt },
      {
        expectedPackageName: PACKAGE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        pinnedJwks: { keys: [kp.jwk] },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.signature_valid).toBe(false);
  });
});
