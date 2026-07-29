/**
 * The paid-intent interlock (#435/#436): "never pay twice for the same
 * job" as a mechanical property, not a prompt convention. The ledger is
 * seeded ONLY by settled-payment facts; one outstanding entry locks its
 * worker+capability pair, two suspend all paid delegation for the session.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
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

  it("re-recording the same pair keeps one entry (latest facts win)", () => {
    ledger.recordSettledUnretrieved(entry());
    ledger.recordSettledUnretrieved(entry({ taskId: "task-9", txHash: "tx-9", recordedAt: 3000 }));
    expect(ledger.outstandingCount).toBe(1);
    const verdict = ledger.check("worker-a", "web_search");
    if (verdict.locked) expect(verdict.prior.taskId).toBe("task-9");
  });

  it("outstanding() renders oldest first", () => {
    ledger.recordSettledUnretrieved(
      entry({ workerMotebitId: "worker-b", taskId: "task-2", recordedAt: 2000 }),
    );
    ledger.recordSettledUnretrieved(entry());
    expect(ledger.outstanding().map((e) => e.taskId)).toEqual(["task-1", "task-2"]);
  });
});
