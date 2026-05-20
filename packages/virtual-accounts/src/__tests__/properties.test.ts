/**
 * Property-based tests for the virtual-accounts ledger.
 *
 * This file exercises the load-bearing money-path invariants from
 * `CLAUDE.md` (Rules 1, 2, 6) under thousands of randomly-generated
 * operation sequences via fast-check, complementing the hand-written
 * examples in `store.test.ts` and `withdrawals.test.ts`.
 *
 * The invariants under test:
 *
 *   1. **Conservation.** For any sequence of credits and debits on a
 *      single motebit, `balance = Σ(signed deltas in transaction log)`.
 *      Every accepted credit adds +amount; every accepted debit adds
 *      -amount; the running sum at any tx must equal that tx's
 *      `balance_after`. This is the money path's central commitment
 *      (CLAUDE.md Rule 1: integer micro-units end-to-end, no FP drift).
 *
 *   2. **Insufficient-funds atomicity.** A debit that would drive the
 *      balance below zero MUST leave state untouched — no transaction
 *      logged, balance unchanged. This is CLAUDE.md Rule 2: "never a
 *      partial debit."
 *
 *   3. **Round-trip identity.** Credit(x) followed by Debit(x) restores
 *      the balance to its pre-credit value AND appends exactly two
 *      transactions. The ledger is a free abelian group on amount
 *      deltas.
 *
 *   4. **Multi-account isolation.** Operations on motebit A do not
 *      perturb motebit B's balance or transaction log.
 *
 *   5. **Non-negative balance.** Across any arbitrary sequence of
 *      well-formed operations, balance MUST NEVER be negative.
 *
 *   6. **`debitAndEnqueuePending` atomicity.** Either the debit AND the
 *      pending row both happen, or neither does. No partial state where
 *      the account is debited but no pending row exists. (CLAUDE.md
 *      Rule 6's compound shape, expressed at the store interface.)
 *
 *   7. **`debitAndEnqueuePending` idempotency.** Replay with the same
 *      `(motebitId, idempotencyKey)` returns the same pendingId and
 *      does NOT double-debit. Mirrors `requestWithdrawal` +
 *      `getWithdrawalByIdempotencyKey`.
 *
 *   8. **Withdrawal lifecycle: failed-withdrawal refund symmetry.** A
 *      successful `requestWithdrawal` followed by `failWithdrawal`
 *      restores the balance to its pre-request value. (CLAUDE.md
 *      Rule 6: "Withdrawals atomically return funds on failure.")
 *
 * ### Determinism
 *
 * Same pattern as `packages/protocol/src/__tests__/semiring-laws.test.ts`:
 * fast-check's seed is pinned via `configureGlobal` so CI runs are
 * reproducible. A failing run is a bisectable counterexample, not a
 * ghost. If a new property fails locally but passes the fixed-seed CI
 * run, bump the runs count temporarily; do not switch the seed in CI.
 */

import { describe, it, beforeAll, expect } from "vitest";
import fc from "fast-check";
import { InMemoryAccountStore } from "../store.js";
import type { AccountStore } from "../store.js";
import type { TransactionType } from "../types.js";
import { requestWithdrawal, failWithdrawal } from "../withdrawals.js";

const FC_SEED = 0x5eed; // arbitrary fixed value, matches semiring-laws.test.ts shape
beforeAll(() => {
  fc.configureGlobal({ seed: FC_SEED, numRuns: 100 });
});

// ── Arbitraries ────────────────────────────────────────────────────

/** Positive integer micro-units, bounded to keep generators tractable. */
const amountArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 10_000_000_000 });

/** Stable motebit id from a small pool — multi-account isolation needs collisions. */
const motebitIdArb: fc.Arbitrary<string> = fc.constantFrom("mote-a", "mote-b", "mote-c");

/**
 * One operation in an arbitrary sequence. Transaction type is set to
 * one of the categorical values in `TransactionType`; "deposit" /
 * "withdrawal" / "settlement_credit" / "settlement_debit" exercise the
 * full type surface.
 */
type Op =
  | { kind: "credit"; motebitId: string; amount: number; type: TransactionType }
  | { kind: "debit"; motebitId: string; amount: number; type: TransactionType };

