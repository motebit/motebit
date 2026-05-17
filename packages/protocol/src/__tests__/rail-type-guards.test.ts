import { describe, it, expect } from "vitest";
import { isDepositableRail, isBatchableRail, isWithdrawableRail } from "../index.js";
import type { GuestRail, WithdrawableGuestRail } from "../index.js";

function makeRail(overrides: Partial<GuestRail> = {}): GuestRail {
  return {
    name: "test",
    custody: "relay",
    railType: "protocol",
    supportsDeposit: false,
    supportsWithdraw: false,
    supportsBatch: false,
    isAvailable: async () => true,
    attachProof: async () => {},
    ...overrides,
  };
}

function makeWithdrawableRail(
  overrides: Partial<WithdrawableGuestRail> = {},
): WithdrawableGuestRail {
  return {
    ...makeRail({ supportsWithdraw: true }),
    supportsWithdraw: true,
    withdraw: async () => ({
      amount: 0,
      currency: "USDC",
      proof: { reference: "", railType: "protocol", confirmedAt: 0 },
    }),
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

describe("isWithdrawableRail", () => {
  it("returns false when supportsWithdraw is false (e.g. BridgeSettlementRail post-Arc-1-Commit-2)", () => {
    expect(isWithdrawableRail(makeRail())).toBe(false);
  });

  it("returns false when supportsWithdraw is true but withdraw method is missing", () => {
    // Defensive: a rail that lies about the discriminant but doesn't
    // actually implement withdraw still fails the guard at runtime.
    const lyingRail = makeRail({ supportsWithdraw: true });
    expect(isWithdrawableRail(lyingRail)).toBe(false);
  });

  it("returns true when supportsWithdraw is true and withdraw is a function", () => {
    expect(isWithdrawableRail(makeWithdrawableRail())).toBe(true);
  });
});

describe("isBatchableRail", () => {
  it("returns false when supportsBatch is false", () => {
    expect(isBatchableRail(makeRail())).toBe(false);
  });

  it("returns false when supportsBatch is true but withdrawBatch is missing", () => {
    const rail = makeWithdrawableRail({ supportsBatch: true });
    expect(isBatchableRail(rail)).toBe(false);
  });

  it("returns true when supportsBatch is true and withdrawBatch is a function", () => {
    const rail = makeWithdrawableRail({
      supportsBatch: true,
      withdrawBatch: async () => ({ fired: [], failed: [] }),
    });
    expect(isBatchableRail(rail)).toBe(true);
  });
});
