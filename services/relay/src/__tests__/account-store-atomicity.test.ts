/**
 * Ledger atomicity under a failure at every statement boundary.
 *
 * The AccountStore contract (`@motebit/virtual-accounts`) promises that a
 * credit or debit is never partial: the balance moves and its ledger row is
 * written together or not at all. `SqliteAccountStore.credit` once ran the
 * balance UPDATE, the read-back and the ledger INSERT as separate autocommit
 * statements, so an INSERT failure left the balance raised with no ledger row
 * — and `processStripeCheckout`'s dedup (which reads the LEDGER) then let a
 * replay credit again (balance 10M, ledger 5M).
 *
 * This harness wraps the relay's real driver and throws at the Nth statement
 * (`prepare(...).run/get/all`) for every N a successful call executes. After
 * each failure it asserts, for the account touched:
 *   1. balance == SUM(ledger amounts)            (no partial write)
 *   2. a replay of the same reference applies exactly once, and the balance
 *      still equals the ledger                    (dedup reads the truth)
 *
 * Every writer of `relay_accounts.balance` / `relay_transactions` (enumerated
 * by `grep -n "UPDATE relay_accounts\|INSERT INTO relay_transactions\|INSERT
 * INTO relay_accounts"` over services/relay/src — all in account-store-sqlite.ts)
 * and every check-then-credit-by-reference caller is listed in WRITERS below:
 *
 *   store:   getOrCreateAccount, credit, debit, debitSpendable,
 *            failWithdrawalAndRefund, debitAndEnqueuePending
 *   callers: processStripeCheckout (stripe-credit.ts),
 *            grantFreeCreditIfEligible (free-credit.ts),
 *            creditX402Settlement (x402-settlements.ts),
 *            proxyDebitByReference (subscriptions.ts — the proxy debit route)
 *            creditSubscriptionByReference (subscriptions.ts — session-status)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseDriver, PreparedStatement } from "@motebit/persistence";
import { createSyncRelay, type SyncRelay } from "../index.js";
import { sqliteAccountStoreFor } from "../account-store-sqlite.js";
import { processStripeCheckout } from "../stripe-credit.js";
import { grantFreeCreditIfEligible } from "../free-credit.js";
import { creditX402Settlement, recordX402Intent } from "../x402-settlements.js";
import { proxyDebitByReference, creditSubscriptionByReference } from "../subscriptions.js";
import { TEST_RELAY_NETWORK } from "./test-helpers.js";

class InjectedFault extends Error {}

/** A real driver whose Nth statement execution throws. */
class FaultDriver implements DatabaseDriver {
  readonly driverName: string;
  failAt: number | null = null;
  count = 0;
  constructor(private readonly inner: DatabaseDriver) {
    this.driverName = inner.driverName;
  }
  private tick(): void {
    this.count += 1;
    if (this.failAt !== null && this.count === this.failAt) {
      throw new InjectedFault(`injected fault at statement ${this.count}`);
    }
  }
  exec(sql: string): void {
    this.inner.exec(sql);
  }
  prepare(sql: string): PreparedStatement {
    const stmt = this.inner.prepare(sql);
    return {
      run: (...p: unknown[]) => {
        this.tick();
        return stmt.run(...p);
      },
      get: (...p: unknown[]) => {
        this.tick();
        return stmt.get(...p);
      },
      all: (...p: unknown[]) => {
        this.tick();
        return stmt.all(...p);
      },
    };
  }
  pragma(sql: string): unknown {
    return this.inner.pragma(sql);
  }
  close(): void {
    this.inner.close();
  }
  transaction<T>(fn: () => T): T {
    return this.inner.transaction(fn);
  }
}

interface Writer {
  name: string;
  /** Fresh per-run state on the CLEAN driver. Returns the account touched. */
  setup(db: DatabaseDriver, k: string): string;
  /** The operation under test (also the replay: every writer here dedups by reference). */
  op(db: DatabaseDriver, k: string): void;
  /** Ledger rows the operation's reference must have, net, once applied. */
  applied(db: DatabaseDriver, k: string): { rows: number; sum: number };
  /** The expected `applied` after exactly one application. */
  once: { rows: number; sum: number };
}

