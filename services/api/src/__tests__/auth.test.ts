import { describe, it, expect } from "vitest";
import { parseTokenPayloadUnsafe } from "../auth.js";

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
