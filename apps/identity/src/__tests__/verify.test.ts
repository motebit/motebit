import { describe, it, expect } from "vitest";
import { hexToBytes, fromBase64Url, bytesToHex } from "../verify.js";

describe("hexToBytes", () => {
  it("converts hex to bytes", () => {
    expect(hexToBytes("deadbeef")).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("handles empty string", () => {
    expect(hexToBytes("")).toEqual(new Uint8Array([]));
  });

  it("handles lowercase hex", () => {
    expect(hexToBytes("ff00")).toEqual(new Uint8Array([255, 0]));
  });
});

describe("bytesToHex", () => {
  it("converts bytes to hex", () => {
    expect(bytesToHex(new Uint8Array([0xde, 0xad]))).toBe("dead");
  });

  it("pads single-digit hex values", () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15]))).toBe("00010f");
  });

  it("roundtrips with hexToBytes", () => {
    const hex = "aabbccdd00112233";
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
  });
});

describe("fromBase64Url", () => {
  it("decodes base64url without padding", () => {
    // "hello" in base64 is "aGVsbG8=", base64url is "aGVsbG8"
    const result = fromBase64Url("aGVsbG8");
    expect(new TextDecoder().decode(result)).toBe("hello");
  });

  it("decodes base64url with URL-safe characters", () => {
    // Standard base64 uses + and /, base64url uses - and _
    // "test?>" → base64 "dGVzdD8+" → base64url "dGVzdD8-"
    const result = fromBase64Url("dGVzdD8-");
    expect(new TextDecoder().decode(result)).toBe("test?>");
  });

  it("handles already-padded base64url", () => {
    const result = fromBase64Url("aGVsbG8=");
    expect(new TextDecoder().decode(result)).toBe("hello");
  });

  it("decodes empty string", () => {
    const result = fromBase64Url("");
    expect(result.length).toBe(0);
  });
});
