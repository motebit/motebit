/**
 * #901 — a task is never admitted as funded with no money held.
 *
 * `debitSpendableAccount` returns null when the SPENDABLE balance (balance −
 * escrow hold) cannot cover the hold. Submission ignored that null, and on the
 * x402 path it sized the hold from the RAW balance while the debit netted the
 * escrow hold — so `raw ≥ lock > spendable` booked a `locked` allocation and
 * admitted the task with nothing debited: priced, admitted, unpayable.
 *
 * The law these tests hold, on every funding path of `POST /agent/:id/task`:
 *
 *   1. One spendable definition (`getSpendableBalance`, = what
 *      `debitSpendableAccount` enforces) sizes the hold, decides a 402, and
 *      decides whether the x402 gate may be skipped.
 *   2. A null debit is a 402 raised INSIDE the admission transaction: no
 *      allocation row, no queued task, no claim binding — and the key is free,
 *      so the same key succeeds once funded, with exactly one task and one debit.
 *
 * The x402 path runs the REAL `@x402/hono` stack (#907); only the
 * facilitator's network round-trip is replaced (`x402-fake-facilitator.ts`),
 * and a paid request carries a payment signed from the relay's own
 * `PAYMENT-REQUIRED` challenge. Everything after the facilitator (settlement
 * before admission, deposit, hold, allocation, admission) is production code.
 * These cells were first written against a stand-in that settled BEFORE the
 * handler — the ordering the handler's x402 branch assumed and the library
 * never had (#907); under the real ordering they now hold as written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { computeGrossAmount } from "@motebit/market";
import { PLATFORM_FEE_RATE } from "@motebit/protocol";
import {
  createAgent,
  createTestRelay,
  JSON_AUTH,
  seedBalance,
  X402_TEST_CONFIG,
} from "./test-helpers.js";
import { facilitator, signPayment } from "./x402-fake-facilitator.js";
import { creditAccount, getSpendableBalance, toMicro } from "../accounts.js";

vi.mock(
  "../x402-facilitator.js",
  async () => (await import("./x402-fake-facilitator.js")).fakeFacilitatorModule,
);

/** The facilitator's record, read the way these cells read it. */
const x402 = {
  /** Onchain settlements. */
  get settled(): number {
    return facilitator.settled.length;
  },
  /** What each PAID request was verified against: its price and destination. */
  get quoted(): { amount: string; payTo: string }[] {
    return facilitator.verified.map((v) => ({ amount: v.amount, payTo: v.payTo }));
  },
};
const TREASURY = X402_TEST_CONFIG.payToAddress;

const UNIT_COST = 1.0;
const GROSS = toMicro(computeGrossAmount(UNIT_COST, PLATFORM_FEE_RATE));

let relay: SyncRelay;

beforeEach(async () => {
  relay = await createTestRelay({ enableDeviceAuth: false });
  facilitator.reset();
});
afterEach(async () => {
  await relay.close();
});

async function newAgent(): Promise<string> {
  const kp = await generateKeypair();
  return (await createAgent(relay, bytesToHex(kp.publicKey))).motebitId;
}

/** A priced worker ($1.00/task). With `payTo`, the x402 gate prices it. */
async function pricedWorker(payTo: boolean): Promise<string> {
  const id = await newAgent();
  await relay.app.request(`/api/v1/agents/${id}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: UNIT_COST, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "901 priced worker",
      ...(payTo ? { pay_to_address: "0x00000000000000000000000000000000000000a1" } : {}),
    }),
  });
  return id;
}

/**
 * Escrow-held earnings: a relay settlement credited to `motebitId` inside the
 * dispute window. With `credit`, the earnings are also in its balance (the
 * ordinary state); without, the hold exceeds what the balance holds.
 */
function seedEscrowHold(motebitId: string, micro: number, credit: boolean): void {
  const db = relay.moteDb.db;
  const settlementId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, amount_settled, status, settled_at)
     VALUES (?, ?, ?, ?, ?, 'completed', ?)`,
  ).run(settlementId, crypto.randomUUID(), crypto.randomUUID(), motebitId, micro, Date.now());
  // The credit names its settlement row (#890 r9).
  if (credit) {
    creditAccount(db, motebitId, micro, "settlement_credit", settlementId, "901 held earnings");
  }
}

/**
 * The client's payment for `body`: the relay's own challenge (asked under a
 * throwaway key), signed. A submission the gate does not challenge (a refused
 * reading, a funded account) carries a header the gate never reads.
 */
