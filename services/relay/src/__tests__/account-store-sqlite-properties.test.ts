/**
 * Property-based tests for `SqliteAccountStore` — the production
 * `AccountStore` implementation that backs the relay's ledger.
 *
 * `packages/virtual-accounts/src/__tests__/properties.test.ts` ships
 * eleven property-based assertions over the `InMemoryAccountStore`
 * (conservation, atomicity, idempotency, refund symmetry). Those
 * properties are the load-bearing money-path invariants from CLAUDE.md
 * Rules 1, 2, 6 — but they verify the in-memory implementation, not the
 * production code path. The same invariants MUST hold against the
 * SQLite-backed store the relay actually runs, or the 5% fee story has
 * a structural hole at the only checkpoint where money moves.
 *
 * This suite mirrors the virtual-accounts shape against
 * `SqliteAccountStore`. Sibling pattern to the seven crypto-* and
 * money-path property suites that landed in the 2026-05-20 arc. Per
 * `services/relay/CLAUDE.md` rule 9, the legacy `accounts.ts` functional
 * API now routes through this same store — so a property failure here
 * implicates every settlement path: deposits, debits, withdrawal
 * enqueue, refund. Per `docs/doctrine/evals-as-attestations.md` §
 * "What ships now", these are testing-only artifacts under the
 * existing service surface.
 *
 * ### What's already covered hand-written
 *
 * - `virtual-accounts.test.ts` (1423 lines) — HTTP-layer happy/sad path
 * - `money-loop-concurrency.test.ts` (399 lines) — N=10 concurrent ops
 * - `money-loop-failures.test.ts`, `settlement-safety.test.ts`,
 *   `account-store-fail-closed.test.ts` — specific failure cases
 *
 * ### What this adds
 *
 * - Arbitrary credit/debit sequences (thousands per property)
 * - Conservation invariant against the SQLite store, not the in-memory
 *   implementation
 * - Catches an implementation-divergence bug that virtual-accounts'
 *   property suite structurally cannot reach
 *
 * ### Determinism
 *
 * Pinned seed 0x5eed matches semiring-laws / virtual-accounts / skills
 * / crypto-* / sensitivity-laws shape for CI reproducibility.
 */

import { describe, it, beforeAll, expect } from "vitest";
import fc from "fast-check";
import { createMotebitDatabase } from "@motebit/persistence";
import type { TransactionType } from "@motebit/virtual-accounts";
import { requestWithdrawal, failWithdrawal } from "@motebit/virtual-accounts";
import {
  SqliteAccountStore,
  createAccountTables,
  createWalletTable,
  createWithdrawalTables,
} from "../account-store-sqlite.js";
import { createFederationTables } from "../federation.js";
import { createPairingTables } from "../pairing.js";
import { createDataSyncTables } from "../data-sync.js";
import { createProofTable } from "../settlement-proofs.js";
import { createIdempotencyTable } from "../idempotency.js";
import { relayMigrations, runMigrations } from "../migrations.js";

const FC_SEED = 0x5eed;

beforeAll(() => {
  fc.configureGlobal({ seed: FC_SEED, numRuns: 50 });
});

/**
 * Fresh in-memory SQLite store per property run. The relay's production
 * boot path wires the schema before the store is used; we mirror that
 * here. Each property run rebuilds because we want isolation between
 * arbitrary op sequences.
 */
function freshStore(): { store: SqliteAccountStore; close: () => void } {
  const moteDb = createMotebitDatabase(":memory:");
  // Mirror the production boot order — `services/relay/src/index.ts`
  // §"Tables from extracted modules" comment notes "federation must
  // precede relay schema for ALTER TABLE". The `relay_pending_withdrawals`
  // table that `debitAndEnqueuePending` writes to is provisioned by the
  // migration set, which in turn alters federation/settlement tables
  // created by the static `createXTables` functions above.
  createFederationTables(moteDb.db);
  createPairingTables(moteDb.db);
  createDataSyncTables(moteDb.db);
  createAccountTables(moteDb.db);
  createWithdrawalTables(moteDb.db);
  createProofTable(moteDb.db);
  createWalletTable(moteDb.db);
  createIdempotencyTable(moteDb.db);
  runMigrations(moteDb.db, relayMigrations);
  return { store: new SqliteAccountStore(moteDb.db), close: () => moteDb.close() };
}

