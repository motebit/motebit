import { describe, it, expect } from "vitest";
import { generateKeypair, createSignedToken, bytesToHex } from "@motebit/crypto";
import type { IdentityManager } from "@motebit/core-identity";
import type { TokenAudience } from "@motebit/protocol";
import { parseTokenPayloadUnsafe, verifySignedTokenForDevice } from "../auth.js";

/** Encode a payload object into the base64.signature format expected by parseTokenPayloadUnsafe. */
function makeToken(payload: unknown): string {
  const json = JSON.stringify(payload);
  const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64}.fakesignature`;
}

describe("parseTokenPayloadUnsafe", () => {
  const validPayload = {
    mid: "motebit-abc123",
    did: "device-xyz789",
    iat: 1711900000,
    exp: 1711903600,
  };

  it("parses a valid payload with required fields", () => {
    const result = parseTokenPayloadUnsafe(makeToken(validPayload));
    expect(result).toEqual(validPayload);
  });

  it("parses a valid payload with optional jti and aud", () => {
    const payload = { ...validPayload, jti: "tok-001", aud: "device:auth" };
    const result = parseTokenPayloadUnsafe(makeToken(payload));
    expect(result).toEqual(payload);
  });

  it("allows extra fields without failing (forward-compatible)", () => {
    const payload = { ...validPayload, foo: "bar", version: 2 };
    const result = parseTokenPayloadUnsafe(makeToken(payload));
    // Extra fields are stripped — only known fields returned
    expect(result).toEqual(validPayload);
  });

  it("returns null when mid is missing", () => {
    const { mid: _, ...rest } = validPayload;
    expect(parseTokenPayloadUnsafe(makeToken(rest))).toBeNull();
  });

  it("returns null when did is missing", () => {
    const { did: _, ...rest } = validPayload;
    expect(parseTokenPayloadUnsafe(makeToken(rest))).toBeNull();
  });

  it("returns null when iat is missing", () => {
    const { iat: _, ...rest } = validPayload;
    expect(parseTokenPayloadUnsafe(makeToken(rest))).toBeNull();
  });

  it("returns null when exp is missing", () => {
    const { exp: _, ...rest } = validPayload;
    expect(parseTokenPayloadUnsafe(makeToken(rest))).toBeNull();
  });

  it("returns null when mid is empty string", () => {
    expect(parseTokenPayloadUnsafe(makeToken({ ...validPayload, mid: "" }))).toBeNull();
  });

  it("returns null when did is empty string", () => {
    expect(parseTokenPayloadUnsafe(makeToken({ ...validPayload, did: "" }))).toBeNull();
  });

  it("returns null when mid is wrong type (number)", () => {
    expect(parseTokenPayloadUnsafe(makeToken({ ...validPayload, mid: 42 }))).toBeNull();
  });

  it("returns null when did is wrong type (boolean)", () => {
    expect(parseTokenPayloadUnsafe(makeToken({ ...validPayload, did: true }))).toBeNull();
  });

  it("returns null when iat is a string", () => {
    expect(parseTokenPayloadUnsafe(makeToken({ ...validPayload, iat: "2024-01-01" }))).toBeNull();
  });

  it("returns null when exp is NaN", () => {
    expect(parseTokenPayloadUnsafe(makeToken({ ...validPayload, exp: NaN }))).toBeNull();
  });

  it("returns null when exp is Infinity", () => {
    expect(parseTokenPayloadUnsafe(makeToken({ ...validPayload, exp: Infinity }))).toBeNull();
  });

  it("returns null when jti is wrong type (number)", () => {
    expect(parseTokenPayloadUnsafe(makeToken({ ...validPayload, jti: 123 }))).toBeNull();
  });

  it("returns null when aud is wrong type (boolean)", () => {
    expect(parseTokenPayloadUnsafe(makeToken({ ...validPayload, aud: false }))).toBeNull();
  });

  it("returns null for token without dot separator", () => {
    expect(parseTokenPayloadUnsafe("nodothere")).toBeNull();
  });

  it("returns null for invalid base64", () => {
    expect(parseTokenPayloadUnsafe("!!!invalid!!!.sig")).toBeNull();
  });

  it("returns null for non-JSON base64", () => {
    const b64 = btoa("not json at all");
    expect(parseTokenPayloadUnsafe(`${b64}.sig`)).toBeNull();
  });

  it("returns null for array payload", () => {
    expect(parseTokenPayloadUnsafe(makeToken([1, 2, 3]))).toBeNull();
  });

  it("returns null for null payload", () => {
    expect(parseTokenPayloadUnsafe(makeToken(null))).toBeNull();
  });

  it("returns null for string payload", () => {
    const b64 = btoa('"just a string"');
    expect(parseTokenPayloadUnsafe(`${b64}.sig`)).toBeNull();
  });
});

describe("verifySignedTokenForDevice — agent-registry sibling fallback", () => {
  const mid = "motebit-molecule-1";
  const did = "device-molecule-1";

  /** IdentityManager whose device store has no row for anyone (service-mode caller). */
  const noDeviceIM = {
    loadDeviceById: async () => null,
  } as unknown as IdentityManager;

  /** IdentityManager with a device row carrying the given public key. */
  function deviceIM(publicKeyHex: string): IdentityManager {
    return {
      loadDeviceById: async () => ({ public_key: publicKeyHex }),
    } as unknown as IdentityManager;
  }

  async function mintToken(privateKey: Uint8Array, aud: TokenAudience = "market:listing") {
    // exp is compared against Date.now() (ms) in verifySignedToken — use ms.
    const now = Date.now();
    return createSignedToken(
      { mid, did, iat: now, exp: now + 300_000, jti: "jti-molecule-1", aud },
      privateKey,
    );
  }

  it("rejects a service-mode molecule's token WITHOUT the fallback (reproduces the bug)", async () => {
    const kp = await generateKeypair();
    const token = await mintToken(kp.privateKey);
    // No device row, no agentKeyLookup → the pre-fix behavior: silent 401.
    const ok = await verifySignedTokenForDevice(token, mid, noDeviceIM, "market:listing");
    expect(ok).toBe(false);
  });

  it("accepts the same token WITH the agent-registry fallback", async () => {
    const kp = await generateKeypair();
    const token = await mintToken(kp.privateKey);
    const lookup = (m: string) => (m === mid ? bytesToHex(kp.publicKey) : null);
    const ok = await verifySignedTokenForDevice(
      token,
      mid,
      noDeviceIM,
      "market:listing",
      undefined,
      undefined,
      lookup,
    );
    expect(ok).toBe(true);
  });

  it("still rejects a wrong-audience token even via the fallback", async () => {
    const kp = await generateKeypair();
    const token = await mintToken(kp.privateKey, "task:submit");
    const lookup = (m: string) => (m === mid ? bytesToHex(kp.publicKey) : null);
    const ok = await verifySignedTokenForDevice(
      token,
      mid,
      noDeviceIM,
      "market:listing",
      undefined,
      undefined,
      lookup,
    );
    expect(ok).toBe(false);
  });

  it("still rejects a revoked agent before consulting the fallback", async () => {
    const kp = await generateKeypair();
    const token = await mintToken(kp.privateKey);
    const lookup = (m: string) => (m === mid ? bytesToHex(kp.publicKey) : null);
    const ok = await verifySignedTokenForDevice(
      token,
      mid,
      noDeviceIM,
      "market:listing",
      undefined,
      () => true, // agentRevokedCheck → revoked
      lookup,
    );
    expect(ok).toBe(false);
  });

  it("rejects a token signed by a key that is NOT the registry key (forged)", async () => {
    const real = await generateKeypair();
    const forger = await generateKeypair();
    const token = await mintToken(forger.privateKey);
    // Registry holds the REAL key; the token was signed by the forger.
    const lookup = (m: string) => (m === mid ? bytesToHex(real.publicKey) : null);
    const ok = await verifySignedTokenForDevice(
      token,
      mid,
      noDeviceIM,
      "market:listing",
      undefined,
      undefined,
      lookup,
    );
    expect(ok).toBe(false);
  });

  it("prefers the device store when a device row exists (fallback not consulted)", async () => {
    const kp = await generateKeypair();
    const token = await mintToken(kp.privateKey);
    // Device row has the right key; lookup would throw if consulted — proving precedence.
    const lookup = () => {
      throw new Error("agentKeyLookup must not be consulted when a device row exists");
    };
    const ok = await verifySignedTokenForDevice(
      token,
      mid,
      deviceIM(bytesToHex(kp.publicKey)),
      "market:listing",
      undefined,
      undefined,
      lookup,
    );
    expect(ok).toBe(true);
  });
});
