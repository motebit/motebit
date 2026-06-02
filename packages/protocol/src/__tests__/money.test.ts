/**
 * Money-boundary converter tests. The drift gate
 * `scripts/check-money-boundary.ts` forbids inline copies of the
 * `Math.round(amount * 100|1_000_000)` formula in money-touching
 * packages; the formula lives only here, so this is the one place
 * the conversion is exercised end-to-end.
 */
import { describe, it, expect } from "vitest";
import {
  MICRO,
  CENTS,
  toMicro,
  fromMicro,
  toCents,
  fromCents,
  computeP2pFeeMicro,
} from "../money.js";

describe("micro-units", () => {
  it("MICRO equals one million — matches USDC's 6 decimals", () => {
    expect(MICRO).toBe(1_000_000);
  });

  it("toMicro rounds dollars to integer micro-units", () => {
    expect(toMicro(1)).toBe(1_000_000);
    expect(toMicro(0)).toBe(0);
    expect(toMicro(0.000001)).toBe(1);
    expect(toMicro(1.2345678)).toBe(1_234_568); // banker's tie not needed; Math.round half-away-from-zero
  });

  it("fromMicro returns dollars as a float", () => {
    expect(fromMicro(1_000_000)).toBe(1);
    expect(fromMicro(0)).toBe(0);
    expect(fromMicro(1)).toBe(0.000001);
  });

  it("round-trips integer micro values losslessly", () => {
    for (const micro of [0, 1, 1_000_000, 4_030_000, 999_999_999]) {
      expect(toMicro(fromMicro(micro))).toBe(micro);
    }
  });
});

describe("cents", () => {
  it("CENTS equals one hundred — matches Stripe's API precision", () => {
    expect(CENTS).toBe(100);
  });

  it("toCents rounds dollars to integer cents", () => {
    expect(toCents(1)).toBe(100);
    expect(toCents(0)).toBe(0);
    expect(toCents(0.01)).toBe(1);
    expect(toCents(2.345)).toBe(235); // Math.round half-away-from-zero on a representable input
  });

  it("fromCents returns dollars as a float", () => {
    expect(fromCents(100)).toBe(1);
    expect(fromCents(0)).toBe(0);
    expect(fromCents(1)).toBe(0.01);
  });

  it("round-trips integer cent values losslessly", () => {
    for (const cents of [0, 1, 100, 4_030, 999_999]) {
      expect(toCents(fromCents(cents))).toBe(cents);
    }
  });
});

describe("computeP2pFeeMicro", () => {
  it("computes gross - net where gross = round(net / (1 - feeRate))", () => {
    // $1.00 net at 5% → gross round(1_000_000/0.95)=1_052_632 → fee 52_632.
    expect(computeP2pFeeMicro(1_000_000, 0.05)).toBe(52_632);
    // $0.50 net at 5% → gross round(500_000/0.95)=526_316 → fee 26_316.
    expect(computeP2pFeeMicro(500_000, 0.05)).toBe(26_316);
  });

  it("matches the relay validator's exact formula (no drift)", () => {
    // The relay's submission check computes the same expression inline-free
    // via this primitive; replicate it here to lock the contract.
    const feeRate = 0.05;
    for (const net of [1, 999, 1_000_000, 902_500, 7_654_321]) {
      const expected = Math.round(net / (1 - feeRate)) - net;
      expect(computeP2pFeeMicro(net, feeRate)).toBe(expected);
    }
  });

  it("returns 0 when the fee rate is 0 (no fee leg)", () => {
    expect(computeP2pFeeMicro(1_000_000, 0)).toBe(0);
  });

  it("throws when feeRate is out of [0, 1)", () => {
    expect(() => computeP2pFeeMicro(1_000_000, 1)).toThrow();
    expect(() => computeP2pFeeMicro(1_000_000, -0.1)).toThrow();
  });
});
