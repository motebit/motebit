import { describe, it, expect } from "vitest";
import { InMemoryAccountStore } from "../store.js";

const ALICE = "motebit_alice";
const BOB = "motebit_bob";

describe("InMemoryAccountStore — accounts", () => {
  it("lazy-creates on first access", () => {
    const store = new InMemoryAccountStore();
    expect(store.getAccount(ALICE)).toBeNull();
    const acc = store.getOrCreateAccount(ALICE);
    expect(acc.motebit_id).toBe(ALICE);
    expect(acc.balance).toBe(0);
    expect(acc.currency).toBe("USD");
    expect(store.getAccount(ALICE)).not.toBeNull();
  });

  it("returns a copy, not a live reference", () => {
    const store = new InMemoryAccountStore();
    const a = store.getOrCreateAccount(ALICE);
    a.balance = 999_000_000;
    expect(store.getOrCreateAccount(ALICE).balance).toBe(0);
  });
});

describe("InMemoryAccountStore — credit/debit atomicity", () => {
  it("credit increments balance and logs the transaction", () => {
    const store = new InMemoryAccountStore();
    const newBal = store.credit(ALICE, 1_000_000, "deposit", "stripe_session_1", "deposit $1");
    expect(newBal).toBe(1_000_000);
    const txns = store.getTransactions(ALICE);
    expect(txns).toHaveLength(1);
    expect(txns[0]!.amount).toBe(1_000_000);
    expect(txns[0]!.type).toBe("deposit");
    expect(txns[0]!.balance_after).toBe(1_000_000);
  });

  it("debit succeeds when balance is sufficient", () => {
    const store = new InMemoryAccountStore();
    store.credit(ALICE, 1_000_000, "deposit", "dep1", null);
    const newBal = store.debit(ALICE, 400_000, "withdrawal", "w1", null);
    expect(newBal).toBe(600_000);
    const txns = store.getTransactions(ALICE);
    expect(txns).toHaveLength(2);
    expect(txns[0]!.amount).toBe(-400_000); // debits are logged as negative
    expect(txns[0]!.balance_after).toBe(600_000);
  });

  it("debit returns null on insufficient funds and leaves state unchanged", () => {
    const store = new InMemoryAccountStore();
    store.credit(ALICE, 100, "deposit", "dep1", null);
    const preTxnCount = store.getTransactions(ALICE).length;
    const preBalance = store.getOrCreateAccount(ALICE).balance;

    const result = store.debit(ALICE, 1_000_000, "withdrawal", "w1", null);
    expect(result).toBeNull();
    // No partial state — balance untouched, no new transaction row.
    expect(store.getOrCreateAccount(ALICE).balance).toBe(preBalance);
    expect(store.getTransactions(ALICE)).toHaveLength(preTxnCount);
  });

  it("debit on a missing account returns null (balance = 0 < amount)", () => {
    const store = new InMemoryAccountStore();
    expect(store.debit(BOB, 100, "withdrawal", "w1", null)).toBeNull();
  });
});

describe("InMemoryAccountStore — transaction ledger", () => {
  it("getTransactions returns DESC by created_at, limited", () => {
    let now = 1_000;
    const store = new InMemoryAccountStore({ now: () => now });
    for (let i = 0; i < 5; i++) {
      store.credit(ALICE, 1_000, "deposit", `d${i}`, null);
      now += 100;
    }
    const all = store.getTransactions(ALICE, 3);
    expect(all).toHaveLength(3);
    // Newest first.
    expect(all[0]!.reference_id).toBe("d4");
    expect(all[1]!.reference_id).toBe("d3");
    expect(all[2]!.reference_id).toBe("d2");
  });

  it("hasDepositWithReference matches only deposits, not withdrawals", () => {
    const store = new InMemoryAccountStore();
    store.credit(ALICE, 5_000_000, "deposit", "session_xyz", null);
    store.debit(ALICE, 1_000_000, "withdrawal", "session_xyz", null);
    expect(store.hasDepositWithReference(ALICE, "session_xyz")).toBe(true);
    expect(store.hasDepositWithReference(ALICE, "nonexistent")).toBe(false);
    // Different motebit — negative.
    expect(store.hasDepositWithReference(BOB, "session_xyz")).toBe(false);
  });
});

