/**
 * Dispute claw-back — the post-settlement mint fix.
 *
 * A dispute filed AFTER a relay settlement credited the worker is the §7.5
 * primary flow (settle → 24h window → dispute). Before the 2026-06 fix,
 * `executeFundAction` credited the winner `amount_locked` with no worker
 * claw-back, so a refund/split MINTED money (the worker kept its settled net
 * AND the delegator was credited) and a release DOUBLE-PAID. `reconcileLedger`
 * cannot catch this — its balance equation is invariant under any credit.
 *
 * These tests seed a settled state (worker holds the net) + a resolved dispute
 * past the appeal window, then trigger lazy-finalize via GET, and assert the
 * decisive invariant: the worker is debited and the winner credited so the
 * TOTAL across both parties is conserved — no mint.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { creditAccount, getAccountBalance } from "../accounts.js";
import { reconcileLedger } from "../reconciliation.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

const WORKER = "motebit_worker_clawback";
const DELEGATOR = "motebit_delegator_clawback";
const NET = 950_000; // micro-units the worker was credited at settlement

interface SeedOpts {
  fundAction: "refund_to_delegator" | "release_to_worker" | "split";
  splitRatio: number;
  taskId: string;
  disputeId: string;
  withDelegator?: boolean;
}

function seedSettledDispute(relay: SyncRelay, o: SeedOpts): void {
  const db = relay.moteDb.db;
  const now = Date.now();

  // 1. Settlement credited the worker NET (the funds now sit in its balance,
  //    held non-spendable/non-withdrawable during the window).
  creditAccount(db, WORKER, NET, "settlement_credit", `stl-${o.taskId}`, "Settlement");

  // 2. The relay settlement row — authoritative worker (motebit_id), payer
  //    (delegator_id), and net (amount_settled).
  db.prepare(
    `INSERT INTO relay_settlements
     (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at, settlement_mode, delegator_id)
     VALUES (?, ?, ?, ?, '', ?, 50000, 0.05, 'completed', ?, 'relay', ?)`,
  ).run(
    `stlrow-${o.taskId}`,
    `alloc-${o.taskId}`,
    o.taskId,
    WORKER,
    NET,
    now,
    o.withDelegator === false ? null : DELEGATOR,
  );

  // 3. Allocation, transitioned to disputed.
  db.prepare(
    `INSERT INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at)
     VALUES (?, ?, ?, ?, 'disputed', ?)`,
  ).run(`alloc-${o.taskId}`, o.taskId, WORKER, 1_000_000, now);

  // 4. A resolved dispute whose appeal window has already expired (resolved 25h
  //    ago) so the next read lazily finalizes and executes the fund action.
  db.prepare(
    `INSERT INTO relay_disputes
     (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state, amount_locked, filing_fee, filed_at, evidence_deadline, resolved_at, filer_role)
     VALUES (?, ?, ?, ?, ?, 'quality', 'bad work', 'resolved', ?, 0, ?, ?, ?, 'delegator')`,
  ).run(
    o.disputeId,
    o.taskId,
    `alloc-${o.taskId}`,
    DELEGATOR,
    WORKER,
    1_000_000,
    now - 26 * 3600_000,
    now - 25 * 3600_000,
    now - 25 * 3600_000,
  );

  // 5. The round-1 resolution row lazy-finalize reads fund_action from.
  db.prepare(
    `INSERT INTO relay_dispute_resolutions
     (resolution_id, dispute_id, round, resolution, rationale, fund_action, split_ratio, adjudicator, resolved_at, signature)
     VALUES (?, ?, 1, ?, 'r', ?, ?, 'op', ?, 'sig')`,
  ).run(
    `res-${o.disputeId}`,
    o.disputeId,
    o.fundAction === "split" ? "split" : "upheld",
    o.fundAction,
    o.splitRatio,
    now - 25 * 3600_000,
  );
}

async function finalize(relay: SyncRelay, disputeId: string): Promise<void> {
  // GET triggers tryFinalizeIfWindowExpired → executeFundAction.
  const res = await relay.app.request(`/api/v1/disputes/${disputeId}`, { headers: AUTH_HEADER });
  expect(res.status).toBe(200);
}

function bal(relay: SyncRelay, id: string): number {
  return getAccountBalance(relay.moteDb.db, id)?.balance ?? 0;
}

describe("Dispute claw-back (post-settlement, no mint)", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  it("refund_to_delegator claws the net back from the worker — total conserved", async () => {
    seedSettledDispute(relay, {
      fundAction: "refund_to_delegator",
      splitRatio: 0.0,
      taskId: "task-refund",
      disputeId: "dsp-refund",
    });
    // Pre: worker holds NET, delegator holds 0. Total across the pair = NET.
    expect(bal(relay, WORKER)).toBe(NET);
    expect(bal(relay, DELEGATOR)).toBe(0);

    await finalize(relay, "dsp-refund");

    // Post: worker clawed back to 0, delegator refunded NET. Total still NET.
    // (Pre-fix this was worker NET + delegator NET = 2*NET — minted NET.)
    expect(bal(relay, WORKER)).toBe(0);
    expect(bal(relay, DELEGATOR)).toBe(NET);
    expect(bal(relay, WORKER) + bal(relay, DELEGATOR)).toBe(NET);

    const recon = reconcileLedger(relay.moteDb.db);
    expect(recon.consistent).toBe(true);
  });

  it("release_to_worker is a no-op — the original settlement stands", async () => {
    seedSettledDispute(relay, {
      fundAction: "release_to_worker",
      splitRatio: 1.0,
      taskId: "task-release",
      disputeId: "dsp-release",
    });
    await finalize(relay, "dsp-release");

    // Worker keeps the net it already holds; nothing minted to it a second time.
    expect(bal(relay, WORKER)).toBe(NET);
    expect(bal(relay, DELEGATOR)).toBe(0);
  });

  it("split divides the net — total conserved", async () => {
    seedSettledDispute(relay, {
      fundAction: "split",
      splitRatio: 0.5,
      taskId: "task-split",
      disputeId: "dsp-split",
    });
    await finalize(relay, "dsp-split");

    const workerShare = Math.floor(NET * 0.5);
    expect(bal(relay, WORKER)).toBe(workerShare);
    expect(bal(relay, DELEGATOR)).toBe(NET - workerShare);
    expect(bal(relay, WORKER) + bal(relay, DELEGATOR)).toBe(NET);
  });

  it("refund with no recorded delegator leaves funds with the worker (never destroyed, never minted)", async () => {
    seedSettledDispute(relay, {
      fundAction: "refund_to_delegator",
      splitRatio: 0.0,
      taskId: "task-nodeleg",
      disputeId: "dsp-nodeleg",
      withDelegator: false,
    });
    await finalize(relay, "dsp-nodeleg");

    // Unroutable refund: worker keeps the net (fail-closed), nothing minted.
    expect(bal(relay, WORKER)).toBe(NET);
    expect(bal(relay, DELEGATOR)).toBe(0);
  });
});