const creditTypeArb: fc.Arbitrary<TransactionType> = fc.constantFrom(
  "deposit",
  "settlement_credit",
  "waiver",
);
const debitTypeArb: fc.Arbitrary<TransactionType> = fc.constantFrom(
  "withdrawal",
  "settlement_debit",
  "fee",
  "allocation_hold",
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("credit" as const),
    motebitId: motebitIdArb,
    amount: amountArb,
    type: creditTypeArb,
  }),
  fc.record({
    kind: fc.constant("debit" as const),
    motebitId: motebitIdArb,
    amount: amountArb,
    type: debitTypeArb,
  }),
);

/** An arbitrary sequence of 0–50 ops. */
const opSequenceArb: fc.Arbitrary<Op[]> = fc.array(opArb, { minLength: 0, maxLength: 50 });

// ── Helpers ────────────────────────────────────────────────────────

interface ReplayResult {
  store: AccountStore;
  acceptedOps: Op[]; // ops that actually mutated state (failed debits filtered out)
}

/** Replay an op sequence against a fresh store, returning the accepted subset. */
function replay(ops: Op[]): ReplayResult {
  const store = new InMemoryAccountStore();
  const acceptedOps: Op[] = [];
  let txnId = 0;
  for (const op of ops) {
    if (op.kind === "credit") {
      store.credit(op.motebitId, op.amount, op.type, `ref-${txnId++}`, null);
      acceptedOps.push(op);
    } else {
      const result = store.debit(op.motebitId, op.amount, op.type, `ref-${txnId++}`, null);
      if (result !== null) acceptedOps.push(op);
      // null = insufficient funds — leaves state untouched; no acceptedOp entry
    }
  }
  return { store, acceptedOps };
}

/** Sum signed deltas for one motebit from an op sequence. */
function expectedBalance(motebitId: string, accepted: Op[]): number {
  return accepted
    .filter((o) => o.motebitId === motebitId)
    .reduce((sum, o) => sum + (o.kind === "credit" ? o.amount : -o.amount), 0);
}

// ── Property 1 — Conservation ──────────────────────────────────────

describe("conservation: balance equals Σ(signed deltas in transaction log)", () => {
  it("balance == expected sum after arbitrary credit/debit sequences", () => {
    fc.assert(
      fc.property(opSequenceArb, (ops) => {
        const { store, acceptedOps } = replay(ops);
        for (const motebitId of ["mote-a", "mote-b", "mote-c"]) {
          const account = store.getAccount(motebitId);
          const expected = expectedBalance(motebitId, acceptedOps);
          if (expected === 0 && account === null) continue; // never touched
          if (account === null) return false;
          if (account.balance !== expected) return false;
        }
        return true;
      }),
    );
  });

  it("every tx's `balance_after` field equals running sum up to that tx", () => {
    fc.assert(
      fc.property(opSequenceArb, (ops) => {
        const { store } = replay(ops);
        for (const motebitId of ["mote-a", "mote-b", "mote-c"]) {
          // `getTransactions` returns DESC by created_at; reverse for time-order
          const txs = store.getTransactions(motebitId, 10_000).reverse();
          let running = 0;
          for (const tx of txs) {
            running += tx.amount; // signed: credits positive, debits negative
            if (tx.balance_after !== running) return false;
          }
        }
        return true;
      }),
    );
  });
});

// ── Property 2 — Insufficient-funds atomicity ──────────────────────

describe("insufficient-funds: failed debit leaves state untouched", () => {
  it("debit returns null when balance < amount AND state is unchanged", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (initialCredit, overdraftAmount) => {
          // Generator constraint: overdraft strictly exceeds the credit.
          // Use modular arithmetic on overdraftAmount to guarantee it.
          const debitAmount = initialCredit + overdraftAmount;

          const store = new InMemoryAccountStore();
          if (initialCredit > 0) {
            store.credit("mote-a", initialCredit, "deposit", "ref-0", null);
          }
          const balanceBefore = store.getAccount("mote-a")?.balance ?? 0;
          const txCountBefore = store.getTransactions("mote-a", 10_000).length;

          const result = store.debit("mote-a", debitAmount, "withdrawal", "ref-1", null);
          if (result !== null) return false;

          const balanceAfter = store.getAccount("mote-a")?.balance ?? 0;
          const txCountAfter = store.getTransactions("mote-a", 10_000).length;

          return balanceAfter === balanceBefore && txCountAfter === txCountBefore;
        },
      ),
    );
  });
});

