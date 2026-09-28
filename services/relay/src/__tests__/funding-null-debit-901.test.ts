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
 * The x402 branch of the submit handler reads a tx hash that the real
 * `onAfterSettle` hook sets. `@x402/hono` is replaced here by a stand-in whose
 * middleware runs that hook for a request carrying `X-PAYMENT` and then the
 * handler — so the branch is driven over the live route. Everything after the
 * facilitator (deposit, hold, allocation, admission) is production code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { computeGrossAmount } from "@motebit/market";
import { PLATFORM_FEE_RATE } from "@motebit/protocol";
import { createAgent, createTestRelay, JSON_AUTH, seedBalance } from "./test-helpers.js";
import { creditAccount, getSpendableBalance, toMicro } from "../accounts.js";

/**
 * The facilitator stand-in's state. `ordering`:
 *  - "before": settle, run the settle hook, then the handler — the ordering the
 *    submit handler's x402 branch is written for (it reads the hook's tx hash).
 *  - "after": the REAL `@x402/hono` ordering for `ExactEvmScheme` (eip3009,
 *    the "authorization" flow): run the handler, then settle only when its
 *    response is < 400.
 * `settled` counts onchain settlements; `quoted` records the price and payTo
 * the relay's route config returned for each paid request.
 */
const x402 = vi.hoisted(() => ({
  settled: 0,
  ordering: "before" as "before" | "after",
  quoted: [] as { price: string; payTo: string }[],
}));

vi.mock("@x402/hono", () => {
  type SettleHook = (ctx: { result: { transaction: string; network: string } }) => Promise<void>;
  type Ctx = { adapter: { getHeader(n: string): string | undefined }; path: string };
  type Accepts = { price: (ctx: Ctx) => string; payTo: (ctx: Ctx) => string };
  class x402ResourceServer {
    hooks: SettleHook[] = [];
    register(): this {
      return this;
    }
    onAfterSettle(fn: SettleHook): this {
      this.hooks.push(fn);
      return this;
    }
  }
  class x402HTTPResourceServer {
    constructor(
      readonly resourceServer: x402ResourceServer,
      readonly routes: Record<string, { accepts: Accepts }>,
    ) {}
    initialize(): Promise<void> {
      return Promise.resolve();
    }
  }
  function paymentMiddlewareFromHTTPServer(httpServer: x402HTTPResourceServer) {
    return async (
      c: {
        req: { header: (n: string) => string | undefined; path: string };
        res: Response;
        json: (b: unknown, s: number) => Response;
      },
      next: () => Promise<void>,
    ): Promise<Response | undefined> => {
      const accepts = httpServer.routes["POST /agent/*/task"]!.accepts;
      const ctx: Ctx = { adapter: { getHeader: (n) => c.req.header(n) }, path: c.req.path };
      const quote = { price: accepts.price(ctx), payTo: accepts.payTo(ctx) };
      if (!c.req.header("X-PAYMENT")) return c.json({ error: "payment_required" }, 402);
      x402.quoted.push(quote);
      const settle = async (): Promise<void> => {
        x402.settled += 1;
        let tx = "0x";
        for (let i = 0; i < 64; i++) tx += "0123456789abcdef"[Math.floor(Math.random() * 16)];
        for (const h of httpServer.resourceServer.hooks) {
          await h({ result: { transaction: tx, network: "eip155:84532" } });
        }
      };
      if (x402.ordering === "before") {
        await settle();
        await next();
      } else {
        await next();
        if (c.res.status < 400) await settle();
      }
      return undefined;
    };
  }
  return { x402ResourceServer, x402HTTPResourceServer, paymentMiddlewareFromHTTPServer };
});

const UNIT_COST = 1.0;
const GROSS = toMicro(computeGrossAmount(UNIT_COST, PLATFORM_FEE_RATE));

let relay: SyncRelay;

