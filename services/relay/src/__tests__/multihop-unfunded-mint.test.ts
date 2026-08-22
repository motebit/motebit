/**
 * Money-conservation regression, multi-hop lane: a sub-receipt must credit a
 * sub-worker only when the ledger actually holds something for that sub-task.
 *
 * `settleSubReceipt` (`tasks.ts`) is the multi-hop sibling of the direct-path
 * guard hardened in #566, and its own comment says so. Its funding claim was
 * ROW-derived:
 *
 *     UPDATE relay_allocations SET status='settled' WHERE task_id=? AND status='locked'
 *
 * `changes > 0` proves the row was `'locked'`. It proves nothing about whether
 * a delegator was ever debited for it. Paid sub-delegations are real
 * `POST /agent/:worker/task` submissions (relay CLAUDE.md rule 8), so they
 * reach the same never-debited best-effort branch a direct delegation does —
 * and crediting against such a row mints balance the relay never received.
 * `reconcileLedger` cannot see it: the credit IS a ledger row, so the balance
 * equation stays self-consistent. Only a hold-vs-credit assertion sees it.
 *
 * WHY THIS FILE EXISTS BEFORE THE FIX (#547). The fix was written during #541
 * and deliberately withheld, because forcing the hold to zero — which should
 * block every funded multi-hop sub-credit — turned ZERO tests red across the
 * full relay suite. No test exercised a funded multi-hop sub-hop credit in
 * either direction, so the change was unverifiable, and shipping an
 * unverifiable guard on a payment path risks silently not paying real
 * sub-workers. The recorded conclusion was: build the positive fixture first.
 * That is what `credits a FUNDED sub-hop` below is. It is the discriminating
 * half, and it must fail if the guard ever over-blocks.
 *
 * Severing checks, both recorded:
 *   - Force `subFundedOnLedger = false` (over-block): the FUNDED case reds —
 *     the sub-worker is not paid and no settlement row is written.
 *   - Restore the row-derived claim (`subClaimed` alone, no ledger read): the
 *     UNFUNDED case reds — the sub-worker's balance goes from 0 to the settled
 *     amount with no corresponding debit anywhere in the ledger.
 *
 * The funded sub-hop is seeded through `seedX402PaidTask` rather than driven
 * over HTTP: post-Arc-3.5 a paid cross-agent sub-delegation needs its own P2P
 * proof (`requiresP2pProof` trips a 402 at submission), so the x402-paid
 * carve-out is the remaining route to a funded relay-custody sub-hop. The
 * helper seeds exactly that post-submission state — deposit, `allocation_hold`
 * debit, and a `'locked'` allocation row keyed `x402-<taskId>`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex, signExecutionReceipt } from "@motebit/encryption";
import type { ExecutionReceipt } from "@motebit/protocol";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import type { SyncRelay } from "../index.js";
import {
  AUTH_HEADER,
  JSON_AUTH,
  createTestRelay,
  createAgent,
  jsonAuthWithIdempotency,
  seedBalance,
  seedX402PaidTask,
} from "./test-helpers.js";

let relay: SyncRelay | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

/** Every ledger row for an account, summed by type — the funding truth. */
function ledgerByType(r: SyncRelay, motebitId: string): Record<string, number> {
  const rows = r.moteDb.db
    .prepare(
      "SELECT type, SUM(amount) as total FROM relay_transactions WHERE motebit_id = ? GROUP BY type",
    )
    .all(motebitId) as Array<{ type: string; total: number }>;
  return Object.fromEntries(rows.map((row) => [row.type, row.total]));
}

function balanceOf(r: SyncRelay, motebitId: string): number {
  const row = r.moteDb.db
    .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
    .get(motebitId) as { balance: number } | undefined;
  return row?.balance ?? 0;
}

function settlementRowsFor(r: SyncRelay, taskId: string): number {
  const row = r.moteDb.db
    .prepare("SELECT COUNT(*) as n FROM relay_settlements WHERE task_id = ?")
    .get(taskId) as { n: number };
  return row.n;
}

function allocationStatus(r: SyncRelay, taskId: string): string | undefined {
  const row = r.moteDb.db
    .prepare("SELECT status FROM relay_allocations WHERE task_id = ?")
    .get(taskId) as { status: string } | undefined;
  return row?.status;
}