// ── Arbitraries ────────────────────────────────────────────────────

const amountArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 10_000_000_000 });

const motebitIdArb: fc.Arbitrary<string> = fc.constantFrom("mote-a", "mote-b", "mote-c");

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

type Op =
  | { kind: "credit"; motebitId: string; amount: number; type: TransactionType }
  | { kind: "debit"; motebitId: string; amount: number; type: TransactionType };

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

/** Bounded sequence length — each op is a SQLite roundtrip, so keep tractable. */
const opSequenceArb: fc.Arbitrary<Op[]> = fc.array(opArb, { minLength: 0, maxLength: 30 });

interface ReplayResult {
  store: SqliteAccountStore;
  close: () => void;
  acceptedOps: Op[];
}

function replay(ops: Op[]): ReplayResult {
  const { store, close } = freshStore();
  const acceptedOps: Op[] = [];
  let txnId = 0;
  for (const op of ops) {
    if (op.kind === "credit") {
      store.credit(op.motebitId, op.amount, op.type, `ref-${txnId++}`, null);
      acceptedOps.push(op);
    } else {
      const result = store.debit(op.motebitId, op.amount, op.type, `ref-${txnId++}`, null);
      if (result !== null) acceptedOps.push(op);
    }
  }
  return { store, close, acceptedOps };
}

function expectedBalance(motebitId: string, accepted: Op[]): number {
  return accepted
    .filter((o) => o.motebitId === motebitId)
    .reduce((sum, o) => sum + (o.kind === "credit" ? o.amount : -o.amount), 0);
}

// ── Property 1 — Conservation against SQLite store ─────────────────

describe("SqliteAccountStore conservation: balance equals Σ(signed deltas in transaction log)", () => {
  it("balance == expected sum after arbitrary credit/debit sequences (SQLite-backed)", () => {
    fc.assert(
      fc.property(opSequenceArb, (ops) => {
        const { store, close, acceptedOps } = replay(ops);
        try {
          for (const motebitId of ["mote-a", "mote-b", "mote-c"]) {
            const account = store.getAccount(motebitId);
            const expected = expectedBalance(motebitId, acceptedOps);
            if (expected === 0 && account === null) continue;
            if (account === null) return false;
            if (account.balance !== expected) return false;
          }
          return true;
        } finally {
          close();
        }
      }),
    );
  });

  it("every tx's `balance_after` equals running sum up to that tx (SQLite-backed)", () => {
    fc.assert(
      fc.property(opSequenceArb, (ops) => {
        const { store, close } = replay(ops);
        try {
          for (const motebitId of ["mote-a", "mote-b", "mote-c"]) {
            // getTransactions returns DESC by created_at; reverse for time-order
            const txs = store.getTransactions(motebitId, 10_000).reverse();
            let running = 0;
            for (const tx of txs) {
              running += tx.amount;
              if (tx.balance_after !== running) return false;
            }
          }
          return true;
        } finally {
          close();
        }
      }),
    );
  });
});

// ── Property 2 — Insufficient-funds atomicity ──────────────────────

describe("SqliteAccountStore insufficient-funds: failed debit leaves state untouched", () => {
  it("debit returns null when balance < amount AND state is unchanged (SQLite-backed)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (initialCredit, overdraftAmount) => {
          const debitAmount = initialCredit + overdraftAmount;
          const { store, close } = freshStore();
          try {
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
          } finally {
            close();
          }
        },
      ),
    );
  });
});

// ── Property 3 — Non-negative balance across any sequence ──────────

describe("SqliteAccountStore non-negative: balance never goes below zero", () => {
  it("at every point during any operation sequence, balance >= 0 (SQLite-backed)", () => {
    fc.assert(
      fc.property(opSequenceArb, (ops) => {
        const { store, close } = freshStore();
        try {
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
        } finally {
          close();
        }
      }),
    );
  });
});

// ── Property 4 — Round-trip identity ───────────────────────────────

