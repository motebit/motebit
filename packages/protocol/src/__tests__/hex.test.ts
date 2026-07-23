import { describe, it, expect } from "vitest";
import { hexToBytes32 } from "../hex.js";

describe("hexToBytes32", () => {
  it("decodes a 64-char hex string to 32 bytes", () => {
    const bytes = hexToBytes32("00".repeat(32));
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(32);
    expect(Array.from(bytes!)).toEqual(new Array(32).fill(0));
  });

  it("decodes byte values correctly (round-trips through the nibble math)", () => {
    const bytes = hexToBytes32("0102ff80" + "00".repeat(28));
    expect(bytes!.slice(0, 4)).toEqual(new Uint8Array([1, 2, 255, 128]));
  });

  it("is case-insensitive", () => {
    const lower = hexToBytes32("ab".repeat(32));
    const upper = hexToBytes32("AB".repeat(32));
    expect(lower).toEqual(upper);
  });

  it("fails closed (null) on wrong length", () => {
    expect(hexToBytes32("00".repeat(31))).toBeNull(); // 62 chars
    expect(hexToBytes32("00".repeat(33))).toBeNull(); // 66 chars
    expect(hexToBytes32("")).toBeNull();
  });

  it("fails closed (null) on non-hex characters", () => {
    expect(hexToBytes32("zz".repeat(32))).toBeNull();
    expect(hexToBytes32("00".repeat(31) + "0g")).toBeNull();
  });
});
