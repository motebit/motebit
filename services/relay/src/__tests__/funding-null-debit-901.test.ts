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

const x402 = vi.hoisted(() => ({ settled: 0 }));

vi.mock("@x402/hono", () => {
  type SettleHook = (ctx: { result: { transaction: string; network: string } }) => Promise<void>;
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
    constructor(readonly resourceServer: x402ResourceServer) {}
    initialize(): Promise<void> {
      return Promise.resolve();
    }
  }
  function paymentMiddlewareFromHTTPServer(httpServer: x402HTTPResourceServer) {
    return async (
      c: {
        req: { header: (n: string) => string | undefined };
        json: (b: unknown, s: number) => Response;
      },
      next: () => Promise<void>,
    ): Promise<Response | undefined> => {
      if (!c.req.header("X-PAYMENT")) return c.json({ error: "payment_required" }, 402);
      x402.settled += 1;
      let tx = "0x";
      for (let i = 0; i < 64; i++) tx += "0123456789abcdef"[Math.floor(Math.random() * 16)];
      for (const h of httpServer.resourceServer.hooks) {
        await h({ result: { transaction: tx, network: "eip155:84532" } });
      }
      await next();
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
    expect(((await refused.json()) as { code?: string }).code).toBe("INSUFFICIENT_FUNDS");
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
