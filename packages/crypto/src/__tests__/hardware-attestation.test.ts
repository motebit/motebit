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
import { describe, expect, it, vi } from "vitest";

import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

import type { HardwareAttestationClaim } from "@motebit/protocol";

import {
  canonicalSecureEnclaveBodyForTest,
  encodeSecureEnclaveReceiptForTest,
  mintSecureEnclaveReceiptForTest,
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
  it("validates a well-formed receipt and returns the SE pubkey", async () => {
    const { claim, sePublicKeyHex } = mintValidReceipt({
      motebit_id: MOTEBIT_ID,
      device_id: DEVICE_ID,
      identity_public_key_hex: IDENTITY_HEX,
      attested_at: 1_700_000_000_000,
    });
    const result = await verifyHardwareAttestationClaim(claim, IDENTITY_HEX);
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("secure_enclave");
    expect(result.se_public_key).toBe(sePublicKeyHex);
    expect(result.attested_at).toBe(1_700_000_000_000);
    expect(result.errors).toEqual([]);
  });

  it("accepts upper-case identity hex (case-insensitive binding check)", async () => {
    const { claim } = mintValidReceipt({
      motebit_id: MOTEBIT_ID,
      device_id: DEVICE_ID,
      identity_public_key_hex: IDENTITY_HEX,
      attested_at: 1_700_000_000_000,
    });
    const result = await verifyHardwareAttestationClaim(claim, IDENTITY_HEX.toUpperCase());
    expect(result.valid).toBe(true);
  });

  it("still verifies signature when key_exported=true (but caller should score lower)", async () => {
    const { claim } = mintValidReceipt({
      motebit_id: MOTEBIT_ID,
      device_id: DEVICE_ID,
      identity_public_key_hex: IDENTITY_HEX,
      attested_at: 1_700_000_000_000,
    });
    const exported: HardwareAttestationClaim = { ...claim, key_exported: true };
    const result = await verifyHardwareAttestationClaim(exported, IDENTITY_HEX);
    expect(result.valid).toBe(true);
  });
});

// ── identity-binding rejection ──────────────────────────────────────

describe("verifyHardwareAttestationClaim — identity binding", () => {
  it("rejects when body's identity_public_key differs from expected", async () => {
    const { claim } = mintValidReceipt({
      motebit_id: MOTEBIT_ID,
      device_id: DEVICE_ID,
      identity_public_key_hex: "a".repeat(64),
      attested_at: 1_700_000_000_000,
    });
    const wrongExpected = "b".repeat(64);
    const result = await verifyHardwareAttestationClaim(claim, wrongExpected);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("identity_public_key mismatch");
  });
});

// ── tampering rejection ─────────────────────────────────────────────

