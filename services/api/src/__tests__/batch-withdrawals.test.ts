/**
 * Batch withdrawal infrastructure — spec/settlement-v1.md §11.2.
 *
 * Three invariants:
 *   1. Enqueue debits at enqueue time; fire does not re-debit.
 *   2. Below policy threshold, no rail call. At threshold, serial fallback
 *      fires every claimed row.
 *   3. `withdrawBatch`-capable rail receives all items in one call; both
 *      fired and failed items update the pending-row state machine.
 *
 * Plus a schema smoke-check for migration v11.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type {
  BatchWithdrawalItem,
  BatchWithdrawalResult,
  GuestRail,
  PaymentProof,
  WithdrawalResult,
} from "@motebit/sdk";
import type { DatabaseDriver } from "@motebit/persistence";
import {
  enqueuePendingWithdrawal,
  evaluateAndFireRail,
  getPendingWithdrawalsSummary,
} from "../batch-withdrawals.js";
import { creditAccount, getAccountBalance } from "../accounts.js";
import { createTestRelay } from "./test-helpers.js";

const $1 = 1_000_000;

interface FakeRailArgs {
  name: string;
  supportsBatch: boolean;
  withdrawResult?: () => Promise<WithdrawalResult>;
  batchResult?: (items: readonly BatchWithdrawalItem[]) => Promise<BatchWithdrawalResult>;
  withdrawThrows?: string;
}

class FakeGuestRail implements GuestRail {
  readonly custody = "relay" as const;
  readonly railType = "protocol" as const;
  readonly supportsDeposit = false as const;
  readonly name: string;
  readonly supportsBatch: boolean;
  private readonly withdrawResult?: () => Promise<WithdrawalResult>;
  private readonly withdrawThrows?: string;
  public calls: Array<{ motebitId: string; amount: number; destination: string }> = [];
  public batchCalls: Array<readonly BatchWithdrawalItem[]> = [];

  constructor(args: FakeRailArgs) {
    this.name = args.name;
    this.supportsBatch = args.supportsBatch;
    this.withdrawResult = args.withdrawResult;
    this.withdrawThrows = args.withdrawThrows;
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async withdraw(
    motebitId: string,
    amount: number,
    _currency: string,
    destination: string,
    _idempotencyKey: string,
  ): Promise<WithdrawalResult> {
    this.calls.push({ motebitId, amount, destination });
    if (this.withdrawThrows) throw new Error(this.withdrawThrows);
    if (!this.withdrawResult) {
      return {
        amount,
        currency: "USDC",
        proof: {
          reference: "tx-mock",
          railType: "protocol",
          network: "fake",
          confirmedAt: Date.now(),
        },
      };
    }
    return this.withdrawResult();
  }

  withdrawBatch?(items: readonly BatchWithdrawalItem[]): Promise<BatchWithdrawalResult>;

  attachProof(_settlementId: string, _proof: PaymentProof): Promise<void> {
    return Promise.resolve();
  }
}

/** Subclass used for the batch test. Must present `supportsBatch: true`. */
class BatchableFakeRail extends FakeGuestRail {
  declare readonly supportsBatch: true;
  constructor(args: Omit<FakeRailArgs, "supportsBatch">) {
    super({ ...args, supportsBatch: true });
    this.withdrawBatch = async (items) => {
      this.batchCalls.push(items);
      if (!args.batchResult) {
        return {
          fired: items.map((item) => ({
            item,
            result: {
              amount: item.amount_micro,
              currency: item.currency,
              proof: {
                reference: `tx-${item.motebit_id}`,
                railType: "protocol" as const,
                network: "fake",
                confirmedAt: Date.now(),
              },
            },
          })),
          failed: [],
        };
      }
      return args.batchResult(items);
    };
  }
}

async function openRelay(): Promise<DatabaseDriver> {
  const relay = await createTestRelay();
  return relay.moteDb.db;
}

async function fundAgent(
  db: DatabaseDriver,
  motebitId: string,
  amountMicro: number,
): Promise<void> {
  creditAccount(db, motebitId, amountMicro, "deposit", null, "test");
}

