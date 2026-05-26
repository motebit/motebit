import { describe, it, expect } from "vitest";
import { base58Encode } from "../base58.js";

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));

describe("base58Encode", () => {
  // Canonical Bitcoin base58btc test vectors.
  it.each([
    ["", ""],
    ["61", "2g"],
    ["626262", "a3gV"],
    ["636363", "aPEr"],
    ["516b6fcd0f", "ABnLTmg"],
    ["00010966776006953d5567439e5e39f86a0d273beed61967f6", "16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM"],
  ])("encodes %s → %s", (input, expected) => {
    expect(base58Encode(hex(input))).toBe(expected);
  });

  it("encodes leading zero bytes as leading '1's (length-preserving prefix)", () => {
    expect(base58Encode(new Uint8Array([0]))).toBe("1");
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe("112");
  });

  it("encodes 32 zero bytes as the Solana System Program id (32 '1's)", () => {
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });

  it("empty input encodes to empty string", () => {
    expect(base58Encode(new Uint8Array(0))).toBe("");
  });

  it("produces only base58btc-alphabet characters (no 0, O, I, l)", () => {
    const bytes = new Uint8Array(64);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
    expect(base58Encode(bytes)).not.toMatch(/[0OIl]/);
  });
});