describe("InMemoryAccountStore — withdrawals", () => {
  it("inserts, looks up by id and by idempotency key", () => {
    const store = new InMemoryAccountStore({ now: () => 5_000 });
    const record = store.insertWithdrawal({
      withdrawal_id: "w1",
      motebit_id: ALICE,
      amount: 100_000,
      currency: "USD",
      destination: "wallet_0xabc",
      idempotency_key: "user-req-1",
      requested_at: 5_000,
    });
    expect(record.status).toBe("pending");
    expect(store.getWithdrawalById("w1")).toMatchObject({ withdrawal_id: "w1", amount: 100_000 });
    expect(store.getWithdrawalByIdempotencyKey(ALICE, "user-req-1")!.withdrawal_id).toBe("w1");
    expect(store.getWithdrawalByIdempotencyKey(ALICE, "other")).toBeNull();
  });

  it("linkWithdrawalTransfer only links pending/processing and only when unlinked", () => {
    const store = new InMemoryAccountStore();
    store.insertWithdrawal({
      withdrawal_id: "w1",
      motebit_id: ALICE,
      amount: 100,
      currency: "USD",
      destination: "d",
      idempotency_key: null,
      requested_at: 1,
    });
    expect(store.linkWithdrawalTransfer("w1", "bridge_xfer_1")).toBe(true);
    // Second link rejected.
    expect(store.linkWithdrawalTransfer("w1", "bridge_xfer_2")).toBe(false);
    expect(store.getWithdrawalById("w1")!.payout_reference).toBe("bridge_xfer_1");
  });

  it("setWithdrawalCompletion refuses to complete already-failed withdrawals", () => {
    const store = new InMemoryAccountStore();
    store.insertWithdrawal({
      withdrawal_id: "w1",
      motebit_id: ALICE,
      amount: 100,
      currency: "USD",
      destination: "d",
      idempotency_key: null,
      requested_at: 1,
    });
    store.updateWithdrawalStatus("w1", "failed", "test");
    expect(store.setWithdrawalCompletion("w1", "ref", 5)).toBe(false);
  });

  it("setWithdrawalSignature persists signature + public key", () => {
    const store = new InMemoryAccountStore();
    store.insertWithdrawal({
      withdrawal_id: "w1",
      motebit_id: ALICE,
      amount: 100,
      currency: "USD",
      destination: "d",
      idempotency_key: null,
      requested_at: 1,
    });
    store.setWithdrawalSignature("w1", "sig_b64", "pk_hex");
    const w = store.getWithdrawalById("w1")!;
    expect(w.relay_signature).toBe("sig_b64");
    expect(w.relay_public_key).toBe("pk_hex");
  });

  it("getPendingWithdrawalsAdmin returns only pending/processing, ASC by requested_at", () => {
    const store = new InMemoryAccountStore();
    store.insertWithdrawal({
      withdrawal_id: "w3",
      motebit_id: ALICE,
      amount: 100,
      currency: "USD",
      destination: "d",
      idempotency_key: null,
      requested_at: 3,
    });
    store.insertWithdrawal({
      withdrawal_id: "w1",
      motebit_id: ALICE,
      amount: 100,
      currency: "USD",
      destination: "d",
      idempotency_key: null,
      requested_at: 1,
    });
    store.insertWithdrawal({
      withdrawal_id: "w2",
      motebit_id: ALICE,
      amount: 100,
      currency: "USD",
      destination: "d",
      idempotency_key: null,
      requested_at: 2,
    });
    store.updateWithdrawalStatus("w2", "failed", "test");
    const pending = store.getPendingWithdrawalsAdmin();
    expect(pending.map((w) => w.withdrawal_id)).toEqual(["w1", "w3"]);
  });

  it("getPendingWithdrawalsTotal sums per-motebit", () => {
    const store = new InMemoryAccountStore();
    store.insertWithdrawal({
      withdrawal_id: "w1",
      motebit_id: ALICE,
      amount: 100,
      currency: "USD",
      destination: "d",
      idempotency_key: null,
      requested_at: 1,
    });
    store.insertWithdrawal({
      withdrawal_id: "w2",
      motebit_id: ALICE,
      amount: 200,
      currency: "USD",
      destination: "d",
      idempotency_key: null,
      requested_at: 2,
    });
    store.insertWithdrawal({
      withdrawal_id: "w3",
      motebit_id: BOB,
      amount: 500,
      currency: "USD",
      destination: "d",
      idempotency_key: null,
      requested_at: 3,
    });
    store.updateWithdrawalStatus("w1", "completed");
    expect(store.getPendingWithdrawalsTotal(ALICE)).toBe(200);
    expect(store.getPendingWithdrawalsTotal(BOB)).toBe(500);
  });
});

describe("InMemoryAccountStore — policy injection", () => {
  it("unwithdrawableHold callback is invoked per motebit", () => {
    const holds = new Map([[ALICE, 1_000]]);
    const store = new InMemoryAccountStore({
      unwithdrawableHold: (id) => holds.get(id) ?? 0,
    });
    expect(store.getUnwithdrawableHold(ALICE)).toBe(1_000);
    expect(store.getUnwithdrawableHold(BOB)).toBe(0);
  });

  it("sweepConfig callback returns configured values", () => {
    const store = new InMemoryAccountStore({
      sweepConfig: (id) =>
        id === ALICE
          ? { sweep_threshold: 5_000_000, settlement_address: "0xdead" }
          : { sweep_threshold: null, settlement_address: null },
    });
    expect(store.getSweepConfig(ALICE)).toEqual({
      sweep_threshold: 5_000_000,
      settlement_address: "0xdead",
    });
    expect(store.getSweepConfig(BOB).sweep_threshold).toBeNull();
  });

  it("defaults: unwithdrawableHold=0, sweepConfig nulls", () => {
    const store = new InMemoryAccountStore();
    expect(store.getUnwithdrawableHold(ALICE)).toBe(0);
    expect(store.getSweepConfig(ALICE)).toEqual({
      sweep_threshold: null,
      settlement_address: null,
    });
  });
});
