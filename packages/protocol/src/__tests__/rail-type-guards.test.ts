import { describe, it, expect } from "vitest";
import { isDepositableRail, isBatchableRail } from "../index.js";
import type { GuestRail } from "../index.js";

function makeRail(overrides: Partial<GuestRail> = {}): GuestRail {
  return {
    name: "test",
    custody: "relay",
    railType: "protocol",
    supportsDeposit: false,
    supportsBatch: false,
    isAvailable: async () => true,
    withdraw: async () => ({
      amount: 0,
      currency: "USDC",
      proof: { reference: "", railType: "protocol", confirmedAt: 0 },
    }),
    attachProof: async () => {},
    ...overrides,
  };
}

describe("isDepositableRail", () => {
  it("returns false for a non-depositable rail", () => {
    expect(isDepositableRail(makeRail())).toBe(false);
  });

  it("returns true when supportsDeposit is true", () => {
    const rail = makeRail({ supportsDeposit: true });
    expect(isDepositableRail(rail)).toBe(true);
  });
});

describe("isBatchableRail", () => {
  it("returns false when supportsBatch is false", () => {
    expect(isBatchableRail(makeRail())).toBe(false);
  });

  it("returns false when supportsBatch is true but withdrawBatch is missing", () => {
    const rail = makeRail({ supportsBatch: true });
    expect(isBatchableRail(rail)).toBe(false);
  });

  it("returns true when supportsBatch is true and withdrawBatch is a function", () => {
    const rail = makeRail({
      supportsBatch: true,
      withdrawBatch: async () => ({ fired: [], failed: [] }),
    });
    expect(isBatchableRail(rail)).toBe(true);
  });
});
