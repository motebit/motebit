/**
 * The priced-but-unpayable listing: the illegal state behind two separate
 * money-path defects. This suite makes it unrepresentable at the source rather
 * than patching each payout site that trusts it.
 *
 * ## The state
 *
 * Two reads decided the two halves of the relay-custody funding contract, and
 * they disagreed about what "priced" means:
 *
 *  - `getListingUnitCost` — drives `price_snapshot`, and therefore the
 *    allocation's `amount_locked`. Reads the `pricing` column only.
 *  - `getAgentPricing` — drives `requiresPayment`, and therefore the
 *    insufficient-funds 402. Returned `null` when `pay_to_address` was absent.
 *
 * `pay_to_address` is optional and self-served on `POST /listing`. So a listing
 * with `pricing > 0` and no payout address was priced enough to mint a
 * `price_snapshot` but not priced enough to demand payment: with no delegator
 * balance, `allocateBudget` returned null, control fell to the free-agent
 * best-effort branch, and an allocation row was booked `status='locked'` with
 * `amount_locked = price_snapshot` and NO debit against any account.
 *
 * That single unfunded row was then trusted by every downstream payout site —
 * the settlement credit, the stale-allocation release, and the
 * retry-exhaustion refund — each of which paid out against `amount_locked`.
 *
 * ## Why the conflation was wrong on its own terms
 *
 * `pay_to_address` is the SOVEREIGN onchain payment destination: the planner's
 * direct-delegation path sends to it (`sovereign-delegation-adapter.ts` —
 * `walletRail.send(candidate.pay_to_address, costMicro)`). The relay-custody
 * lane never uses it — the worker is credited to its VIRTUAL ACCOUNT. So an
 * agent that charges for relay-custody work but publishes no onchain address
 * is perfectly coherent, and was being read as free.
 *
 * `getAgentPricing`'s return value was never destructured either: the only use
 * was `requiresPayment = agentPricingInfo != null`. An elaborate way to compute
 * a boolean, computing the wrong one.
 *
 * ## The fix, and why it is structural rather than a patch
 *
 * Both halves now read `getListingUnitCost`. Two reads cannot disagree when
 * there is only one read — the illegal state stops being representable instead
 * of being caught later. A priced agent now demands payment whether or not it
 * publishes an onchain address, so an unfunded delegation is refused at
 * submission (402) rather than booking a row that mints money downstream.
 *
 * Severing check: restore `requiresPayment` to a `pay_to_address`-gated read
 * and the first test flips red — the submission succeeds and books an
 * allocation with no matching debit.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import type { SyncRelay } from "../index.js";
import {
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

/** Ledger totals by transaction type — the funding truth for an account. */
function ledgerByType(r: SyncRelay, motebitId: string): Record<string, number> {
  const rows = r.moteDb.db
    .prepare(
      "SELECT type, SUM(amount) as total FROM relay_transactions WHERE motebit_id = ? GROUP BY type",
    )
    .all(motebitId) as Array<{ type: string; total: number }>;
  return Object.fromEntries(rows.map((row) => [row.type, row.total]));
}

function allocationsFor(r: SyncRelay, taskId: string): Array<{ status: string; locked: number }> {
  return r.moteDb.db
    .prepare("SELECT status, amount_locked as locked FROM relay_allocations WHERE task_id = ?")
    .all(taskId) as Array<{ status: string; locked: number }>;
}

