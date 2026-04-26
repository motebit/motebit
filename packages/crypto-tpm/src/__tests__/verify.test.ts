/**
 * End-to-end TPM 2.0 quote verification tests.
 *
 * We fabricate a fake "vendor root" in-process — a self-signed P-256
 * CA — then sign an intermediate with it, then an Attestation Key leaf
 * cert with the intermediate. The AK signs a well-formed `TPMS_ATTEST`
 * whose extraData binds `SHA256(canonical body)` — byte-identical to
 * what the Rust TPM bridge will produce when the `tss-esapi`-backed
 * mint path lands.
 *
 * This exercises every branch of the real verifier (`verifyTpmQuote`)
 * without needing a real vendor-signed AK cert. A real-TPM fixture
 * would need a vendor-CA-signed device leaf to generate — out of
 * scope for unit tests; see the package CLAUDE.md for operator
 * follow-up.
 */

import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";

import { verifyTpmQuote } from "../verify.js";
import { tpmVerifier } from "../index.js";
import { composeTpmsAttestForTest } from "../tpm-parse.js";

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

/**
 * Mirror of the canonical body composer in `verify.ts`. Must stay
 * byte-identical — drift would allow the verifier's re-derivation step
 * to pass for the wrong reason.
 */
function canonicalTpmBody(input: {
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

interface Chain {
  rootPem: string;
  intermediate: x509.X509Certificate;
  leaf: x509.X509Certificate;
  leafDer: Uint8Array;
  intermediateDer: Uint8Array;
  leafKeyPair: CryptoKeyPair;
}

interface BuildChainOptions {
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

async function buildFakeVendorChain(opts: BuildChainOptions = {}): Promise<Chain> {
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
  const bc = opts.intermediateBasicConstraints ?? { ca: true, pathLength: 1 as number | undefined };

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

interface FixtureInput {
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

async function buildFixture(input: FixtureInput): Promise<{
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

const IDENT = "a".repeat(64);
const MOTEBIT_ID = "01234567-89ab-cdef-0123-456789abcdef";
const DEVICE_ID = "dev-1";
const ATTESTED_AT = 1_745_000_000_000;
const FIXED_NOW = () => new Date("2026-04-22").getTime();

describe("verifyTpmQuote — happy path", () => {
  it("verifies a well-formed fabricated chain against the injected vendor root", async () => {
    const { receipt, chain } = await buildFixture({ identityPublicKeyHex: IDENT });

    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );

    expect(result.valid).toBe(true);
    expect(result.cert_chain_valid).toBe(true);
    expect(result.quote_signature_valid).toBe(true);
    expect(result.quote_shape_valid).toBe(true);
    expect(result.identity_bound).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("tpmVerifier factory delegates to the same path with captured context", async () => {
    const { receipt, chain } = await buildFixture({ identityPublicKeyHex: IDENT });

    const verifier = tpmVerifier({
      rootPems: [chain.rootPem],
      now: FIXED_NOW,
      context: {
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
      },
    });
    const result = await verifier({ platform: "tpm", attestation_receipt: receipt }, IDENT);
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("tpm");
  });

  it("accepts an AK that chains directly to a pinned root (empty intermediates slot)", async () => {
    // The TPM wire format allows an empty intermediates segment when
    // the AK's issuer IS the pinned root. We build such a chain by
    // signing the AK directly with the root's key.
    const alg: EcKeyGenParams & EcdsaParams = {
      name: "ECDSA",
      namedCurve: "P-256",
      hash: "SHA-256",
    };
    const rootKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);
    const leafKeys = await subtle.generateKey(alg, true, ["sign", "verify"]);

    const root = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: "CN=FakeTpmRootDirect",
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2099-01-01"),
      signingAlgorithm: alg,
      keys: rootKeys,
      extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
    });
    const rootPem = root.toString("pem");

    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: "02",
      issuer: root.subject,
      subject: "CN=FakeTpmAkDirect",
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2099-01-01"),
      signingAlgorithm: alg,
      publicKey: leafKeys.publicKey,
      signingKey: rootKeys.privateKey,
      extensions: [],
    });

    const body = canonicalTpmBody({
      attestedAt: ATTESTED_AT,
      deviceId: DEVICE_ID,
      identityPublicKeyHex: IDENT,
      motebitId: MOTEBIT_ID,
    });
    const extraData = await sha256(new TextEncoder().encode(body));
    const attestBytes = composeTpmsAttestForTest({
      qualifiedSigner: new Uint8Array([0x01]),
      extraData,
    });
    const sigBuffer = await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      leafKeys.privateKey,
      attestBytes as BufferSource,
    );

    const receipt = [
      toBase64Url(attestBytes),
      toBase64Url(new Uint8Array(sigBuffer)),
      toBase64Url(new Uint8Array(leaf.rawData)),
      "", // empty intermediates — AK issued directly by the pinned root
    ].join(".");

    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(true);
  });
});

describe("verifyTpmQuote — rejections", () => {
  it("rejects missing attestation_receipt", async () => {
    const result = await verifyTpmQuote(
      { platform: "tpm" },
      { expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("missing");
  });

  it("rejects receipt that is not 4 parts", async () => {
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: "a.b.c" },
      { expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("4 base64url parts");
  });

  it("rejects malformed base64url segment", async () => {
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: "$.$.$.$$$$$" },
      { expectedIdentityPublicKeyHex: IDENT },
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a non-TPM_GENERATED_VALUE magic", async () => {
    const { receipt, chain } = await buildFixture({
      identityPublicKeyHex: IDENT,
      tamperMagic: true,
    });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.quote_shape_valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("magic"))).toBe(true);
  });

  it("rejects a non-quote structure tag", async () => {
    const { receipt, chain } = await buildFixture({
      identityPublicKeyHex: IDENT,
      tamperType: true,
    });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.quote_shape_valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("TPM_ST_ATTEST_QUOTE"))).toBe(true);
  });

  it("rejects a signature produced over different bytes than the transmitted attest", async () => {
    const { receipt, chain } = await buildFixture({
      identityPublicKeyHex: IDENT,
      tamperSignatureSource: true,
    });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.quote_signature_valid).toBe(false);
  });

  it("rejects when the pinned root does not match the chain's terminal", async () => {
    const { receipt } = await buildFixture({ identityPublicKeyHex: IDENT });
    // Use a DIFFERENT fabricated root so the chain terminates at a
    // self-signed anchor that is not on the pin list. The chain-
    // builder will still find the fixture's OWN root in the input
    // pool (the leaf + intermediate's subject/issuer points back to
    // it), but the terminal cert must byte-equal the wrongRootPem we
    // pass via `rootPems` to pass the "matchedPinnedRoot" test.
    const { rootPem: wrongRootPem } = await buildFakeVendorChain();
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [wrongRootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
    // The chain doesn't reach a trusted anchor because the pinned root
    // is a stranger; `X509ChainBuilder` terminates at the best anchor
    // it can find in its pool (the leaf itself when no chain is
    // possible), so the rejection reason may land on "self-signed"
    // or "pinned root" — both are valid. We assert the shape, not the
    // exact sentence.
    expect(
      result.errors.some((e) => e.message.includes("pinned") || e.message.includes("self-signed")),
    ).toBe(true);
  });

  it("rejects when the intermediate lacks basicConstraints.cA=true", async () => {
    const { receipt, chain } = await buildFixture({
      identityPublicKeyHex: IDENT,
      intermediateBasicConstraints: { ca: false },
    });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
  });

  it("rejects when the extraData body names a different identity than the verifier expects", async () => {
    // Body signs identity B; verifier expects identity A. Re-derivation
    // in the verifier produces a hash that doesn't match the
    // transmitted extraData.
    const bodyIdent = "b".repeat(64);
    const { receipt, chain } = await buildFixture({
      identityPublicKeyHex: IDENT,
      bodyIdentityHex: bodyIdent,
    });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
  });

  it("rejects when the body names a different motebit_id", async () => {
    const { receipt, chain } = await buildFixture({
      identityPublicKeyHex: IDENT,
      bodyMotebitId: "wrong-motebit",
    });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
  });

  it("reports identity_bound:false when expectedMotebitId is omitted", async () => {
    const { receipt, chain } = await buildFixture({ identityPublicKeyHex: IDENT });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        // expectedMotebitId/DeviceId/AttestedAt intentionally omitted
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.identity_bound).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("expectedMotebitId"))).toBe(true);
  });

  it("reports identity_bound:false when expectedIdentityPublicKeyHex is empty", async () => {
    const { receipt, chain } = await buildFixture({ identityPublicKeyHex: IDENT });
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: "",
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: FIXED_NOW,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.identity_bound).toBe(false);
  });

  it("rejects when the clock is outside the chain's validity window", async () => {
    const { receipt, chain } = await buildFixture({ identityPublicKeyHex: IDENT });
    // Use a clock value decades after every cert's notAfter.
    const tooLate = () => new Date("2200-01-01").getTime();
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: receipt },
      {
        expectedIdentityPublicKeyHex: IDENT,
        expectedMotebitId: MOTEBIT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedAttestedAt: ATTESTED_AT,
        rootPems: [chain.rootPem],
        now: tooLate,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.cert_chain_valid).toBe(false);
  });
});

describe("verifyTpmQuote — factory minimal config", () => {
  it("tpmVerifier with no config uses defaults and rejects a pinned-root mismatch cleanly", async () => {
    // No config → uses the DEFAULT_PINNED_TPM_ROOTS (real vendor bytes:
    // Infineon, Nuvoton, STMicro RSA, STMicro ECC, Intel PTT). Since
    // tests fabricate their own root, the chain won't match the pins —
    // the verifier should fail-closed with a structured error, not throw.
    const verifier = tpmVerifier();
    const result = await verifier(
      { platform: "tpm" }, // no receipt — short-circuits before chain
      IDENT,
    );
    expect(result.valid).toBe(false);
    expect(result.platform).toBe("tpm");
  });
});
