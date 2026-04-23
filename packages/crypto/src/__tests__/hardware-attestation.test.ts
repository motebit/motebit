/**
 * Tests for `verifyHardwareAttestationClaim` — the in-process verifier
 * that checks a Secure Enclave-style `HardwareAttestationClaim` round-
 * trips cryptographically without needing an actual macOS SE.
 *
 * Test fixtures use `@noble/curves/p256` directly to stand in for the
 * SE: generate a P-256 keypair, build the canonical body + signature
 * with our helpers, assemble the receipt, verify. This exercises the
 * full parse → signature-check → identity-binding path.
 */
import { describe, expect, it } from "vitest";

import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

import type { HardwareAttestationClaim } from "@motebit/protocol";

import {
  canonicalSecureEnclaveBodyForTest,
  encodeSecureEnclaveReceiptForTest,
  verifyHardwareAttestationClaim,
} from "../hardware-attestation.js";

// ── fixture helpers ─────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function makeSeKeypair(): { privateKey: Uint8Array; publicKeyHex: string } {
  const privateKey = p256.utils.randomPrivateKey();
  const publicKey = p256.getPublicKey(privateKey, true); // compressed
  return { privateKey, publicKeyHex: toHex(publicKey) };
}

function signBody(bodyBytes: Uint8Array, privateKey: Uint8Array): Uint8Array {
  // ECDSA-SHA256 over the body. Production SE does the same.
  const digest = sha256(bodyBytes);
  const sig = p256.sign(digest, privateKey, { prehash: false });
  return sig.toDERRawBytes();
}

function mintValidReceipt(opts: {
  motebit_id: string;
  device_id: string;
  identity_public_key_hex: string;
  attested_at: number;
}): { claim: HardwareAttestationClaim; sePublicKeyHex: string } {
  const { privateKey, publicKeyHex } = makeSeKeypair();
  const bodyBytes = canonicalSecureEnclaveBodyForTest({
    motebit_id: opts.motebit_id,
    device_id: opts.device_id,
    identity_public_key: opts.identity_public_key_hex,
    se_public_key: publicKeyHex,
    attested_at: opts.attested_at,
  });
  const sigBytes = signBody(bodyBytes, privateKey);
  const receipt = encodeSecureEnclaveReceiptForTest(bodyBytes, sigBytes);
  return {
    claim: {
      platform: "secure_enclave",
      key_exported: false,
      attestation_receipt: receipt,
    },
    sePublicKeyHex: publicKeyHex,
  };
}

const IDENTITY_HEX = "a".repeat(64); // 32 bytes, plausible Ed25519 shape
const MOTEBIT_ID = "01234567-89ab-cdef-0123-456789abcdef";
const DEVICE_ID = "dev-1";

// ── happy path ──────────────────────────────────────────────────────

describe("verifyHardwareAttestationClaim — secure_enclave happy path", () => {
  it("validates a well-formed receipt and returns the SE pubkey", () => {
    const { claim, sePublicKeyHex } = mintValidReceipt({
      motebit_id: MOTEBIT_ID,
      device_id: DEVICE_ID,
      identity_public_key_hex: IDENTITY_HEX,
      attested_at: 1_700_000_000_000,
    });
    const result = verifyHardwareAttestationClaim(claim, IDENTITY_HEX);
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("secure_enclave");
    expect(result.se_public_key).toBe(sePublicKeyHex);
    expect(result.attested_at).toBe(1_700_000_000_000);
    expect(result.errors).toEqual([]);
  });

  it("accepts upper-case identity hex (case-insensitive binding check)", () => {
    const { claim } = mintValidReceipt({
      motebit_id: MOTEBIT_ID,
      device_id: DEVICE_ID,
      identity_public_key_hex: IDENTITY_HEX,
      attested_at: 1_700_000_000_000,
    });
    const result = verifyHardwareAttestationClaim(claim, IDENTITY_HEX.toUpperCase());
    expect(result.valid).toBe(true);
  });

  it("still verifies signature when key_exported=true (but caller should score lower)", () => {
    const { claim } = mintValidReceipt({
      motebit_id: MOTEBIT_ID,
      device_id: DEVICE_ID,
      identity_public_key_hex: IDENTITY_HEX,
      attested_at: 1_700_000_000_000,
    });
    const exported: HardwareAttestationClaim = { ...claim, key_exported: true };
    const result = verifyHardwareAttestationClaim(exported, IDENTITY_HEX);
    expect(result.valid).toBe(true);
  });
});

// ── identity-binding rejection ──────────────────────────────────────

describe("verifyHardwareAttestationClaim — identity binding", () => {
  it("rejects when body's identity_public_key differs from expected", () => {
    const { claim } = mintValidReceipt({
      motebit_id: MOTEBIT_ID,
      device_id: DEVICE_ID,
      identity_public_key_hex: "a".repeat(64),
      attested_at: 1_700_000_000_000,
    });
    const wrongExpected = "b".repeat(64);
    const result = verifyHardwareAttestationClaim(claim, wrongExpected);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("identity_public_key mismatch");
  });
});

// ── tampering rejection ─────────────────────────────────────────────