async function paymentFor(worker: string, body: Record<string, unknown>): Promise<string> {
  const res = await relay.app.request(`/agent/${worker}/task`, {
    method: "POST",
    headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const header = res.headers.get("PAYMENT-REQUIRED");
  return header != null ? signPayment(header, "0xpayer") : "not-challenged";
}

const submit = async (
  worker: string,
  key: string,
  body: Record<string, unknown>,
  opts: { pay?: boolean } = {},
) => {
  const payment = opts.pay ? await paymentFor(worker, body) : undefined;
  return relay.app.request(`/agent/${worker}/task`, {
    method: "POST",
    headers: {
      ...JSON_AUTH,
      "Idempotency-Key": key,
      ...(payment != null ? { "PAYMENT-SIGNATURE": payment } : {}),
    },
    body: JSON.stringify(body),
  });
};

function balanceOf(id: string): number {
  const row = relay.moteDb.db
    .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
    .get(id) as { balance: number } | undefined;
  return row?.balance ?? 0;
}
function tasksWithPrompt(prompt: string): string[] {
  return (
    relay.moteDb.db
      .prepare("SELECT task_id FROM relay_task_queue WHERE prompt = ?")
      .all(prompt) as { task_id: string }[]
  ).map((r) => r.task_id);
}
function allocationsForTasks(taskIds: string[]): { task_id: string; amount_locked: number }[] {
  if (taskIds.length === 0) return [];
  return relay.moteDb.db
    .prepare(
      `SELECT task_id, amount_locked FROM relay_allocations WHERE task_id IN (${taskIds.map(() => "?").join(",")})`,
    )
    .all(...taskIds) as { task_id: string; amount_locked: number }[];
}
function holdDebited(taskId: string): number {
  const row = relay.moteDb.db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM relay_transactions WHERE type = 'allocation_hold' AND reference_id = ?",
    )
    .get(`x402-${taskId}`) as { total: number };
  return -row.total;
}
function claimRow(key: string, motebitId: string): { task_id: string | null } | undefined {
  return relay.moteDb.db
    .prepare(
      "SELECT task_id FROM relay_idempotency_keys WHERE idempotency_key = ? AND motebit_id = ?",
    )
    .get(key, motebitId) as { task_id: string | null } | undefined;
}

describe("#901 funding: the check and the debit read one spendable balance", () => {
  it("x402, raw ≥ price > spendable: 402 — no allocation, no task, key free, the x402 deposit kept; the same key, paid again, admits one task with one debit", async () => {
    const worker = await pricedWorker(true);
    const delegator = await newAgent();
    // Hold of half the price the balance does not cover: after the x402
    // deposit, raw = GROSS ≥ price, spendable = GROSS / 2 < price.
    seedEscrowHold(delegator, GROSS / 2, false);
    const prompt = `901 x402 short ${crypto.randomUUID()}`;
    const key = crypto.randomUUID();
    const body = { prompt, submitted_by: delegator };

    const refused = await submit(worker, key, body, { pay: true });
    expect(x402.settled, "the x402 payment was taken").toBe(1);
    expect(refused.status, await refused.clone().text()).toBe(402);
    const refusal = (await refused.json()) as {
      code?: string;
      error?: string;
      payment_credited?: { amount_micro: number; reference: string; motebit_id: string };
    };
    expect(refusal.code).toBe("INSUFFICIENT_FUNDS");
    // The refusal names the payment this request made, where it sits, and
    // never invites a second payment.
    expect(refusal.payment_credited).toMatchObject({ amount_micro: GROSS, motebit_id: delegator });
    expect(refusal.payment_credited?.reference).toMatch(/^x402-/);
    expect(refusal.error).toMatch(/was credited to account/);
    expect(refusal.error).toMatch(/withdrawable once the account's dispute-escrow hold clears/);
    expect(refusal.error).toMatch(/Do not pay again/);
    expect(refusal.error).not.toMatch(/pay via x402/);
    expect(tasksWithPrompt(prompt), "a refused task is never queued").toEqual([]);
    expect(
      relay.moteDb.db
        .prepare("SELECT COUNT(*) AS n FROM relay_allocations WHERE motebit_id = ?")
        .get(worker) as { n: number },
      "no allocation row",
    ).toEqual({ n: 0 });
    expect(claimRow(key, worker), "nothing admitted, so the key is free").toBeUndefined();
    expect(balanceOf(delegator), "the x402 deposit stays with the delegator").toBe(GROSS);

    // The same key, retried with a second x402 payment (a cross-agent
    // delegation is funded by x402 or a P2P proof — Arc 3.5 closes the
    // deposit-funded path): spendable is now GROSS/2 + GROSS. Evaluated afresh.
    const before = balanceOf(delegator) + GROSS;
    const funded = await submit(worker, key, body, { pay: true });
    expect(x402.settled).toBe(2);
    expect(funded.status, await funded.clone().text()).toBe(201);
    const { task_id } = (await funded.json()) as { task_id: string };
    expect(tasksWithPrompt(prompt)).toEqual([task_id]);
    const allocs = allocationsForTasks([task_id]);
    expect(allocs).toHaveLength(1);
    expect(holdDebited(task_id), "one debit, equal to the hold booked").toBe(
      allocs[0]!.amount_locked,
    );
    expect(balanceOf(delegator)).toBe(before - allocs[0]!.amount_locked);
  });

  it("x402, held earnings net the risk buffer: admitted with the hold sized to what the debit can take — never a hold larger than the debit", async () => {
    const worker = await pricedWorker(true);
    const delegator = await newAgent();
    // Ordinary state: half a price of recent earnings, credited and held.
    // After the x402 deposit raw = 1.5·GROSS, spendable = GROSS < 1.2·GROSS.
    seedEscrowHold(delegator, GROSS / 2, true);
    const prompt = `901 x402 buffer ${crypto.randomUUID()}`;

    const res = await submit(
      worker,
      crypto.randomUUID(),
      { prompt, submitted_by: delegator },
      {
        pay: true,
      },
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };
    const allocs = allocationsForTasks([task_id]);
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.amount_locked, "the hold is what was spendable").toBe(GROSS);
    expect(holdDebited(task_id), "and it was debited").toBe(GROSS);
    expect(getSpendableBalance(relay.moteDb.db, delegator)).toBe(0);
  });

  it("the x402 gate is skipped only for a SPENDABLE balance that covers the price — a held balance pays via x402 and is admitted", async () => {
    const worker = await pricedWorker(true);
    const delegator = await newAgent();
    // Raw 2·GROSS, all of it held: spendable 0.
    seedEscrowHold(delegator, 2 * GROSS, true);
    const prompt = `901 bypass ${crypto.randomUUID()}`;

    const unpaid = await submit(worker, crypto.randomUUID(), { prompt, submitted_by: delegator });
    expect(unpaid.status).toBe(402);
    expect(await unpaid.json(), "the x402 gate asks for payment").toMatchObject({
      error: "payment_required",
    });

    const paid = await submit(
      worker,
      crypto.randomUUID(),
      { prompt, submitted_by: delegator },
      {
        pay: true,
      },
    );
    expect(paid.status, await paid.clone().text()).toBe(201);
    const { task_id } = (await paid.json()) as { task_id: string };
    expect(holdDebited(task_id)).toBe(allocationsForTasks([task_id])[0]!.amount_locked);
    expect(holdDebited(task_id)).toBeGreaterThanOrEqual(GROSS);
  });

  it("relay-custody budget: a debit that takes nothing is a 402 inside admission — no allocation, no task, key free; the same key once it can debit admits one task with one debit", async () => {
    // Self-delegation on a priced worker with no payout address: the budget
    // path, no x402. The check passes; the debit is made to find nothing
    // (a fault at the ledger: the balance UPDATE is ignored), standing for any
    // way the two could ever disagree again.
    const worker = await pricedWorker(false);
    seedBalance(relay, worker, 5);
    const funded = balanceOf(worker);
    const prompt = `901 null debit ${crypto.randomUUID()}`;
    const key = crypto.randomUUID();
    relay.moteDb.db.exec(
      `CREATE TRIGGER zz901_ignore_debit BEFORE UPDATE ON relay_accounts
       WHEN NEW.balance < OLD.balance BEGIN SELECT RAISE(IGNORE); END;`,
    );

    const refused = await submit(worker, key, { prompt });
    expect(refused.status, await refused.clone().text()).toBe(402);
    expect(((await refused.json()) as { code?: string }).code).toBe("INSUFFICIENT_FUNDS");
    expect(tasksWithPrompt(prompt), "no task").toEqual([]);
    expect(
      relay.moteDb.db
        .prepare("SELECT COUNT(*) AS n FROM relay_allocations WHERE motebit_id = ?")
        .get(worker) as { n: number },
      "no allocation row",
    ).toEqual({ n: 0 });
    expect(claimRow(key, worker), "the key is free").toBeUndefined();
    expect(balanceOf(worker)).toBe(funded);

    relay.moteDb.db.exec("DROP TRIGGER zz901_ignore_debit");
    const retry = await submit(worker, key, { prompt });
    expect(retry.status, await retry.clone().text()).toBe(201);
    const { task_id } = (await retry.json()) as { task_id: string };
    expect(tasksWithPrompt(prompt)).toEqual([task_id]);
    const allocs = allocationsForTasks([task_id]);
    expect(allocs).toHaveLength(1);
    expect(holdDebited(task_id)).toBe(allocs[0]!.amount_locked);
    expect(balanceOf(worker)).toBe(funded - allocs[0]!.amount_locked);
  });
});

// ── Rounds 2–3: the gate and the handler read a submission the same way ──────

const PAY_TO_T = "0x00000000000000000000000000000000000000b2";
const PAY_TO_W = "0x00000000000000000000000000000000000000c3";

/** Publish a listing with the given per-capability prices (dollars). */
async function listing(id: string, prices: Record<string, number>, payTo: string): Promise<void> {
  const caps = Object.keys(prices);
  await relay.app.request(`/api/v1/agents/${id}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: caps,
      pricing: caps.map((cap) => ({
        capability: cap,
        unit_cost: prices[cap],
        currency: "USD",
        per: "task",
      })),
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "901 round 2",
      pay_to_address: payTo,
    }),
  });
}

function queuedFor(workerId: string): number {
  return (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_task_queue WHERE worker_id = ?")
      .get(workerId) as { n: number }
  ).n;
}
function claimHeld(key: string, motebitId: string): boolean {
  return claimRow(key, motebitId) !== undefined;
}

describe("#901 round 3: a task is priced for exactly the worker it is routed to", () => {
  // target_agent routes a task only on a P2P proof submission. Priced from a
  // target that routes nothing, the PATH worker worked at the target's price —
  // free for an unlisted target, or the cheap agent's price.
  async function freeWorkCell(
    opts: { submittedBy: boolean; payTo: boolean },
    target: (w: string) => Promise<string> | string,
  ) {
    const w = await newAgent();
    if (opts.payTo) await listing(w, { web_search: 1.0 }, PAY_TO_W);
    else {
      await relay.app.request(`/api/v1/agents/${w}/listing`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          capabilities: ["web_search"],
          pricing: [{ capability: "web_search", unit_cost: 1.0, currency: "USD", per: "task" }],
          sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
          description: "901 r3 no payTo",
        }),
      });
    }
    const d = await newAgent(); // broke
    const key = crypto.randomUUID();
    const res = await submit(w, key, {
      prompt: `901 r3 ${crypto.randomUUID()}`,
      ...(opts.submittedBy ? { submitted_by: d } : {}),
      target_agent: await target(w),
      required_capabilities: ["web_search"],
    });
    return { w, key, res };
  }

  it("T1: an unlisted target_agent on a priced worker (no proof) is refused 400 — nothing queued, no x402 asked, key free", async () => {
    const { w, key, res } = await freeWorkCell(
      { submittedBy: true, payTo: true },
      () => "no-such-agent",
    );
    // Checked first: no free work, whatever the status. Without the refusal
    // the task is priced AND routed for the path agent (one reading,
    // `terms.routedTo`), so it would be charged, not free.
    expect(queuedFor(w), "no free work").toBe(0);
    expect(claimHeld(key, w), "a pre-admission refusal frees the key").toBe(false);
    expect(res.status, await res.clone().text()).toBe(400);
    expect(x402.quoted).toEqual([]);
  });

  it("a pinned capability on the path agent itself: the gate charges what the handler prices — an account that can fund the $1 capability is never sent to x402 for the $2 listing sum", async () => {
    const w = await newAgent();
    await listing(w, { web_search: 1.0, read_url: 1.0 }, PAY_TO_W);
    // Spendable 1.1·G1: covers the $1 capability, not the $2 sum.
    seedEscrowHold(w, Math.round(1.1 * GROSS), true);
    creditAccount(relay.moteDb.db, w, Math.round(1.1 * GROSS), "deposit", null, "901 r3");
    const res = await submit(w, crypto.randomUUID(), {
      prompt: `901 r3 pinned self ${crypto.randomUUID()}`,
      submitted_by: w,
      target_agent: w,
      required_capabilities: ["web_search"],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };
    expect(x402.quoted, "never asked to pay").toEqual([]);
    expect(x402.settled).toBe(0);
    expect(holdDebited(task_id), "funded once, from the account").toBe(
      allocationsForTasks([task_id])[0]!.amount_locked,
    );
  });

  it("T1b: the same with no submitted_by — refused 400, nothing queued", async () => {
    const { w, res } = await freeWorkCell(
      { submittedBy: false, payTo: true },
      () => "no-such-agent",
    );
    expect(res.status, await res.clone().text()).toBe(400);
    expect(queuedFor(w)).toBe(0);
  });

  it("T1c: the same on a priced worker with NO payTo (not x402-chargeable; main's gate never backstopped it) — refused 400, nothing queued", async () => {
    const { w, res } = await freeWorkCell(
      { submittedBy: true, payTo: false },
      () => "no-such-agent",
    );
    expect(res.status, await res.clone().text()).toBe(400);
    expect(queuedFor(w)).toBe(0);
  });

  it("T2: a cheap target_agent on a $1 worker, paid via x402 — refused 400 before any quote; never charged the cheap price", async () => {
    const w = await newAgent();
    await listing(w, { web_search: 1.0 }, PAY_TO_W);
    const cheap = await newAgent();
    await listing(cheap, { web_search: 0.01 }, PAY_TO_T);
    const res = await submit(
      w,
      crypto.randomUUID(),
      {
        prompt: `901 r3 T2 ${crypto.randomUUID()}`,
        submitted_by: w,
        target_agent: cheap,
        required_capabilities: ["web_search"],
      },
      { pay: true },
    );
    expect(res.status, await res.clone().text()).toBe(400);
    expect(x402.quoted, "the gate charges nothing on a refused reading").toEqual([]);
    expect(x402.settled).toBe(0);
    expect(queuedFor(w)).toBe(0);
    expect(queuedFor(cheap)).toBe(0);
  });

  it("reviewer's round-2 cell: a pinned self-delegation with a differing target_agent and no proof is refused 400 — never admitted, never charged", async () => {
    const t = await newAgent();
    await listing(t, { web_search: 1.0 }, PAY_TO_T);
    const w = await newAgent();
    await listing(w, { web_search: 1.0, read_url: 1.0 }, PAY_TO_W);
    seedEscrowHold(w, Math.round(1.1 * GROSS), true);
    creditAccount(relay.moteDb.db, w, Math.round(1.1 * GROSS), "deposit", null, "901 r3");
    const before = balanceOf(w);
    const res = await submit(w, crypto.randomUUID(), {
      prompt: `901 r3 reviewer ${crypto.randomUUID()}`,
      submitted_by: w,
      target_agent: t,
      required_capabilities: ["web_search"],
    });
    expect(res.status, await res.clone().text()).toBe(400);
    expect(x402.settled).toBe(0);
    expect(x402.quoted).toEqual([]);
    expect(balanceOf(w), "never charged").toBe(before);
    expect(queuedFor(w) + queuedFor(t)).toBe(0);
  });

  it("a target_agent naming the path agent itself is accepted (non-P2P) and priced as that agent", async () => {
    const w = await newAgent();
    await listing(w, { web_search: 1.0 }, PAY_TO_W);
    seedBalance(relay, w, 2);
    const res = await submit(w, crypto.randomUUID(), {
      prompt: `901 r3 self-target ${crypto.randomUUID()}`,
      submitted_by: w,
      target_agent: w,
      required_capabilities: ["web_search"],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };
    expect(holdDebited(task_id)).toBeGreaterThanOrEqual(GROSS);
  });

  it("a payment_proof + target_agent with NO submitter is not P2P, so the differing target is refused 400", async () => {
    const w = await newAgent();
    await listing(w, { web_search: 1.0 }, PAY_TO_W);
    const res = await submit(w, crypto.randomUUID(), {
      prompt: `901 r3 proof-no-submitter ${crypto.randomUUID()}`,
      target_agent: "no-such-agent",
      required_capabilities: ["web_search"],
      payment_proof: { tx_hash: "x" },
    });
    expect(res.status, await res.clone().text()).toBe(400);
    expect(queuedFor(w)).toBe(0);
  });

  it("P2P with an unlisted target_agent is refused before admission (the federated branch cannot discover it) — as on main", async () => {
    const d = await newAgent();
    const key = crypto.randomUUID();
    const res = await submit(d, key, {
      prompt: `901 r3 p2p bogus ${crypto.randomUUID()}`,
      submitted_by: d,
      target_agent: "no-such-agent",
      required_capabilities: ["web_search"],
      payment_proof: {
        tx_hash: "5".repeat(88),
        chain: "solana",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        to_address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
        amount_micro: 1_000_000,
        fee_to_address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
        fee_amount_micro: 52_632,
        b_fee_to_address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
        b_fee_amount_micro: 50_000,
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(queuedFor(d)).toBe(0);
    expect(claimHeld(key, d), "a pre-admission refusal frees the key").toBe(false);
  });

  it('submitted_by: "" is refused 400 by the handler and charged nothing by the gate', async () => {
    const w = await pricedWorker(true);
    const res = await submit(
      w,
      crypto.randomUUID(),
      { prompt: `901 r3 empty submitter ${crypto.randomUUID()}`, submitted_by: "" },
      { pay: true },
    );
    expect(res.status, await res.clone().text()).toBe(400);
    expect(x402.quoted).toEqual([]);
    expect(queuedFor(w)).toBe(0);
  });

  it("a null, array, or unparseable body is a 400 — never a 500 — and is charged nothing", async () => {
    const w = await pricedWorker(true);
    for (const raw of ["null", "[]", "{not json", '"a string"']) {
      const key = crypto.randomUUID();
      const res = await relay.app.request(`/agent/${w}/task`, {
        method: "POST",
        headers: { ...JSON_AUTH, "Idempotency-Key": key, "PAYMENT-SIGNATURE": "x" },
        body: raw,
      });
      expect(res.status, `${raw}: ${await res.clone().text()}`).toBe(400);
      expect(claimHeld(key, w), `${raw}: key freed`).toBe(false);
    }
    expect(x402.quoted).toEqual([]);
    expect(x402.settled).toBe(0);
  });
});

describe("#901 round 3: each request is charged its own quote", () => {
  it("a client-sent quote header naming ANOTHER request's live nonce (a cheaper one) is replaced — the request is charged its own price", async () => {
    const cheapWorker = await newAgent();
    await listing(cheapWorker, { web_search: 0.5 }, PAY_TO_T);
    const dearWorker = await newAgent();
    await listing(dearWorker, { web_search: 1.0 }, PAY_TO_W);
    const d = await newAgent();
    const bodyA = { prompt: `901 r3 A ${crypto.randomUUID()}`, submitted_by: d };
    const bodyB = { prompt: `901 r3 B ${crypto.randomUUID()}`, submitted_by: d };
    const payA = await paymentFor(cheapWorker, bodyA);
    const payB = await paymentFor(dearWorker, bodyB);
    let release!: () => void;
    facilitator.verifyBarrier = new Promise<void>((r) => (release = r));

    // A: the cheap request, held inside the facilitator with its quote live.
    // Its nonce is the last UUID the relay minted before A reached verify.
    const minted: string[] = [];
    const realUuid = crypto.randomUUID.bind(crypto);
    const spy = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      const u = realUuid();
      minted.push(u);
      return u;
    });
    const keyA = realUuid();
    const a = relay.app.request(`/agent/${cheapWorker}/task`, {
      method: "POST",
      headers: { ...JSON_AUTH, "Idempotency-Key": keyA, "PAYMENT-SIGNATURE": payA },
      body: JSON.stringify(bodyA),
    });
    await vi.waitFor(() => expect(facilitator.verifyEntered).toBe(1));
    spy.mockRestore();
    const aNonce = minted[minted.length - 1]!;
    expect(aNonce).toBeDefined();

    // B: the dear request, naming A's live nonce as its own quote.
    const b = relay.app.request(`/agent/${dearWorker}/task`, {
      method: "POST",
      headers: {
        ...JSON_AUTH,
        "Idempotency-Key": crypto.randomUUID(),
        "PAYMENT-SIGNATURE": payB,
        "x-motebit-x402-quote": aNonce,
      },
      body: JSON.stringify(bodyB),
    });
    await vi.waitFor(() => expect(facilitator.verifyEntered).toBe(2));
    release();
    await Promise.all([a, b]);
    const G_HALF = toMicro(computeGrossAmount(0.5, PLATFORM_FEE_RATE));
    expect(x402.quoted).toEqual([
      { amount: String(G_HALF), payTo: TREASURY },
      { amount: String(GROSS), payTo: TREASURY },
    ]);
  });

  it("two submissions at different prices, interleaved across the facilitator await: each is charged its own price", async () => {
    const cheapWorker = await newAgent();
    await listing(cheapWorker, { web_search: 0.5 }, PAY_TO_T);
    const dearWorker = await newAgent();
    await listing(dearWorker, { web_search: 1.0 }, PAY_TO_W);
    const d = await newAgent();
    let release!: () => void;
    facilitator.verifyBarrier = new Promise<void>((r) => (release = r));
    const a = submit(
      cheapWorker,
      crypto.randomUUID(),
      { prompt: `901 r3 C1 ${crypto.randomUUID()}`, submitted_by: d },
      { pay: true },
    );
    await vi.waitFor(() => expect(facilitator.verifyEntered).toBe(1));
    const b = submit(
      dearWorker,
      crypto.randomUUID(),
      { prompt: `901 r3 C2 ${crypto.randomUUID()}`, submitted_by: d },
      { pay: true },
    );
    await vi.waitFor(() => expect(facilitator.verifyEntered).toBe(2));
    release(); // both finish verifying only now, A first
    const [resA, resB] = await Promise.all([a, b]);
    // Each is admitted on its own payment (#907: never another request's).
    expect([resA.status, resB.status]).toEqual([201, 201]);
    const G_HALF = toMicro(computeGrossAmount(0.5, PLATFORM_FEE_RATE));
    expect(x402.quoted).toEqual([
      { amount: String(G_HALF), payTo: TREASURY },
      { amount: String(GROSS), payTo: TREASURY },
    ]);
    expect(facilitator.settled.map((x) => x.amount).sort()).toEqual(
      [String(G_HALF), String(GROSS)].sort(),
    );
  });
});

describe("#901 round 3: the gate reads the VERIFIED caller, never a re-parse of the bearer", () => {
  it("relay without apiToken + a forged bearer naming a broken payer: the funded path agent is debited once, x402 never settles (no double charge)", async () => {
    await relay.close();
    relay = await createTestRelay({ enableDeviceAuth: false, apiToken: "" });
    // The listing route needs auth this relay doesn't mount; seed the same
    // priced listing directly (pricedWorker's shape, with a payTo).
    const worker = await newAgent();
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_service_listings (listing_id, motebit_id, capabilities, pricing, description, pay_to_address, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        worker,
        JSON.stringify(["web_search"]),
        JSON.stringify([
          { capability: "web_search", unit_cost: UNIT_COST, currency: "USD", per: "task" },
        ]),
        "901 priced worker",
        "0x00000000000000000000000000000000000000a1",
        Date.now(),
      );
    const forgedPayer = await newAgent(); // broke
    creditAccount(relay.moteDb.db, worker, Math.ceil(GROSS * 1.3), "deposit", null, "901 funded");
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    // motebit token shape: `<base64url payload>.<signature>` — a well-formed
    // payload the gate could read, with a signature nothing verifies.
    const forged = `${b64({
      mid: forgedPayer,
      did: "did:key:forged",
      iat: Date.now(),
      exp: Date.now() + 60_000,
      jti: crypto.randomUUID(),
      aud: "task:submit",
    })}.forged-signature`;
    const prompt = `901 forged bearer ${crypto.randomUUID()}`;
    const res = await relay.app.request(`/agent/${worker}/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${forged}`,
        "Idempotency-Key": crypto.randomUUID(),
        "PAYMENT-SIGNATURE": "not-challenged",
      },
      body: JSON.stringify({ prompt }),
    });
    const tasks = tasksWithPrompt(prompt);
    // Gate and handler agree on the submitter (no verified caller, no
    // submitted_by ⇒ the path agent itself): one reading, so x402 is never
    // asked for a task the handler admits on other terms. The forged bearer's
    // `mid` decides nothing.
    expect(res.status, await res.clone().text()).toBe(201);
    expect(tasks).toHaveLength(1);
    expect(x402.settled, "x402 must not settle: the forged mid is not the payer").toBe(0);
    expect(x402.quoted, "the gate never quoted the forged payer's task").toHaveLength(0);
  });
});