// ── Property 3 — Round-trip identity ───────────────────────────────

describe("round-trip: credit(x) ; debit(x) returns balance to pre-credit value", () => {
  it("balance is restored AND exactly two transactions are logged", () => {
    fc.assert(
      fc.property(amountArb, (amount) => {
        const store = new InMemoryAccountStore();
        const pre = store.getAccount("mote-a")?.balance ?? 0;
        store.credit("mote-a", amount, "deposit", "ref-0", null);
        store.debit("mote-a", amount, "withdrawal", "ref-1", null);
        const post = store.getAccount("mote-a")?.balance ?? 0;
        const txs = store.getTransactions("mote-a", 10_000);
        return post === pre && txs.length === 2;
      }),
    );
  });
});

// ── Property 4 — Multi-account isolation ───────────────────────────

describe("isolation: operations on one motebit don't perturb another", () => {
  it("balance(B) is independent of operations on A", () => {
    fc.assert(
      fc.property(opSequenceArb, opSequenceArb, (opsA, opsB) => {
        // Force motebit field to "mote-a" / "mote-b" respectively
        const aOps: Op[] = opsA.map((o) => ({ ...o, motebitId: "mote-a" }));
        const bOps: Op[] = opsB.map((o) => ({ ...o, motebitId: "mote-b" }));

        // Interleave them in two different orderings; both should yield
        // the same final balance for each motebit independently.
        const interleavedA = [...aOps, ...bOps];
        const interleavedB = [...bOps, ...aOps];

        const r1 = replay(interleavedA);
        const r2 = replay(interleavedB);

        const aBalance1 = r1.store.getAccount("mote-a")?.balance ?? 0;
        const bBalance1 = r1.store.getAccount("mote-b")?.balance ?? 0;
        const aBalance2 = r2.store.getAccount("mote-a")?.balance ?? 0;
        const bBalance2 = r2.store.getAccount("mote-b")?.balance ?? 0;

        return aBalance1 === aBalance2 && bBalance1 === bBalance2;
      }),
    );
  });
});

// ── Property 5 — Non-negative balance ──────────────────────────────

describe("non-negative: balance never goes below zero", () => {
  it("at every point during any operation sequence, balance >= 0", () => {
    fc.assert(
      fc.property(opSequenceArb, (ops) => {
        const store = new InMemoryAccountStore();
        let txnId = 0;
        for (const op of ops) {
          if (op.kind === "credit") {
            store.credit(op.motebitId, op.amount, op.type, `ref-${txnId++}`, null);
          } else {
            store.debit(op.motebitId, op.amount, op.type, `ref-${txnId++}`, null);
          }
          for (const motebitId of ["mote-a", "mote-b", "mote-c"]) {
            const bal = store.getAccount(motebitId)?.balance ?? 0;
            if (bal < 0) return false;
          }
        }
        return true;
      }),
    );
  });
});

// ── Property 6 — debitAndEnqueuePending atomicity ──────────────────