describe("verifyHardwareAttestationClaim — tampering", () => {
  it("rejects when the signed body is tampered (sig no longer verifies)", async () => {
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
    const result = await verifyHardwareAttestationClaim(tamperedClaim, IDENTITY_HEX);
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
  it("rejects missing attestation_receipt", async () => {
    const result = await verifyHardwareAttestationClaim(
      { platform: "secure_enclave" },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("missing");
  });

  it("rejects receipt that isn't two parts", async () => {
    const result = await verifyHardwareAttestationClaim(
      { platform: "secure_enclave", attestation_receipt: "onepart" },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("2 base64url parts");
  });

  it("rejects receipt with invalid base64url", async () => {
    const result = await verifyHardwareAttestationClaim(
      { platform: "secure_enclave", attestation_receipt: "$$$.$$$" },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
  });

  it("rejects body with non-JSON content", async () => {
    const notJson = btoa("not json at all").replace(/=+$/, "");
    const result = await verifyHardwareAttestationClaim(
      { platform: "secure_enclave", attestation_receipt: `${notJson}.AAA` },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("parse failed");
  });

  it("rejects body missing required fields", async () => {
    const partialBody = new TextEncoder().encode(
      JSON.stringify({ version: "1", algorithm: "ecdsa-p256-sha256" }),
    );
    const bodyB64 = btoa(String.fromCharCode(...partialBody))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const result = await verifyHardwareAttestationClaim(
      {
        platform: "secure_enclave",
        attestation_receipt: `${bodyB64}.AAA`,
      },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("missing required field");
  });

  it("rejects body with unsupported version", async () => {
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
    const result = await verifyHardwareAttestationClaim(
      { platform: "secure_enclave", attestation_receipt: receipt },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("unsupported body version");
  });

  it("rejects body with unsupported algorithm", async () => {
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
    const result = await verifyHardwareAttestationClaim(
      { platform: "secure_enclave", attestation_receipt: receipt },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("unsupported body algorithm");
  });
});

// ── non-SE platforms ────────────────────────────────────────────────

describe("verifyHardwareAttestationClaim — non-SE platforms", () => {
  it("returns valid:false for software sentinel (no hardware channel)", async () => {
    const result = await verifyHardwareAttestationClaim({ platform: "software" }, IDENTITY_HEX);
    expect(result.valid).toBe(false);
    expect(result.platform).toBe("software");
    expect(result.errors[0]!.message).toContain("no-hardware sentinel");
  });

  it("returns valid:false with 'not wired' default for tpm (no injected adapter)", async () => {
    const result = await verifyHardwareAttestationClaim({ platform: "tpm" }, IDENTITY_HEX);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("not wired");
  });

  it("returns valid:false for play_integrity (no injected adapter)", async () => {
    const result = await verifyHardwareAttestationClaim(
      { platform: "play_integrity" },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
  });

  it("returns valid:false for device_check (no injected adapter)", async () => {
    const result = await verifyHardwareAttestationClaim({ platform: "device_check" }, IDENTITY_HEX);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("not wired");
  });

  it("delegates to the injected deviceCheck verifier when wired, threading context", async () => {
    const fakeVerifier = vi.fn(async () => ({
      valid: true,
      errors: [],
    }));
    const ctx = {
      expectedMotebitId: MOTEBIT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedAttestedAt: 1_700_000_000_000,
    };
    const result = await verifyHardwareAttestationClaim(
      { platform: "device_check", attestation_receipt: "fake" },
      IDENTITY_HEX,
      { deviceCheck: fakeVerifier },
      ctx,
    );
    expect(fakeVerifier).toHaveBeenCalledOnce();
    // The dispatcher must thread the context through so the verifier
    // can re-derive the JCS body Apple signed over. If the third arg
    // ever drops, App Attest receipts silently lose identity binding.
    expect(fakeVerifier).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "device_check" }),
      IDENTITY_HEX,
      ctx,
    );
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("device_check");
  });

  it("returns valid:false for webauthn (no injected adapter)", async () => {
    const result = await verifyHardwareAttestationClaim({ platform: "webauthn" }, IDENTITY_HEX);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("not wired");
  });

  it("delegates to the injected webauthn verifier when wired, threading context", async () => {
    const fakeVerifier = vi.fn(async () => ({
      valid: true,
      errors: [],
    }));
    const ctx = {
      expectedMotebitId: MOTEBIT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedAttestedAt: 1_700_000_000_000,
    };
    const result = await verifyHardwareAttestationClaim(
      { platform: "webauthn", attestation_receipt: "fake" },
      IDENTITY_HEX,
      { webauthn: fakeVerifier },
      ctx,
    );
    expect(fakeVerifier).toHaveBeenCalledOnce();
    // Same contract as the deviceCheck dispatch: the body-reconstruction
    // context (motebit_id / device_id / attested_at) must thread through
    // so the WebAuthn verifier can re-derive the canonical body the
    // browser signed over.
    expect(fakeVerifier).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "webauthn" }),
      IDENTITY_HEX,
      ctx,
    );
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("webauthn");
  });

  it("returns valid:false for android_keystore (no injected adapter)", async () => {
    const result = await verifyHardwareAttestationClaim(
      { platform: "android_keystore" },
      IDENTITY_HEX,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("not wired");
  });

  it("delegates to the injected androidKeystore verifier when wired, threading context", async () => {
    // Regression: same context-threading gap as the other adapters.
    // Android Keystore Attestation binds the identity via
    // `attestationChallenge === SHA256(canonical body)` — without the
    // threaded motebit_id / device_id / attested_at the verifier cannot
    // reconstruct the body and identity_bound falls to false.
    const fakeVerifier = vi.fn(async () => ({
      valid: true,
      errors: [],
    }));
    const ctx = {
      expectedMotebitId: MOTEBIT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedAttestedAt: 1_700_000_000_000,
    };
    const result = await verifyHardwareAttestationClaim(
      { platform: "android_keystore", attestation_receipt: "fake" },
      IDENTITY_HEX,
      { androidKeystore: fakeVerifier },
      ctx,
    );
    expect(fakeVerifier).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "android_keystore" }),
      IDENTITY_HEX,
      ctx,
    );
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("android_keystore");
  });

  it("delegates to the injected tpm verifier when wired, threading context", async () => {
    // Regression: an earlier revision dispatched `tpm` with only two args
    // so the injected verifier never received the per-credential context.
    // TPM's identity-binding step requires motebit_id / device_id /
    // attested_at to re-derive the canonical body the Rust bridge hashed
    // into `extraData`. If the third arg ever drops, TPM-attested
    // credentials silently fail identity binding.
    const fakeVerifier = vi.fn(async () => ({
      valid: true,
      errors: [],
    }));
    const ctx = {
      expectedMotebitId: MOTEBIT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedAttestedAt: 1_700_000_000_000,
    };
    const result = await verifyHardwareAttestationClaim(
      { platform: "tpm", attestation_receipt: "fake" },
      IDENTITY_HEX,
      { tpm: fakeVerifier },
      ctx,
    );
    expect(fakeVerifier).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "tpm" }),
      IDENTITY_HEX,
      ctx,
    );
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("tpm");
  });

  it("delegates to the injected playIntegrity verifier when wired, threading context", async () => {
    // Regression: same gap as `tpm`. Play Integrity binds the identity via
    // `payload.nonce === base64url(SHA256(canonical body))` — without the
    // threaded motebit_id / device_id / attested_at the verifier cannot
    // reconstruct the body and identity_bound falls to false.
    const fakeVerifier = vi.fn(async () => ({
      valid: true,
      errors: [],
    }));
    const ctx = {
      expectedMotebitId: MOTEBIT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedAttestedAt: 1_700_000_000_000,
    };
    const result = await verifyHardwareAttestationClaim(
      { platform: "play_integrity", attestation_receipt: "fake" },
      IDENTITY_HEX,
      { playIntegrity: fakeVerifier },
      ctx,
    );
    expect(fakeVerifier).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "play_integrity" }),
      IDENTITY_HEX,
      ctx,
    );
    expect(result.valid).toBe(true);
    expect(result.platform).toBe("play_integrity");
  });

  it("returns valid:false + platform:null for an off-enum platform", async () => {
    const result = await verifyHardwareAttestationClaim(
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

// ── mintSecureEnclaveReceiptForTest convenience helper ──────────────

describe("mintSecureEnclaveReceiptForTest", () => {
  // The helper bundles keypair generation + canonical-body encoding +
  // signing + receipt assembly into one call so cross-workspace tests
  // (e.g. services/relay) can exercise the SE verification path without
  // pulling @noble/curves into their own dep tree. The contract is:
  // whatever it returns must round-trip through verifyHardwareAttestationClaim
  // with valid:true. If the helper drifts from the verifier's
  // expectations, every consumer of the helper silently breaks.
  it("produces a claim that verifies against its returned se_public_key", async () => {
    const { claim, sePublicKeyHex } = await mintSecureEnclaveReceiptForTest({
      motebit_id: MOTEBIT_ID,
      device_id: DEVICE_ID,
      identity_public_key: IDENTITY_HEX,
      attested_at: 1_700_000_000_000,
    });
    expect(claim.platform).toBe("secure_enclave");
    expect(claim.key_exported).toBe(false);
    const result = await verifyHardwareAttestationClaim(claim, IDENTITY_HEX);
    expect(result.valid).toBe(true);
    expect(result.se_public_key).toBe(sePublicKeyHex);
    expect(result.attested_at).toBe(1_700_000_000_000);
  });

  it("produces a fresh keypair on each call (returned receipts diverge)", async () => {
    // Belt-and-suspenders against an accidental shared-key regression —
    // the helper must call randomPrivateKey() on each invocation. Two
    // mints with identical inputs should still produce distinct se
    // pubkeys.
    const a = await mintSecureEnclaveReceiptForTest({
      motebit_id: MOTEBIT_ID,
      device_id: DEVICE_ID,
      identity_public_key: IDENTITY_HEX,
      attested_at: 1_700_000_000_000,
    });
    const b = await mintSecureEnclaveReceiptForTest({
      motebit_id: MOTEBIT_ID,
      device_id: DEVICE_ID,
      identity_public_key: IDENTITY_HEX,
      attested_at: 1_700_000_000_000,
    });
    expect(a.sePublicKeyHex).not.toBe(b.sePublicKeyHex);
    expect(a.claim.attestation_receipt).not.toBe(b.claim.attestation_receipt);
  });
});
