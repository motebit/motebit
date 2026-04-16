import { describe, it, expect } from "vitest";
import { DISPUTE_WINDOW_MS, MICRO, fromMicro, toMicro } from "../money.js";

describe("money", () => {
  it("MICRO is 1_000_000 — matches USDC 6-decimal precision", () => {
    expect(MICRO).toBe(1_000_000);
  });

  it("DISPUTE_WINDOW_MS is 24 hours in ms", () => {
    expect(DISPUTE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("toMicro rounds $25.00 to 25_000_000", () => {
    expect(toMicro(25.0)).toBe(25_000_000);
  });

  it("toMicro rounds fractional dollars correctly", () => {
    expect(toMicro(0.1)).toBe(100_000);
    expect(toMicro(0.01)).toBe(10_000);
    // 0.1 + 0.2 in floats → 0.30000000000000004. Math.round handles it.
    expect(toMicro(0.1 + 0.2)).toBe(300_000);
  });

  it("fromMicro returns dollars", () => {
    expect(fromMicro(25_000_000)).toBe(25);
    expect(fromMicro(100_000)).toBe(0.1);
  });

  it("toMicro and fromMicro round-trip integer cents", () => {
    for (const dollars of [0, 0.5, 1, 25, 100, 1234.56]) {
      const micro = toMicro(dollars);
      expect(fromMicro(micro)).toBeCloseTo(dollars, 6);
    }
  });
});
