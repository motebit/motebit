/**
 * allocationEscrowHeld — the one "still held" reading every refund of an
 * allocation pays out of. Dispute rows are a guard, never a term: an
 * allocation a dispute of its OWN already paid from reads 0 (fail closed —
 * unreachable for a `locked` allocation, which is all a refund path reads,
 * so it is asserted here directly), while a legacy dispute on ANOTHER
 * allocation that merely names this allocation's task does not touch its
 * escrow.
 */
import { describe, it, expect } from "vitest";
import { createTestRelay, seedX402PaidTask } from "./test-helpers.js";
import { creditAccount } from "../accounts.js";
import { allocationEscrowHeld, allocationLedgerPosition } from "../dispute-fund-ledger.js";

function insertDispute(
  db: Awaited<ReturnType<typeof createTestRelay>>["moteDb"]["db"],
  id: string,
  taskId: string,
  allocationId: string,
): void {
  db.prepare(
    `INSERT INTO relay_disputes
     (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state,
      amount_locked, filing_fee, filed_at, evidence_deadline, body_json, filer_role)
     VALUES (?, ?, ?, 'del-led', 'wrk-led', 'quality', 'x', 'final', 1, 0, ?, ?, '', 'delegator')`,
  ).run(id, taskId, allocationId, Date.now(), Date.now());
}

describe("allocationEscrowHeld", () => {
  it("reads the hold; 0 once a dispute of its own moved money; another allocation's dispute naming its task does not count", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    const db = relay.moteDb.db;
    const t1 = seedX402PaidTask(relay, {
      workerId: "wrk-led",
      delegatorId: "del-led",
      prompt: "p",
      unitCostUsd: 1.0,
    });
    const t2 = seedX402PaidTask(relay, {
      workerId: "wrk-led",
      delegatorId: "del-led",
      prompt: "p",
      unitCostUsd: 1.0,
    });
    const a1 = `x402-${t1}`;
    const a2 = `x402-${t2}`;
    const held = allocationEscrowHeld(db, a1);
    expect(held).toBeGreaterThan(0);
    expect(allocationEscrowHeld(db, a2)).toBe(held);

    // A legacy dispute on A1 naming A2's task paid out of A1's escrow.
    insertDispute(db, "dsp-led-1", t2, a1);
    creditAccount(db, "del-led", held, "settlement_credit", "dsp-led-1", "legacy refund");
    expect(allocationEscrowHeld(db, a1)).toBe(0);
    // A2's escrow is untouched by it; the fund action still sees it as a prior
    // movement naming A2's task (the guard), with nothing paid to reverse.
    expect(allocationEscrowHeld(db, a2)).toBe(held);
    // A2 settles: its worker holds the credit. Once a dispute naming A2 has
    // moved money, paid reads empty — the fund action stops at the guard and
    // never reverses that settlement a second time.
    db.prepare(
      `INSERT INTO relay_settlements
       (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled,
        platform_fee, platform_fee_rate, status, settled_at, settlement_mode, delegator_id)
       VALUES ('stl-led-2', ?, ?, 'wrk-led', 'rh', 1000, 0, 0.05, 'completed', ?, 'relay', 'del-led')`,
    ).run(a2, t2, Date.now());
    creditAccount(db, "wrk-led", 1000, "settlement_credit", "stl-led-2", "payment");
    const pos2 = allocationLedgerPosition(db, a2);
    expect(pos2.taskId).toBe(t2);
    expect(pos2.priorDisputeRows).toBe(1);
    expect(pos2.paid).toEqual([]);
    await relay.close();
  });
});
