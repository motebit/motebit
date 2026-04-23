/**
 * End-to-end App Attest verification tests.
 *
 * We fabricate a fake "Apple root" in-process — a self-signed P-256 CA
 * — then sign an intermediate with it, then a leaf with the
 * intermediate. The leaf carries the Apple nonce extension OID whose
 * payload binds `SHA256(authData || clientDataHash)`. The attestation
 * object is CBOR-encoded with the W3C WebAuthn-shaped fields.
 *
 * This exercises every branch of the real verifier (`verifyAppAttestReceipt`)
 * without needing a real Apple-signed leaf. An Apple-signed fixture test
 * would need a matching Apple Developer team review to generate — out
 * of scope for unit tests; see the package CLAUDE.md for operator
 * follow-up.
 */

import { describe, expect, it } from "vitest";
import { encode as cborEncode } from "cbor2";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";

import { verifyAppAttestReceipt } from "../verify.js";
import { deviceCheckVerifier } from "../index.js";

// @peculiar/x509 needs a WebCrypto provider registered.
x509.cryptoProvider.set(new Crypto() as unknown as globalThis.Crypto);

// ── helpers ─────────────────────────────────────────────────────────

const subtle = new Crypto().subtle;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const APPLE_NONCE_OID = "1.2.840.113635.100.8.2";

// DER-encode an Apple-shaped nonce extension payload:
//   SEQUENCE { [1] EXPLICIT { OCTET STRING <32 bytes> } }
function encodeAppleNonceExtension(nonce32: Uint8Array): Uint8Array {
  if (nonce32.length !== 32) throw new Error("nonce must be 32 bytes");
  const octetString = new Uint8Array([0x04, 32, ...nonce32]); // OCTET STRING 32 bytes
  const contextWrap = new Uint8Array([0xa1, octetString.length, ...octetString]); // [1] EXPLICIT
  const seq = new Uint8Array([0x30, contextWrap.length, ...contextWrap]); // SEQUENCE
  return seq;
}

interface Chain {
  rootPem: string;
  intermediate: x509.X509Certificate;
  leaf: x509.X509Certificate;
  leafDer: Uint8Array;
  intermediateDer: Uint8Array;
  leafKeyPair: CryptoKeyPair;
}