function refRows(db: DatabaseDriver, motebitId: string, ref: string, where = "1=1") {
  return db
    .prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(amount), 0) AS sum FROM relay_transactions
       WHERE motebit_id = ? AND reference_id = ? AND ${where}`,
    )
    .get(motebitId, ref) as { rows: number; sum: number };
}

function seed(db: DatabaseDriver, id: string, amount: number): void {
  sqliteAccountStoreFor(db).credit(id, amount, "deposit", `seed-${id}`, "seed");
}

const WRITERS: Writer[] = [
  {
    name: "store.getOrCreateAccount",
    setup: (_db, k) => `acct-${k}`,
    op: (db, k) => {
      sqliteAccountStoreFor(db).getOrCreateAccount(`acct-${k}`);
    },
    applied: () => ({ rows: 0, sum: 0 }),
    once: { rows: 0, sum: 0 },
  },
  {
    name: "store.credit",
    setup: (_db, k) => `credit-${k}`,
    op: (db, k) => {
      const s = sqliteAccountStoreFor(db);
      if (!s.hasDepositWithReference(`credit-${k}`, `ref-${k}`)) {
        s.credit(`credit-${k}`, 5_000_000, "deposit", `ref-${k}`, "t");
      }
    },
    applied: (db, k) => refRows(db, `credit-${k}`, `ref-${k}`),
    once: { rows: 1, sum: 5_000_000 },
  },
  {
    name: "store.debit",
    setup: (db, k) => {
      seed(db, `debit-${k}`, 1_000_000);
      return `debit-${k}`;
    },
    op: (db, k) => {
      const s = sqliteAccountStoreFor(db);
      if (!s.hasFeeWithReference(`debit-${k}`, `ref-${k}`)) {
        s.debit(`debit-${k}`, 300_000, "fee", `ref-${k}`, "t");
      }
    },
    applied: (db, k) => refRows(db, `debit-${k}`, `ref-${k}`),
    once: { rows: 1, sum: -300_000 },
  },
  {
    name: "store.debitSpendable",
    setup: (db, k) => {
      seed(db, `dspend-${k}`, 1_000_000);
      return `dspend-${k}`;
    },
    op: (db, k) => {
      const s = sqliteAccountStoreFor(db);
      if (!s.hasFeeWithReference(`dspend-${k}`, `ref-${k}`)) {
        s.debitSpendable(`dspend-${k}`, 300_000, "fee", `ref-${k}`, "t");
      }
    },
    applied: (db, k) => refRows(db, `dspend-${k}`, `ref-${k}`),
    once: { rows: 1, sum: -300_000 },
  },
  {
    name: "store.failWithdrawalAndRefund",
    setup: (db, k) => {
      const s = sqliteAccountStoreFor(db);
      const id = `wfail-${k}`;
      seed(db, id, 1_000_000);
      s.debit(id, 400_000, "withdrawal", `w-${k}`, "withdrawal");
      s.insertWithdrawal({
        withdrawal_id: `w-${k}`,
        motebit_id: id,
        amount: 400_000,
        currency: "USD",
        destination: "dest",
        idempotency_key: null,
        requested_at: Date.now(),
      });
      return id;
    },
    op: (db, k) => {
      sqliteAccountStoreFor(db).failWithdrawalAndRefund(`w-${k}`, "rail down", "pending");
    },
    applied: (db, k) => refRows(db, `wfail-${k}`, `w-${k}`, "amount > 0"),
    once: { rows: 1, sum: 400_000 },
  },
  {
    name: "store.debitAndEnqueuePending",
    setup: (db, k) => {
      seed(db, `enq-${k}`, 1_000_000);
      return `enq-${k}`;
    },
    op: (db, k) => {
      sqliteAccountStoreFor(db).debitAndEnqueuePending({
        motebitId: `enq-${k}`,
        amountMicro: 250_000,
        destination: "dest",
        rail: "solana",
        source: "user",
        idempotencyKey: `idem-${k}`,
        pendingId: `pend-${k}`,
      });
    },
    applied: (db, k) => refRows(db, `enq-${k}`, `pend-${k}`),
    once: { rows: 1, sum: -250_000 },
  },
  {
    name: "processStripeCheckout",
    setup: (_db, k) => `stripe-${k}`,
    op: (db, k) => {
      processStripeCheckout(db, `cs_${k}`, `stripe-${k}`, 5);
    },
    applied: (db, k) => refRows(db, `stripe-${k}`, `cs_${k}`),
    once: { rows: 1, sum: 5_000_000 },
  },
  {
    name: "grantFreeCreditIfEligible",
    setup: (_db, k) => `free-${k}`,
    op: (db, k) => {
      grantFreeCreditIfEligible(db, `free-${k}`, `10.0.0.${k.length}-${k}`, {
        config: { amountMicro: 100_000, ipDailyCap: 1_000, dailyBudgetMicro: 1_000_000_000_000 },
      });
    },
    applied: (db, k) => refRows(db, `free-${k}`, `free-credit:free-${k}`),
    once: { rows: 1, sum: 100_000 },
  },
  {
    name: "creditX402Settlement",
    setup: (db, k) => {
      recordX402Intent(db, {
        payer: `0xpayer-${k.toLowerCase()}`,
        nonce: `0xnonce-${k.toLowerCase()}`,
        network: "eip155:84532",
        token: "0xtoken",
        pay_to: "0xpayto",
        amount_micro: 700_000,
        valid_after: 0,
        valid_before: 1,
        idempotency_key: `k-${k}`,
        motebit_id: "worker",
        delegator_id: `x402-${k}`,
        task_id: `task-${k}`,
      });
      return `x402-${k}`;
    },
    op: (db, k) => {
      creditX402Settlement(db, `0xpayer-${k}`, `0xnonce-${k}`, {
        txHash: null,
        description: "x402",
        from: "pending",
      });
    },
    applied: (db, k) => refRows(db, `x402-${k}`, `x402-task-${k}`),
    once: { rows: 1, sum: 700_000 },
  },
  {
    name: "proxyDebitByReference",
    setup: (db, k) => {
      seed(db, `proxy-${k}`, 1_000_000);
      return `proxy-${k}`;
    },
    op: (db, k) => {
      proxyDebitByReference(db, `proxy-${k}`, 300_000, `req-${k}`, "Cloud AI usage");
    },
    applied: (db, k) => refRows(db, `proxy-${k}`, `req-${k}`),
    once: { rows: 1, sum: -300_000 },
  },
  {
    name: "proxyDebitByReference (shortfall drain)",
    setup: (db, k) => {
      seed(db, `drain-${k}`, 100_000);
      return `drain-${k}`;
    },
    op: (db, k) => {
      proxyDebitByReference(db, `drain-${k}`, 300_000, `req-${k}`, "Cloud AI usage");
    },
    applied: (db, k) => refRows(db, `drain-${k}`, `req-${k}`),
    once: { rows: 1, sum: -100_000 },
  },
  {
    name: "creditSubscriptionByReference",
    setup: (_db, k) => `sub-${k}`,
    op: (db, k) => {
      creditSubscriptionByReference(db, {
        motebitId: `sub-${k}`,
        email: null,
        customerId: `cus_${k}`,
        subscriptionId: `sub_${k}`,
      });
    },
    applied: (db, k) => refRows(db, `sub-${k}`, `sub:sub_${k}:initial`),
    once: { rows: 1, sum: 0 }, // sum checked separately: > 0
  },
];

function invariant(db: DatabaseDriver, id: string): { balance: number; ledger: number } {
  const acct = db.prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?").get(id) as
    { balance: number } | undefined;
  const ledger = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM relay_transactions WHERE motebit_id = ?")
    .get(id) as { s: number };
  return { balance: acct?.balance ?? 0, ledger: ledger.s };
}

describe("account store: every writer is atomic at every statement boundary", () => {
  let relay: SyncRelay;
  let clean: DatabaseDriver;

  beforeAll(async () => {
    relay = await createSyncRelay({
      ...TEST_RELAY_NETWORK,
      apiToken: "test-token",
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });
    clean = relay.moteDb.db;
  });
  afterAll(async () => {
    await relay.close();
  });

  for (const w of WRITERS) {
    it(`${w.name}: balance == ledger after a fault at each statement, and a replay applies once`, () => {
      // Measure the statements a successful call executes.
      const probe = new FaultDriver(clean);
      const kProbe = `${w.name}-probe`;
      const probeId = w.setup(clean, kProbe);
      w.op(probe, kProbe);
      const total = probe.count;
      expect(total).toBeGreaterThan(0);
      const probeApplied = w.applied(clean, kProbe);
      expect(probeApplied.rows).toBe(w.once.rows);
      if (w.name === "creditSubscriptionByReference") expect(probeApplied.sum).toBeGreaterThan(0);
      else expect(probeApplied.sum).toBe(w.once.sum);
      expect(invariant(clean, probeId).balance).toBe(invariant(clean, probeId).ledger);

      for (let n = 1; n <= total; n++) {
        const k = `${w.name}-${n}`;
        const id = w.setup(clean, k);
        const faulty = new FaultDriver(clean);
        faulty.failAt = n;
        try {
          w.op(faulty, k);
        } catch (err) {
          if (!(err instanceof InjectedFault)) throw err;
        }
        const after = invariant(clean, id);
        expect(after.balance, `${w.name}: fault at statement ${n}/${total}`).toBe(after.ledger);

        // Replay the same reference on a healthy driver: applied exactly once.
        w.op(clean, k);
        w.op(clean, k);
        const replayed = invariant(clean, id);
        expect(replayed.balance, `${w.name}: replay after fault ${n}`).toBe(replayed.ledger);
        const applied = w.applied(clean, k);
        expect(applied.rows, `${w.name}: rows after replay of fault ${n}`).toBe(w.once.rows);
        if (w.name !== "creditSubscriptionByReference") {
          expect(applied.sum, `${w.name}: sum after replay of fault ${n}`).toBe(w.once.sum);
        }
      }
    });
  }
});
