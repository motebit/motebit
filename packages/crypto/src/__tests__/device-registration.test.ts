import { describe, it, expect, beforeAll } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import {
  signDeviceRegistration,
  verifyDeviceRegistration,
  DEVICE_REGISTRATION_SUITE,
  DEVICE_REGISTRATION_MAX_AGE_MS,
} from "../index";

beforeAll(() => {
  if (!ed.hashes.sha512) {
    ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
  }
});

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function freshKeys() {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, publicKeyHex: toHex(publicKey) };
}

function baseBody(publicKeyHex: string, overrides: Record<string, unknown> = {}) {
  return {
    motebit_id: "019d903f-13de-75a4-8341-58319e0a2f16",
    device_id: "01a04bb5-9c87-7d2c-bc6c-2f4cd3ce11d8",
    public_key: publicKeyHex,
    device_name: "test-device",
    owner_id: "self:019d903f-13de-75a4-8341-58319e0a2f16",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("signDeviceRegistration / verifyDeviceRegistration", () => {
  it("round-trips: signed request verifies against the embedded public key", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const signed = await signDeviceRegistration(baseBody(publicKeyHex), privateKey);
    expect(signed.suite).toBe(DEVICE_REGISTRATION_SUITE);
    expect(typeof signed.signature).toBe("string");
    expect(signed.signature.length).toBeGreaterThan(0);

    const result = await verifyDeviceRegistration(signed);
    expect(result).toEqual({ valid: true });
  });

  it("rejects requests outside the ±5 minute timestamp window (stale)", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const tooOld = Date.now() - DEVICE_REGISTRATION_MAX_AGE_MS - 1000;
    const signed = await signDeviceRegistration(
      baseBody(publicKeyHex, { timestamp: tooOld }),
      privateKey,
    );
    const result = await verifyDeviceRegistration(signed);
    expect(result).toEqual({ valid: false, reason: "stale" });
  });

  it("rejects future-dated requests outside the window (also stale)", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const tooFuture = Date.now() + DEVICE_REGISTRATION_MAX_AGE_MS + 1000;
    const signed = await signDeviceRegistration(
      baseBody(publicKeyHex, { timestamp: tooFuture }),
      privateKey,
    );
    const result = await verifyDeviceRegistration(signed);
    expect(result).toEqual({ valid: false, reason: "stale" });
  });

  it("rejects when the body is mutated after signing (bad_signature)", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const signed = await signDeviceRegistration(baseBody(publicKeyHex), privateKey);
    const tampered = { ...signed, motebit_id: "different-id" };
    const result = await verifyDeviceRegistration(tampered);
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects when the public_key in the body does not match the signer", async () => {
    // Signer A's private key, but body advertises signer B's public key.
    // The relay uses the public key in the body to verify, so this fails.
    const a = await freshKeys();
    const b = await freshKeys();
    const signed = await signDeviceRegistration(baseBody(b.publicKeyHex), a.privateKey);
    const result = await verifyDeviceRegistration(signed);
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects malformed public_key (non-hex)", async () => {
    const { privateKey } = await freshKeys();
    const signed = await signDeviceRegistration(baseBody("not-a-hex-key"), privateKey);
    const result = await verifyDeviceRegistration(signed);
    expect(result).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects malformed timestamp (string)", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const signed = await signDeviceRegistration(baseBody(publicKeyHex), privateKey);
    // Coerce timestamp to a string after signing
    const broken = { ...signed, timestamp: "1234" as unknown as number };
    const result = await verifyDeviceRegistration(broken);
    expect(result).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects unknown suite", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const signed = await signDeviceRegistration(baseBody(publicKeyHex), privateKey);
    const wrongSuite = {
      ...signed,
      suite: "made-up-suite-v999" as unknown as typeof DEVICE_REGISTRATION_SUITE,
    };
    const result = await verifyDeviceRegistration(wrongSuite);
    expect(result).toEqual({ valid: false, reason: "unsupported_suite" });
  });

  it("optional fields (device_name, owner_id) round-trip", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const signed = await signDeviceRegistration(
      baseBody(publicKeyHex, { device_name: undefined, owner_id: undefined }),
      privateKey,
    );
    const result = await verifyDeviceRegistration(signed);
    expect(result).toEqual({ valid: true });
  });

  it("clock parameter overrides Date.now() for testing replay windows", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const stamp = 1_000_000_000_000; // arbitrary fixed time
    const signed = await signDeviceRegistration(
      baseBody(publicKeyHex, { timestamp: stamp }),
      privateKey,
    );
    // Verifier's clock matches the signer's — within window even though Date.now()
    // is years away.
    const inWindow = await verifyDeviceRegistration(signed, stamp + 1_000);
    expect(inWindow).toEqual({ valid: true });
    // Pin the clock outside the window — fails.
    const outOfWindow = await verifyDeviceRegistration(signed, stamp + 10 * 60 * 1000);
    expect(outOfWindow).toEqual({ valid: false, reason: "stale" });
  });
});
