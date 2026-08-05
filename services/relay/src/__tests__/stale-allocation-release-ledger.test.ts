/**
 * Payout sites release what the LEDGER holds, never what the allocation row
 * claims.
 *
 * `amount_locked` is a CLAIM; the `allocation_hold` / `allocation_release`
 * ledger rows are the FACT. Allocation rows also exist on never-debited paths —
 * free agents, and (before the funding check was corrected) any listing priced
 * above zero whose `pay_to_address` was absent, which read as free. Crediting
 * `amount_locked` against such a row mints balance the relay never received.
 *
 * This is the larger of the two legs in that family, and the easier to reach:
 *
 *   - the settlement credit pays the worker NET and needs a signed receipt;
 *   - this pays the delegator the full GROSS and needs nothing but patience —
 *     book the row, never return a receipt, wait out the horizon.
 *
 * It is also the more dangerous payout: `allocation_release` carries neither
 * the dispute-window hold nor the promotional-grant hold, so minted balance is
 * immediately withdrawable/sweepable as real cash. `reconcileLedger` cannot see
 * it — the credit is itself a ledger row, so the balance equation stays
 * self-consistent.
 *
 * ## Why these rows are seeded directly
 *
 * The submission-time fix means the API will no longer CREATE a priced-but-
 * unfunded allocation, so the state has to be seeded to be tested at all.
 *
 * Measured against production at the time of writing: 1,861 allocations, of
 * which 1,387 `settled` and 474 `released` — **zero `locked`**, and no
 * `reference_id` has ever released more than it held. So this guard is
 * FORWARD-LOOKING, not remediation: nothing in the live ledger is currently
 * awaiting a payout it could mint from. The invariant still has to hold,
 * because a submission-time check cannot protect a row that is already booked,
 * and any future path that books one lands here.
 *
 * ## Why this drives the real function
 *
 * The prior coverage (`money-loop-failures.test.ts`) re-implemented the cleanup
 * loop's body inside the test — "same as the interval callback." A modeled
 * composition proves nothing about the deployed path: it stays green no matter
 * what the real loop does. `releaseStaleAllocations` was extracted so this
 * suite drives production code, and the interval now calls the same function.
 *
 * Severing: restore either payout to `alloc.amount_locked` and the unfunded
 * cases below go red with a minted credit.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { releaseStaleAllocations } from "../index.js";
import { createTestRelay, seedBalance } from "./test-helpers.js";
import { getAccountBalance, toMicro, debitSpendableAccount } from "../accounts.js";

let relay: SyncRelay | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

const HORIZON_MS = 3_600_000;

/** Insert an allocation row, optionally backed by a real ledger debit. */
function seedAllocation(
  r: SyncRelay,
  opts: { taskId: string; motebitId: string; claimMicro: number; funded: boolean; ageMs: number },
): string {
  const allocationId = `x402-${opts.taskId}`;
  if (opts.funded) {
    // A real hold: credit the delegator, then debit under the allocation
    // reference exactly as the submission path does.
    seedBalance(r, opts.motebitId, opts.claimMicro / 1_000_000 + 1);
    debitSpendableAccount(
      r.moteDb.db,
      opts.motebitId,
      opts.claimMicro,
      "allocation_hold",
      allocationId,
      "test hold",
    );
  }
  r.moteDb.db
    .prepare(
      "INSERT INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, ?, ?, 'locked', ?)",
    )
    .run(allocationId, opts.taskId, opts.motebitId, opts.claimMicro, Date.now() - opts.ageMs);
  return allocationId;
}

function balance(r: SyncRelay, id: string): number {
  return getAccountBalance(r.moteDb.db, id)?.balance ?? 0;
}

function releaseCredits(r: SyncRelay, id: string): number {
  const row = r.moteDb.db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) as t FROM relay_transactions WHERE motebit_id = ? AND type = 'allocation_release'",
    )
    .get(id) as { t: number };
  return row.t;
}