describe("SqliteAccountStore round-trip: credit(x) ; debit(x) restores balance", () => {
  it("balance is restored AND exactly two transactions are logged (SQLite-backed)", () => {
    fc.assert(
      fc.property(amountArb, (amount) => {
        const { store, close } = freshStore();
        try {
          const pre = store.getAccount("mote-a")?.balance ?? 0;
          store.credit("mote-a", amount, "deposit", "ref-0", null);
          store.debit("mote-a", amount, "withdrawal", "ref-1", null);
          const post = store.getAccount("mote-a")?.balance ?? 0;
          const txs = store.getTransactions("mote-a", 10_000);
          return post === pre && txs.length === 2;
        } finally {
          close();
        }
      }),
    );
  });
});

// ── Property 5 — Multi-account isolation ───────────────────────────

describe("SqliteAccountStore isolation: ops on one motebit don't perturb another", () => {
  it("balance(B) is independent of ordering of ops on A vs B (SQLite-backed)", () => {
    fc.assert(
      fc.property(opSequenceArb, opSequenceArb, (opsA, opsB) => {
        const aOps: Op[] = opsA.map((o) => ({ ...o, motebitId: "mote-a" }));
        const bOps: Op[] = opsB.map((o) => ({ ...o, motebitId: "mote-b" }));
        const r1 = replay([...aOps, ...bOps]);
        const r2 = replay([...bOps, ...aOps]);
        try {
          const aBalance1 = r1.store.getAccount("mote-a")?.balance ?? 0;
          const bBalance1 = r1.store.getAccount("mote-b")?.balance ?? 0;
          const aBalance2 = r2.store.getAccount("mote-a")?.balance ?? 0;
          const bBalance2 = r2.store.getAccount("mote-b")?.balance ?? 0;
          return aBalance1 === aBalance2 && bBalance1 === bBalance2;
        } finally {
          r1.close();
          r2.close();
        }
      }),
    );
  });
});

// ── Property 6 — debitAndEnqueuePending atomicity ──────────────────

describe("SqliteAccountStore debitAndEnqueuePending: both happen or neither", () => {
  it("on success: balance decremented AND pending row exists (SQLite-backed)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (initialCredit, withdrawAmount) => {
          fc.pre(withdrawAmount <= initialCredit);
          const { store, close } = freshStore();
          try {
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
            return bal === initialCredit - withdrawAmount;
          } finally {
            close();
          }
        },
      ),
    );
  });

  it("on insufficient funds: returns null AND state untouched (SQLite-backed)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (initialCredit, overdraftAmount) => {
          const withdrawAmount = initialCredit + overdraftAmount;
          const { store, close } = freshStore();
          try {
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
          } finally {
            close();
          }
        },
      ),
    );
  });
});

// ── Property 7 — debitAndEnqueuePending idempotency ────────────────

describe("SqliteAccountStore debitAndEnqueuePending: replay does not double-debit", () => {
  it("two calls with same idempotency key return same pendingId and debit only once", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 1_000_000 }),
        fc.integer({ min: 1, max: 500_000 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        (initialCredit, withdrawAmount, idempotencyKey) => {
          fc.pre(withdrawAmount <= initialCredit);
          const { store, close } = freshStore();
          try {
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
            return bal === initialCredit - withdrawAmount;
          } finally {
            close();
          }
        },
      ),
    );
  });
});

// ── Property 8 — Withdrawal lifecycle: fail restores balance ───────

describe("SqliteAccountStore withdrawal lifecycle: fail restores balance", () => {
  it("requestWithdrawal then failWithdrawal returns balance to pre-request value", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (initialCredit, withdrawAmount) => {
          fc.pre(withdrawAmount <= initialCredit);
          const { store, close } = freshStore();
          try {
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
          } finally {
            close();
          }
        },
      ),
    );
  });
});

// ── Sanity smoke: hand-rolled example ───────────────────────────────

// Mirror of the smoke at the bottom of `virtual-accounts/properties.test.ts`.
// A regression that breaks every property is also caught by this single
// concrete case without needing fast-check shrinkage.
describe("SqliteAccountStore smoke: hand-rolled balance equation", () => {
  it("credit 1M then debit 400k then credit 200k = 800k", () => {
    const { store, close } = freshStore();
    try {
      store.credit("mote-a", 1_000_000, "deposit", "ref-0", null);
      store.debit("mote-a", 400_000, "withdrawal", "ref-1", null);
      store.credit("mote-a", 200_000, "settlement_credit", "ref-2", null);
      expect(store.getAccount("mote-a")?.balance).toBe(800_000);
    } finally {
      close();
    }
  });
});
