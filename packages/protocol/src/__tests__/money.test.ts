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
  computeFederatedFeeSplit,
  roundSettlementSplitMicro,
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

describe("computeFederatedFeeSplit", () => {
  it("splits a $1.00 budget into A $0.05 / B $0.0475 / worker $0.9025 (spec §7.1 example)", () => {
    const split = computeFederatedFeeSplit(1_000_000, 0.05);
    expect(split.originFeeMicro).toBe(50_000);
    expect(split.executorFeeMicro).toBe(47_500);
    expect(split.workerNetMicro).toBe(902_500);
  });

  it("conserves the budget exactly (three legs sum to the budget)", () => {
    for (const budget of [1, 999, 1_000_000, 7_777_777, 333_333]) {
      const { originFeeMicro, executorFeeMicro, workerNetMicro } = computeFederatedFeeSplit(
        budget,
        0.05,
      );
      expect(originFeeMicro + executorFeeMicro + workerNetMicro).toBe(budget);
    }
  });

  it("matches the relay validator's exact fee-from-budget formula (no drift)", () => {
    const feeRate = 0.05;
    for (const budget of [1_000_000, 902_500, 50_000_000]) {
      const aFee = Math.round(budget * feeRate);
      const fwd = budget - aFee;
      const bFee = Math.round(fwd * feeRate);
      const net = fwd - bFee;
      expect(computeFederatedFeeSplit(budget, feeRate)).toEqual({
        originFeeMicro: aFee,
        executorFeeMicro: bFee,
        workerNetMicro: net,
      });
    }
  });

  it("throws when feeRate is out of [0, 1)", () => {
    expect(() => computeFederatedFeeSplit(1_000_000, 1)).toThrow();
    expect(() => computeFederatedFeeSplit(1_000_000, -0.1)).toThrow();
  });
});

describe("roundSettlementSplitMicro", () => {
  /** The fractional but conserving pair `settleOnReceipt` returns. */
  function exactSplit(gross: number, feeRate: number): { net: number; fee: number } {
    const fee = Math.round(gross * feeRate * 1_000_000) / 1_000_000;
    const net = Math.round((gross - fee) * 1_000_000) / 1_000_000;
    return { net, fee };
  }

  it("conserves the gross across the whole 5%-boundary class that independent rounding breaks", () => {
    const feeRate = 0.05;
    // At feeRate 0.05 every gross ≡ 10 (mod 20) puts BOTH legs on a .5
    // boundary — the class where `Math.round` applied separately to each half
    // sums to gross + 1.
    for (let gross = 10; gross <= 20_000; gross += 20) {
      const { net, fee } = exactSplit(gross, feeRate);

      // The break this function exists to close.
      expect(Math.round(net) + Math.round(fee)).toBe(gross + 1);

      const { netMicro, feeMicro } = roundSettlementSplitMicro(net, fee);
      expect(netMicro + feeMicro).toBe(gross);
      expect(Number.isInteger(netMicro)).toBe(true);
      expect(Number.isInteger(feeMicro)).toBe(true);
    }
  });

  it("conserves for every integer gross in a dense sweep, at several fee rates", () => {
    for (const feeRate of [0.05, 0.03, 0.1, 0.025]) {
      for (let gross = 0; gross <= 5_000; gross++) {
        const { net, fee } = exactSplit(gross, feeRate);
        const { netMicro, feeMicro } = roundSettlementSplitMicro(net, fee);
        expect(netMicro + feeMicro).toBe(gross);
        expect(netMicro).toBeGreaterThanOrEqual(0);
        expect(feeMicro).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("rounds the FEE leg and gives the remainder to the net — same dust direction as the P2P lane", () => {
    // computeP2pFeeMicro rounds the fee and the worker takes the remainder;
    // the relay-custody lane must not disagree about who absorbs the dust.
    const gross = 10;
    const { net, fee } = exactSplit(gross, 0.05); // 9.5 / 0.5
    expect(roundSettlementSplitMicro(net, fee)).toEqual({ netMicro: 9, feeMicro: 1 });
  });

  it("is a no-op on pairs that are already whole micro-units", () => {
    expect(roundSettlementSplitMicro(1_000_000, 52_632)).toEqual({
      netMicro: 1_000_000,
      feeMicro: 52_632,
    });
    expect(roundSettlementSplitMicro(0, 0)).toEqual({ netMicro: 0, feeMicro: 0 });
  });
});