/** Register an agent, list it at `unitCost`, optionally with a payout address. */
async function listedAgent(
  r: SyncRelay,
  opts: { unitCost: number; payTo?: string; fund?: number },
): Promise<{ motebitId: string; deviceId: string }> {
  const kp = await generateKeypair();
  const agent = await createAgent(r, bytesToHex(kp.publicKey));

  await r.app.request(`/api/v1/agents/${agent.motebitId}/listing`, {
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

  const ws = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  r.connections.set(agent.motebitId, [
    { ws: ws as never, deviceId: agent.deviceId, capabilities: ["web_search"] },
  ]);

  if (opts.fund != null) seedBalance(r, agent.motebitId, opts.fund);
  return agent;
}

/**
 * Self-delegation, with `submitted_by` set explicitly.
 *
 * Both details are load-bearing. `submitted_by` is what lets the x402
 * middleware's virtual-account bypass identify the delegator at all — under a
 * master token `parseTokenPayloadUnsafe` yields no `mid`, so the bypass falls
 * back to peeking at the body, and without it the balance check is skipped and
 * a `pay_to_address`-carrying listing 402s at the HTTP layer before the handler
 * ever runs. Self-delegation (`submitted_by === worker`) keeps this inside the
 * Arc-3.5 submission carve-out, so `requiresP2pProof` does not fire — otherwise
 * a paid cross-agent relay-custody delegation is refused for an unrelated
 * reason and the two 402s become indistinguishable.
 */
async function submitSelfTask(r: SyncRelay, motebitId: string): Promise<Response> {
  return r.app.request(`/agent/${motebitId}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({
      prompt: "search",
      required_capabilities: ["web_search"],
      submitted_by: motebitId,
    }),
  });
}

/** The error code in a 402 body — insufficient funds and the x402 gate share the status. */
async function errorCode(res: Response): Promise<string> {
  const body = (await res.clone().json()) as { error?: string; code?: string };
  return body.code ?? body.error ?? "";
}

describe("a priced listing demands payment whether or not it declares pay_to_address", () => {
  it("refuses an unfunded delegation to a priced listing that has NO pay_to_address", async () => {
    relay = await createTestRelay();
    const { motebitId } = await listedAgent(relay, { unitCost: 1.0 }); // no payTo, no funds

    const res = await submitSelfTask(relay, motebitId);

    // Refused at submission — the delegator cannot pay, so no work is queued.
    // Assert the SPECIFIC refusal: this listing has no `pay_to_address`, so the
    // x402 gate is not even armed; reaching a 402 by that path instead would
    // mean the test is passing for the wrong reason.
    expect(res.status).toBe(402);
    expect(await errorCode(res)).not.toBe("payment_required");

    // The invariant that matters: no allocation row exists to be paid out
    // against later by the settlement credit, the stale release, or the
    // retry refund. Nothing was booked, so nothing can be minted.
    const ledger = ledgerByType(relay, motebitId);
    expect(ledger["allocation_hold"] ?? 0).toBe(0);
    const orphanRows = relay.moteDb.db
      .prepare("SELECT COUNT(*) as n FROM relay_allocations")
      .get() as { n: number };
    expect(orphanRows.n).toBe(0);
  });

  it("books a REAL hold when the same listing is funded — payment is demanded, not refused outright", async () => {
    relay = await createTestRelay();
    const { motebitId } = await listedAgent(relay, { unitCost: 1.0, fund: 5.0 });

    const res = await submitSelfTask(relay, motebitId);
    expect(res.status).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };

    // Funded path is unchanged: a locked allocation backed by a real debit.
    const ledger = ledgerByType(relay, motebitId);
    expect(ledger["allocation_hold"] ?? 0).toBeLessThan(0);

    const allocs = allocationsFor(relay, task_id);
    expect(allocs).toHaveLength(1);
    expect(allocs[0]?.status).toBe("locked");
    // Every micro the row claims is actually held on the ledger.
    expect(allocs[0]?.locked).toBeLessThanOrEqual(Math.abs(ledger["allocation_hold"] ?? 0));
  });

  it("leaves a listing WITH pay_to_address on the x402 path, unchanged", async () => {
    relay = await createTestRelay();
    const payTo = "SoLPayTo11111111111111111111111111111111111";

    // Unfunded: the x402 middleware arms (it has a payout destination) and
    // demands onchain USDC before the handler runs. This is the ONE case where
    // `pay_to_address` legitimately decides the outcome.
    const poor = await listedAgent(relay, { unitCost: 1.0, payTo });
    const poorRes = await submitSelfTask(relay, poor.motebitId);
    expect(poorRes.status).toBe(402);
    expect(await errorCode(poorRes)).toBe("payment_required");

    // Funded: the virtual-account bypass resolves the delegator from
    // `submitted_by`, sees balance >= gross, and skips x402 — so the same
    // listing settles through relay custody with a real hold.
    const rich = await listedAgent(relay, { unitCost: 1.0, payTo, fund: 5.0 });
    const res = await submitSelfTask(relay, rich.motebitId);
    expect(res.status).toBe(201);
    expect(ledgerByType(relay, rich.motebitId)["allocation_hold"] ?? 0).toBeLessThan(0);
  });

  it("still lets a genuinely FREE agent through with no hold and no payment demand", async () => {
    relay = await createTestRelay();
    // unit_cost 0 → not priced → no price_snapshot → no allocation at all.
    const { motebitId } = await listedAgent(relay, { unitCost: 0 });

    const res = await submitSelfTask(relay, motebitId);
    expect(res.status).toBe(201);

    const ledger = ledgerByType(relay, motebitId);
    expect(ledger["allocation_hold"] ?? 0).toBe(0);
    expect(ledger["settlement_credit"] ?? 0).toBe(0);
  });
});