describe("debitAndEnqueuePending: either both happen or neither does", () => {
  it("on success: balance decremented AND pending row exists", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (initialCredit, withdrawAmount) => {
          fc.pre(withdrawAmount <= initialCredit);
          const store = new InMemoryAccountStore();
          store.credit("mote-a", initialCredit, "deposit", "ref-0", null);

          const result = store.debitAndEnqueuePending({
            motebitId: "mote-a",
            amountMicro: withdrawAmount,
            destination: "0xdest",
            rail: "x402",
            source: "user",
            idempotencyKey: null,
          });

          if (result === null) return false;
          const bal = store.getAccount("mote-a")?.balance ?? 0;
          if (bal !== initialCredit - withdrawAmount) return false;

          const pending = (store as InMemoryAccountStore)._debugGetPendingWithdrawal(
            result.pendingId,
          );
          return pending != null && pending.amountMicro === withdrawAmount;
        },
      ),
    );
  });

  it("on insufficient funds: returns null AND state untouched (no debit, no pending row)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (initialCredit, overdraftAmount) => {
          const withdrawAmount = initialCredit + overdraftAmount;
          const store = new InMemoryAccountStore();
          if (initialCredit > 0) {
            store.credit("mote-a", initialCredit, "deposit", "ref-0", null);
          }
          const balBefore = store.getAccount("mote-a")?.balance ?? 0;
          const txsBefore = store.getTransactions("mote-a", 10_000).length;

          const result = store.debitAndEnqueuePending({
            motebitId: "mote-a",
            amountMicro: withdrawAmount,
            destination: "0xdest",
            rail: "x402",
            source: "user",
            idempotencyKey: null,
          });

          if (result !== null) return false;
          const balAfter = store.getAccount("mote-a")?.balance ?? 0;
          const txsAfter = store.getTransactions("mote-a", 10_000).length;
          return balAfter === balBefore && txsAfter === txsBefore;
        },
      ),
    );
  });
});

// ── Property 7 — debitAndEnqueuePending idempotency ────────────────

describe("debitAndEnqueuePending: replay with same idempotency key does not double-debit", () => {
  it("two calls with same key return same pendingId and debit only once", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 1_000_000 }),
        fc.integer({ min: 1, max: 500_000 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        (initialCredit, withdrawAmount, idempotencyKey) => {
          fc.pre(withdrawAmount <= initialCredit);
          const store = new InMemoryAccountStore();
          store.credit("mote-a", initialCredit, "deposit", "ref-0", null);

          const r1 = store.debitAndEnqueuePending({
            motebitId: "mote-a",
            amountMicro: withdrawAmount,
            destination: "0xdest",
            rail: "x402",
            source: "user",
            idempotencyKey,
          });
          const r2 = store.debitAndEnqueuePending({
            motebitId: "mote-a",
            amountMicro: withdrawAmount,
            destination: "0xdest",
            rail: "x402",
            source: "user",
            idempotencyKey,
          });

          if (r1 === null || r2 === null) return false;
          if (r1.pendingId !== r2.pendingId) return false;
          const bal = store.getAccount("mote-a")?.balance ?? 0;
          return bal === initialCredit - withdrawAmount; // debited exactly once
        },
      ),
    );
  });
});

// ── Property 8 — Withdrawal lifecycle: fail restores balance ───────

describe("withdrawal lifecycle: request → fail restores balance to pre-request value", () => {
  it("requestWithdrawal then failWithdrawal returns balance to original", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (initialCredit, withdrawAmount) => {
          fc.pre(withdrawAmount <= initialCredit);
          const store = new InMemoryAccountStore();
          store.credit("mote-a", initialCredit, "deposit", "ref-0", null);
          const balBefore = store.getAccount("mote-a")?.balance ?? 0;

          const result = requestWithdrawal(store, {
            motebitId: "mote-a",
            amountMicro: withdrawAmount,
            destination: "0xdest",
            newId: () => "withdraw-1",
            now: () => 1_700_000_000_000,
          });
          if (!result || "existing" in result) return false;

          const okFail = failWithdrawal(store, result.withdrawal_id, "vendor-error");
          if (!okFail) return false;

          const balAfter = store.getAccount("mote-a")?.balance ?? 0;
          return balAfter === balBefore;
        },
      ),
    );
  });
});

// ── Sanity check: hand-rolled example (not property) ───────────────

// Keep a smoke test next to the property suite so a regression that
// breaks every property is also caught by a single concrete example
// without needing fast-check shrinkage. Mirrors the value of the
// hand-written cases in `store.test.ts`.
describe("smoke: hand-rolled balance equation", () => {
  it("credit 1M then debit 400k then credit 200k = 800k", () => {
    const store = new InMemoryAccountStore();
    store.credit("mote-a", 1_000_000, "deposit", "ref-0", null);
    store.debit("mote-a", 400_000, "withdrawal", "ref-1", null);
    store.credit("mote-a", 200_000, "settlement_credit", "ref-2", null);
    expect(store.getAccount("mote-a")?.balance).toBe(800_000);
  });
});