describe("stale-allocation release pays the ledger, not the claim", () => {
  it("mints nothing for an allocation that was never debited", async () => {
    relay = await createTestRelay();
    // The exploit shape: a locked row claiming $1.00 with no hold behind it.
    seedAllocation(relay, {
      taskId: "task-unfunded",
      motebitId: "attacker",
      claimMicro: toMicro(1),
      funded: false,
      ageMs: HORIZON_MS + 60_000,
    });
    expect(balance(relay, "attacker")).toBe(0);

    const released = releaseStaleAllocations(
      relay.moteDb.db,
      Date.now(),
      HORIZON_MS,
      () => undefined,
    );
    expect(released).toBe(1); // considered…

    // …but nothing minted. This is the whole invariant.
    expect(releaseCredits(relay, "attacker")).toBe(0);
    expect(balance(relay, "attacker")).toBe(0);

    // The row is still retired, so it stops being reconsidered every tick.
    const status = relay.moteDb.db
      .prepare("SELECT status FROM relay_allocations WHERE task_id = ?")
      .get("task-unfunded") as { status: string };
    expect(status.status).toBe("released");
  });

  it("returns exactly the held amount for a genuinely funded allocation", async () => {
    relay = await createTestRelay();
    const claim = toMicro(1);
    seedAllocation(relay, {
      taskId: "task-funded",
      motebitId: "honest",
      claimMicro: claim,
      funded: true,
      ageMs: HORIZON_MS + 60_000,
    });
    const before = balance(relay, "honest");

    releaseStaleAllocations(relay.moteDb.db, Date.now(), HORIZON_MS, () => undefined);

    // The delegator is made whole — exactly the hold, no more.
    expect(releaseCredits(relay, "honest")).toBe(claim);
    expect(balance(relay, "honest")).toBe(before + claim);
  });

  it("never releases twice — a second sweep is a no-op", async () => {
    relay = await createTestRelay();
    const claim = toMicro(1);
    seedAllocation(relay, {
      taskId: "task-twice",
      motebitId: "honest2",
      claimMicro: claim,
      funded: true,
      ageMs: HORIZON_MS + 60_000,
    });

    releaseStaleAllocations(relay.moteDb.db, Date.now(), HORIZON_MS, () => undefined);
    const afterFirst = balance(relay, "honest2");
    releaseStaleAllocations(relay.moteDb.db, Date.now(), HORIZON_MS, () => undefined);

    expect(balance(relay, "honest2")).toBe(afterFirst);
    expect(releaseCredits(relay, "honest2")).toBe(claim);
  });

  it("leaves allocations inside the horizon alone", async () => {
    relay = await createTestRelay();
    seedAllocation(relay, {
      taskId: "task-fresh",
      motebitId: "fresh",
      claimMicro: toMicro(1),
      funded: true,
      ageMs: 60_000, // well inside the horizon
    });

    expect(releaseStaleAllocations(relay.moteDb.db, Date.now(), HORIZON_MS, () => undefined)).toBe(
      0,
    );
    expect(releaseCredits(relay, "fresh")).toBe(0);
    const status = relay.moteDb.db
      .prepare("SELECT status FROM relay_allocations WHERE task_id = ?")
      .get("task-fresh") as { status: string };
    expect(status.status).toBe("locked");
  });

  it("credits the task's submitter when the task is still queued", async () => {
    relay = await createTestRelay();
    const claim = toMicro(1);
    seedAllocation(relay, {
      taskId: "task-delegated",
      motebitId: "worker",
      claimMicro: claim,
      funded: true,
      ageMs: HORIZON_MS + 60_000,
    });

    // Delegator resolution routes the refund away from the allocation's own
    // motebit_id when the queue knows who submitted it.
    releaseStaleAllocations(relay.moteDb.db, Date.now(), HORIZON_MS, () => "delegator");

    expect(releaseCredits(relay, "delegator")).toBe(claim);
    expect(releaseCredits(relay, "worker")).toBe(0);
  });
});