describe("verifyHardwareAttestationClaim — tampering", () => {
  it("rejects when the signed body is tampered (sig no longer verifies)", () => {
    const { claim } = mintValidReceipt({
      motebit_id: MOTEBIT_ID,
      device_id: DEVICE_ID,
      identity_public_key_hex: IDENTITY_HEX,
      attested_at: 1_700_000_000_000,
    });
    // Swap the body for a different one while keeping the original sig.
    const otherBody = canonicalSecureEnclaveBodyForTest({
      motebit_id: "different",
      device_id: DEVICE_ID,
      identity_public_key: IDENTITY_HEX,
      se_public_key: "00".repeat(33),
      attested_at: 1_700_000_000_000,
    });
    const [_, sigB64] = claim.attestation_receipt!.split(".");
    const tamperedReceipt = `${btoa(String.fromCharCode(...otherBody))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}.${sigB64}`;
    const tamperedClaim: HardwareAttestationClaim = {
      ...claim,
      attestation_receipt: tamperedReceipt,
    };
    const result = verifyHardwareAttestationClaim(tamperedClaim, IDENTITY_HEX);
    expect(result.valid).toBe(false);
    // The body parses, but signature verification fails (OR the
    // se_public_key mismatch bubbles up first — both are correct
    // rejection reasons).
    expect(
      result.errors.some(
        (e) =>
          e.message.includes("does not verify") ||
          e.message.includes("se_public_key") ||
          e.message.includes("p-256"),
      ),
    ).toBe(true);
  });
});

// ── malformed receipt rejection ─────────────────────────────────────

describe("verifyHardwareAttestationClaim — malformed receipts", () => {
  it("rejects missing attestation_receipt", () => {
    const result = verifyHardwareAttestationClaim({ platform: "secure_enclave" }, IDENTITY_HEX);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("missing");
  });

  it("rejects receipt that isn't two parts", () => {
    const result = verifyHardwareAttestationClaim(
      { platform: "secure_enclave", attestation_receipt: "onepart" },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("2 base64url parts");
  });

  it("rejects receipt with invalid base64url", () => {
    const result = verifyHardwareAttestationClaim(
      { platform: "secure_enclave", attestation_receipt: "$$$.$$$" },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
  });

  it("rejects body with non-JSON content", () => {
    const notJson = btoa("not json at all").replace(/=+$/, "");
    const result = verifyHardwareAttestationClaim(
      { platform: "secure_enclave", attestation_receipt: `${notJson}.AAA` },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("parse failed");
  });

  it("rejects body missing required fields", () => {
    const partialBody = new TextEncoder().encode(
      JSON.stringify({ version: "1", algorithm: "ecdsa-p256-sha256" }),
    );
    const bodyB64 = btoa(String.fromCharCode(...partialBody))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const result = verifyHardwareAttestationClaim(
      {
        platform: "secure_enclave",
        attestation_receipt: `${bodyB64}.AAA`,
      },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("missing required field");
  });

  it("rejects body with unsupported version", () => {
    const { privateKey, publicKeyHex } = makeSeKeypair();
    const oddBody = new TextEncoder().encode(
      JSON.stringify({
        version: "99",
        algorithm: "ecdsa-p256-sha256",
        motebit_id: MOTEBIT_ID,
        device_id: DEVICE_ID,
        identity_public_key: IDENTITY_HEX,
        se_public_key: publicKeyHex,
        attested_at: 1,
      }),
    );
    const sigBytes = signBody(oddBody, privateKey);
    const receipt = encodeSecureEnclaveReceiptForTest(oddBody, sigBytes);
    const result = verifyHardwareAttestationClaim(
      { platform: "secure_enclave", attestation_receipt: receipt },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("unsupported body version");
  });

  it("rejects body with unsupported algorithm", () => {
    const { privateKey, publicKeyHex } = makeSeKeypair();
    const weirdBody = new TextEncoder().encode(
      JSON.stringify({
        version: "1",
        algorithm: "rsa-pkcs1-v1_5",
        motebit_id: MOTEBIT_ID,
        device_id: DEVICE_ID,
        identity_public_key: IDENTITY_HEX,
        se_public_key: publicKeyHex,
        attested_at: 1,
      }),
    );
    const sigBytes = signBody(weirdBody, privateKey);
    const receipt = encodeSecureEnclaveReceiptForTest(weirdBody, sigBytes);
    const result = verifyHardwareAttestationClaim(
      { platform: "secure_enclave", attestation_receipt: receipt },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("unsupported body algorithm");
  });
});

// ── non-SE platforms ────────────────────────────────────────────────

describe("verifyHardwareAttestationClaim — non-SE platforms", () => {
  it("returns valid:false for software sentinel (no hardware channel)", () => {
    const result = verifyHardwareAttestationClaim({ platform: "software" }, IDENTITY_HEX);
    expect(result.valid).toBe(false);
    expect(result.platform).toBe("software");
    expect(result.errors[0]!.message).toContain("no-hardware sentinel");
  });

  it("returns valid:false with 'adapter not shipped' for tpm", () => {
    const result = verifyHardwareAttestationClaim({ platform: "tpm" }, IDENTITY_HEX);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("not yet shipped");
  });

  it("returns valid:false for play_integrity", () => {
    const result = verifyHardwareAttestationClaim({ platform: "play_integrity" }, IDENTITY_HEX);
    expect(result.valid).toBe(false);
  });

  it("returns valid:false for device_check", () => {
    const result = verifyHardwareAttestationClaim({ platform: "device_check" }, IDENTITY_HEX);
    expect(result.valid).toBe(false);
  });

  it("returns valid:false + platform:null for an off-enum platform", () => {
    const result = verifyHardwareAttestationClaim(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        platform: "mystery-platform" as any,
      },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.platform).toBeNull();
    expect(result.errors[0]!.message).toContain("unknown platform");
  });
});
