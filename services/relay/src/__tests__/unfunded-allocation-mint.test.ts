/**
 * Money-conservation regression: an UNFUNDED allocation row must never credit
 * a worker at settlement.
 *
 * The relay-custody lane holds delegator funds before work and credits the
 * worker after. Two independent listing reads decide the two halves of that
 * contract, and they disagree on what "priced" means:
 *
 *  - `getListingUnitCost` (drives `price_snapshot`, and therefore the
 *    allocation's `amount_locked`) reads ONLY the `pricing` column.
 *  - `getAgentPricing` (drives `requiresPayment`, and therefore the
 *    insufficient-funds 402) returns `null` when `pay_to_address` is absent.
 *
 * `pay_to_address` is optional and self-served on `POST /listing`. A listing
 * with `pricing > 0` and no `pay_to_address` therefore lands in the gap: it is
 * priced enough to mint a `price_snapshot`, but not priced enough to demand
 * payment. With no delegator balance, `allocateBudget` returns null, control
 * falls to the free-agent/best-effort `else` branch, and an allocation row is
 * inserted `status='locked'` with `amount_locked = price_snapshot` and NO
 * debit against any account.
 *
 * At settlement, `allocationClaimed` asks only whether that row is still
 * `'locked'` — never whether the ledger actually holds anything for it — so
 * `settlementFunded` is true and the worker is credited from nothing. The
 * refund and partial branches were already hardened against exactly this
 * ("releasing `amount_locked` there would mint unfunded balance"); the
 * worker-credit branch was not.
 *
 * `reconcileLedger` cannot catch the mint: the credit IS written to
 * `relay_transactions`, so the balance equation stays self-consistent. Only a
 * hold-vs-credit test sees it.
 *
 * Severing check (discriminating power): restore `settlementFunded` to
 * `grossAmount === 0 || allocationClaimed` and the accept-half below flips red
 * — the worker's balance goes from 0 to the settled amount with no
 * corresponding debit anywhere in the ledger.
 *
 * Rung: composition-root in-process. The relay-custody lane is not
 * HTTP-fundable (the self-declared /deposit route was removed as a
 * treasury-drain vector), which is why `booted-settlement-activation.test.ts`
 * records this lane's severing as the honest in-process remainder.
 */
import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex, signExecutionReceipt } from "@motebit/encryption";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import type { SyncRelay } from "../index.js";
import {
  AUTH_HEADER,
  JSON_AUTH,
  createTestRelay,
  createAgent,
  jsonAuthWithIdempotency,
  seedBalance,
} from "./test-helpers.js";

let relay: SyncRelay | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

/** Total of every ledger row for an account, by type — the funding truth. */
function ledgerByType(r: SyncRelay, motebitId: string): Record<string, number> {
  const rows = r.moteDb.db
    .prepare(
      "SELECT type, SUM(amount) as total FROM relay_transactions WHERE motebit_id = ? GROUP BY type",
    )
    .all(motebitId) as Array<{ type: string; total: number }>;
  return Object.fromEntries(rows.map((row) => [row.type, row.total]));
}

