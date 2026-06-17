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

/**
 * Pre-settlement distribution — the worker-filed inversion fix.
 *
 * A dispute filed BEFORE any relay settlement has no settlement row, so
 * `executeFundAction` takes Case A: it distributes the still-held escrow
 * (`amount_locked`) with no claw-back. Worker/delegator are NOT in the ledger,
 * so they must be recovered from the dispute parties + the `filer_role` captured
 * at filing. Before the 2026-06 fix, Case A credited `filed_by`/`respondent`
 * directly — correct only when the DELEGATOR filed. On a WORKER-filed dispute
 * `filed_by` = worker and `respondent` = delegator, so `release_to_worker` paid
 * the delegator and `refund_to_delegator` paid the worker — escrow to the LOSING
 * party every time. (`reconcileLedger` cannot catch this; it's a routing bug,
 * not a conservation bug — the right total reaches the wrong account.)
 *
 * These tests seed a resolved pre-settlement dispute past the appeal window,
 * vary the filer, and assert the escrow lands in the correct account.
 */
const ESCROW = 1_000_000;

interface PreSeedOpts {
  fundAction: "refund_to_delegator" | "release_to_worker" | "split";
  splitRatio: number;
  resolution: "upheld" | "overturned" | "split";
  filerRole: "worker" | "delegator";
  taskId: string;
  disputeId: string;
}

function seedPreSettlementDispute(relay: SyncRelay, o: PreSeedOpts): void {
  const db = relay.moteDb.db;
  const now = Date.now();

  // filed_by is whoever filed; respondent is the counterparty. NO settlement
  // row → executeFundAction takes the pre-settlement escrow path.
  const filedBy = o.filerRole === "worker" ? WORKER : DELEGATOR;
  const respondent = o.filerRole === "worker" ? DELEGATOR : WORKER;

  db.prepare(
    `INSERT INTO relay_disputes
     (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state, amount_locked, filing_fee, filed_at, evidence_deadline, resolved_at, filer_role)
     VALUES (?, ?, ?, ?, ?, 'quality', 'dispute', 'resolved', ?, 0, ?, ?, ?, ?)`,
  ).run(
    o.disputeId,
    o.taskId,
    `alloc-${o.taskId}`,
    filedBy,
    respondent,
    ESCROW,
    now - 26 * 3600_000,
    now - 25 * 3600_000,
    now - 25 * 3600_000,
    o.filerRole,
  );

  db.prepare(
    `INSERT INTO relay_dispute_resolutions
     (resolution_id, dispute_id, round, resolution, rationale, fund_action, split_ratio, adjudicator, resolved_at, signature)
     VALUES (?, ?, 1, ?, 'r', ?, ?, 'op', ?, 'sig')`,
  ).run(
    `res-${o.disputeId}`,
    o.disputeId,
    o.resolution,
    o.fundAction,
    o.splitRatio,
    now - 25 * 3600_000,
  );
}

describe("Dispute pre-settlement distribution (worker-filed inversion fix)", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  it("worker-filed + upheld pays the WORKER (was paying the delegator pre-fix)", async () => {
    // Worker files, wins (upheld) → release_to_worker. The escrow must reach
    // the worker (= filed_by here), NOT the respondent.
    seedPreSettlementDispute(relay, {
      fundAction: "release_to_worker",
      splitRatio: 1.0,
      resolution: "upheld",
      filerRole: "worker",
      taskId: "task-pre-wf-up",
      disputeId: "dsp-pre-wf-up",
    });
    await finalize(relay, "dsp-pre-wf-up");

    expect(bal(relay, WORKER)).toBe(ESCROW);
    expect(bal(relay, DELEGATOR)).toBe(0);
  });

  it("worker-filed + overturned refunds the DELEGATOR (was paying the worker pre-fix)", async () => {
    // Worker files, loses (overturned) → refund_to_delegator. The escrow must
    // reach the delegator (= respondent here), NOT the filer.
    seedPreSettlementDispute(relay, {
      fundAction: "refund_to_delegator",
      splitRatio: 0.0,
      resolution: "overturned",
      filerRole: "worker",
      taskId: "task-pre-wf-ov",
      disputeId: "dsp-pre-wf-ov",
    });
    await finalize(relay, "dsp-pre-wf-ov");

    expect(bal(relay, DELEGATOR)).toBe(ESCROW);
    expect(bal(relay, WORKER)).toBe(0);
  });

  it("delegator-filed + upheld refunds the DELEGATOR — common path unchanged", async () => {
    // The pre-existing (and majority) case: delegator files and wins. Behavior
    // must be byte-identical to before the fix — escrow back to the delegator.
    seedPreSettlementDispute(relay, {
      fundAction: "refund_to_delegator",
      splitRatio: 0.0,
      resolution: "upheld",
      filerRole: "delegator",
      taskId: "task-pre-df-up",
      disputeId: "dsp-pre-df-up",
    });
    await finalize(relay, "dsp-pre-df-up");

    expect(bal(relay, DELEGATOR)).toBe(ESCROW);
    expect(bal(relay, WORKER)).toBe(0);
  });

  it("worker-filed + split divides escrow worker/delegator by ratio, not filer/respondent", async () => {
    seedPreSettlementDispute(relay, {
      fundAction: "split",
      splitRatio: 0.5,
      resolution: "split",
      filerRole: "worker",
      taskId: "task-pre-wf-sp",
      disputeId: "dsp-pre-wf-sp",
    });
    await finalize(relay, "dsp-pre-wf-sp");

    const workerShare = Math.floor(ESCROW * 0.5);
    expect(bal(relay, WORKER)).toBe(workerShare);
    expect(bal(relay, DELEGATOR)).toBe(ESCROW - workerShare);
    expect(bal(relay, WORKER) + bal(relay, DELEGATOR)).toBe(ESCROW);
  });
});