async function priceListing(r: SyncRelay, motebitId: string, unitCost: number): Promise<void> {
  await r.app.request(`/api/v1/agents/${motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: unitCost, currency: "USD", per: "task" }],
      // No `pay_to_address` deliberately. It is what makes `getAgentPricing`
      // return non-null, which makes the parent submission a PAID cross-agent
      // delegation and trips Arc 3.5's `TASK_P2P_PROOF_REQUIRED` 402 at the
      // door (#552). The parent here is only a carrier for the nested
      // sub-receipt; the funding under test is the SUB-task's, seeded
      // directly by `seedX402PaidTask`.
    }),
  });
}

/** `allocation_hold` is a DEBIT — stored negative. Magnitude is the hold. */
function holdMagnitudeFor(r: SyncRelay, taskId: string): number {
  const row = r.moteDb.db
    .prepare(
      "SELECT SUM(amount) as total FROM relay_transactions WHERE reference_id = ? AND type = 'allocation_hold'",
    )
    .get(`x402-${taskId}`) as { total: number | null };
  return Math.abs(row.total ?? 0);
}

interface Party {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
}

async function makeAgent(r: SyncRelay, unitCost: number): Promise<Party> {
  const keypair = await generateKeypair();
  const { motebitId, deviceId } = await createAgent(r, bytesToHex(keypair.publicKey));
  await priceListing(r, motebitId, unitCost);
  const ws = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  r.connections.set(motebitId, [{ ws: ws as never, deviceId, capabilities: ["web_search"] }]);
  return { motebitId, deviceId, privateKey: keypair.privateKey };
}

async function signFor(
  party: Party,
  taskId: string,
  relayTaskId: string,
  nested?: ExecutionReceipt[],
): Promise<ExecutionReceipt> {
  return (await signExecutionReceipt(
    {
      task_id: taskId,
      relay_task_id: relayTaskId,
      motebit_id: party.motebitId as unknown as MotebitId,
      device_id: party.deviceId as unknown as DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed" as const,
      result: "sub-work done, and long enough to clear the completion quality floor "
        .repeat(4)
        .trim(),
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: "abc",
      result_hash: "def",
      ...(nested != null ? { delegation_receipts: nested } : {}),
    },
    party.privateKey,
  )) as ExecutionReceipt;
}

/**
 * Drive one parent self-delegation to settlement carrying a nested sub-receipt.
 *
 * The PARENT is self-delegated because self-delegation is the explicit Arc-3.5
 * submission carve-out (`requiresP2pProof` needs `submittedBy !== workerId`),
 * which is what lets the parent reach relay-custody settlement without a P2P
 * proof. The nested sub-receipt is what exercises `settleSubReceipt`.
 */
async function settleParentCarrying(
  r: SyncRelay,
  parent: Party,
  subReceipt: ExecutionReceipt,
): Promise<void> {
  const submitRes = await r.app.request(`/agent/${parent.motebitId}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({ prompt: "orchestrate", required_capabilities: ["web_search"] }),
  });
  expect(submitRes.status).toBe(201);
  const { task_id } = (await submitRes.json()) as { task_id: string };

  const parentReceipt = await signFor(parent, task_id, task_id, [subReceipt]);

  const resultRes = await r.app.request(`/agent/${parent.motebitId}/task/${task_id}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify(parentReceipt),
  });
  expect(resultRes.status).toBe(200);
}

describe("multi-hop sub-settlement credits only what the ledger holds", () => {
  it("credits a FUNDED sub-hop — the discriminating half", async () => {
    // This is the case the guard must NOT block. It is the test whose absence
    // made the fix unshippable in #541: without it, over-blocking is invisible
    // and the failure mode is real sub-workers silently going unpaid.
    relay = await createTestRelay();
    const parent = await makeAgent(relay, 0.05);
    const subWorker = await makeAgent(relay, 0.02);
    const delegator = await makeAgent(relay, 0.01);
    seedBalance(relay, delegator.motebitId, 5);
    seedBalance(relay, parent.motebitId, 5);

    // Funded sub-task: deposit + allocation_hold debit + 'locked' allocation.
    const subTaskId = seedX402PaidTask(relay, {
      workerId: subWorker.motebitId,
      delegatorId: delegator.motebitId,
      prompt: "sub-search",
      unitCostUsd: 0.02,
    });

    // The guard depends on `x402-<subRelayTaskId>` being BOTH the allocation
    // row id and the `reference_id` of the hold debit. Nothing else asserts
    // that correspondence, and the whole ledger read hangs off it (#547).
    expect(holdMagnitudeFor(relay, subTaskId)).toBeGreaterThan(0);
    expect(allocationStatus(relay, subTaskId)).toBe("locked");

    const before = balanceOf(relay, subWorker.motebitId);
    const subReceipt = await signFor(subWorker, subTaskId, subTaskId);
    await settleParentCarrying(relay, parent, subReceipt);

    // Paid, and the allocation retired.
    expect(settlementRowsFor(relay, subTaskId)).toBe(1);
    expect(balanceOf(relay, subWorker.motebitId)).toBeGreaterThan(before);
    expect(allocationStatus(relay, subTaskId)).toBe("settled");

    const ledger = ledgerByType(relay, subWorker.motebitId);
    expect(ledger["settlement_credit"] ?? 0).toBeGreaterThan(0);
  });

  it("does NOT credit an unfunded sub-hop whose allocation holds nothing", async () => {
    relay = await createTestRelay();
    const parent = await makeAgent(relay, 0.05);
    const subWorker = await makeAgent(relay, 0.02);
    const delegator = await makeAgent(relay, 0.01);
    seedBalance(relay, delegator.motebitId, 5);
    seedBalance(relay, parent.motebitId, 5);

    const subTaskId = seedX402PaidTask(relay, {
      workerId: subWorker.motebitId,
      delegatorId: delegator.motebitId,
      prompt: "sub-search",
      unitCostUsd: 0.02,
    });

    // Strip the ledger hold, LEAVE the row 'locked'. This is the only shape
    // where the row-derived claim says "funded" and the ledger says otherwise
    // — a never-debited best-effort allocation, or one booked before the
    // submission-time fix. Seeded rather than driven, because the submission
    // paths that used to create it have since been closed (#552).
    relay.moteDb.db
      .prepare("DELETE FROM relay_transactions WHERE reference_id = ? AND type = 'allocation_hold'")
      .run(`x402-${subTaskId}`);
    expect(allocationStatus(relay, subTaskId)).toBe("locked");

    const before = balanceOf(relay, subWorker.motebitId);
    const subReceipt = await signFor(subWorker, subTaskId, subTaskId);
    await settleParentCarrying(relay, parent, subReceipt);

    // Nothing minted, and no settlement row claiming money moved.
    expect(balanceOf(relay, subWorker.motebitId)).toBe(before);
    expect(settlementRowsFor(relay, subTaskId)).toBe(0);
    expect(ledgerByType(relay, subWorker.motebitId)["settlement_credit"] ?? 0).toBe(0);

    // Claim-order: an unfunded allocation must stay 'locked' so the
    // stale-allocation sweep can retire it. Marking it 'settled' with no
    // settlement row is a hard error in reconcileLedger invariant 3 — the
    // exact defect that sent the direct-path fix back for rework in #541.
    expect(allocationStatus(relay, subTaskId)).toBe("locked");
  });

  it("conserves: sub-credits never exceed what the ledger held for the sub-task", async () => {
    relay = await createTestRelay();
    const parent = await makeAgent(relay, 0.05);
    const subWorker = await makeAgent(relay, 0.02);
    const delegator = await makeAgent(relay, 0.01);
    seedBalance(relay, delegator.motebitId, 5);
    seedBalance(relay, parent.motebitId, 5);

    const subTaskId = seedX402PaidTask(relay, {
      workerId: subWorker.motebitId,
      delegatorId: delegator.motebitId,
      prompt: "sub-search",
      unitCostUsd: 0.02,
    });
    const held = holdMagnitudeFor(relay, subTaskId);

    const subReceipt = await signFor(subWorker, subTaskId, subTaskId);
    await settleParentCarrying(relay, parent, subReceipt);

    const credited = ledgerByType(relay, subWorker.motebitId)["settlement_credit"] ?? 0;
    // The worker's net is gross minus the platform fee, so the credit is
    // strictly less than the hold — never more. This is the invariant the
    // whole guard exists to preserve.
    expect(credited).toBeLessThanOrEqual(held);
    expect(credited).toBeGreaterThan(0);
  });
});
