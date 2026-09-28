import { describe, it, expect } from "vitest";
import { InMemoryAccountStore } from "../store.js";
import { computeSpendableAvailable } from "../spendable.js";

const ALICE = "motebit_alice";

describe("computeSpendableAvailable — the number debitSpendable enforces (#901)", () => {
  it("nets the escrow hold, and debitSpendable accepts exactly that amount and not one micro more", () => {
    for (const [balance, hold] of [
      [1_000_000, 0],
      [1_000_000, 400_000],
      [1_000_000, 999_999],
      [1_000_000, 1_000_000],
      [1_000_000, 1_500_000], // hold above balance (a claw-back drained the credit)
    ] as const) {
      const store = new InMemoryAccountStore({ unwithdrawableHold: () => hold });
      store.credit(ALICE, balance, "deposit", "seed", "seed");
      const spendable = computeSpendableAvailable(store, ALICE);
      expect(spendable).toBe(Math.max(0, balance - hold));
      // One micro above is refused, with no state change.
      expect(store.debitSpendable(ALICE, spendable + 1, "allocation_hold", "r", null)).toBeNull();
      expect(store.getAccount(ALICE)!.balance).toBe(balance);
      if (spendable > 0) {
        expect(store.debitSpendable(ALICE, spendable, "allocation_hold", "r", null)).toBe(
          balance - spendable,
        );
      }
    }
  });

  it("ignores the grant hold (withdrawal-only), as debitSpendable does", () => {
    const store = new InMemoryAccountStore({ unspentGrantHold: () => 700_000 });
    store.credit(ALICE, 1_000_000, "deposit", "seed", "seed");
    expect(computeSpendableAvailable(store, ALICE)).toBe(1_000_000);
  });

  it("reads an unknown account as 0 without creating it", () => {
    const store = new InMemoryAccountStore();
    expect(computeSpendableAvailable(store, "nobody")).toBe(0);
    expect(store.getAccount("nobody")).toBeNull();
  });
});