async function priceListing(
  r: SyncRelay,
  motebitId: string,
  opts: { unitCost: number; payTo?: string },
): Promise<void> {
  await r.app.request(`/api/v1/agents/${motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [
        { capability: "web_search", unit_cost: opts.unitCost, currency: "USD", per: "task" },
      ],
      ...(opts.payTo != null ? { pay_to_address: opts.payTo } : {}),
    }),
  });
}

/**
 * Drive one relay-custody delegation to settlement: worker registers, is
 * priced, connects, receives a self-delegated task, returns a signed receipt.
 * Self-delegation is an explicit Arc-3.5 submission carve-out
 * (`requiresP2pProof` needs `submittedBy !== workerId`), so this reaches the
 * relay-custody settlement path without a P2P proof.
 */
async function settleSelfDelegatedTask(
  r: SyncRelay,
  args: {
    unitCost: number;
    payTo?: string;
    fundDelegator?: number;
    /**
     * Strip the allocation's ledger hold while LEAVING the row `'locked'`.
     * Models a legacy row booked before the submission-time fix: claimable, but
     * with nothing behind it. Not creatable through the API any more, which is
     * exactly why it has to be seeded to be tested.
     */
    orphanHoldBeforeReceipt?: boolean;
  },
): Promise<{ motebitId: string; taskId: string }> {
  const keypair = await generateKeypair();
  const pubHex = bytesToHex(keypair.publicKey);
  const { motebitId, deviceId } = await createAgent(r, pubHex);

  await priceListing(r, motebitId, { unitCost: args.unitCost, payTo: args.payTo });

  const ws = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  r.connections.set(motebitId, [{ ws: ws as never, deviceId, capabilities: ["web_search"] }]);

  if (args.fundDelegator != null) seedBalance(r, motebitId, args.fundDelegator);

  const submitRes = await r.app.request(`/agent/${motebitId}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({ prompt: "search", required_capabilities: ["web_search"] }),
  });
  expect(submitRes.status).toBe(201);
  const { task_id } = (await submitRes.json()) as { task_id: string };

  const receipt = await signExecutionReceipt(
    {
      task_id,
      relay_task_id: task_id,
      motebit_id: motebitId as unknown as MotebitId,
      device_id: deviceId as unknown as DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed" as const,
      result: "found it",
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: "abc",
      result_hash: "def",
    },
    keypair.privateKey,
  );

  if (args.orphanHoldBeforeReceipt === true) {
    // Delete the hold rows but leave the allocation `'locked'`. The status
    // check alone still passes here — which is the whole point: this is the
    // one shape where `allocationClaimed` is TRUE and the ledger holds
    // nothing, so it is the only thing that exercises the ledger condition
    // rather than the status condition.
    r.moteDb.db
      .prepare("DELETE FROM relay_transactions WHERE reference_id = ? AND type = 'allocation_hold'")
      .run(`x402-${task_id}`);
  }

  const resultRes = await r.app.request(`/agent/${motebitId}/task/${task_id}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify(receipt),
  });
  expect(resultRes.status).toBe(200);

  return { motebitId, taskId: task_id };
}

describe("settlement credits only what the ledger still holds", () => {
  /**
   * The scenario is deliberately NOT "submit an unfunded priced task" any more.
   * The submission-time fix refuses that at the door (402), so it cannot be
   * reached through the API — which is the point of shipping both.
   *
   * What remains reachable, and is the case this guard actually exists for: an
   * allocation that WAS funded, whose hold has since been released back to the
   * delegator, followed by a late receipt. Crediting there pays twice — once to
   * the delegator on release, once to the worker on settlement — from one hold.
   */
  it("refuses to credit against a claimable allocation the ledger does not back", async () => {
    relay = await createTestRelay();
    const { motebitId, taskId } = await settleSelfDelegatedTask(relay, {
      unitCost: 1.0,
      fundDelegator: 5.0,
      orphanHoldBeforeReceipt: true,
    });

    const ledger = ledgerByType(relay, motebitId);

    // The row is still claimable, but the ledger holds nothing for it.
    expect(ledger["allocation_hold"] ?? 0).toBe(0);

    // The invariant: a claimable row with no ledger backing must not pay. The
    // status check alone would have paid here — this is the ledger condition.
    expect(ledger["settlement_credit"] ?? 0).toBe(0);

    // And reconciliation invariant 3 holds: the row is not left 'settled'
    // without a settlement record. (Claim-order — see the fix's commit.)
    const orphans = relay.moteDb.db
      .prepare(
        `SELECT COUNT(*) as n FROM relay_allocations a
         LEFT JOIN relay_settlements s ON s.allocation_id = a.allocation_id
         WHERE a.status = 'settled' AND s.settlement_id IS NULL`,
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0);
    expect(taskId).toBeTruthy();
  });

  it("still credits normally when the hold is intact (no regression)", async () => {
    relay = await createTestRelay();
    const { motebitId } = await settleSelfDelegatedTask(relay, {
      unitCost: 1.0,
      fundDelegator: 5.0,
    });

    const ledger = ledgerByType(relay, motebitId);
    expect(ledger["allocation_hold"] ?? 0).toBeLessThan(0);
    expect(ledger["settlement_credit"] ?? 0).toBeGreaterThan(0);

    // Conservation: the worker's credit never exceeds what was actually held.
    const held = Math.abs(ledger["allocation_hold"] ?? 0);
    expect(ledger["settlement_credit"] ?? 0).toBeLessThanOrEqual(held);
  });
});
