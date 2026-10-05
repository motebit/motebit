/**
 * Withdrawal amount floor — the chokepoint refuses any `amountMicro` that is
 * not a positive safe integer.
 *
 * Incident: production held two `pending` withdrawals of 0 micro-units. The
 * relay route validated the DOLLAR value (`amount > 0`) and then converted it
 * with `toMicro`, so a positive sub-micro amount (1e-7 USD) rounded to 0 and
 * `requestWithdrawal` — which did no amount validation of its own — debited 0
 * and recorded a $0 withdrawal. The package is the chokepoint every caller
 * reaches, so the rule lives here: anything but a positive safe integer is a
 * programming error (callers validate first) and throws a RangeError before
 * the store is touched.
 */
import { describe, it, expect } from "vitest";
import { InMemoryAccountStore } from "../store.js";
import { requestWithdrawal } from "../withdrawals.js";

const ALICE = "motebit_alice";
const FUNDED = 10_000_000;

const BAD_AMOUNTS: Array<[string, number]> = [
  ["zero", 0],
  ["negative", -1],
  ["fractional", 1.5],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 2],
];

describe("requestWithdrawal — amount floor", () => {
  it.each(BAD_AMOUNTS)(
    "refuses %s amountMicro with a RangeError and touches nothing",
    (_, amountMicro) => {
      const store = new InMemoryAccountStore();
      store.credit(ALICE, FUNDED, "deposit", "seed", "seed");
      const txCount = store.getTransactions(ALICE).length;

      expect(() => requestWithdrawal(store, { motebitId: ALICE, amountMicro })).toThrow(RangeError);

      expect(store.getOrCreateAccount(ALICE).balance).toBe(FUNDED);
      expect(store.getTransactions(ALICE)).toHaveLength(txCount);
      expect(store.getWithdrawals(ALICE)).toHaveLength(0);
    },
  );

  it("accepts the 1-micro minimum", () => {
    const store = new InMemoryAccountStore();
    store.credit(ALICE, FUNDED, "deposit", "seed", "seed");
    const r = requestWithdrawal(store, { motebitId: ALICE, amountMicro: 1 });
    if (!r || "existing" in r) throw new Error("expected success");
    expect(r.amount).toBe(1);
    expect(store.getOrCreateAccount(ALICE).balance).toBe(FUNDED - 1);
  });

  it("refuses an invalid amount even when an idempotency key would replay", () => {
    const store = new InMemoryAccountStore();
    store.credit(ALICE, FUNDED, "deposit", "seed", "seed");
    expect(() =>
      requestWithdrawal(store, { motebitId: ALICE, amountMicro: 0, idempotencyKey: "k1" }),
    ).toThrow(RangeError);
    expect(store.getWithdrawals(ALICE)).toHaveLength(0);
  });
});

describe("InMemoryAccountStore.debitAndRecordWithdrawal — amount floor", () => {
  it.each(BAD_AMOUNTS)("refuses %s amount with a RangeError and touches nothing", (_, amount) => {
    const store = new InMemoryAccountStore();
    store.credit(ALICE, FUNDED, "deposit", "seed", "seed");
    expect(() =>
      store.debitAndRecordWithdrawal(
        {
          withdrawal_id: "w1",
          motebit_id: ALICE,
          amount,
          currency: "USD",
          destination: "pending",
          idempotency_key: null,
          requested_at: 1,
        },
        "direct store call",
      ),
    ).toThrow(RangeError);
    expect(store.getOrCreateAccount(ALICE).balance).toBe(FUNDED);
    expect(store.getWithdrawals(ALICE)).toHaveLength(0);
  });
});
