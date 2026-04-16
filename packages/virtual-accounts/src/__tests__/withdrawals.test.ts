import { describe, it, expect } from "vitest";
import { InMemoryAccountStore } from "../store.js";
import {
  completeWithdrawal,
  failWithdrawal,
  getAccountBalanceDetailed,
  linkWithdrawalTransfer,
  requestWithdrawal,
} from "../withdrawals.js";

const ALICE = "motebit_alice";

function seededStore(balance: number): InMemoryAccountStore {
  const store = new InMemoryAccountStore();
  if (balance > 0) store.credit(ALICE, balance, "deposit", "seed", "seed");
  return store;
}

describe("requestWithdrawal", () => {
  it("succeeds when balance covers amount — debits and inserts", () => {
    const store = seededStore(10_000_000);
    let id = 0;
    const r = requestWithdrawal(store, {
      motebitId: ALICE,
      amountMicro: 1_000_000,
      destination: "0xdead",
      newId: () => `w${++id}`,
      now: () => 5_000,
    });
    if (!r || "existing" in r) throw new Error("expected success");
    expect(r.withdrawal_id).toBe("w1");
    expect(r.amount).toBe(1_000_000);
    expect(r.status).toBe("pending");
    expect(r.destination).toBe("0xdead");
    // Balance debited atomically.
    expect(store.getOrCreateAccount(ALICE).balance).toBe(9_000_000);
    // Transaction logged.
    expect(store.getTransactions(ALICE)[0]!.type).toBe("withdrawal");
    expect(store.getTransactions(ALICE)[0]!.amount).toBe(-1_000_000);
  });

  it("returns null on insufficient funds without touching state", () => {
    const store = seededStore(500);
    const txCount = store.getTransactions(ALICE).length;
    const r = requestWithdrawal(store, { motebitId: ALICE, amountMicro: 1_000_000 });
    expect(r).toBeNull();
    expect(store.getOrCreateAccount(ALICE).balance).toBe(500);
    expect(store.getTransactions(ALICE)).toHaveLength(txCount);
    expect(store.getWithdrawals(ALICE)).toHaveLength(0);
  });

  it("returns null when dispute-window hold blocks the withdrawal", () => {
    const store = new InMemoryAccountStore({
      unwithdrawableHold: () => 800_000, // most of the balance held
    });
    store.credit(ALICE, 1_000_000, "deposit", "seed", "seed");
    const r = requestWithdrawal(store, { motebitId: ALICE, amountMicro: 500_000 });
    expect(r).toBeNull();
    // Balance untouched — hold check is before debit.
    expect(store.getOrCreateAccount(ALICE).balance).toBe(1_000_000);
  });

  it("returns the existing request on idempotency-key replay", () => {
    const store = seededStore(10_000_000);
    let id = 0;
    const first = requestWithdrawal(store, {
      motebitId: ALICE,
      amountMicro: 1_000_000,
      idempotencyKey: "user-req-1",
      newId: () => `w${++id}`,
    });
    if (!first || "existing" in first) throw new Error("expected fresh");

    const replay = requestWithdrawal(store, {
      motebitId: ALICE,
      amountMicro: 1_000_000,
      idempotencyKey: "user-req-1",
      newId: () => `w${++id}`,
    });
    if (!replay || !("existing" in replay)) throw new Error("expected idempotent replay");
    expect(replay.existing.withdrawal_id).toBe(first.withdrawal_id);

    // Balance was debited only once.
    expect(store.getOrCreateAccount(ALICE).balance).toBe(9_000_000);
  });

  it("destination defaults to 'pending' when unspecified", () => {
    const store = seededStore(1_000_000);
    const r = requestWithdrawal(store, { motebitId: ALICE, amountMicro: 100_000 });
    if (!r || "existing" in r) throw new Error("expected success");
    expect(r.destination).toBe("pending");
  });
});

describe("linkWithdrawalTransfer", () => {
  it("links a pending withdrawal and rejects a second link", () => {
    const store = seededStore(1_000_000);
    const r = requestWithdrawal(store, {
      motebitId: ALICE,
      amountMicro: 100_000,
      newId: () => "w1",
    });
    if (!r || "existing" in r) throw new Error("expected fresh");

    expect(linkWithdrawalTransfer(store, "w1", "bridge_xfer_a")).toBe(true);
    expect(linkWithdrawalTransfer(store, "w1", "bridge_xfer_b")).toBe(false);
    expect(store.getWithdrawalById("w1")!.payout_reference).toBe("bridge_xfer_a");
  });
});

