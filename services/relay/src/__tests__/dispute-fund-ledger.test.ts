/**
 * allocationEscrowHeld — the one "still held" reading every refund of an
 * allocation pays out of (allocation-escrow.ts). A dispute row counts for the
 * allocation whose money it MOVED, never for another allocation whose task the
 * dispute merely names: a legacy (pre-§4.2) dispute on A1 naming A2's task
 * that refunded A1's escrow is attributed to A1 by the upgrade migration,
 * flags A1 for operator review, and is no prior action of A2's — A2's escrow
 * and its own dispute are untouched (C2).
 */
import { describe, it, expect } from "vitest";
import { createTestRelay, seedX402PaidTask } from "./test-helpers.js";
import { creditAccount } from "../accounts.js";
import { allocationEscrowHeld, allocationLedgerPosition } from "../dispute-fund-ledger.js";
import { backfillAllocationEscrow } from "../allocation-escrow.js";

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
  it("attributes a legacy cross-allocation dispute row to the allocation it moved; the other allocation keeps its escrow", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    const db = relay.moteDb.db;
    const t1 = seedX402PaidTask(relay, {
      workerId: "wrk-led",
      delegatorId: "del-led",
      prompt: "p",
      unitCostUsd: 1.0,
    });
    const t2 = seedX402PaidTask(relay, {
      workerId: "wrk-led2",
      delegatorId: "del-led2",
      prompt: "p",
      unitCostUsd: 1.0,
    });
    const a1 = `x402-${t1}`;
    const a2 = `x402-${t2}`;
    const held = allocationEscrowHeld(db, a1);
    expect(held).toBeGreaterThan(0);
    expect(allocationEscrowHeld(db, a2)).toBe(held);

    // A legacy dispute on A1 naming A2's task refunded A1's delegator out of
    // A1's escrow (the pre-binding pre-settlement path), then the upgrade ran.
    insertDispute(db, "dsp-led-1", t2, a1);
    creditAccount(db, "del-led", held, "settlement_credit", "dsp-led-1", "legacy refund");
    backfillAllocationEscrow(db);

    // The row moved A1's money (its payee is A1's hold payer): A1 holds 0 and
    // is flagged for review; A2's escrow is untouched and it is NOT flagged.
    expect(allocationEscrowHeld(db, a1)).toBe(0);
    expect(allocationLedgerPosition(db, a1).reviewReason).toBe("legacy_cross_allocation_dispute");
    expect(allocationLedgerPosition(db, a1).priorDisputeRows).toBe(1);
    const pos2 = allocationLedgerPosition(db, a2);
    expect(pos2.taskId).toBe(t2);
    expect(pos2.escrowRemaining).toBe(held);
    expect(pos2.priorDisputeRows).toBe(0);
    expect(pos2.reviewReason).toBeNull();
    await relay.close();
  });

  it("a row touching parties of both allocations is ambiguous: left unstamped, both flagged", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    const db = relay.moteDb.db;
    // One delegator funds both allocations.
    const t1 = seedX402PaidTask(relay, {
      workerId: "wrk-a",
      delegatorId: "del-both",
      prompt: "p",
      unitCostUsd: 1.0,
    });
    const t2 = seedX402PaidTask(relay, {
      workerId: "wrk-b",
      delegatorId: "del-both",
      prompt: "p",
      unitCostUsd: 1.0,
    });
    const a1 = `x402-${t1}`;
    const a2 = `x402-${t2}`;
    insertDispute(db, "dsp-amb", t2, a1);
    creditAccount(db, "del-both", 1000, "settlement_credit", "dsp-amb", "legacy refund");
    backfillAllocationEscrow(db);
    const stamped = db
      .prepare("SELECT allocation_id FROM relay_transactions WHERE reference_id = 'dsp-amb'")
      .get() as { allocation_id: string | null };
    expect(stamped.allocation_id).toBeNull();
    expect(allocationLedgerPosition(db, a1).reviewReason).toBe("legacy_ambiguous_dispute_rows");
    expect(allocationLedgerPosition(db, a2).reviewReason).toBe("legacy_ambiguous_dispute_rows");
    await relay.close();
  });
});