beforeEach(async () => {
  relay = await createTestRelay({ enableDeviceAuth: false });
  x402.settled = 0;
  x402.ordering = "before";
  x402.quoted = [];
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
  db.prepare(
    `INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, amount_settled, status, settled_at)
     VALUES (?, ?, ?, ?, ?, 'completed', ?)`,
  ).run(
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
    motebitId,
    micro,
    Date.now(),
  );
  if (credit) creditAccount(db, motebitId, micro, "settlement_credit", null, "901 held earnings");
}

const submit = (
  worker: string,
  key: string,
  body: Record<string, unknown>,
  opts: { pay?: boolean } = {},
) =>
  relay.app.request(`/agent/${worker}/task`, {
    method: "POST",
    headers: {
      ...JSON_AUTH,
      "Idempotency-Key": key,
      ...(opts.pay ? { "X-PAYMENT": "stand-in" } : {}),
    },
    body: JSON.stringify(body),
  });

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
    expect(await unpaid.json(), "the x402 gate asks for payment").toEqual({
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

// ── Round 2: the gate and the handler price a submission the same way ──────

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
const dollars = (micro: number) => `$${(micro / 1_000_000).toFixed(6)}`;

describe("#901 round 2: one price for the x402 gate and the handler", () => {
  it("reviewer's cell (real ordering): a pinned self-delegation the account can fund is admitted from the account — the gate never diverts it to x402, so it is never charged twice", async () => {
    x402.ordering = "after";
    const t = await newAgent();
    await listing(t, { web_search: 1.0 }, PAY_TO_T);
    const w = await newAgent();
    // W's own listing sums to $2 — what the gate used to price the path agent at.
    await listing(w, { web_search: 1.0, read_url: 1.0 }, PAY_TO_W);
    // Raw 2.2·G1, spendable 1.1·G1: covers T's $1 capability, not W's $2 sum.
    seedEscrowHold(w, Math.round(1.1 * GROSS), true);
    creditAccount(relay.moteDb.db, w, Math.round(1.1 * GROSS), "deposit", null, "901 r2");
    const spendableBefore = getSpendableBalance(relay.moteDb.db, w);
    const prompt = `901 r2 reviewer ${crypto.randomUUID()}`;
    const body = {
      prompt,
      submitted_by: w,
      target_agent: t,
      required_capabilities: ["web_search"],
    };

    // No X-PAYMENT: a client that can pay from its account never needs one.
    const res = await submit(w, crypto.randomUUID(), body);
    expect(res.status, await res.clone().text()).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };
    expect(x402.settled, "never charged onchain").toBe(0);
    expect(x402.quoted, "never even asked to pay").toEqual([]);
    const allocs = allocationsForTasks([task_id]);
    expect(allocs).toHaveLength(1);
    expect(holdDebited(task_id), "funded once, from the account").toBe(allocs[0]!.amount_locked);
    expect(getSpendableBalance(relay.moteDb.db, w)).toBe(
      spendableBefore - allocs[0]!.amount_locked,
    );
  });

  it("the x402 charge is the handler's price: a pinned capability priced above the path agent's listing is charged at that capability's price, to its agent's payTo (the gate used to ask for the path agent's lower sum)", async () => {
    const t = await newAgent();
    await listing(t, { web_search: 1.0 }, PAY_TO_T);
    const w = await newAgent();
    await listing(w, { web_search: 0.5 }, PAY_TO_W);
    const prompt = `901 r2 undercharge ${crypto.randomUUID()}`;
    const body = {
      prompt,
      submitted_by: w,
      target_agent: t,
      required_capabilities: ["web_search"],
    };

    const res = await submit(w, crypto.randomUUID(), body, { pay: true });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(x402.quoted).toEqual([{ price: dollars(GROSS), payTo: PAY_TO_T }]);
    // What was credited is exactly what was charged.
    const credited = relay.moteDb.db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) AS t FROM relay_transactions WHERE motebit_id = ? AND type = 'deposit' AND reference_id LIKE 'x402-%'",
      )
      .get(w) as { t: number };
    expect(credited.t).toBe(GROSS);
  });

  it("an unparseable body is charged nothing and priced as nothing — the handler rejects it", async () => {
    const worker = await pricedWorker(true);
    const res = await relay.app.request(`/agent/${worker}/task`, {
      method: "POST",
      headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID(), "X-PAYMENT": "x" },
      body: "{not json",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(x402.quoted).toEqual([]);
    expect(x402.settled).toBe(0);
  });

  it("a client-sent quote header is ignored: the gate prices the request itself", async () => {
    const worker = await pricedWorker(true);
    const d = await newAgent();
    const res = await relay.app.request(`/agent/${worker}/task`, {
      method: "POST",
      headers: {
        ...JSON_AUTH,
        "Idempotency-Key": crypto.randomUUID(),
        "X-PAYMENT": "x",
        "x-motebit-x402-quote": "forged",
      },
      body: JSON.stringify({ prompt: `901 r2 forged ${crypto.randomUUID()}`, submitted_by: d }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(x402.quoted).toEqual([
      { price: dollars(GROSS), payTo: "0x00000000000000000000000000000000000000a1" },
    ]);
  });
});

describe("#901 what production does today (real x402 ordering: settle after the handler, only on < 400)", () => {
  it("cell A — raw ≥ price > spendable, paid via x402: refused before any settlement; nothing charged, credited, held or queued", async () => {
    x402.ordering = "after";
    const worker = await pricedWorker(true);
    const delegator = await newAgent();
    seedEscrowHold(delegator, GROSS / 2, false);
    const prompt = `901 real A ${crypto.randomUUID()}`;
    const res = await submit(
      worker,
      crypto.randomUUID(),
      { prompt, submitted_by: delegator },
      { pay: true },
    );
    // The handler sees no tx hash of its own (settlement comes after it), so a
    // cross-agent relay-custody task needs a P2P proof.
    expect(res.status).toBe(402);
    expect(((await res.json()) as { code?: string }).code).toBe("TASK_P2P_PROOF_REQUIRED");
    expect(x402.settled, "a >= 400 response cancels settlement").toBe(0);
    expect(balanceOf(delegator), "nothing credited").toBe(0);
    expect(tasksWithPrompt(prompt)).toEqual([]);
  });

  it("cell D — a fully escrow-held balance, paid via x402: asked to pay, then refused before settlement; nothing charged", async () => {
    x402.ordering = "after";
    const worker = await pricedWorker(true);
    const delegator = await newAgent();
    seedEscrowHold(delegator, 2 * GROSS, true);
    const prompt = `901 real D ${crypto.randomUUID()}`;
    const unpaid = await submit(worker, crypto.randomUUID(), { prompt, submitted_by: delegator });
    expect(unpaid.status).toBe(402);
    expect(await unpaid.json()).toEqual({ error: "payment_required" });
    const paid = await submit(
      worker,
      crypto.randomUUID(),
      { prompt, submitted_by: delegator },
      { pay: true },
    );
    expect(paid.status).toBe(402);
    expect(((await paid.json()) as { code?: string }).code).toBe("TASK_P2P_PROOF_REQUIRED");
    expect(x402.settled).toBe(0);
    expect(balanceOf(delegator)).toBe(2 * GROSS);
    expect(tasksWithPrompt(prompt)).toEqual([]);
  });
});