describe("completeWithdrawal", () => {
  it("marks the withdrawal completed with optional signature", () => {
    const store = seededStore(1_000_000);
    const r = requestWithdrawal(store, {
      motebitId: ALICE,
      amountMicro: 100_000,
      newId: () => "w1",
    });
    if (!r || "existing" in r) throw new Error("expected fresh");

    const ok = completeWithdrawal(store, {
      withdrawalId: "w1",
      payoutReference: "tx_0x123",
      relaySignature: "sig_b64",
      relayPublicKey: "pk_hex",
      completedAt: 42_000,
    });
    expect(ok).toBe(true);
    const w = store.getWithdrawalById("w1")!;
    expect(w.status).toBe("completed");
    expect(w.payout_reference).toBe("tx_0x123");
    expect(w.completed_at).toBe(42_000);
    expect(w.relay_signature).toBe("sig_b64");
    expect(w.relay_public_key).toBe("pk_hex");
  });

  it("returns false when the withdrawal doesn't exist", () => {
    const store = new InMemoryAccountStore();
    expect(completeWithdrawal(store, { withdrawalId: "missing", payoutReference: "ref" })).toBe(
      false,
    );
  });
});

describe("failWithdrawal", () => {
  it("atomically refunds the debited amount and marks failed", () => {
    const store = seededStore(1_000_000);
    const r = requestWithdrawal(store, {
      motebitId: ALICE,
      amountMicro: 400_000,
      newId: () => "w1",
    });
    if (!r || "existing" in r) throw new Error("expected fresh");

    expect(store.getOrCreateAccount(ALICE).balance).toBe(600_000);

    const ok = failWithdrawal(store, "w1", "rail rejected");
    expect(ok).toBe(true);
    // Full refund — balance back to pre-withdrawal state.
    expect(store.getOrCreateAccount(ALICE).balance).toBe(1_000_000);

    const w = store.getWithdrawalById("w1")!;
    expect(w.status).toBe("failed");
    expect(w.failure_reason).toBe("rail rejected");

    // Ledger reflects the refund as a credit of type "withdrawal".
    const lastTx = store.getTransactions(ALICE)[0]!;
    expect(lastTx.type).toBe("withdrawal");
    expect(lastTx.amount).toBe(400_000);
    expect(lastTx.description).toContain("failed");
  });

  it("returns false for a completed withdrawal", () => {
    const store = seededStore(1_000_000);
    const r = requestWithdrawal(store, {
      motebitId: ALICE,
      amountMicro: 100_000,
      newId: () => "w1",
    });
    if (!r || "existing" in r) throw new Error("expected fresh");
    completeWithdrawal(store, { withdrawalId: "w1", payoutReference: "done" });
    expect(failWithdrawal(store, "w1", "late fail")).toBe(false);
  });

  it("returns false for unknown withdrawal ids", () => {
    const store = new InMemoryAccountStore();
    expect(failWithdrawal(store, "missing", "reason")).toBe(false);
  });
});

describe("getAccountBalanceDetailed", () => {
  it("composes balance, pending withdrawals, hold, and sweep config", () => {
    const sweep = { sweep_threshold: 5_000_000, settlement_address: "0xdead" };
    const store = new InMemoryAccountStore({
      unwithdrawableHold: () => 300_000,
      sweepConfig: () => sweep,
    });
    store.credit(ALICE, 2_000_000, "deposit", "seed", null);
    store.insertWithdrawal({
      withdrawal_id: "w1",
      motebit_id: ALICE,
      amount: 100_000,
      currency: "USD",
      destination: "d",
      idempotency_key: null,
      requested_at: 1,
    });

    const detail = getAccountBalanceDetailed(store, ALICE);
    expect(detail).toEqual({
      balance: 2_000_000,
      currency: "USD",
      pending_withdrawals: 100_000,
      pending_allocations: 0,
      dispute_window_hold: 300_000,
      available_for_withdrawal: 1_700_000,
      sweep_threshold: 5_000_000,
      settlement_address: "0xdead",
    });
  });

  it("floors available_for_withdrawal at 0 when hold exceeds balance", () => {
    const store = new InMemoryAccountStore({ unwithdrawableHold: () => 999_000_000 });
    store.credit(ALICE, 100, "deposit", null, null);
    expect(getAccountBalanceDetailed(store, ALICE).available_for_withdrawal).toBe(0);
  });
});
