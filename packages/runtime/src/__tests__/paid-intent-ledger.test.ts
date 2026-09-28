/**
 * The paid-intent interlock (#435/#436): "never pay twice for the same
 * job" as a mechanical property, not a prompt convention. The ledger is
 * seeded ONLY by settled-payment facts; one outstanding entry locks its
 * worker+capability pair, two suspend all paid delegation for the session.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryPaidIntentStore,
  PaidIntentLedger,
  SESSION_SUSPEND_THRESHOLD,
  type UnretrievedPayment,
} from "../paid-intent-ledger.js";

function entry(overrides: Partial<UnretrievedPayment> = {}): UnretrievedPayment {
  return {
    workerMotebitId: "worker-a",
    capability: "web_search",
    taskId: "task-1",
    txHash: "tx-1",
    paidMicro: 250_000,
    feeMicro: 13_158,
    recordedAt: 1000,
    ...overrides,
  };
}

describe("PaidIntentLedger", () => {
  let ledger: PaidIntentLedger;

  beforeEach(() => {
    ledger = new PaidIntentLedger();
  });

  it("empty ledger locks nothing", () => {
    expect(ledger.check("worker-a", "web_search")).toEqual({ locked: false });
  });

  it("a settled-unretrieved payment locks its worker+capability pair (the #433 shape)", () => {
    ledger.recordSettledUnretrieved(entry());
    const verdict = ledger.check("worker-a", "web_search");
    expect(verdict.locked).toBe(true);
    if (verdict.locked) {
      expect(verdict.scope).toBe("pair");
      expect(verdict.prior.taskId).toBe("task-1");
      expect(verdict.prior.txHash).toBe("tx-1");
    }
  });

  it("one outstanding payment does NOT lock a different worker (legitimate fan-out)", () => {
    ledger.recordSettledUnretrieved(entry());
    expect(ledger.check("worker-b", "web_search")).toEqual({ locked: false });
  });

  it("one outstanding payment does NOT lock a different capability on the same worker", () => {
    ledger.recordSettledUnretrieved(entry());
    expect(ledger.check("worker-a", "code_review")).toEqual({ locked: false });
  });

  it(`${SESSION_SUSPEND_THRESHOLD} outstanding payments suspend ALL paid delegation (money is leaking)`, () => {
    ledger.recordSettledUnretrieved(entry());
    ledger.recordSettledUnretrieved(
      entry({ workerMotebitId: "worker-b", taskId: "task-2", txHash: "tx-2", recordedAt: 2000 }),
    );
    const verdict = ledger.check("worker-c", "translate");
    expect(verdict.locked).toBe(true);
    if (verdict.locked) {
      expect(verdict.scope).toBe("session");
      // The oldest entry is the one surfaced — the first leak to chase.
      expect(verdict.prior.taskId).toBe("task-1");
    }
  });

  it("resolving an entry unlocks its pair", () => {
    ledger.recordSettledUnretrieved(entry());
    expect(ledger.resolve("task-1")).toBe(true);
    expect(ledger.check("worker-a", "web_search")).toEqual({ locked: false });
    expect(ledger.outstandingCount).toBe(0);
  });

  it("resolving an unknown taskId is a no-op", () => {
    ledger.recordSettledUnretrieved(entry());
    expect(ledger.resolve("task-nope")).toBe(false);
    expect(ledger.outstandingCount).toBe(1);
  });

  it("two payments on one pair are two outstanding entries — neither overwrites the other", () => {
    // Both are money that left the wallet. The in-memory Map this replaced
    // keyed on the pair and silently dropped the first payment (#874).
    ledger.recordSettledUnretrieved(entry());
    ledger.recordSettledUnretrieved(entry({ taskId: "task-9", txHash: "tx-9", recordedAt: 3000 }));
    expect(ledger.outstandingCount).toBe(2);
    const verdict = ledger.check("worker-a", "web_search");
    expect(verdict.locked).toBe(true);
    // The pair lock surfaces the oldest — the first leak to chase.
    if (verdict.locked) expect(verdict.prior.taskId).toBe("task-1");
  });

  it("recording the same task twice is idempotent", () => {
    ledger.recordSettledUnretrieved(entry());
    ledger.recordSettledUnretrieved(entry({ recordedAt: 9999 }));
    expect(ledger.outstandingCount).toBe(1);
  });

  it("dismissing an entry unlocks its pair (an explicit owner act)", () => {
    ledger.recordSettledUnretrieved(entry());
    expect(ledger.dismiss("task-1")).toBe(true);
    expect(ledger.check("worker-a", "web_search")).toEqual({ locked: false });
    // Resolved once — a second resolution is a no-op.
    expect(ledger.resolve("task-1")).toBe(false);
  });

  it("outstanding() renders oldest first", () => {
    ledger.recordSettledUnretrieved(
      entry({ workerMotebitId: "worker-b", taskId: "task-2", recordedAt: 2000 }),
    );
    ledger.recordSettledUnretrieved(entry());
    expect(ledger.outstanding().map((e) => e.taskId)).toEqual(["task-1", "task-2"]);
  });
});

// #874: the ledger is as durable as its store. A restart is a NEW ledger
// over the SAME store — the refusal and the outstanding list must survive.
describe("PaidIntentLedger over a shared store (simulated restart, #874)", () => {
  it("a new ledger over the same store still locks the pair and lists the payment", () => {
    const store = new InMemoryPaidIntentStore();
    const before = new PaidIntentLedger(store, "mote-a");
    before.recordSettledUnretrieved(entry());

    const after = new PaidIntentLedger(store, "mote-a");
    expect(after.outstanding().map((e) => e.taskId)).toEqual(["task-1"]);
    const verdict = after.check("worker-a", "web_search");
    expect(verdict.locked).toBe(true);
    if (verdict.locked) expect(verdict.prior.txHash).toBe("tx-1");
  });

  it("is per identity — another motebit on the same store sees nothing", () => {
    const store = new InMemoryPaidIntentStore();
    new PaidIntentLedger(store, "mote-a").recordSettledUnretrieved(entry());
    const other = new PaidIntentLedger(store, "mote-b");
    expect(other.outstandingCount).toBe(0);
    expect(other.check("worker-a", "web_search")).toEqual({ locked: false });
  });

  it("a retrieval recorded by one ledger unlocks every ledger over the store", () => {
    const store = new InMemoryPaidIntentStore();
    const a = new PaidIntentLedger(store, "mote-a");
    a.recordSettledUnretrieved(entry());
    const b = new PaidIntentLedger(store, "mote-a");
    expect(b.resolve("task-1")).toBe(true);
    expect(a.check("worker-a", "web_search")).toEqual({ locked: false });
  });
});