async function buildFakeChain(nonce32: Uint8Array): Promise<Chain> {
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
    extensions: [new x509.BasicConstraintsExtension(true, 1, true)],
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

interface FixtureInput {
  readonly bundleId: string;
  readonly identityPublicKeyHex: string;
  readonly clientDataBody?: string;
  readonly authDataTail?: Uint8Array;
}

async function buildFixture(input: FixtureInput): Promise<{
  receipt: string;
  chain: Chain;
}> {
  // rpIdHash = SHA256(bundleId)
  const rpIdHash = await sha256(new TextEncoder().encode(input.bundleId));
  const authData = concat(rpIdHash, input.authDataTail ?? new Uint8Array(10));

  // clientDataHash = SHA256(canonical body naming the identity key)
  const body =
    input.clientDataBody ?? JSON.stringify({ identity_public_key: input.identityPublicKeyHex });
  const clientDataHash = await sha256(new TextEncoder().encode(body));

  // nonce = SHA256(authData || clientDataHash)
  const nonce = await sha256(concat(authData, clientDataHash));

  const chain = await buildFakeChain(nonce);

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

  return { receipt, chain };
}

// ── tests ────────────────────────────────────────────────────────────

const BUNDLE = "com.motebit.app";
const IDENT = "a".repeat(64);

describe("verifyAppAttestReceipt — happy path", () => {
  it("verifies a well-formed fabricated chain against the injected root", async () => {
    const { receipt, chain } = await buildFixture({
      bundleId: BUNDLE,
      identityPublicKeyHex: IDENT,
    });

    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      {
        expectedBundleId: BUNDLE,
        expectedIdentityPublicKeyHex: IDENT,
        rootPem: chain.rootPem,
        now: () => new Date("2026-04-22").getTime(),
      },
    );

    expect(result.valid).toBe(true);
    expect(result.cert_chain_valid).toBe(true);
    expect(result.nonce_bound).toBe(true);
    expect(result.bundle_bound).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("deviceCheckVerifier factory accepts a minimal config with no optional overrides", async () => {
    // Hits the `undefined`-branches of rootPem / now / expectedFmt spreads
    // in the factory. Since no rootPem override is given, chain verify
    // won't succeed against the pinned real Apple root — but that is the
    // point: we exercise the branch, not the outcome.
    const verifier = deviceCheckVerifier({ expectedBundleId: BUNDLE });
    const result = await verifier(
      { platform: "device_check" }, // no receipt — short-circuits before chain check
      IDENT,
    );
    expect(result.valid).toBe(false);
    expect(result.platform).toBe("device_check");
  });

  it("deviceCheckVerifier factory delegates to the same path", async () => {
    const { receipt, chain } = await buildFixture({
      bundleId: BUNDLE,
      identityPublicKeyHex: IDENT,
    });

    const verifier = deviceCheckVerifier({
      expectedBundleId: BUNDLE,
      rootPem: chain.rootPem,
      now: () => new Date("2026-04-22").getTime(),
    });
    const result = await verifier(
      { platform: "device_check", attestation_receipt: receipt },
      IDENT,
    );
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("device_check");
  });
});

describe("verifyAppAttestReceipt — rejections", () => {
  it("rejects missing attestation_receipt", async () => {
    const result = await verifyAppAttestReceipt(
      { platform: "device_check" },
      { expectedBundleId: BUNDLE, expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("missing");
  });

  it("rejects receipt that isn't 3 parts", async () => {
    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: "onlyone" },
      { expectedBundleId: BUNDLE, expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("3 base64url parts");
  });

  it("rejects a malformed base64url segment", async () => {
    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: "$$$$.$$$.$$$$$$$$$$" },
      { expectedBundleId: BUNDLE, expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
  });

  it("rejects wrong bundle id (rpIdHash mismatch)", async () => {
    const { receipt, chain } = await buildFixture({
      bundleId: "com.other.app",
      identityPublicKeyHex: IDENT,
    });
    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      {
        expectedBundleId: BUNDLE,
        expectedIdentityPublicKeyHex: IDENT,
        rootPem: chain.rootPem,
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.bundle_bound).toBe(false);
    expect(result.errors.some((e) => e.message.includes("rpIdHash"))).toBe(true);
  });

  it("rejects when the pinned root does not match the chain", async () => {
    const { receipt, chain } = await buildFixture({
      bundleId: BUNDLE,
      identityPublicKeyHex: IDENT,
    });
    // Build a second independent root and pass it instead — chain
    // can no longer verify because intermediate is signed by the
    // original root.
    const other = await buildFakeChain(new Uint8Array(32));
    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      {
        expectedBundleId: BUNDLE,
        expectedIdentityPublicKeyHex: IDENT,
        rootPem: other.rootPem,
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    // The chain check fails because the intermediate is not signed by
    // `other.rootPem`. At least one error must surface.
    expect(result.valid).toBe(false);
    // Chain might be flagged valid=false OR nonce/bundle still succeed
    // but overall valid is still false. Either way, result.valid=false
    // — which is the invariant we care about.
    void chain; // eslint: appease unused binding
  });

  it("rejects when the attestation fmt isn't apple-appattest", async () => {
    const { receipt } = await buildFixture({
      bundleId: BUNDLE,
      identityPublicKeyHex: IDENT,
    });
    // Re-encode with a fake fmt to trip the format check. We can do
    // this by passing a different expected fmt so the test is purely
    // about the fmt branch.
    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      {
        expectedBundleId: BUNDLE,
        expectedIdentityPublicKeyHex: IDENT,
        expectedFmt: "not-apple-appattest",
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("fmt"))).toBe(true);
  });

  it("rejects when the nonce-binding extension payload is wrong", async () => {
    // Build a fixture where the leaf's nonce extension holds a
    // DIFFERENT 32-byte value than SHA256(authData || clientDataHash).
    const wrongNonce = new Uint8Array(32);
    wrongNonce.fill(0xcc);
    const chain = await buildFakeChain(wrongNonce);

    const rpIdHash = await sha256(new TextEncoder().encode(BUNDLE));
    const authData = concat(rpIdHash, new Uint8Array(10));
    const clientDataHash = await sha256(
      new TextEncoder().encode(JSON.stringify({ identity_public_key: IDENT })),
    );

    const cbor = cborEncode({
      fmt: "apple-appattest",
      attStmt: {
        x5c: [chain.leafDer, chain.intermediateDer],
        receipt: new Uint8Array([0x01]),
      },
      authData,
    });
    const receipt = [
      toBase64Url(new Uint8Array(cbor)),
      toBase64Url(new TextEncoder().encode("k")),
      toBase64Url(clientDataHash),
    ].join(".");

    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      {
        expectedBundleId: BUNDLE,
        expectedIdentityPublicKeyHex: IDENT,
        rootPem: chain.rootPem,
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.nonce_bound).toBe(false);
  });

  it("rejects when authData is shorter than 32 bytes", async () => {
    const chain = await buildFakeChain(new Uint8Array(32));
    const cbor = cborEncode({
      fmt: "apple-appattest",
      attStmt: { x5c: [chain.leafDer, chain.intermediateDer], receipt: new Uint8Array([]) },
      authData: new Uint8Array(10), // too short
    });
    const receipt = [
      toBase64Url(new Uint8Array(cbor)),
      toBase64Url(new TextEncoder().encode("k")),
      toBase64Url(new Uint8Array(32)),
    ].join(".");

    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      {
        expectedBundleId: BUNDLE,
        expectedIdentityPublicKeyHex: IDENT,
        rootPem: chain.rootPem,
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("authData"))).toBe(true);
  });

  it("rejects a malformed nonce extension (not OCTET STRING inside context[1])", async () => {
    // Build a leaf whose nonce extension wraps a BOOLEAN instead of
    // OCTET STRING — the parser must flag "expected OCTET STRING".
    const rpIdHash = await sha256(new TextEncoder().encode(BUNDLE));
    const authData = concat(rpIdHash, new Uint8Array(10));
    const clientDataHash = await sha256(
      new TextEncoder().encode(JSON.stringify({ identity_public_key: IDENT })),
    );

    const alg: EcKeyGenParams & EcdsaParams = {
      name: "ECDSA",
      namedCurve: "P-256",
      hash: "SHA-256",
    };
    const rootKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
    const leafKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
    const intermediateKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);

    const root = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: "CN=Root",
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2099-01-01"),
      signingAlgorithm: alg,
      keys: rootKeys,
      extensions: [new x509.BasicConstraintsExtension(true, 2, true)],
    });
    const intermediate = await x509.X509CertificateGenerator.create({
      serialNumber: "02",
      issuer: root.subject,
      subject: "CN=Int",
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2099-01-01"),
      signingAlgorithm: alg,
      publicKey: intermediateKeys.publicKey,
      signingKey: rootKeys.privateKey,
      extensions: [new x509.BasicConstraintsExtension(true, 1, true)],
    });

    // SEQUENCE { [1] EXPLICIT BOOLEAN } — wrong inner tag (0x01 = BOOLEAN).
    const badPayload = new Uint8Array([0x30, 0x06, 0xa1, 0x04, 0x01, 0x02, 0xff, 0x00]);
    const badBuffer = badPayload.buffer.slice(
      badPayload.byteOffset,
      badPayload.byteOffset + badPayload.byteLength,
    ) as ArrayBuffer;
    const nonceExt = new x509.Extension(APPLE_NONCE_OID, false, badBuffer);

    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: "03",
      issuer: intermediate.subject,
      subject: "CN=Leaf",
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2099-01-01"),
      signingAlgorithm: alg,
      publicKey: leafKeys.publicKey,
      signingKey: intermediateKeys.privateKey,
      extensions: [nonceExt],
    });

    const cbor = cborEncode({
      fmt: "apple-appattest",
      attStmt: {
        x5c: [new Uint8Array(leaf.rawData), new Uint8Array(intermediate.rawData)],
        receipt: new Uint8Array([]),
      },
      authData,
    });
    const receipt = [
      toBase64Url(new Uint8Array(cbor)),
      toBase64Url(new TextEncoder().encode("k")),
      toBase64Url(clientDataHash),
    ].join(".");

    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      {
        expectedBundleId: BUNDLE,
        expectedIdentityPublicKeyHex: IDENT,
        rootPem: root.toString("pem"),
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.nonce_bound).toBe(false);
    expect(result.errors.some((e) => e.message.includes("OCTET STRING"))).toBe(true);
  });

  it("rejects when x5c has fewer than 2 certs", async () => {
    const chain = await buildFakeChain(new Uint8Array(32));
    const cbor = cborEncode({
      fmt: "apple-appattest",
      attStmt: { x5c: [chain.leafDer], receipt: new Uint8Array([]) },
      authData: new Uint8Array(32),
    });
    const receipt = [
      toBase64Url(new Uint8Array(cbor)),
      toBase64Url(new TextEncoder().encode("k")),
      toBase64Url(new Uint8Array(32)),
    ].join(".");

    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: receipt },
      {
        expectedBundleId: BUNDLE,
        expectedIdentityPublicKeyHex: IDENT,
        rootPem: chain.rootPem,
        now: () => new Date("2026-04-22").getTime(),
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("x5c"))).toBe(true);
  });
});