describe("relay_pending_withdrawals schema", () => {
  it("migration v11 creates the table and indexes", async () => {
    const db = await openRelay();
    const cols = db.prepare("PRAGMA table_info(relay_pending_withdrawals)").all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "amount_micro",
        "destination",
        "enqueued_at",
        "idempotency_key",
        "last_attempt_at",
        "last_error",
        "motebit_id",
        "pending_id",
        "rail",
        "source",
        "status",
        "withdrawal_id",
      ].sort(),
    );
    const indexes = db.prepare("PRAGMA index_list(relay_pending_withdrawals)").all() as Array<{
      name: string;
    }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_pending_withdrawals_rail_status");
    expect(indexNames).toContain("idx_pending_withdrawals_motebit");
  });
});

describe("enqueuePendingWithdrawal", () => {
  let db: DatabaseDriver;
  beforeEach(async () => {
    db = await openRelay();
  });

  it("debits the virtual account and inserts a pending row", async () => {
    await fundAgent(db, "agent-a", 10 * $1);

    const pendingId = enqueuePendingWithdrawal(db, {
      motebitId: "agent-a",
      amountMicro: 3 * $1,
      destination: "0xdest",
      rail: "fake",
      source: "sweep",
    });

    expect(pendingId).not.toBeNull();
    expect(getAccountBalance(db, "agent-a")?.balance).toBe(7 * $1);

    const row = db
      .prepare("SELECT * FROM relay_pending_withdrawals WHERE pending_id = ?")
      .get(pendingId) as { status: string; amount_micro: number; rail: string } | undefined;
    expect(row?.status).toBe("pending");
    expect(row?.amount_micro).toBe(3 * $1);
    expect(row?.rail).toBe("fake");
  });

  it("returns null on insufficient balance; no row inserted", async () => {
    await fundAgent(db, "agent-b", 1 * $1);
    const pendingId = enqueuePendingWithdrawal(db, {
      motebitId: "agent-b",
      amountMicro: 5 * $1,
      destination: "0xdest",
      rail: "fake",
      source: "sweep",
    });
    expect(pendingId).toBeNull();
    expect(getAccountBalance(db, "agent-b")?.balance).toBe(1 * $1);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM relay_pending_withdrawals WHERE motebit_id = ?")
      .get("agent-b") as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("evaluateAndFireRail — serial fallback", () => {
  let db: DatabaseDriver;
  let rail: FakeGuestRail;

  beforeEach(async () => {
    db = await openRelay();
    rail = new FakeGuestRail({ name: "fake-serial", supportsBatch: false });
  });

  it("does not fire below policy threshold", async () => {
    await fundAgent(db, "agent-c", 10 * $1);
    // One small enqueue well below the $1 floor clear policy:
    // minAggregateMicro is $1 and multiplier threshold with zero fee is 0,
    // so $0.50 aggregate fails the floor → no fire.
    enqueuePendingWithdrawal(db, {
      motebitId: "agent-c",
      amountMicro: 500_000,
      destination: "0xdest",
      rail: rail.name,
      source: "sweep",
    });
    await evaluateAndFireRail(db, rail, {});
    expect(rail.calls).toHaveLength(0);
  });

  it("fires serially for every claimed row when policy clears", async () => {
    await fundAgent(db, "agent-d", 50 * $1);
    await fundAgent(db, "agent-e", 50 * $1);
    enqueuePendingWithdrawal(db, {
      motebitId: "agent-d",
      amountMicro: 5 * $1,
      destination: "0xdestD",
      rail: rail.name,
      source: "sweep",
    });
    enqueuePendingWithdrawal(db, {
      motebitId: "agent-e",
      amountMicro: 7 * $1,
      destination: "0xdestE",
      rail: rail.name,
      source: "sweep",
    });

    // Zero fee estimate → aggregated $12 clears the $1 floor trivially.
    await evaluateAndFireRail(db, rail, {});

    expect(rail.calls).toHaveLength(2);
    // GuestRail.withdraw takes dollars, not micros — the serial fallback
    // converts at the boundary via fromMicro. Assert the boundary is right.
    const byAgent = Object.fromEntries(rail.calls.map((c) => [c.motebitId, c]));
    expect(byAgent["agent-d"]?.amount).toBe(5);
    expect(byAgent["agent-e"]?.amount).toBe(7);

    const rows = db
      .prepare(
        "SELECT motebit_id, status, withdrawal_id FROM relay_pending_withdrawals ORDER BY motebit_id",
      )
      .all() as Array<{ motebit_id: string; status: string; withdrawal_id: string | null }>;
    expect(rows.every((r) => r.status === "fired")).toBe(true);
    expect(rows.every((r) => r.withdrawal_id !== null)).toBe(true);

    // relay_withdrawals rows exist for each fired item
    const wCount = db.prepare("SELECT COUNT(*) AS n FROM relay_withdrawals").get() as { n: number };
    expect(wCount.n).toBe(2);

    // Virtual account stayed debited at enqueue, NOT re-debited on fire.
    expect(getAccountBalance(db, "agent-d")?.balance).toBe(45 * $1);
    expect(getAccountBalance(db, "agent-e")?.balance).toBe(43 * $1);
  });

  it("marks rows failed on rail exception; balance stays debited", async () => {
    const failRail = new FakeGuestRail({
      name: "fake-failing",
      supportsBatch: false,
      withdrawThrows: "rpc down",
    });
    await fundAgent(db, "agent-f", 10 * $1);
    enqueuePendingWithdrawal(db, {
      motebitId: "agent-f",
      amountMicro: 4 * $1,
      destination: "0xdest",
      rail: failRail.name,
      source: "sweep",
    });
    await evaluateAndFireRail(db, failRail, {});

    const row = db
      .prepare("SELECT status, last_error FROM relay_pending_withdrawals WHERE motebit_id = ?")
      .get("agent-f") as { status: string; last_error: string };
    expect(row.status).toBe("failed");
    expect(row.last_error).toBe("rpc down");
    // Balance stays debited — the debit is the audit trail
    expect(getAccountBalance(db, "agent-f")?.balance).toBe(6 * $1);
  });
});

describe("evaluateAndFireRail — batch-capable rail", () => {
  it("invokes withdrawBatch once with all items when supportsBatch=true", async () => {
    const db = await openRelay();
    const rail = new BatchableFakeRail({ name: "fake-batch" });
    await fundAgent(db, "agent-g", 50 * $1);
    await fundAgent(db, "agent-h", 50 * $1);
    enqueuePendingWithdrawal(db, {
      motebitId: "agent-g",
      amountMicro: 3 * $1,
      destination: "dst-g",
      rail: rail.name,
      source: "sweep",
    });
    enqueuePendingWithdrawal(db, {
      motebitId: "agent-h",
      amountMicro: 4 * $1,
      destination: "dst-h",
      rail: rail.name,
      source: "sweep",
    });

    await evaluateAndFireRail(db, rail, {});

    expect(rail.batchCalls).toHaveLength(1);
    expect(rail.batchCalls[0]!.length).toBe(2);

    // withdraw (serial) MUST NOT have been called
    expect(rail.calls).toHaveLength(0);

    const fired = db
      .prepare("SELECT COUNT(*) AS n FROM relay_pending_withdrawals WHERE status = 'fired'")
      .get() as { n: number };
    expect(fired.n).toBe(2);
  });
});

describe("getPendingWithdrawalsSummary", () => {
  it("aggregates by rail and reports oldest_age", async () => {
    const db = await openRelay();
    await fundAgent(db, "agent-i", 50 * $1);
    await fundAgent(db, "agent-j", 50 * $1);
    enqueuePendingWithdrawal(db, {
      motebitId: "agent-i",
      amountMicro: 3 * $1,
      destination: "dst-i",
      rail: "rail-A",
      source: "sweep",
    });
    enqueuePendingWithdrawal(db, {
      motebitId: "agent-j",
      amountMicro: 4 * $1,
      destination: "dst-j",
      rail: "rail-A",
      source: "sweep",
    });
    enqueuePendingWithdrawal(db, {
      motebitId: "agent-j",
      amountMicro: 2 * $1,
      destination: "dst-j2",
      rail: "rail-B",
      source: "sweep",
    });

    const summary = getPendingWithdrawalsSummary(db);
    expect(summary.total).toBe(3);
    const railA = summary.by_rail.find((r) => r.rail === "rail-A");
    expect(railA?.count).toBe(2);
    expect(railA?.aggregated_micro).toBe(7 * $1);
    expect(railA?.oldest_age_ms).toBeGreaterThanOrEqual(0);
  });
});
