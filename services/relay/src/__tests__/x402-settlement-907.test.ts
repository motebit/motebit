/**
 * #907 / #925 — an x402-funded submission is credited with ITS OWN verified
 * settlement, exactly once, to the principal who paid; a same-key replay is
 * never charged.
 *
 * Runs the REAL `@x402/hono` 2.22 stack (`x402ResourceServer`,
 * `x402HTTPResourceServer`, `ExactEvmScheme` — eip3009, whose library
 * middleware settles AFTER the handler). Only the facilitator's network
 * round-trip is replaced (`x402-fake-facilitator.ts`). The client reads the
 * `PAYMENT-REQUIRED` challenge and echoes it signed in `PAYMENT-SIGNATURE`.
 *
 * Before: the relay captured the settle tx hash in an `onAfterSettle` hook into
 * one variable shared by every request, and the handler read it before its own
 * settlement existed. The paying request was refused (so never settled), a paid same-key replay was charged onchain and credited nowhere
 * (#925), and the hash it left was credited to the NEXT submission — another
 * principal's (#907). The x402 payTo was the worker's address while the relay
 * credited the delegator as if it had received the money.
 *
 * The law these tests hold:
 *   1. The gate verifies a payment and binds it to the request; the handler
 *      settles THAT payment once, after every pre-admission refusal, and
 *      credits what the relay treasury received to the delegator the request
 *      names. No request ever reads another's settlement.
 *   2. A request that is refused, replayed or in conflict is charged nothing.
 *   3. A key that already holds a claim is never quoted: replay and conflict
 *      are served by the idempotency layer, not the x402 gate.
 *   4. x402 pays the relay treasury (`x402Config.payToAddress`) — relay
 *      custody — never the worker's `pay_to_address`.
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
import { checkIdempotency } from "../idempotency.js";
import { toMicro } from "../accounts.js";
import {
  facilitator,
  decodeRequired,
  signPayment,
  authorizationOf,
  fakeChainReader,
  tokenOf,
  addressOf,
} from "./x402-fake-facilitator.js";
import {
  selectX402Candidates,
  startX402ReconciliationLoop,
  reconcilePendingX402Settlements,
  classifySettleVerdict,
  readEip3009Authorization,
  parseAtomicAmount,
  creditX402Settlement,
  recordX402Intent,
  markX402Failed,
  type X402ChainReader as X402ChainReaderT,
  DEFINITE_REFUSALS,
  HttpX402ChainReader,
  reconcileX402Settlement,
  findX402Settlement,
  pairedTransfer,
  X402_MAX_VALIDITY_SECONDS,
  X402_MAX_WINDOW_SECONDS,
  X402_SCAN,
  AUTHORIZATION_USED_TOPIC,
  AUTHORIZATION_CANCELED_TOPIC,
  TRANSFER_TOPIC,
} from "../x402-settlements.js";

vi.mock(
  "../x402-facilitator.js",
  async () => (await import("./x402-fake-facilitator.js")).fakeFacilitatorModule,
);

const UNIT_COST = 1.0;
const GROSS = toMicro(computeGrossAmount(UNIT_COST, PLATFORM_FEE_RATE));
const WORKER_PAY_TO = "0x00000000000000000000000000000000000000a1";
const TREASURY = X402_TEST_CONFIG.payToAddress;

let relay: SyncRelay;

beforeEach(async () => {
  facilitator.reset();
  relay = await createTestRelay({ enableDeviceAuth: false });
});
afterEach(async () => {
  await relay.close();
});

async function newAgent(): Promise<string> {
  const kp = await generateKeypair();
  return (await createAgent(relay, bytesToHex(kp.publicKey))).motebitId;
}

/** A $1.00/task agent that publishes a `pay_to_address` (x402-chargeable). */
async function pricedAgent(): Promise<string> {
  const id = await newAgent();
  await relay.app.request(`/api/v1/agents/${id}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: UNIT_COST, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "907 priced agent",
      pay_to_address: WORKER_PAY_TO,
    }),
  });
  return id;
}

const submit = (agent: string, key: string, body: unknown, payment?: string) =>
  relay.app.request(`/agent/${agent}/task`, {
    method: "POST",
    headers: {
      ...JSON_AUTH,
      "Idempotency-Key": key,
      ...(payment != null ? { "PAYMENT-SIGNATURE": payment } : {}),
    },
    body: JSON.stringify(body),
  });

/** Ask for the challenge (under a throwaway key) and sign it as `payer`. */
async function paymentFor(agent: string, body: unknown, payer: string): Promise<string> {
  const res = await submit(agent, crypto.randomUUID(), body);
  expect(res.status, "an unfunded priced submission is challenged").toBe(402);
  const header = res.headers.get("PAYMENT-REQUIRED");
  expect(header, "the challenge carries PAYMENT-REQUIRED").not.toBeNull();
  return signPayment(header!, payer);
}

function x402Deposits(id: string): { amount: number; reference_id: string; description: string }[] {
  return relay.moteDb.db
    .prepare(
      "SELECT amount, reference_id, description FROM relay_transactions WHERE motebit_id = ? AND type = 'deposit' AND reference_id LIKE 'x402-%'",
    )
    .all(id) as { amount: number; reference_id: string; description: string }[];
}
function queued(prompt: string): { task_id: string; task_json: string }[] {
  return relay.moteDb.db
    .prepare("SELECT task_id, task_json FROM relay_task_queue WHERE prompt = ?")
    .all(prompt) as { task_id: string; task_json: string }[];
}
function holdOf(taskId: string): number {
  const row = relay.moteDb.db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) AS t FROM relay_transactions WHERE type = 'allocation_hold' AND reference_id = ?",
    )
    .get(`x402-${taskId}`) as { t: number };
  return -row.t;
}
/** Reconciliation with no wall-clock waits (the two-observation gap and re-check backoff). */
const NOW = {
  scan: { expiryConfirmGapMs: 0, recheckBackoffMs: [0, 0, 0], mismatchRecheckBackoffMs: 0 },
};

function x402Records(): {
  payer: string;
  nonce: string;
  status: string;
  failure_reason: string | null;
  tx_hash: string | null;
  delegator_id: string;
  amount_micro: number;
}[] {
  return relay.moteDb.db
    .prepare("SELECT * FROM relay_x402_settlements ORDER BY created_at")
    .all() as never;
}
function txOf(payer: string): string | undefined {
  return facilitator.settled.find((s) => s.payer === payer)?.tx;
}

describe("#907: the paying request is credited with its own settlement", () => {
  it("a zero-balance self-delegation pays via x402: admitted, credited exactly the price once, under its own tx", async () => {
    const w = await pricedAgent();
    const prompt = `907 own ${crypto.randomUUID()}`;
    const body = { prompt, submitted_by: w };
    const pay = await paymentFor(w, body, "0xW");
    const res = await submit(w, crypto.randomUUID(), body, pay);
    expect(res.status, await res.clone().text()).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };

    expect(facilitator.settled, "settled once, to the relay treasury").toEqual([
      expect.objectContaining({ payer: "0xW", amount: String(GROSS), payTo: TREASURY }),
    ]);
    const tx = txOf("0xW")!;
    expect(x402Deposits(w)).toEqual([
      { amount: GROSS, reference_id: `x402-${task_id}`, description: expect.stringContaining(tx) },
    ]);
    expect(queued(prompt)).toHaveLength(1);
    expect(queued(prompt)[0]!.task_json, "the task records its own payment").toContain(tx);
    expect(holdOf(task_id)).toBe(GROSS);
    // The x402 client reads its settlement from PAYMENT-RESPONSE.
    expect(res.headers.get("PAYMENT-RESPONSE")).not.toBeNull();
  });

  it("two principals paying at once, interleaved across the facilitator await: each is credited its own payment", async () => {
    const p = await pricedAgent();
    const q = await pricedAgent();
    const bodyP = { prompt: `907 P ${crypto.randomUUID()}`, submitted_by: p };
    const bodyQ = { prompt: `907 Q ${crypto.randomUUID()}`, submitted_by: q };
    const payP = await paymentFor(p, bodyP, "0xP");
    const payQ = await paymentFor(q, bodyQ, "0xQ");
    let release!: () => void;
    facilitator.verifyBarrier = new Promise<void>((r) => (release = r));
    const rp = submit(p, crypto.randomUUID(), bodyP, payP);
    await vi.waitFor(() => expect(facilitator.verifyEntered).toBe(1));
    const rq = submit(q, crypto.randomUUID(), bodyQ, payQ);
    await vi.waitFor(() => expect(facilitator.verifyEntered).toBe(2));
    release();
    const [resP, resQ] = await Promise.all([rp, rq]);
    expect([resP.status, resQ.status]).toEqual([201, 201]);

    expect(facilitator.settled).toHaveLength(2);
    for (const [id, payer, prompt] of [
      [p, "0xP", bodyP.prompt],
      [q, "0xQ", bodyQ.prompt],
    ] as const) {
      const deposits = x402Deposits(id);
      expect(deposits, `${payer}: one credit, the price`).toHaveLength(1);
      expect(deposits[0]!.amount).toBe(GROSS);
      expect(deposits[0]!.description, `${payer}: credited its OWN tx`).toContain(txOf(payer)!);
      expect(queued(prompt)[0]!.task_json).toContain(txOf(payer)!);
    }
  });

  it("ONE delegator paying two tasks at once: both admitted, each hold is exactly its own payment (never the other's deposit)", async () => {
    const w1 = await pricedAgent();
    const w2 = await pricedAgent();
    const d = await newAgent();
    const body1 = { prompt: `907 same-d 1 ${crypto.randomUUID()}`, submitted_by: d };
    const body2 = { prompt: `907 same-d 2 ${crypto.randomUUID()}`, submitted_by: d };
    const pay1 = await paymentFor(w1, body1, "0xD1");
    const pay2 = await paymentFor(w2, body2, "0xD2");
    let release!: () => void;
    facilitator.verifyBarrier = new Promise<void>((r) => (release = r));
    const r1 = submit(w1, crypto.randomUUID(), body1, pay1);
    await vi.waitFor(() => expect(facilitator.verifyEntered).toBe(1));
    const r2 = submit(w2, crypto.randomUUID(), body2, pay2);
    await vi.waitFor(() => expect(facilitator.verifyEntered).toBe(2));
    release();
    const [res1, res2] = await Promise.all([r1, r2]);
    expect([res1.status, res2.status], await res2.clone().text()).toEqual([201, 201]);
    const t1 = ((await res1.json()) as { task_id: string }).task_id;
    const t2 = ((await res2.json()) as { task_id: string }).task_id;
    expect([holdOf(t1), holdOf(t2)]).toEqual([GROSS, GROSS]);
    expect(x402Deposits(d).map((x) => x.amount)).toEqual([GROSS, GROSS]);
  });

  it("cross-agent x402 delegation: the delegator is credited and held, the worker's pay_to_address is never paid", async () => {
    const worker = await pricedAgent();
    const delegator = await newAgent();
    const prompt = `907 cross ${crypto.randomUUID()}`;
    const body = { prompt, submitted_by: delegator };
    const pay = await paymentFor(worker, body, "0xD");
    const res = await submit(worker, crypto.randomUUID(), body, pay);
    expect(res.status, await res.clone().text()).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };
    expect(facilitator.settled.map((s) => s.payTo)).toEqual([TREASURY]);
    expect(facilitator.settled.some((s) => s.payTo === WORKER_PAY_TO)).toBe(false);
    expect(x402Deposits(delegator).map((d) => d.amount)).toEqual([GROSS]);
    expect(x402Deposits(worker), "the worker is paid at settlement, not at submission").toEqual([]);
    expect(holdOf(task_id)).toBe(GROSS);
  });
});

describe("#907: a settlement is never read by another request", () => {
  it("after a paid admission and a paid replay, a different principal's account-funded submission is credited nothing and carries no tx", async () => {
    const a = await pricedAgent();
    const bodyA = { prompt: `907 A ${crypto.randomUUID()}`, submitted_by: a };
    const keyA = crypto.randomUUID();
    const payA = await paymentFor(a, bodyA, "0xA");
    expect((await submit(a, keyA, bodyA, payA)).status).toBe(201);
    // The paid replay: on main it settled a SECOND time and left its hash.
    const payA2 = await paymentFor(a, bodyA, "0xA-replay");
    expect((await submit(a, keyA, bodyA, payA2)).status).toBe(201);

    const b = await pricedAgent();
    seedBalance(relay, b, (2 * GROSS) / 1_000_000);
    const promptB = `907 B ${crypto.randomUUID()}`;
    const resB = await submit(b, crypto.randomUUID(), { prompt: promptB, submitted_by: b });
    expect(resB.status, await resB.clone().text()).toBe(201);
    expect(x402Deposits(b), "B paid nothing via x402 and is credited nothing").toEqual([]);
    for (const s of facilitator.settled) {
      expect(queued(promptB)[0]!.task_json, "B's task carries no one's tx").not.toContain(s.tx);
    }
    expect(
      x402Deposits(a).map((d) => d.amount),
      "A credited once, its own",
    ).toEqual([GROSS]);
    expect(
      facilitator.settled.map((s) => s.payer),
      "only A's first payment settled",
    ).toEqual(["0xA"]);
  });
});

describe("#925: replay and conflict are served by the idempotency layer, never charged", () => {
  it("the same key after admission, unpaid: the replay (201, same task) — never a 402 challenge", async () => {
    const w = await pricedAgent();
    seedBalance(relay, w, (1.2 * GROSS) / 1_000_000); // funds exactly the hold
    const body = { prompt: `925 unpaid ${crypto.randomUUID()}`, submitted_by: w };
    const key = crypto.randomUUID();
    const first = await submit(w, key, body);
    expect(first.status).toBe(201);
    const { task_id } = (await first.json()) as { task_id: string };
    const again = await submit(w, key, body);
    expect(again.status, await again.clone().text()).toBe(201);
    expect(((await again.json()) as { task_id: string }).task_id).toBe(task_id);
    expect(facilitator.verified, "never quoted to the facilitator").toEqual([]);
  });

  it("the same key after admission, paid: the replay — settled 0, credited 0, one task", async () => {
    const w = await pricedAgent();
    const prompt = `925 paid ${crypto.randomUUID()}`;
    const body = { prompt, submitted_by: w };
    const key = crypto.randomUUID();
    const pay = await paymentFor(w, body, "0xW1");
    expect((await submit(w, key, body, pay)).status).toBe(201);
    expect(facilitator.settled).toHaveLength(1);

    const pay2 = await paymentFor(w, body, "0xW2");
    const replay = await submit(w, key, body, pay2);
    expect(replay.status).toBe(201);
    expect(facilitator.settled, "the replay is never settled").toHaveLength(1);
    expect(
      facilitator.verified.map((v) => v.payer),
      "the replay's payment is never even verified",
    ).toEqual(["0xW1"]);
    expect(queued(prompt)).toHaveLength(1);
    expect(x402Deposits(w)).toHaveLength(1);
  });

  it("a key whose claim is still processing (conflict): 409, never quoted, never charged", async () => {
    const w = await pricedAgent();
    const key = crypto.randomUUID();
    const body = { prompt: `925 conflict ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xW");
    facilitator.verified = [];
    // Another request with this key is in flight.
    expect(checkIdempotency(relay.moteDb.db, key, w).action).toBe("proceed");
    const res = await submit(w, key, body, pay);
    expect(res.status).toBe(409);
    expect(facilitator.verified).toEqual([]);
    expect(facilitator.settled).toEqual([]);
  });
});

describe("#907: a request the handler refuses is charged nothing", () => {
  it("a verified payment on a submission the handler refuses 400: never settled, nothing credited, key free", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 refusal ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xW");
    const key = crypto.randomUUID();
    const res = await submit(w, key, { ...body, invocation_origin: "bogus" }, pay);
    expect(res.status).toBe(400);
    expect(
      facilitator.verified.map((v) => v.payer),
      "it was verified",
    ).toEqual(["0xW"]);
    expect(facilitator.settled, "and never settled").toEqual([]);
    expect(x402Deposits(w)).toEqual([]);
    expect(queued(body.prompt)).toEqual([]);
    // The key is free: a corrected same-key retry is admitted, charged once.
    const retry = await submit(w, key, body, pay);
    expect(retry.status, await retry.clone().text()).toBe(201);
    expect(facilitator.settled).toHaveLength(1);
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it('a DEFINITE facilitator refusal: 402 TASK_X402_SETTLEMENT_FAILED "nothing was charged" — no task, no credit, no pending record, key free', async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 settle-fail ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xW");
    const key = crypto.randomUUID();
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
    const res = await submit(w, key, body, pay);
    expect(res.status, await res.clone().text()).toBe(402);
    const refusal = (await res.json()) as { code?: string; error?: string };
    expect(refusal.code).toBe("TASK_X402_SETTLEMENT_FAILED");
    expect(refusal.error).toMatch(/nothing has been charged/);
    expect(refusal.error, "does not overclaim: a late execution is credited").toMatch(
      /if it is executed anyway, the payment is credited to account/,
    );
    expect(queued(body.prompt)).toEqual([]);
    expect(x402Deposits(w)).toEqual([]);
    expect(x402Records(), "resolved failed, nothing left pending").toEqual([
      expect.objectContaining({
        status: "failed",
        failure_reason: "invalid_exact_evm_insufficient_balance",
      }),
    ]);
    // The key is free; the refused authorization is spent (never re-presented).
    facilitator.settleMode = "ok";
    const retry = await submit(w, key, body, await paymentFor(w, body, "0xW"));
    expect(retry.status, await retry.clone().text()).toBe(201);
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });
});

describe("#907: funding is decided once, at the gate", () => {
  it("an account funded while the payment is at the facilitator: the bound x402 payment funds the task — one settlement, one hold", async () => {
    const w = await pricedAgent();
    const prompt = `907 once ${crypto.randomUUID()}`;
    const body = { prompt, submitted_by: w };
    const pay = await paymentFor(w, body, "0xW");
    let release!: () => void;
    facilitator.verifyBarrier = new Promise<void>((r) => (release = r));
    const pending = submit(w, crypto.randomUUID(), body, pay);
    await vi.waitFor(() => expect(facilitator.verifyEntered).toBe(1));
    seedBalance(relay, w, (5 * GROSS) / 1_000_000); // a concurrent deposit
    release();
    const res = await pending;
    expect(res.status, await res.clone().text()).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };
    expect(facilitator.settled).toHaveLength(1);
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
    const holds = relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) AS n FROM relay_transactions WHERE type = 'allocation_hold' AND reference_id = ?",
      )
      .get(`x402-${task_id}`) as { n: number };
    expect(holds.n, "one hold").toBe(1);
  });

  it("the challenge names the relay treasury and exactly the quoted gross", async () => {
    const w = await pricedAgent();
    const res = await submit(w, crypto.randomUUID(), { prompt: "907 payto", submitted_by: w });
    expect(res.status).toBe(402);
    const req = decodeRequired(res.headers.get("PAYMENT-REQUIRED")!);
    expect(req.accepts).toHaveLength(1);
    expect(req.accepts[0]).toMatchObject({ payTo: TREASURY, amount: String(GROSS) });
  });
});

describe('#907 round 2: an unknown settle outcome is never reported as "not charged"', () => {
  it('the transfer lands, the settle answer is lost: 402 OUTCOME_UNKNOWN "do not pay again", a pending record; a same-key retry is 409 PENDING and settles nothing; reconciliation credits once; then the same key is funded from the account', async () => {
    const w = await pricedAgent();
    const prompt = `907 r2 unknown ${crypto.randomUUID()}`;
    const body = { prompt, submitted_by: w };
    const key = crypto.randomUUID();
    const pay = await paymentFor(w, body, "0xW");
    facilitator.settleMode = "timeout-after-transfer";
    const res = await submit(w, key, body, pay);
    expect(res.status, await res.clone().text()).toBe(402);
    const unknown = (await res.json()) as {
      code?: string;
      error?: string;
      x402_settlement?: { payer: string; nonce: string; amount_micro: number; delegator: string };
    };
    expect(unknown.code).toBe("TASK_X402_OUTCOME_UNKNOWN");
    expect(unknown.error).toMatch(/Do NOT pay again/);
    expect(unknown.error).not.toMatch(/nothing (was|has been) charged/);
    const auth = authorizationOf(pay);
    expect(unknown.x402_settlement).toMatchObject({
      payer: auth.from.toLowerCase(),
      nonce: auth.nonce.toLowerCase(),
      amount_micro: GROSS,
      delegator: w,
    });
    expect(facilitator.settled, "it landed onchain").toHaveLength(1);
    expect(x402Records()).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(queued(prompt)).toEqual([]);
    expect(x402Deposits(w)).toEqual([]);

    // The client retries as told NOT to — same key, a fresh payment: nothing settles.
    const settleCalls = facilitator.settleCalls;
    facilitator.settleMode = "ok";
    const retry = await submit(w, key, body, await paymentFor(w, body, "0xW-again"));
    expect(retry.status, await retry.clone().text()).toBe(409);
    expect(((await retry.json()) as { code?: string }).code).toBe("TASK_X402_OUTCOME_PENDING");
    expect(facilitator.settleCalls, "no second settle").toBe(settleCalls);

    // Reconciliation reads the chain: used ⇒ credited, once.
    const reader = fakeChainReader();
    expect(await reconcilePendingX402Settlements(relay.moteDb.db, reader)).toMatchObject({
      credited: 1,
    });
    expect(x402Records()[0]!.tx_hash, "the reconciled credit records the execution's tx").toBe(
      facilitator.settled[0]!.tx,
    );
    expect(await reconcilePendingX402Settlements(relay.moteDb.db, reader)).toMatchObject({
      credited: 0,
      stillPending: 0,
    });
    expect(
      x402Deposits(w).map((d) => d.amount),
      "credited exactly once",
    ).toEqual([GROSS]);
    expect(x402Records()).toEqual([expect.objectContaining({ status: "credited" })]);

    // The same key now proceeds, funded from the credited account — never charged again.
    const funded = await submit(w, key, body);
    expect(funded.status, await funded.clone().text()).toBe(201);
    expect(facilitator.settled, "still one onchain charge").toHaveLength(1);
    expect(queued(prompt)).toHaveLength(1);
  });

  it('a refusal reason outside the closed set (a post-submission failure\'s message) is UNKNOWN, never "not charged"', async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r2 odd ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { refuse: "execution reverted: nonce already used" };
    const res = await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xW"));
    expect(res.status).toBe(402);
    expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_OUTCOME_UNKNOWN");
    expect(x402Records()).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it("an unexecuted authorization past validBefore (by the CHAIN's clock) is resolved failed; before it, or on a read error, it stays pending", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r2 expire ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { refuse: "some facilitator 5xx text" };
    await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xW"));
    expect(x402Records()).toEqual([expect.objectContaining({ status: "pending" })]);
    const rec = x402Records()[0]! as unknown as { valid_before: number };
    facilitator.chainTime = rec.valid_before + 10_000;
    const failedRun = await reconcilePendingX402Settlements(
      relay.moteDb.db,
      fakeChainReader({ failing: true }),
    );
    expect(failedRun.errors).toBeGreaterThan(0);
    expect(failedRun.failed).toBe(0);
    expect(x402Records()).toEqual([expect.objectContaining({ status: "pending" })]);
    facilitator.chainTime = rec.valid_before - 1;
    expect(await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader())).toMatchObject(
      { stillPending: 1 },
    );
    facilitator.chainTime = rec.valid_before + 10_000;
    // One observation is not an expiry: the first run only records it…
    expect(
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW),
    ).toMatchObject({ failed: 0, stillPending: 1 });
    expect(x402Records()).toEqual([expect.objectContaining({ status: "pending" })]);
    // …a second, agreeing, full rescan declares it.
    expect(
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW),
    ).toMatchObject({ failed: 1 });
    expect(x402Records()).toEqual([
      expect.objectContaining({ status: "failed", failure_reason: "authorization_expired_unused" }),
    ]);
    expect(x402Deposits(w)).toEqual([]);
  });

  it("the same signed payload on a NEW key is refused 409 REPLAYED — never settled or credited twice, even by a facilitator that would settle it again", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r2 replay ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xW");
    expect((await submit(w, crypto.randomUUID(), body, pay)).status).toBe(201);
    const again = await submit(
      w,
      crypto.randomUUID(),
      { ...body, prompt: `${body.prompt} 2` },
      pay,
    );
    expect(again.status, await again.clone().text()).toBe(409);
    expect(((await again.json()) as { code?: string }).code).toBe("TASK_X402_PAYMENT_REPLAYED");
    expect(facilitator.settled).toHaveLength(1);
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("two requests carrying the same payload at once: exactly one settles", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r2 race ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xW");
    let release!: () => void;
    facilitator.verifyBarrier = new Promise<void>((r) => (release = r));
    const a = submit(w, crypto.randomUUID(), body, pay);
    const b = submit(w, crypto.randomUUID(), { ...body, prompt: `${body.prompt} b` }, pay);
    await vi.waitFor(() => expect(facilitator.verifyEntered).toBe(2));
    release();
    const statuses = (await Promise.all([a, b])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(facilitator.settled).toHaveLength(1);
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("a crash between the pending write and the settle answer: the next reconciliation run credits it once", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r2 crash ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xW");
    facilitator.settleMode = "hang";
    // The request never returns — the process "dies" here.
    void submit(w, crypto.randomUUID(), body, pay);
    await vi.waitFor(() => expect(facilitator.settleCalls).toBe(1));
    expect(x402Records(), "the intent was durable before the call").toEqual([
      expect.objectContaining({ status: "pending" }),
    ]);
    // The facilitator did submit it (it lands on chain later).
    const auth = authorizationOf(pay);
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    expect(await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader())).toMatchObject(
      { credited: 1 },
    );
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });
});

describe("#907 round 2: the settling request and the reconciler credit a payment once between them", () => {
  it("the reconciler credits a landed authorization while its settle answer is still in flight: the request then admits the task on that credit — one deposit, one hold", async () => {
    const w = await pricedAgent();
    const prompt = `907 r2 credit-race ${crypto.randomUUID()}`;
    const body = { prompt, submitted_by: w };
    const pay = await paymentFor(w, body, "0xW");
    let answer!: () => void;
    facilitator.settleAnswerBarrier = new Promise<void>((r) => (answer = r));
    const pending = submit(w, crypto.randomUUID(), body, pay);
    await vi.waitFor(() => expect(facilitator.settled).toHaveLength(1));
    expect(await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader())).toMatchObject(
      { credited: 1 },
    );
    answer();
    const res = await pending;
    expect(res.status, await res.clone().text()).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };
    expect(
      x402Deposits(w).map((d) => d.amount),
      "credited once",
    ).toEqual([GROSS]);
    expect(holdOf(task_id)).toBe(GROSS);
  });
});

describe("#907 round 2: the handler settles only the payment verified for THIS submission", () => {
  it("the listing's price changes while the payment is at the facilitator: 409 TASK_X402_PAYMENT_UNBOUND, nothing settled", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r2 reprice ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xW");
    let release!: () => void;
    facilitator.verifyBarrier = new Promise<void>((r) => (release = r));
    const pending = submit(w, crypto.randomUUID(), body, pay);
    await vi.waitFor(() => expect(facilitator.verifyEntered).toBe(1));
    await relay.app.request(`/api/v1/agents/${w}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "907 repriced",
        pay_to_address: WORKER_PAY_TO,
      }),
    });
    release();
    const res = await pending;
    expect(res.status, await res.clone().text()).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_PAYMENT_UNBOUND");
    expect(facilitator.settleCalls).toBe(0);
    expect(queued(body.prompt)).toEqual([]);
  });
});

describe("#907 round 3: reconciliation credits only on PROOF OF EXECUTION", () => {
  /** A request left pending: the settle answer is lost before anything happens onchain. */
  async function pendingPayment(label: string) {
    const w = await pricedAgent();
    const body = { prompt: `907 r3 ${label} ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, `0x${label}`);
    facilitator.settleMode = { refuse: "Facilitator settle failed (502): upstream" };
    const res = await submit(w, crypto.randomUUID(), body, pay);
    expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_OUTCOME_UNKNOWN");
    facilitator.settleMode = "ok";
    return { w, pay, auth: authorizationOf(pay), token: tokenOf(pay) };
  }

  it("the payer CANCELS the authorization (the state bit is set, nothing moved): never credited, failed `authorization_cancelled`", async () => {
    const { w, auth } = await pendingPayment("cancel");
    facilitator.chainCancel(auth.from, auth.nonce);
    expect(facilitator.authorizationStateBit(auth.from, auth.nonce), "the bit reads 'used'").toBe(
      true,
    );
    expect(await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader())).toMatchObject(
      { credited: 0, failed: 1 },
    );
    expect(x402Deposits(w), "no free credit").toEqual([]);
    expect(x402Records()).toEqual([
      expect.objectContaining({ status: "failed", failure_reason: "authorization_cancelled" }),
    ]);
    // A cancellation is decided from an event: never re-checked into a credit.
    facilitator.chainTime = Math.floor(Date.now() / 1000) + 100_000;
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader());
    expect(x402Deposits(w)).toEqual([]);
  });

  it("the reviewer's race: cancel between verify and settle — settle fails `nonce_already_used` (UNKNOWN), reconciliation never credits", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r3 race-cancel ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xAttacker");
    const auth = authorizationOf(pay);
    let release!: () => void;
    facilitator.verifyBarrier = new Promise<void>((r) => (release = r));
    const pending = submit(w, crypto.randomUUID(), body, pay);
    await vi.waitFor(() => expect(facilitator.verifyEntered).toBe(1));
    facilitator.chainCancel(auth.from, auth.nonce);
    release();
    const res = await pending;
    expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_OUTCOME_UNKNOWN");
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader());
    expect(facilitator.settled, "0 transfers").toEqual([]);
    expect(x402Deposits(w), "credited nothing").toEqual([]);
    expect(queued(body.prompt)).toEqual([]);
  });

  it("a used authorization with the matching Transfer: credited once, with that execution's tx hash", async () => {
    const { w, auth, token } = await pendingPayment("used");
    const tx = facilitator.chainExecute({
      token,
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    expect(await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader())).toMatchObject(
      { credited: 1 },
    );
    expect(await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader())).toMatchObject(
      { credited: 0 },
    );
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
    expect(x402Records()).toEqual([expect.objectContaining({ status: "credited", tx_hash: tx })]);
  });

  it("a used authorization whose Transfer amount or recipient does not match: not credited, failed `execution_mismatch` for the operator", async () => {
    for (const bad of ["amount", "recipient", "token"] as const) {
      facilitator.reset();
      const { w, auth, token } = await pendingPayment(`mismatch-${bad}`);
      facilitator.chainExecute({
        token: bad === "token" ? "0x00000000000000000000000000000000000000ee" : token,
        from: auth.from,
        nonce: auth.nonce,
        to: bad === "recipient" ? "0x00000000000000000000000000000000000000dd" : auth.to,
        value: bad === "amount" ? BigInt(auth.value) - 1n : BigInt(auth.value),
      });
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader());
      expect(x402Deposits(w), bad).toEqual([]);
      const rec = x402Records().find((x) => x.delegator_id === w)!;
      // Another token's log is not this authorization's (eth_getLogs filters
      // by the token address): nothing is seen, so nothing is decided.
      expect(rec, bad).toMatchObject(
        bad === "token"
          ? { status: "pending" }
          : { status: "failed", failure_reason: "execution_mismatch" },
      );
    }
  });

  it("the scan is bounded and paged: an execution far past the first page is found, the cursor persists, and nothing is read past the confirmed head", async () => {
    const { w, auth, token } = await pendingPayment("paged");
    // A signed window opening 5 h back: the scan starts ~9 000 blocks back, several pages.
    relay.moteDb.db
      .prepare("UPDATE relay_x402_settlements SET valid_after = valid_after - ?")
      .run(5 * 3_600);
    facilitator.chainExecute({
      token,
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    const reader = fakeChainReader();
    const calls: { fromBlock: number; toBlock: number }[] = [];
    const orig = reader.getAuthorizationEvents.bind(reader);
    reader.getAuthorizationEvents = (args) => {
      calls.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
      return orig(args);
    };
    expect(await reconcilePendingX402Settlements(relay.moteDb.db, reader)).toMatchObject({
      credited: 1,
    });
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.toBlock - c.fromBlock + 1).toBeLessThanOrEqual(2_000);
      expect(c.toBlock).toBeLessThanOrEqual(facilitator.head);
    }
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("the lagging-reader cell: a lagging read marks the record expired, the settle's late success is refused UNKNOWN (never admitted on other funds), and the one re-check credits it from the execution log", async () => {
    const w3 = await pricedAgent();
    const body3 = { prompt: `907 r3 lag ${crypto.randomUUID()}`, submitted_by: w3 };
    const payment = await paymentFor(w3, body3, "0xLag");
    let answer!: () => void;
    facilitator.settleAnswerBarrier = new Promise<void>((r) => (answer = r));
    const pending = submit(w3, crypto.randomUUID(), body3, payment);
    await vi.waitFor(() => expect(facilitator.settled).toHaveLength(1));
    // Meanwhile other funds land (the task must NOT use them) and a lagging
    // read declares the authorization expired.
    seedBalance(relay, w3, (5 * GROSS) / 1_000_000);
    const rec = x402Records().find((x) => x.delegator_id === w3)! as unknown as {
      valid_before: number;
    };
    facilitator.chainTime = rec.valid_before + 10_000;
    // Two lagging reads (the worst case two-observation expiry admits).
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader({ lagging: true }), NOW);
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader({ lagging: true }), NOW);
    expect(x402Records().find((x) => x.delegator_id === w3)).toMatchObject({
      status: "failed",
      failure_reason: "authorization_expired_unused",
    });
    answer();
    const res = await pending;
    expect(res.status, await res.clone().text()).toBe(402);
    expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_OUTCOME_UNKNOWN");
    expect(queued(body3.prompt), "not admitted on the account's other funds").toEqual([]);
    expect(x402Deposits(w3)).toEqual([]);
    // The re-check reads the execution and credits it, once.
    expect(
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW),
    ).toMatchObject({ credited: 1 });
    expect(
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW),
    ).toMatchObject({ credited: 0 });
    expect(x402Deposits(w3).map((d) => d.amount)).toEqual([GROSS]);
    expect(x402Records().find((x) => x.delegator_id === w3)).toMatchObject({
      status: "credited",
      tx_hash: facilitator.settled[0]!.tx,
    });
  });
});

describe("#907 round 3: laws pinned", () => {
  it("T3: the library's `invalid_exact_evm_nonce_already_used` is NOT a definite refusal — UNKNOWN, record pending", async () => {
    expect(DEFINITE_REFUSALS.has("invalid_exact_evm_nonce_already_used")).toBe(false);
    const w = await pricedAgent();
    const body = { prompt: `907 T3 ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { refuse: "invalid_exact_evm_nonce_already_used" };
    const res = await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xW"));
    expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_OUTCOME_UNKNOWN");
    expect(x402Records()).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it('T11: a definite-reason refusal that carries a transaction hash is UNKNOWN, never "not charged"', async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 T11 ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance", tx: true };
    const res = await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xW"));
    const out = (await res.json()) as { code?: string; error?: string };
    expect(out.code).toBe("TASK_X402_OUTCOME_UNKNOWN");
    expect(out.error).not.toMatch(/nothing (was|has been) charged/);
  });

  it("T5: a success on another network is UNKNOWN, not credited", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 T5 ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { network: "eip155:1" };
    const res = await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xW"));
    expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_OUTCOME_UNKNOWN");
    expect(x402Deposits(w)).toEqual([]);
  });

  it("a success reporting a different amount is UNKNOWN; the credited amount is only ever the authorization's", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 amt ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { amount: String(GROSS * 10) };
    const res = await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xW"));
    expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_OUTCOME_UNKNOWN");
    expect(x402Deposits(w)).toEqual([]);
    // Reconciled from the execution: the authorization's value, never 10×.
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader());
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("T14: an authorization whose value is not exactly the quoted gross is refused before settling (the facilitator honours the signed value)", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 T14 ${crypto.randomUUID()}`, submitted_by: w };
    const res0 = await submit(w, crypto.randomUUID(), body);
    const header = res0.headers.get("PAYMENT-REQUIRED")!;
    for (const value of [String(GROSS - 1), "1", String(GROSS + 1)]) {
      const res = await submit(
        w,
        crypto.randomUUID(),
        body,
        signPayment(header, "0xCheap", { value }),
      );
      expect(res.status, value).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_PAYMENT_UNBOUND");
    }
    expect(facilitator.settleCalls).toBe(0);
    expect(x402Deposits(w)).toEqual([]);
  });

  it("T12: a record with a non-positive amount is never written or credited", () => {
    const db = relay.moteDb.db;
    const base = {
      payer: "0x" + "a".repeat(40),
      nonce: "0x" + "b".repeat(64),
      network: "eip155:84532",
      token: "0x" + "c".repeat(40),
      pay_to: "0x" + "d".repeat(40),
      valid_after: 0,
      valid_before: 1,
      idempotency_key: "k",
      motebit_id: "m",
      delegator_id: "d",
      task_id: "t",
    };
    expect(() => recordX402Intent(db, { ...base, amount_micro: 0 })).toThrow(/non-positive/);
    db.prepare(
      `INSERT INTO relay_x402_settlements (payer, nonce, network, token, pay_to, amount_micro, valid_after, valid_before, idempotency_key, motebit_id, delegator_id, task_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 1, 'k', 'm', 'd', 't', 'pending', 0)`,
    ).run(base.payer, base.nonce, base.network, base.token, base.pay_to);
    expect(() =>
      creditX402Settlement(db, base.payer, base.nonce, {
        txHash: null,
        description: "x",
        from: "pending",
      }),
    ).toThrow(/non-positive/);
    expect(x402Deposits("d")).toEqual([]);
  });
});

describe("#907 round 3: pure laws", () => {
  const expected = { network: "eip155:84532", amountMicro: 1_052_632 };
  it("classifySettleVerdict", () => {
    const tx = "0x" + "1".repeat(64);
    expect(
      classifySettleVerdict(
        { success: true, transaction: tx, network: expected.network },
        expected,
      ),
    ).toEqual({ kind: "settled", txHash: tx, network: expected.network });
    expect(
      classifySettleVerdict({ success: true, transaction: "", network: expected.network }, expected)
        .kind,
    ).toBe("unknown");
    expect(
      classifySettleVerdict({ success: true, transaction: tx, network: "eip155:1" }, expected).kind,
    ).toBe("unknown");
    for (const amount of [
      "0",
      "1052631",
      "0x10",
      "-1052632",
      "1052632.0",
      "1e6",
      "01052632",
      1_052_632,
    ]) {
      expect(
        classifySettleVerdict(
          { success: true, transaction: tx, network: expected.network, amount },
          expected,
        ).kind,
        String(amount),
      ).toBe("unknown");
    }
    expect(
      classifySettleVerdict(
        { success: true, transaction: tx, network: expected.network, amount: "1052632" },
        expected,
      ).kind,
    ).toBe("settled");
    expect(
      classifySettleVerdict(
        { success: false, errorReason: "invalid_exact_evm_signature" },
        expected,
      ),
    ).toEqual({ kind: "refused", reason: "invalid_exact_evm_signature" });
    expect(
      classifySettleVerdict(
        { success: false, errorReason: "invalid_exact_evm_signature", transaction: tx },
        expected,
      ).kind,
    ).toBe("unknown");
    for (const reason of [
      "invalid_exact_evm_nonce_already_used",
      "invalid_exact_evm_transaction_failed",
      "invalid_exact_evm_transfer_event_mismatch",
      "",
      "Timed out",
    ]) {
      expect(
        classifySettleVerdict({ success: false, errorReason: reason }, expected).kind,
        reason,
      ).toBe("unknown");
    }
  });

  it("readEip3009Authorization and parseAtomicAmount", () => {
    const ok = {
      from: "0x" + "A".repeat(40),
      to: "0x" + "b".repeat(40),
      value: "1052632",
      validAfter: "0",
      validBefore: "1790000000",
      nonce: "0x" + "C".repeat(64),
    };
    expect(readEip3009Authorization({ authorization: ok })).toEqual({
      payer: "0x" + "a".repeat(40),
      nonce: "0x" + "c".repeat(64),
      to: "0x" + "b".repeat(40),
      value: "1052632",
      validAfter: 0,
      validBefore: 1790000000,
    });
    for (const bad of [
      { validAfter: 0 },
      { validAfter: "-5" },
      { validAfter: undefined },
      { value: "0x10" },
      { value: "-1" },
      { value: "1.5" },
      { value: "1e6" },
      { value: 1052632 },
      { value: "01" },
      { validBefore: 1790000000 },
      { validBefore: "soon" },
      { from: "0x12" },
      { nonce: "0x" + "c".repeat(63) },
    ]) {
      expect(
        readEip3009Authorization({ authorization: { ...ok, ...bad } }),
        JSON.stringify(bad),
      ).toBeNull();
    }
    expect(readEip3009Authorization(null)).toBeNull();
    expect(readEip3009Authorization({})).toBeNull();
    expect(parseAtomicAmount("0")).toBe(0);
    expect(parseAtomicAmount("9007199254740993")).toBeNull();
  });
});

describe("#907 round 3: operator door", () => {
  it("lists pending and failed records (master token only) and resolves ONE by proof of execution — never a blind credit", async () => {
    await relay.close();
    relay = await createTestRelay({ enableDeviceAuth: false, x402ChainReader: fakeChainReader() });
    const w = await pricedAgent();
    const body = { prompt: `907 op ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xOp");
    facilitator.settleMode = { refuse: "upstream 502" };
    await submit(w, crypto.randomUUID(), body, pay);
    const noAuth = await relay.app.request("/api/v1/admin/x402-settlements");
    expect(noAuth.status).toBe(401);
    const list = await relay.app.request("/api/v1/admin/x402-settlements?status=pending", {
      headers: JSON_AUTH,
    });
    expect(list.status).toBe(200);
    const { settlements } = (await list.json()) as {
      settlements: { payer: string; nonce: string; status: string }[];
    };
    expect(settlements).toHaveLength(1);
    const { payer, nonce } = settlements[0]!;
    const resolve = () =>
      relay.app.request(`/api/v1/admin/x402-settlements/${payer}/${nonce}/resolve`, {
        method: "POST",
        headers: JSON_AUTH,
      });
    // Nothing on chain: the resolve does not credit.
    expect(((await (await resolve()).json()) as { decision: string }).decision).toBe(
      "authorization_still_valid",
    );
    expect(x402Deposits(w)).toEqual([]);
    // A cancellation on chain: resolved failed, still no credit.
    const auth = authorizationOf(pay);
    facilitator.chainCancel(auth.from, auth.nonce);
    expect(((await (await resolve()).json()) as { decision: string }).decision).toBe("cancelled");
    expect(x402Deposits(w)).toEqual([]);
  });

  it("X402_RPC_URL_<NETWORK> overrides the default RPC", async () => {
    const { x402RpcUrlFor } = await import("../x402-settlements.js");
    const defaults = { "eip155:8453": "https://mainnet.base.org" };
    expect(x402RpcUrlFor("eip155:8453", defaults, {})).toBe("https://mainnet.base.org");
    expect(
      x402RpcUrlFor("eip155:8453", defaults, { X402_RPC_URL_EIP155_8453: "https://my.rpc" }),
    ).toBe("https://my.rpc");
    expect(x402RpcUrlFor("eip155:1", defaults, {})).toBeUndefined();
  });
});

describe("#907 round 4: one authorization, ITS OWN Transfer — never a shared one", () => {
  /** N pending records for one payer (race path: settle answered `nonce_already_used`). */
  async function pendingRecords(n: number, path: "race" | "refusal") {
    const w = await pricedAgent();
    const payer = "0xBatcher";
    const records: { pay: string; auth: ReturnType<typeof authorizationOf> }[] = [];
    for (let i = 0; i < n; i++) {
      const body = { prompt: `907 r4 batch ${path} ${i} ${crypto.randomUUID()}`, submitted_by: w };
      const pay = await paymentFor(w, body, payer);
      facilitator.settleMode =
        path === "race"
          ? { refuse: "invalid_exact_evm_nonce_already_used" }
          : { refuse: "invalid_exact_evm_insufficient_balance" };
      await submit(w, crypto.randomUUID(), body, pay);
      records.push({ pay, auth: authorizationOf(pay) });
    }
    facilitator.settleMode = "ok";
    return { w, payer: addressOf(payer), records, token: tokenOf(records[0]!.pay) };
  }

  for (const path of ["race", "refusal"] as const) {
    it(`the batch attack (${path} path): N nonces burned to self for 1, plus ONE Transfer of the gross to the treasury ⇒ credited nothing`, async () => {
      const { w, payer, records, token } = await pendingRecords(3, path);
      const treasury = records[0]!.auth.to;
      facilitator.chainBatch(token, [
        ...records.map((r) => ({
          kind: "execute" as const,
          from: payer,
          nonce: r.auth.nonce,
          to: payer, // an authorization to SELF, same nonce, value 1
          value: 1n,
        })),
        { kind: "transfer" as const, from: payer, to: treasury, value: BigInt(GROSS) },
      ]);
      const rec0 = x402Records()[0]! as unknown as { valid_before: number };
      facilitator.chainTime = rec0.valid_before + 10_000;
      for (let i = 0; i < 4; i++) {
        await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
      }
      expect(x402Deposits(w), "never 2× or 3× — nothing").toEqual([]);
      for (const rec of x402Records()) {
        // The mismatch is recorded as the latest observation; a refusal keeps
        // its original failure class (#907 round 11).
        expect(rec).toMatchObject({ status: "failed", last_observation: "execution_mismatch" });
        expect(rec.failure_reason).toBe(
          path === "race" ? "execution_mismatch" : "invalid_exact_evm_insufficient_balance",
        );
      }
    });
  }

  it("a legitimate batch — each authorization executed with its own Transfer to the treasury — credits each once", async () => {
    const { w, payer, records, token } = await pendingRecords(2, "race");
    facilitator.chainBatch(
      token,
      records.map((r) => ({
        kind: "execute" as const,
        from: payer,
        nonce: r.auth.nonce,
        to: r.auth.to,
        value: BigInt(r.auth.value),
      })),
    );
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS, GROSS]);
    const consumed = x402Records().map(
      (r) => (r as unknown as { credit_log_index: number }).credit_log_index,
    );
    expect(new Set(consumed).size, "two distinct Transfer logs consumed").toBe(2);
  });

  it("a forged second Used log beside a Transfer: each authorization pairs only with the log right after ITS OWN Used log", async () => {
    const { w, payer, records, token } = await pendingRecords(2, "race");
    const tx = facilitator.chainExecute({
      token,
      from: payer,
      nonce: records[0]!.auth.nonce,
      to: records[0]!.auth.to,
      value: BigInt(GROSS),
    });
    // A second Used log for the other nonce, forged into the SAME transaction
    // right before the same Transfer (an impossible chain; a wrong pairing).
    const used0 = facilitator.events.find((e) => e.txHash === tx)!;
    facilitator.events.push({
      ...used0,
      nonce: records[1]!.auth.nonce.toLowerCase(),
    });
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
    expect(
      x402Deposits(w).map((d) => d.amount),
      "credited once",
    ).toEqual([GROSS]);
    expect(x402Records().filter((r) => r.status === "credited")).toHaveLength(1);
    // The forged Used log has no Transfer of its own: sticky evidence, never a credit.
    expect(x402Records().filter((r) => r.status !== "credited")).toEqual([
      expect.objectContaining({ status: "pending", used_state: "unpaired" }),
    ]);
  });

  it("pairedTransfer takes the receipt's NEXT log after this authorization's Used log, from the same token only", () => {
    const tok = "0x" + "aa".repeat(20);
    const payer = "0x" + "01".repeat(20);
    const nonce = "0x" + "0e".repeat(32);
    const pad32 = (a: string) => "0x" + a.slice(2).padStart(64, "0");
    const used = (n = nonce) => ({
      address: tok,
      topics: [AUTHORIZATION_USED_TOPIC, pad32(payer), n],
      data: "0x",
    });
    const xfer = (to: string, v: bigint, address = tok) => ({
      address,
      topics: [TRANSFER_TOPIC, pad32(payer), pad32(to)],
      data: "0x" + v.toString(16).padStart(64, "0"),
    });
    const T = "0x" + "fe".repeat(20);
    const auth = { token: tok.toUpperCase().replace("0X", "0x"), authorizer: payer, nonce };
    expect(pairedTransfer([xfer(T, 9n), used(), xfer(T, 5n)], auth)).toEqual({
      position: 2,
      from: payer,
      to: T,
      value: 5n,
    });
    // Not the transfer before it, nor one after an intervening log, nor another token's.
    expect(pairedTransfer([xfer(T, 5n), used()], auth)).toBeUndefined();
    expect(
      pairedTransfer([used(), used("0x" + "11".repeat(32)), xfer(T, 5n)], auth),
    ).toBeUndefined();
    expect(pairedTransfer([used(), xfer(T, 5n, "0x" + "bb".repeat(20))], auth)).toBeUndefined();
  });

  it("the consumed-transfer marker is UNIQUE: a second record can never be credited on the same (tx, log)", () => {
    const db = relay.moteDb.db;
    const mk = (n: string) => ({
      payer: "0x" + "a".repeat(40),
      nonce: "0x" + n.repeat(64),
      network: "eip155:84532",
      token: "0x" + "c".repeat(40),
      pay_to: "0x" + "d".repeat(40),
      amount_micro: 5,
      valid_after: 0,
      valid_before: 1,
      idempotency_key: "k" + n,
      motebit_id: "m",
      delegator_id: "marker-delegator",
      task_id: "t" + n,
    });
    recordX402Intent(db, mk("1"));
    recordX402Intent(db, mk("2"));
    const tx = "0x" + "e".repeat(64);
    const credit = (n: string) =>
      creditX402Settlement(db, mk(n).payer, mk(n).nonce, {
        txHash: tx,
        creditLogIndex: 3,
        description: "x",
        from: "pending",
      });
    expect(credit("1")).toBe(true);
    expect(() => credit("2")).toThrow(/UNIQUE/i);
    expect(x402Deposits("marker-delegator").map((d) => d.amount)).toEqual([5]);
  });
});

describe("#907 round 4: expiry needs a complete scan and two agreeing observations", () => {
  it("a scan capped before the head (execution past the cursor) is never an expiry; the next runs find it and credit", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r4 capped ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xCapped");
    facilitator.settleMode = { refuse: "upstream 502" };
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const auth = authorizationOf(pay);
    // A signed window opening 6 h back: ~10 800 blocks to scan, one 2 000-block page per run.
    relay.moteDb.db
      .prepare("UPDATE relay_x402_settlements SET valid_after = valid_after - ?")
      .run(6 * 3_600);
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    const rec = x402Records()[0]! as unknown as { valid_before: number };
    facilitator.chainTime = rec.valid_before + 10_000;
    const capped = { scan: { ...NOW.scan, maxPagesPerRun: 1 } };
    for (let i = 0; i < 3; i++) {
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), capped);
      expect(x402Records()[0]!.status, `run ${i}: never expired mid-scan`).toBe("pending");
    }
    for (let i = 0; i < 6 && x402Records()[0]!.status === "pending"; i++) {
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), capped);
    }
    expect(x402Records()[0]).toMatchObject({ status: "credited" });
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("one lagging read never expires a record: the confirming rescan finds the execution and credits", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r4 onelag ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xOneLag");
    facilitator.settleMode = { refuse: "upstream 502" };
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const auth = authorizationOf(pay);
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    const rec = x402Records()[0]! as unknown as { valid_before: number };
    facilitator.chainTime = rec.valid_before + 10_000;
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader({ lagging: true }), NOW);
    expect(x402Records()[0]!.status, "one lagging observation is not an expiry").toBe("pending");
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
    expect(x402Records()[0]).toMatchObject({ status: "credited" });
  });

  it("the two observations must be separated in time", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r4 gap ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { refuse: "upstream 502" };
    await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xGap"));
    const rec = x402Records()[0]! as unknown as { valid_before: number };
    facilitator.chainTime = rec.valid_before + 10_000;
    const gap = { scan: { ...NOW.scan, expiryConfirmGapMs: 60 * 60_000 } };
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), gap);
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), gap);
    expect(x402Records()[0]!.status, "back-to-back runs do not agree yet").toBe("pending");
    // The gap is CHAIN time (round 10): the head moves on by more than an hour.
    facilitator.chainTime += 2 * 60 * 60;
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), gap);
    expect(x402Records()[0]).toMatchObject({
      status: "failed",
      failure_reason: "authorization_expired_unused",
    });
  });

  it("a failed record is re-checked up to three times with backoff: two lagging re-checks, the third finds the execution", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r4 recheck ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xRecheck");
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" }; // failed at once
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const auth = authorizationOf(pay);
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    const rec = x402Records()[0]! as unknown as { valid_before: number };
    facilitator.chainTime = rec.valid_before + 10_000;
    const backoff = { scan: { ...NOW.scan, recheckBackoffMs: [0, 0, 60 * 60_000] } };
    await reconcilePendingX402Settlements(
      relay.moteDb.db,
      fakeChainReader({ lagging: true }),
      backoff,
    );
    await reconcilePendingX402Settlements(
      relay.moteDb.db,
      fakeChainReader({ lagging: true }),
      backoff,
    );
    expect(x402Records()[0]).toMatchObject({ status: "failed", recheck_count: 2 });
    // Backoff honoured: the third re-check waits an hour.
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), backoff);
    expect(x402Records()[0]!.status).toBe("failed");
    facilitator.chainTime += 60 * 60 + 2; // an hour of CHAIN time (round 10)
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), backoff);
    expect(x402Records()[0]).toMatchObject({ status: "credited" });
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("after three spent re-checks the record is left to the operator", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r4 spent ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
    await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xSpent"));
    const rec = x402Records()[0]! as unknown as { valid_before: number };
    facilitator.chainTime = rec.valid_before + 10_000;
    const reader = fakeChainReader({ lagging: true });
    for (let i = 0; i < 5; i++) {
      await reconcilePendingX402Settlements(relay.moteDb.db, reader, NOW);
    }
    expect(x402Records()[0]).toMatchObject({ status: "failed", recheck_count: 3 });
  });
});

describe("#907 round 4: validBefore is bounded at the gate", () => {
  it(`an authorization valid for more than ${X402_MAX_VALIDITY_SECONDS} s is refused before settling`, async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r4 vb ${crypto.randomUUID()}`, submitted_by: w };
    const res0 = await submit(w, crypto.randomUUID(), body);
    const header = res0.headers.get("PAYMENT-REQUIRED")!;
    const now = Math.floor(Date.now() / 1000);
    const far = await submit(
      w,
      crypto.randomUUID(),
      body,
      signPayment(header, "0xFar", { validBefore: now + X402_MAX_VALIDITY_SECONDS + 60 }),
    );
    expect(far.status).toBe(400);
    expect(((await far.json()) as { code?: string }).code).toBe("TASK_X402_PAYMENT_UNBOUND");
    expect(facilitator.settleCalls).toBe(0);
    const near = await submit(
      w,
      crypto.randomUUID(),
      body,
      signPayment(header, "0xNear", { validBefore: now + X402_MAX_VALIDITY_SECONDS - 60 }),
    );
    expect(near.status, await near.clone().text()).toBe(201);
  });
});

// ── The production reader, over fixtures shaped like Base Sepolia JSON-RPC ──

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC (checksummed)
const PAYER = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const TREASURY_CS = "0x00000000000000000000000000000000000000Fe";
const NONCE = "0x" + "9f".repeat(32);
const TX = "0x" + "ab".repeat(32);
const pad = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const hex = (n: number | bigint) => "0x" + n.toString(16);

interface RpcFixture {
  latest: number;
  logs: Record<string, unknown>[];
  receipts: Record<string, Record<string, unknown>>;
}
function rpcStub(f: RpcFixture) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetchFn = (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    const { method, params } = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    calls.push({ method, params });
    let result: unknown;
    if (method === "eth_blockNumber") result = hex(f.latest);
    else if (method === "eth_getBlockByNumber") {
      const n = Number.parseInt(String(params[0]), 16);
      result = {
        number: hex(n),
        hash: "0x" + "11".repeat(32),
        timestamp: hex(1_790_000_000 + n * 2),
        transactions: [],
      };
    } else if (method === "eth_getLogs") {
      // A node that honours only the block range — the reader must re-check the rest.
      const q = params[0] as { fromBlock: string; toBlock: string };
      const lo = Number.parseInt(q.fromBlock, 16);
      const hi = Number.parseInt(q.toBlock, 16);
      result = f.logs.filter((l) => {
        const b = Number.parseInt(String(l["blockNumber"]), 16);
        return b >= lo && b <= hi;
      });
    } else if (method === "eth_getTransactionReceipt") {
      result = f.receipts[String(params[0])] ?? null;
    }
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { fetchFn: fetchFn as unknown as typeof globalThis.fetch, calls };
}
function usedLog(block: number, logIndex: number, extra: Record<string, unknown> = {}) {
  return {
    address: USDC,
    topics: [AUTHORIZATION_USED_TOPIC, pad(PAYER), NONCE],
    data: "0x",
    blockNumber: hex(block),
    blockHash: "0x" + "22".repeat(32),
    transactionHash: TX,
    transactionIndex: "0x3",
    logIndex: hex(logIndex),
    removed: false,
    ...extra,
  };
}
function transferLog(
  logIndex: number,
  to: string,
  value: bigint,
  extra: Record<string, unknown> = {},
) {
  return {
    address: USDC,
    topics: [TRANSFER_TOPIC, pad(PAYER), pad(to)],
    data: "0x" + value.toString(16).padStart(64, "0"),
    blockNumber: hex(990),
    transactionHash: TX,
    logIndex: hex(logIndex),
    removed: false,
    ...extra,
  };
}
function receipt(status: string, logs: Record<string, unknown>[]) {
  return {
    transactionHash: TX,
    blockNumber: hex(990),
    status,
    from: PAYER,
    to: USDC,
    gasUsed: "0x1d4c0",
    logs,
  };
}

describe("#907 round 4: HttpX402ChainReader over JSON-RPC fixtures", () => {
  it("decodes a Used log: lowercased hash, numbers from hex, logIndex", async () => {
    const { fetchFn } = rpcStub({ latest: 1_000, logs: [usedLog(990, 0x2a)], receipts: {} });
    const r = new HttpX402ChainReader("https://rpc.example", 12, fetchFn);
    expect(await r.getConfirmedHead()).toEqual({ number: 988, timestamp: 1_790_000_000 + 988 * 2 });
    const ev = await r.getAuthorizationEvents({
      token: USDC,
      authorizer: PAYER.toLowerCase(),
      nonce: NONCE,
      fromBlock: 900,
      toBlock: 995,
    });
    expect(ev).toEqual([{ kind: "used", txHash: TX, blockNumber: 990, logIndex: 42 }]);
  });

  it("ignores `removed: true`, another contract's log, another nonce, and an unknown topic", async () => {
    const { fetchFn } = rpcStub({
      latest: 1_000,
      logs: [
        usedLog(990, 1, { removed: true }),
        usedLog(990, 2, { address: "0x0000000000000000000000000000000000000bad" }),
        usedLog(990, 3, { topics: [AUTHORIZATION_USED_TOPIC, pad(PAYER), "0x" + "00".repeat(32)] }),
        usedLog(990, 4, { topics: ["0x" + "de".repeat(32), pad(PAYER), NONCE] }),
        usedLog(990, 5, { topics: [AUTHORIZATION_CANCELED_TOPIC, pad(PAYER), NONCE] }),
      ],
      receipts: {},
    });
    const r = new HttpX402ChainReader("https://rpc.example", 12, fetchFn);
    const ev = await r.getAuthorizationEvents({
      token: USDC.toLowerCase(),
      authorizer: PAYER.toLowerCase(),
      nonce: NONCE,
      fromBlock: 900,
      toBlock: 995,
    });
    expect(ev).toEqual([{ kind: "canceled", txHash: TX, blockNumber: 990, logIndex: 5 }]);
  });

  it("reads receipt logs in receipt order, lowercased; a failed receipt or a removed log proves nothing; pairing decodes values past 32 bits", async () => {
    const big = 2n ** 40n + 5n;
    const logs = [usedLog(990, 7), transferLog(8, TREASURY_CS, big)];
    const ok = rpcStub({ latest: 1_000, logs: [], receipts: { [TX]: receipt("0x1", logs) } });
    const r = new HttpX402ChainReader("https://rpc.example", 12, ok.fetchFn);
    const got = await r.getReceiptLogs(TX);
    expect(got.map((l) => l.address)).toEqual([USDC.toLowerCase(), USDC.toLowerCase()]);
    expect(
      pairedTransfer(got, { token: USDC, authorizer: PAYER.toLowerCase(), nonce: NONCE }),
    ).toEqual({
      position: 1,
      from: PAYER.toLowerCase(),
      to: TREASURY_CS.toLowerCase(),
      value: big,
    });
    const bad = rpcStub({ latest: 1_000, logs: [], receipts: { [TX]: receipt("0x0", logs) } });
    expect(
      await new HttpX402ChainReader("https://rpc.example", 12, bad.fetchFn).getReceiptLogs(TX),
    ).toEqual([]);
    const removed = rpcStub({
      latest: 1_000,
      logs: [],
      receipts: {
        [TX]: receipt("0x1", [
          usedLog(990, 7),
          transferLog(8, TREASURY_CS, big, { removed: true }),
        ]),
      },
    });
    expect(
      await new HttpX402ChainReader("https://rpc.example", 12, removed.fetchFn).getReceiptLogs(TX),
    ).toEqual([]);
  });

  /** A record reconciled end to end through the HTTP reader. */
  async function reconcileOverFixture(fx: RpcFixture, scan: object = {}, validBeforeBlock = 950) {
    const db = relay.moteDb.db;
    // Created well after the fixture's genesis; expired by the fixture's clock.
    recordX402Intent(db, {
      payer: PAYER.toLowerCase(),
      nonce: NONCE,
      network: "eip155:84532",
      token: USDC.toLowerCase(),
      pay_to: TREASURY_CS.toLowerCase(),
      amount_micro: 1_052_632,
      valid_after: 1_790_000_000 + 600 * 2,
      valid_before: 1_790_000_000 + validBeforeBlock * 2,
      idempotency_key: "k",
      motebit_id: "m",
      delegator_id: "fixture-delegator",
      task_id: "t",
    });
    const stub = rpcStub(fx);
    const reader = new HttpX402ChainReader("https://rpc.example", 12, stub.fetchFn);
    for (let i = 0; i < 3; i++) {
      await reconcilePendingX402Settlements(db, reader, { scan: { ...NOW.scan, ...scan } });
    }
    return { rec: findX402Settlement(db, PAYER, NONCE)!, calls: stub.calls };
  }

  it("end to end: the paired Transfer credits once, recording the tx and the consumed log", async () => {
    const logs = [usedLog(980, 7), transferLog(8, TREASURY_CS, 1_052_632n)];
    const { rec } = await reconcileOverFixture({
      latest: 1_000,
      logs: [logs[0]!],
      receipts: { [TX]: receipt("0x1", logs) },
    });
    // The consumed marker is the Transfer's position in the receipt (one source).
    expect(rec).toMatchObject({ status: "credited", tx_hash: TX, credit_log_index: 1 });
    expect(x402Deposits("fixture-delegator").map((d) => d.amount)).toEqual([1_052_632]);
  });

  it("a reverted receipt (status 0x0) is not proof", async () => {
    const logs = [usedLog(980, 7), transferLog(8, TREASURY_CS, 1_052_632n)];
    const { rec } = await reconcileOverFixture({
      latest: 1_000,
      logs: [logs[0]!],
      receipts: { [TX]: receipt("0x0", logs) },
    });
    expect(rec.status).not.toBe("credited");
    expect(x402Deposits("fixture-delegator")).toEqual([]);
  });

  it("a Used log above the confirmed head is not seen", async () => {
    // latest 1 000, depth 12 ⇒ confirmed head 988; the execution is at 995.
    const logs = [usedLog(995, 7), transferLog(8, TREASURY_CS, 1_052_632n)];
    const { rec, calls } = await reconcileOverFixture({
      latest: 1_000,
      logs: [logs[0]!],
      receipts: { [TX]: receipt("0x1", logs) },
    });
    expect(rec.status).not.toBe("credited");
    for (const c of calls.filter((c) => c.method === "eth_getLogs")) {
      expect(Number.parseInt((c.params[0] as { toBlock: string }).toBlock, 16)).toBeLessThanOrEqual(
        988,
      );
    }
  });

  it("paging: every eth_getLogs range is at most pageBlocks and never past the confirmed head", async () => {
    const logs = [usedLog(9_000, 7), transferLog(8, TREASURY_CS, 1_052_632n)];
    const { rec, calls } = await reconcileOverFixture(
      { latest: 10_000, logs: [logs[0]!], receipts: { [TX]: receipt("0x1", logs) } },
      { pageBlocks: 500 },
      9_500, // still valid when the execution at 9 000 lands
    );
    const ranges = calls
      .filter((c) => c.method === "eth_getLogs")
      .map((c) => c.params[0] as { fromBlock: string; toBlock: string })
      .map((q) => [Number.parseInt(q.fromBlock, 16), Number.parseInt(q.toBlock, 16)] as const);
    expect(ranges.length).toBeGreaterThan(1);
    for (const [lo, hi] of ranges) {
      expect(hi - lo + 1).toBeLessThanOrEqual(500);
      expect(hi).toBeLessThanOrEqual(10_000 - 12);
    }
    expect(rec.status).toBe("credited");
  });

  it("reconcileX402Settlement is exported for the operator door and uses the same rules", () => {
    expect(typeof reconcileX402Settlement).toBe("function");
  });
});

describe("#907 round 5", () => {
  /** A pending payment (the settle answer lost before anything moved). */
  async function lostAnswer(label: string, settleMode: typeof facilitator.settleMode) {
    const w = await pricedAgent();
    const body = { prompt: `907 r5 ${label} ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, `0x${label}`);
    facilitator.settleMode = settleMode;
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const auth = authorizationOf(pay);
    const execute = () =>
      facilitator.chainExecute({
        token: tokenOf(pay),
        from: auth.from,
        nonce: auth.nonce,
        to: auth.to,
        value: BigInt(auth.value),
      });
    const rec = () =>
      x402Records().find((x) => x.delegator_id === w)! as unknown as {
        status: string;
        valid_before: number;
        recheck_count: number;
        next_recheck_at: number | null;
        failure_reason: string | null;
      };
    return { w, pay, auth, execute, rec };
  }

  it("a record first reconciled 80 h after it was created (long freeze, outage, late reader) is still found and credited", async () => {
    const { w, execute, rec } = await lostAnswer("late80h", { refuse: "upstream 502" });
    // The execution happened at creation time; the chain then ran on for 80 h
    // before the reconciler first looked (a freeze, an outage, a late reader).
    execute();
    facilitator.chainTime = Math.floor(Date.now() / 1000) + 80 * 3_600;
    for (let i = 0; i < 6 && rec().status === "pending"; i++) {
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
    }
    expect(rec().status).toBe("credited");
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
    const start = (
      relay.moteDb.db.prepare("SELECT scan_from_block FROM relay_x402_settlements").get() as {
        scan_from_block: number;
      }
    ).scan_from_block;
    expect(start, "the scan starts before the execution").toBeLessThanOrEqual(
      facilitator.events[0]!.blockNumber,
    );
  });

  it("before validBefore: neither the loop nor operator resolves spend a failed record's re-checks, nothing is expired early, and the loop credits once it can", async () => {
    const { w, execute, rec } = await lostAnswer("early", {
      refuse: "invalid_exact_evm_insufficient_balance",
    });
    expect(rec().status).toBe("failed");
    facilitator.chainTime = rec().valid_before - 60; // still valid by chain time
    for (let i = 0; i < 3; i++) {
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
      const full = findX402Settlement(
        relay.moteDb.db,
        x402Records()[0]!.payer,
        x402Records()[0]!.nonce,
      )!;
      expect(
        await reconcileX402Settlement(relay.moteDb.db, fakeChainReader(), full, undefined, {
          operator: true,
        }),
      ).toBe("authorization_still_valid");
    }
    expect(rec()).toMatchObject({ status: "failed", recheck_count: 0 });
    execute(); // inside validity
    facilitator.chainTime = rec().valid_before + 10_000;
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
    expect(rec().status).toBe("credited");
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("an operator resolve before validBefore never expires a PENDING record", async () => {
    const { rec } = await lostAnswer("oppending", { refuse: "upstream 502" });
    facilitator.chainTime = rec().valid_before - 60;
    for (let i = 0; i < 3; i++) {
      const full = findX402Settlement(
        relay.moteDb.db,
        x402Records()[0]!.payer,
        x402Records()[0]!.nonce,
      )!;
      expect(
        await reconcileX402Settlement(
          relay.moteDb.db,
          fakeChainReader(),
          full,
          { ...X402_SCAN, ...NOW.scan },
          {
            operator: true,
          },
        ),
      ).toBe("authorization_still_valid");
    }
    expect(rec().status).toBe("pending");
  });

  it("re-check schedule is 10 min / 1 h / 6 h of CHAIN time, the first counted from the head the failure was first seen under", async () => {
    const { rec } = await lostAnswer("sched", { refuse: "invalid_exact_evm_insufficient_balance" });
    facilitator.chainTime = rec().valid_before + 10_000;
    const run = () => reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader());
    const chain = () =>
      rec() as unknown as {
        recheck_count: number;
        resolved_head_ts: number | null;
        next_recheck_head_ts: number | null;
      };
    await run();
    // The request path had no chain time; the reconciler stamped the head it saw.
    const failedAt = chain().resolved_head_ts!;
    expect(failedAt).toBe(facilitator.chainTime);
    expect(chain().recheck_count, "not before 10 min").toBe(0);
    facilitator.chainTime = failedAt + 9 * 60;
    await run();
    expect(chain().recheck_count, "still not at 9 min").toBe(0);
    facilitator.chainTime = failedAt + 10 * 60;
    const t1 = facilitator.chainTime;
    await run();
    expect(chain().recheck_count).toBe(1);
    expect(chain().next_recheck_head_ts).toBe(t1 + 60 * 60);
    facilitator.chainTime = t1 + 60 * 60 - 2;
    await run();
    expect(chain().recheck_count, "waits the hour").toBe(1);
    facilitator.chainTime = t1 + 60 * 60;
    const t2 = facilitator.chainTime;
    await run();
    expect(chain().recheck_count).toBe(2);
    expect(chain().next_recheck_head_ts).toBe(t2 + 6 * 60 * 60);
    facilitator.chainTime = t2 + 6 * 60 * 60;
    const t3 = facilitator.chainTime;
    await run();
    // Every spend leaves a chain-time wait, the last one too (round 11).
    expect(chain()).toMatchObject({ recheck_count: 3, next_recheck_head_ts: t3 + 6 * 60 * 60 });
    await run();
    expect(chain().recheck_count, "no fourth").toBe(3);
  });

  it("the gate refuses an authorization that pays anyone but the treasury, even when the facilitator would settle it (the fake honours the signed recipient)", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r5 to ${crypto.randomUUID()}`, submitted_by: w };
    const res0 = await submit(w, crypto.randomUUID(), body);
    const header = res0.headers.get("PAYMENT-REQUIRED")!;
    const elsewhere = "0x00000000000000000000000000000000000000e1";
    const res = await submit(
      w,
      crypto.randomUUID(),
      body,
      signPayment(header, "0xElsewhere", { to: elsewhere }),
    );
    expect(res.status, await res.clone().text()).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_PAYMENT_UNBOUND");
    expect(facilitator.settleCalls).toBe(0);
    expect(x402Deposits(w)).toEqual([]);
  });

  it("a node quirk that drops the Transfer log leaves the record STICKY (Used seen, unpaired); the re-read credits", async () => {
    const { w, execute, rec } = await lostAnswer("quirk", { refuse: "upstream 502" });
    execute();
    facilitator.chainTime = rec().valid_before + 10_000;
    const reader = fakeChainReader({ receiptQuirkOnce: true });
    await reconcilePendingX402Settlements(relay.moteDb.db, reader, NOW);
    expect(rec()).toMatchObject({ status: "pending", used_state: "unpaired" });
    // A node that lags on logs AND drops the Transfer: evidence stays, nothing
    // is spent, nothing expires — a no-event read after a Used is lagging.
    for (let i = 0; i < 4; i++) {
      facilitator.chainTime += 7 * 3_600;
      await reconcilePendingX402Settlements(
        relay.moteDb.db,
        fakeChainReader({ lagging: true, receiptQuirkOnce: true }),
        NOW,
      );
    }
    expect(rec() as unknown as Record<string, unknown>).toMatchObject({
      status: "pending",
      used_state: "unpaired",
      expiry_observed_head_ts: null,
      recheck_count: 0,
    });
    await reconcilePendingX402Settlements(relay.moteDb.db, reader, NOW);
    expect(rec().status).toBe("credited");
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("a genuine mismatch is re-checked only once", async () => {
    const { w, auth, pay, rec } = await lostAnswer("genuine", { refuse: "upstream 502" });
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.from,
      value: 1n,
    });
    facilitator.chainTime = rec().valid_before + 10_000;
    for (let i = 0; i < 4; i++) {
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
    }
    expect(rec()).toMatchObject({
      status: "failed",
      failure_reason: "execution_mismatch",
      mismatch_rechecks: 1,
    });
    expect(x402Deposits(w)).toEqual([]);
  });

  it("HTTP reader: a node with TX-SCOPED receipt logIndex (vs block-scoped getLogs) still pairs and credits", async () => {
    const db = relay.moteDb.db;
    recordX402Intent(db, {
      payer: PAYER.toLowerCase(),
      nonce: NONCE,
      network: "eip155:84532",
      token: USDC.toLowerCase(),
      pay_to: TREASURY_CS.toLowerCase(),
      amount_micro: 1_052_632,
      valid_after: 1_790_000_000 + 600 * 2,
      valid_before: 1_790_000_000 + 950 * 2,
      idempotency_key: "k",
      motebit_id: "m",
      delegator_id: "txscoped-delegator",
      task_id: "t",
    });
    const stub = rpcStub({
      latest: 1_000,
      logs: [usedLog(980, 0x2a)], // block-scoped index 42
      receipts: {
        // the same tx's receipt, with tx-scoped indexes 0 and 1
        [TX]: receipt("0x1", [usedLog(980, 0), transferLog(1, TREASURY_CS, 1_052_632n)]),
      },
    });
    const reader = new HttpX402ChainReader("https://rpc.example", 12, stub.fetchFn);
    await reconcilePendingX402Settlements(db, reader, NOW);
    expect(findX402Settlement(db, PAYER, NONCE)).toMatchObject({ status: "credited" });
    expect(x402Deposits("txscoped-delegator").map((d) => d.amount)).toEqual([1_052_632]);
  });
});

describe("#907 round 6: a reconciler outage never strands records", () => {
  it("a pending record first reconciled 80 h late (no execution) resolves failed-unused within a bounded number of runs — the scan ends at a fixed block, not the moving head", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r6 late-unused ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { refuse: "upstream 502" };
    await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xLateUnused"));
    facilitator.settleMode = "ok";
    facilitator.chainTime = Math.floor(Date.now() / 1000) + 80 * 3_600; // 144 000 blocks on
    for (let i = 0; i < 4 && x402Records()[0]!.status === "pending"; i++) {
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
      facilitator.head += 500; // the head keeps moving between runs
    }
    expect(x402Records()[0]).toMatchObject({
      status: "failed",
      failure_reason: "authorization_expired_unused",
    });
    const rec = x402Records()[0]! as unknown as { scan_end_block: number; valid_before: number };
    expect(facilitator.genesis + 2 * rec.scan_end_block).toBeGreaterThan(rec.valid_before + 120);
    expect(facilitator.genesis + 2 * (rec.scan_end_block - 1)).toBeLessThanOrEqual(
      rec.valid_before + 120,
    );
  });

  it("100 long-pending records never starve a fresh executed one: records are visited least-recently-checked first", async () => {
    const db = relay.moteDb.db;
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 100; i++) {
      recordX402Intent(db, {
        payer: "0x" + (i + 1).toString(16).padStart(40, "0"),
        nonce: "0x" + (i + 1).toString(16).padStart(64, "0"),
        network: "eip155:84532",
        token: "0x" + "c".repeat(40),
        pay_to: "0x" + "d".repeat(40),
        amount_micro: 1,
        valid_after: now - 600,
        valid_before: now + 3_000, // still valid: legitimately pending
        idempotency_key: `stuck-${i}`,
        motebit_id: "m",
        delegator_id: "stuck",
        task_id: `stuck-${i}`,
      });
    }
    db.prepare("UPDATE relay_x402_settlements SET created_at = created_at - 3600000").run();
    const w = await pricedAgent();
    const body = { prompt: `907 r6 fresh ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xFresh");
    facilitator.settleMode = "timeout-after-transfer"; // executed, answer lost
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    for (let i = 0; i < 3; i++) {
      await reconcilePendingX402Settlements(db, fakeChainReader(), NOW);
    }
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("a range longer than one run's page budget advances across runs, for the ordinary pass AND the confirming full pass, then expires", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r6 long ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { refuse: "upstream 502" };
    await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xLong"));
    facilitator.settleMode = "ok";
    // Created 6 h ago: ~11 000 blocks to scan; one 2 000-block page per run.
    relay.moteDb.db
      .prepare("UPDATE relay_x402_settlements SET valid_after = valid_after - ?")
      .run(6 * 3_600);
    const rec0 = x402Records()[0]! as unknown as { valid_before: number };
    facilitator.chainTime = rec0.valid_before + 10_000;
    const capped = { scan: { ...NOW.scan, maxPagesPerRun: 1 } };
    let runs = 0;
    while (x402Records()[0]!.status === "pending" && runs < 30) {
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), capped);
      runs += 1;
    }
    expect(x402Records()[0]).toMatchObject({
      status: "failed",
      failure_reason: "authorization_expired_unused",
    });
    expect(runs, "two passes of ~6 pages each, not one run").toBeGreaterThan(8);
    expect(runs).toBeLessThanOrEqual(16);
  });

  it("a Transfer that pairs by position but comes from ANOTHER address is refused", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r6 from ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xFromGuard");
    facilitator.settleMode = { refuse: "upstream 502" };
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const auth = authorizationOf(pay);
    const tx = facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    facilitator.transfers.get(tx)![0]!.from = "0x00000000000000000000000000000000000000ab";
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
    expect(x402Deposits(w)).toEqual([]);
    expect(x402Records()[0]).toMatchObject({
      status: "failed",
      failure_reason: "execution_mismatch",
    });
  });
});

describe("#907 round 6: operator resolves after validBefore never spend the budget either", () => {
  it("three concluded operator resolves past validBefore leave all three automatic re-checks, and the loop still credits", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r6 opafter ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xOpAfter");
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    // The payment executes inside its validity window (the facilitator's
    // refusal was wrong), then the chain passes validBefore.
    const auth = authorizationOf(pay);
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    const r0 = x402Records()[0]! as unknown as { valid_before: number };
    facilitator.chainTime = r0.valid_before + 10_000;
    for (let i = 0; i < 3; i++) {
      const full = findX402Settlement(
        relay.moteDb.db,
        x402Records()[0]!.payer,
        x402Records()[0]!.nonce,
      )!;
      await reconcileX402Settlement(
        relay.moteDb.db,
        fakeChainReader({ lagging: true }),
        full,
        undefined,
        { operator: true },
      );
    }
    expect(x402Records()[0]).toMatchObject({ status: "failed", recheck_count: 0 });
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
    expect(x402Records()[0]!.status).toBe("credited");
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });
});

describe("#907 round 7", () => {
  const recOf = (w: string) =>
    x402Records().find((x) => x.delegator_id === w)! as unknown as {
      status: string;
      valid_before: number;
      recheck_count: number;
      pass_cursor: number | null;
      failure_reason: string | null;
    };

  it("100 still-valid refused records never starve a re-check: eligibility is in SQL before the LIMIT (the reviewer's N=100 cell)", async () => {
    const db = relay.moteDb.db;
    // The victim: its payment executed, but its record was marked expired.
    const w = await pricedAgent();
    const body = { prompt: `907 r7 victim ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xVictim");
    facilitator.settleMode = "timeout-after-transfer";
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    facilitator.chainTime = recOf(w).valid_before + 1_000;
    const lag = fakeChainReader({ lagging: true });
    await reconcilePendingX402Settlements(db, lag, NOW);
    await reconcilePendingX402Settlements(db, lag, NOW);
    expect(recOf(w)).toMatchObject({
      status: "failed",
      failure_reason: "authorization_expired_unused",
    });
    // The attack: 100 cheap definite refusals, validBefore = now + 3 500 s —
    // still valid by chain time, older, never checked.
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 100; i++) {
      recordX402Intent(db, {
        payer: "0x" + (i + 1).toString(16).padStart(40, "0"),
        nonce: "0x" + (i + 7).toString(16).padStart(64, "0"),
        network: "eip155:84532",
        token: "0x" + "c".repeat(40),
        pay_to: "0x" + "d".repeat(40),
        amount_micro: 1,
        valid_after: now - 600,
        valid_before: now + 3_500,
        idempotency_key: `attack-${i}`,
        motebit_id: "m",
        delegator_id: "attacker",
        task_id: `attack-${i}`,
      });
    }
    db.prepare(
      "UPDATE relay_x402_settlements SET status = 'failed', failure_reason = 'invalid_exact_evm_insufficient_balance', resolved_at = 0, resolved_head_ts = 0, created_at = 0 WHERE delegator_id = 'attacker'",
    ).run();
    // ONLY the SQL chain-time clause can put the victim in the first run's
    // selection: the 100 refusals are older and never checked, so with the
    // clause missing they fill the LIMIT ahead of it.
    const selected = selectX402Candidates(
      db,
      facilitator.chainTime,
      { ...X402_SCAN, ...NOW.scan },
      100,
    ).failed.map((x) => x.delegator_id);
    expect(selected, "the victim is selected in the first run").toContain(w);
    expect(
      selected.filter((d) => d === "attacker"),
      "no still-valid row holds a slot",
    ).toEqual([]);
    for (let i = 0; i < 3 && recOf(w).status !== "credited"; i++) {
      await reconcilePendingX402Settlements(db, fakeChainReader(), NOW);
    }
    expect(recOf(w).status).toBe("credited");
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("overlapping runs: a slow run's stale pass cursor is a no-op, so the next re-check still scans the whole range and credits (the reviewer's cell)", async () => {
    const db = relay.moteDb.db;
    const w = await pricedAgent();
    const body = { prompt: `907 r7 overlap ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xOverlap");
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const auth = authorizationOf(pay);
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    facilitator.chainTime = recOf(w).valid_before + 10_000;
    const scan = { scan: { ...NOW.scan, pageBlocks: 500 } };
    // Run A: a slow, lagging reader that stalls on its first page.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fakeChainReader({ lagging: true });
    const origEvents = slow.getAuthorizationEvents.bind(slow);
    let first = true;
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    slow.getAuthorizationEvents = async (a) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return origEvents(a);
    };
    const runA = reconcilePendingX402Settlements(db, slow, scan);
    await inside;
    // Run B: concludes the pass (lagging), spending one re-check.
    await reconcilePendingX402Settlements(db, fakeChainReader({ lagging: true }), scan);
    expect(recOf(w)).toMatchObject({ recheck_count: 1, pass_cursor: null });
    release();
    await runA;
    expect(recOf(w).pass_cursor, "the slow run wrote nothing").toBeNull();
    expect(recOf(w).recheck_count, "and spent nothing").toBe(1);
    // Run C: an honest reader scans from the start and finds the execution.
    await reconcilePendingX402Settlements(db, fakeChainReader(), scan);
    expect(recOf(w).status).toBe("credited");
  });

  it("single-flight: loop ticks that fire while a run is in flight are skipped", async () => {
    let active = 0;
    let maxActive = 0;
    const reader = fakeChainReader();
    const orig = reader.getConfirmedHead.bind(reader);
    reader.getConfirmedHead = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 60));
      active -= 1;
      return orig();
    };
    const t = startX402ReconciliationLoop({ db: relay.moteDb.db, reader, intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 250));
    clearInterval(t);
    await new Promise((r) => setTimeout(r, 80));
    expect(maxActive).toBe(1);
  });

  it("a re-check is spent only when its pass concludes, not on each run of a pass spanning several runs", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r7 spend ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
    await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xSpend"));
    facilitator.settleMode = "ok";
    relay.moteDb.db
      .prepare("UPDATE relay_x402_settlements SET valid_after = valid_after - ?")
      .run(6 * 3_600);
    facilitator.chainTime = recOf(w).valid_before + 10_000;
    const capped = { scan: { ...NOW.scan, maxPagesPerRun: 1 } };
    let runs = 0;
    while (recOf(w).recheck_count === 0 && runs < 20) {
      await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), capped);
      runs += 1;
    }
    expect(runs, "the pass took several runs, none of which spent it").toBeGreaterThan(3);
    expect(recOf(w).recheck_count).toBe(1);
  });

  it("an RPC that caps eth_getLogs ranges: the page halves instead of a permanent read error", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r7 cap ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xCap");
    facilitator.settleMode = "timeout-after-transfer";
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const reader = fakeChainReader();
    const orig = reader.getAuthorizationEvents.bind(reader);
    const ranges: number[] = [];
    reader.getAuthorizationEvents = (a) => {
      if (a.toBlock - a.fromBlock + 1 > 300) {
        return Promise.reject(new Error("query exceeds max block range 300"));
      }
      ranges.push(a.toBlock - a.fromBlock + 1);
      return orig(a);
    };
    await reconcilePendingX402Settlements(relay.moteDb.db, reader, NOW);
    expect(recOf(w).status).toBe("credited");
    expect(Math.max(...ranges)).toBeLessThanOrEqual(300);
  });
});

describe("#907 rounds 8–9: queue selection is FIFO/LRU with a provable bounded wait", () => {
  const LIMIT = 5;
  const db = () => relay.moteDb.db;
  let seq = 0;
  /** The module's two entry points — swapped for a freshly imported copy to model a restart. */
  type Mod = Pick<
    typeof import("../x402-settlements.js"),
    "recordX402Intent" | "reconcilePendingX402Settlements"
  >;
  const here: Mod = { recordX402Intent, reconcilePendingX402Settlements };
  /** A record inserted directly; `kind` decides which queue it lands in. */
  function seed(
    kind: "pending" | "failed",
    createdAt: number | null,
    tag: string,
    mod: Mod = here,
  ): string {
    seq += 1;
    const now = Math.floor(Date.now() / 1000);
    const payer = "0x" + seq.toString(16).padStart(40, "0");
    const validBefore = kind === "pending" ? now + 3_000 : now - 100_000;
    mod.recordX402Intent(db(), {
      payer,
      nonce: "0x" + seq.toString(16).padStart(64, "0"),
      network: "eip155:84532",
      token: "0x" + "c".repeat(40),
      pay_to: "0x" + "d".repeat(40),
      amount_micro: 1,
      // pending: still valid, so it stays pending; failed: long expired, eligible.
      valid_after: validBefore - 900,
      valid_before: validBefore,
      idempotency_key: `${tag}-${seq}`,
      motebit_id: "m",
      delegator_id: tag,
      task_id: `${tag}-${seq}`,
    });
    db()
      .prepare(
        kind === "failed"
          ? "UPDATE relay_x402_settlements SET created_at = COALESCE(?, created_at), status = 'failed', failure_reason = 'invalid_exact_evm_insufficient_balance', resolved_at = 0 WHERE payer = ?"
          : "UPDATE relay_x402_settlements SET created_at = COALESCE(?, created_at) WHERE payer = ?",
      )
      .run(createdAt, payer);
    return payer;
  }
  const keyOf = (payer: string) =>
    db()
      .prepare(
        "SELECT COALESCE(last_checked_at, created_at) AS k, created_at AS c, last_checked_at AS v FROM relay_x402_settlements WHERE payer = ?",
      )
      .get(payer) as { k: number; c: number; v: number | null };
  /** 2 × LIMIT older records and the victim behind them. */
  function seedQueue(kind: "pending" | "failed"): string {
    const base = Date.now() - 10_000_000;
    for (let i = 0; i < 2 * LIMIT; i++) seed(kind, base + i, "old");
    return seed(kind, base + 2 * LIMIT, "victim");
  }
  interface Watch {
    run: number;
    visits: number[];
    bound: number | null;
    lastVisit: number | null;
  }
  /**
   * `runs` reconciliation runs, LIMIT brand-new records injected after each
   * (created_at from the relay's own clock, as in production), asserting
   * after EVERY run: a visited victim is revisited within
   * ceil(#records ordered before it at its visit / LIMIT) + 1 runs.
   */
  async function drive(
    kind: "pending" | "failed",
    victim: string,
    runs: number,
    mod: Mod,
    w: Watch = { run: 0, visits: [], bound: null, lastVisit: keyOf(victim).v },
  ): Promise<Watch> {
    // A long, never-concluding pass keeps failed rows eligible (a re-check
    // is spent only when its pass concludes).
    const scan = { scan: { ...NOW.scan, maxPagesPerRun: 1, pageBlocks: 10 } };
    for (let i = 0; i < runs; i++) {
      w.run += 1;
      await mod.reconcilePendingX402Settlements(db(), fakeChainReader(), {
        limit: LIMIT,
        ...scan,
      });
      const now = keyOf(victim);
      if (now.v !== w.lastVisit) {
        w.visits.push(w.run);
        if (w.bound != null && w.visits.length > 1) {
          expect(
            w.run - w.visits[w.visits.length - 2]!,
            `revisit within ${w.bound} runs`,
          ).toBeLessThanOrEqual(w.bound);
        }
        // The bound from this visit: records ordered before the victim
        // (the selection order exactly: key, then created_at).
        const before = (
          db()
            .prepare(
              `SELECT COUNT(*) AS n FROM relay_x402_settlements WHERE status = ?
                 AND (COALESCE(last_checked_at, created_at) < ?
                      OR (COALESCE(last_checked_at, created_at) = ? AND created_at < ?))`,
            )
            .get(kind, now.k, now.k, now.c) as { n: number }
        ).n;
        w.bound = Math.ceil(before / LIMIT) + 1;
        w.lastVisit = now.v;
      } else if (w.bound != null && w.visits.length > 0) {
        expect(
          w.run - w.visits[w.visits.length - 1]!,
          `not starved past ${w.bound} runs`,
        ).toBeLessThanOrEqual(w.bound);
      }
      for (let j = 0; j < LIMIT; j++) seed(kind, null, "flood", mod);
    }
    return w;
  }

  for (const kind of ["pending", "failed"] as const) {
    for (const clock of ["real", "frozen"] as const) {
      it(`${kind} queue, ${clock} clock: with ≥ limit new records injected every run, a visited record is revisited within ceil(#ordered before it / limit) + 1 runs`, async () => {
        // "frozen": every stamp is minted in the same millisecond — the tie a
        // plain wall-clock stamp cannot order (round 9: deterministic, where
        // the real clock only hits it sometimes).
        const t = Date.now();
        const spy = clock === "frozen" ? vi.spyOn(Date, "now").mockReturnValue(t) : null;
        try {
          const victim = seedQueue(kind);
          const w = await drive(kind, victim, 12, here);
          expect(w.visits.length, "the victim keeps being visited").toBeGreaterThanOrEqual(2);
        } finally {
          spy?.mockRestore();
        }
      });
    }
  }

  it("a restart after the wall clock ran 24 h fast and was corrected: stamps stay monotonic across processes, the victim is revisited within the bound", async () => {
    const victim = seedQueue("pending");
    const wall = Date.now;
    const fast = vi.spyOn(Date, "now").mockImplementation(() => wall.call(Date) + 24 * 3_600_000);
    let w: Watch;
    try {
      w = await drive("pending", victim, 4, here);
    } finally {
      fast.mockRestore();
    }
    expect(w.visits.length, "visited while the clock ran fast").toBeGreaterThanOrEqual(1);
    // A new process (fresh module state), the clock now correct.
    vi.resetModules();
    const fresh = (await import("../x402-settlements.js")) as Mod;
    w = await drive("pending", victim, 12, fresh, w);
    expect(w.visits.length, "still visited after the restart").toBeGreaterThanOrEqual(3);
  });
});

describe("#907 round 8: an execution_mismatch has its own re-check budget", () => {
  it("refused → lands late → the first re-check reads a node that drops the Transfer (Used seen: sticky, nothing spent) → the next honest run credits it", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r8 quirk ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xQuirk8");
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const auth = authorizationOf(pay);
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    const r0 = x402Records()[0]! as unknown as { valid_before: number };
    facilitator.chainTime = r0.valid_before + 10_000;
    await reconcilePendingX402Settlements(
      relay.moteDb.db,
      fakeChainReader({ receiptQuirkOnce: true }),
      NOW,
    );
    // Round 12: a dropped Transfer log is a MISSING log, not a mismatch — the
    // record is sticky (Used seen), and the re-read spends no budget.
    expect(x402Records()[0]).toMatchObject({
      status: "failed",
      failure_reason: "invalid_exact_evm_insufficient_balance", // the original class, kept
      used_state: "unpaired",
      recheck_count: 0,
    });
    await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
    expect(x402Records()[0]!.status).toBe("credited");
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });
});

describe("#907 round 8: the pass_cursor compare-and-set on its own", () => {
  it("a concurrent run advanced the cursor: a stale run's next cursor write is a no-op, and its lagging pass neither concludes nor spends", async () => {
    const dbh = relay.moteDb.db;
    const w = await pricedAgent();
    const body = { prompt: `907 r8 cas ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
    await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xCas"));
    facilitator.settleMode = "ok";
    const r0 = x402Records()[0]! as unknown as { valid_before: number };
    facilitator.chainTime = r0.valid_before + 10_000;
    const scan = { scan: { ...NOW.scan, pageBlocks: 400 } };
    // Run A: writes its first page's cursor, then stalls on its second page.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let stalled!: () => void;
    const atSecond = new Promise<void>((res) => (stalled = res));
    const slow = fakeChainReader({ lagging: true });
    const orig = slow.getAuthorizationEvents.bind(slow);
    let calls = 0;
    slow.getAuthorizationEvents = async (a) => {
      calls += 1;
      if (calls === 2) {
        stalled();
        await gate;
      }
      return orig(a);
    };
    const runA = reconcilePendingX402Settlements(dbh, slow, scan);
    await atSecond;
    const mid = x402Records()[0]! as unknown as { pass_cursor: number | null };
    expect(mid.pass_cursor, "run A wrote its first page").not.toBeNull();
    // Run B (same generation) advances the same pass by one page.
    const full = findX402Settlement(dbh, x402Records()[0]!.payer, x402Records()[0]!.nonce)!;
    await reconcileX402Settlement(dbh, fakeChainReader({ lagging: true }), full, {
      ...X402_SCAN,
      ...NOW.scan,
      pageBlocks: 50,
      maxPagesPerRun: 1,
    });
    const advanced = mid.pass_cursor! + 50;
    expect(x402Records()[0]).toMatchObject({ pass_cursor: advanced, recheck_count: 0 });
    release();
    await runA;
    expect(x402Records()[0], "run A's stale write and its conclusion were no-ops").toMatchObject({
      pass_cursor: advanced,
      recheck_count: 0,
    });
  });
});

describe("#907 round 9: the relay's wall clock never defines the scanned chain window", () => {
  const recOf = (w: string) =>
    x402Records().find((x) => x.delegator_id === w)! as unknown as {
      status: string;
      valid_before: number;
      valid_after: number;
      scan_from_block: number | null;
      scan_end_block: number | null;
      scanned_to_block: number | null;
      expiry_observed_at: number | null;
      recheck_count: number;
      mismatch_rechecks: number;
      pass_cursor: number | null;
      failure_reason: string | null;
    };
  /** Shift the relay's wall clock (Date.now) by `ms`; the payment was signed on the true clock. */
  function skewRelayClock(ms: number) {
    const wall = Date.now;
    return vi.spyOn(Date, "now").mockImplementation(() => wall.call(Date) + ms);
  }

  for (const [label, skewMs] of [
    ["2 h fast", 2 * 3_600_000],
    ["55 min slow", -55 * 60_000],
  ] as const) {
    it(`relay clock ${label}, the settle answer lost after the transfer: the execution is found from the SIGNED window and credited`, async () => {
      const w = await pricedAgent();
      const body = { prompt: `907 r9 skew ${label} ${crypto.randomUUID()}`, submitted_by: w };
      const pay = await paymentFor(w, body, `0xSkew${skewMs > 0 ? "F" : "S"}`);
      const skew = skewRelayClock(skewMs);
      try {
        facilitator.settleMode = "timeout-after-transfer";
        const res = await submit(w, crypto.randomUUID(), body, pay);
        expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_OUTCOME_UNKNOWN");
        facilitator.settleMode = "ok";
        expect(facilitator.settled).toHaveLength(1); // charged onchain
        facilitator.chainTime = recOf(w).valid_before + 10_000;
        for (let i = 0; i < 4 && recOf(w).status === "pending"; i++) {
          await reconcilePendingX402Settlements(relay.moteDb.db, fakeChainReader(), NOW);
        }
        expect(recOf(w).status).toBe("credited");
        expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
      } finally {
        skew.mockRestore();
      }
    });
  }

  it("relay clock 2 h slow: the relay-clock sanity bound refuses before settling — nothing is charged", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r9 slow ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xSkewSlow2h");
    const skew = skewRelayClock(-2 * 3_600_000);
    try {
      const res = await submit(w, crypto.randomUUID(), body, pay);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_PAYMENT_UNBOUND");
    } finally {
      skew.mockRestore();
    }
    expect(facilitator.settleCalls).toBe(0);
    expect(x402Records().filter((x) => x.delegator_id === w)).toEqual([]);
  });

  it("the gate bounds the signed window validAfter..validBefore (chain-time facts only): wider, empty or inverted is refused unsettled; just inside is admitted", async () => {
    const w = await pricedAgent();
    const now = Math.floor(Date.now() / 1000);
    for (const [validAfter, validBefore] of [
      [0, now + 300], // validAfter = 0: a scan from genesis
      [now + 300 - X402_MAX_WINDOW_SECONDS - 1, now + 300],
      [now + 300, now + 300],
      [now + 400, now + 300],
    ] as const) {
      const body = { prompt: `907 r9 window ${crypto.randomUUID()}`, submitted_by: w };
      const first = await submit(w, crypto.randomUUID(), body);
      const pay = signPayment(first.headers.get("PAYMENT-REQUIRED")!, `0xWin${validAfter}`, {
        validAfter,
        validBefore,
      });
      const res = await submit(w, crypto.randomUUID(), body, pay);
      expect(res.status, `${validAfter}..${validBefore}`).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_PAYMENT_UNBOUND");
    }
    expect(facilitator.settleCalls).toBe(0);
    const body = { prompt: `907 r9 window ok ${crypto.randomUUID()}`, submitted_by: w };
    const first = await submit(w, crypto.randomUUID(), body);
    const pay = signPayment(first.headers.get("PAYMENT-REQUIRED")!, "0xWinOk", {
      validAfter: now + 300 - X402_MAX_WINDOW_SECONDS,
      validBefore: now + 300,
    });
    expect((await submit(w, crypto.randomUUID(), body, pay)).status).toBe(201);
    expect(recOf(w).valid_after).toBe(now + 300 - X402_MAX_WINDOW_SECONDS);
  });

  it("a reader whose head regressed below the persisted scan end never concludes over blocks it does not have; the next honest reader credits", async () => {
    const db = relay.moteDb.db;
    const w = await pricedAgent();
    const body = { prompt: `907 r9 regressed ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xRegressed");
    facilitator.settleMode = "timeout-after-transfer";
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const execBlock = facilitator.head; // the settle executed in the newest block
    facilitator.chainTime = recOf(w).valid_before + 10_000;
    // One honest run: the fixed end is persisted, the cursor stops well before the execution.
    await reconcilePendingX402Settlements(db, fakeChainReader(), {
      scan: { ...NOW.scan, pageBlocks: 50, maxPagesPerRun: 1 },
    });
    const r1 = recOf(w);
    expect(r1.scan_end_block).not.toBeNull();
    expect(r1.scanned_to_block!).toBeLessThan(execBlock);
    // A load-balanced node behind: its head is below the execution (and the end).
    const behind = fakeChainReader({ headAt: r1.scanned_to_block! + 60 });
    expect(r1.scanned_to_block! + 60).toBeLessThan(execBlock);
    for (let i = 0; i < 3; i++) await reconcilePendingX402Settlements(db, behind, NOW);
    expect(recOf(w), "never concluded, never expired").toMatchObject({
      status: "pending",
      expiry_observed_at: null,
    });
    expect(recOf(w).scanned_to_block).toBeLessThanOrEqual(r1.scanned_to_block! + 60);
    await reconcilePendingX402Settlements(db, fakeChainReader(), NOW);
    expect(recOf(w).status).toBe("credited");
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  /** A refused (definite) payment, recorded failed, re-check-eligible. */
  async function failedRecord(label: string) {
    const w = await pricedAgent();
    const body = { prompt: `907 r9 ${label} ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, `0x${label}`);
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    return { w, pay, auth: authorizationOf(pay) };
  }
  const full = (w: string) => {
    const r = recOf(w) as unknown as { payer: string; nonce: string };
    return findX402Settlement(relay.moteDb.db, r.payer, r.nonce)!;
  };
  /** A reader whose FIRST event read waits on `gate` (a run stalled mid-flight). */
  function stalledOnFirstRead(base: ReturnType<typeof fakeChainReader>) {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let stalled!: () => void;
    const atRead = new Promise<void>((res) => (stalled = res));
    const orig = base.getAuthorizationEvents.bind(base);
    let calls = 0;
    base.getAuthorizationEvents = async (a) => {
      calls += 1;
      const out = await orig(a);
      if (calls === 1) {
        stalled();
        await gate;
      }
      return out;
    };
    return { reader: base, release, atRead };
  }

  it("CAS: a stale run from an earlier MISMATCH generation writes no pass cursor — its lagging reads never make the next re-check skip the execution", async () => {
    const db = relay.moteDb.db;
    const { w, pay, auth } = await failedRecord("CasMismatch");
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    facilitator.chainTime = recOf(w).valid_before + 10_000;
    // The first re-check reads a corrupt receipt: a (paired) mismatch observed.
    await reconcilePendingX402Settlements(db, fakeChainReader({ receiptCorruptOnce: true }), NOW);
    expect(recOf(w) as unknown as Record<string, unknown>).toMatchObject({
      last_observation: "execution_mismatch",
      mismatch_rechecks: 0,
      pass_cursor: null,
    });
    const stale = full(w);
    // Run A (a lagging node) reads its first page, then stalls.
    const a = stalledOnFirstRead(fakeChainReader({ lagging: true }));
    const runA = reconcileX402Settlement(db, a.reader, stale, {
      ...X402_SCAN,
      ...NOW.scan,
      pageBlocks: 50,
    });
    await a.atRead;
    // Run B concludes the mismatch re-check (the quirk again): budget spent.
    await reconcileX402Settlement(db, fakeChainReader({ receiptCorruptOnce: true }), stale, {
      ...X402_SCAN,
      ...NOW.scan,
    });
    expect(recOf(w)).toMatchObject({ mismatch_rechecks: 1, pass_cursor: null });
    a.release();
    expect(await runA).toBe("unchanged");
    expect(recOf(w).pass_cursor, "the stale run wrote no cursor").toBeNull();
    // The next re-check (an expiry re-check is left) rescans from the start.
    await reconcilePendingX402Settlements(db, fakeChainReader(), NOW);
    expect(recOf(w).status).toBe("credited");
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("CAS: a stale run concluding an EARLIER re-check generation never rolls back the re-check count (no budget handed back)", async () => {
    const db = relay.moteDb.db;
    const { w, auth } = await failedRecord("CasSpend");
    facilitator.chainCancel(auth.from, auth.nonce);
    facilitator.chainTime = recOf(w).valid_before + 10_000;
    const gen0 = full(w);
    expect(gen0.recheck_count).toBe(0);
    // Run A reads the cancellation, then stalls before concluding.
    const a = stalledOnFirstRead(fakeChainReader());
    const runA = reconcileX402Settlement(db, a.reader, gen0, { ...X402_SCAN, ...NOW.scan });
    await a.atRead;
    // Two later runs conclude generations 0 and 1.
    await reconcileX402Settlement(db, fakeChainReader(), gen0, { ...X402_SCAN, ...NOW.scan });
    await reconcileX402Settlement(db, fakeChainReader(), full(w), { ...X402_SCAN, ...NOW.scan });
    expect(recOf(w).recheck_count).toBe(2);
    a.release();
    await runA;
    expect(recOf(w).recheck_count, "generation 0's late conclusion is a no-op").toBe(2);
  });
});

describe("#907 round 10: every wait is measured in CHAIN time — a relay clock that jumped never holds a credit back", () => {
  const MONTH = 30 * 24 * 3_600_000;
  const recOf = (w: string) =>
    x402Records().find((x) => x.delegator_id === w)! as unknown as {
      status: string;
      valid_before: number;
      recheck_count: number;
      failure_reason: string | null;
    };
  /** The production gap and backoff (5 min; 10 min / 1 h / 6 h). */
  const PROD = { scan: { ...X402_SCAN } };
  function relayClockFast(ms: number) {
    const wall = Date.now;
    return vi.spyOn(Date, "now").mockImplementation(() => wall.call(Date) + ms);
  }

  it("pending, executed, the first concluding pass missed the log while the relay clock ran 30 days fast; clock corrected: credited after the normal 5-minute chain-time gap", async () => {
    const db = relay.moteDb.db;
    const w = await pricedAgent();
    const body = { prompt: `907 r10 pending ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xJumpPending");
    facilitator.settleMode = "timeout-after-transfer"; // executed, answer lost
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    facilitator.chainTime = recOf(w).valid_before + 10_000;
    const fast = relayClockFast(MONTH);
    try {
      // A lagging node: the ordinary pass concludes with no event — the first observation.
      await reconcilePendingX402Settlements(db, fakeChainReader({ lagging: true }), PROD);
    } finally {
      fast.mockRestore();
    }
    expect(recOf(w).status).toBe("pending");
    // Clock corrected. Before the gap: nothing yet.
    await reconcilePendingX402Settlements(db, fakeChainReader(), PROD);
    expect(recOf(w).status, "the confirming pass waits the gap").toBe("pending");
    facilitator.chainTime += 5 * 60 + 2; // five minutes of chain time
    await reconcilePendingX402Settlements(db, fakeChainReader(), PROD);
    expect(recOf(w).status).toBe("credited");
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("a definite refusal that executes late, refused while the relay clock ran 30 days fast; clock corrected: credited at the normal 10-minute chain-time re-check", async () => {
    const db = relay.moteDb.db;
    const w = await pricedAgent();
    const body = { prompt: `907 r10 refused ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xJumpRefused");
    const fast = relayClockFast(MONTH);
    try {
      facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
      await submit(w, crypto.randomUUID(), body, pay);
      facilitator.settleMode = "ok";
      // The loop sees the failure (and stamps its chain time) while the clock is still fast.
      await reconcilePendingX402Settlements(db, fakeChainReader(), PROD);
    } finally {
      fast.mockRestore();
    }
    const failedAt = (
      x402Records().find((x) => x.delegator_id === w) as unknown as { resolved_head_ts: number }
    ).resolved_head_ts;
    expect(recOf(w)).toMatchObject({ status: "failed", recheck_count: 0 });
    // It executes after all, inside its window.
    const auth = authorizationOf(pay);
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    // Nine minutes of chain time: past validBefore, but before the first re-check.
    facilitator.chainTime = failedAt + 9 * 60;
    expect(facilitator.chainTime).toBeGreaterThan(recOf(w).valid_before + 120);
    await reconcilePendingX402Settlements(db, fakeChainReader(), PROD);
    expect(recOf(w).status, "not before the 10-minute re-check").toBe("failed");
    facilitator.chainTime = failedAt + 10 * 60;
    await reconcilePendingX402Settlements(db, fakeChainReader(), PROD);
    expect(recOf(w).status).toBe("credited");
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("a failed head read makes nothing eligible that run (no re-check, no failure stamped)", async () => {
    const db = relay.moteDb.db;
    const w = await pricedAgent();
    const body = { prompt: `907 r10 nohead ${crypto.randomUUID()}`, submitted_by: w };
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
    await submit(w, crypto.randomUUID(), body, await paymentFor(w, body, "0xNoHead"));
    facilitator.settleMode = "ok";
    facilitator.chainTime = recOf(w).valid_before + 10_000;
    await reconcilePendingX402Settlements(db, fakeChainReader({ failing: true }), NOW);
    expect(
      x402Records().find((x) => x.delegator_id === w) as unknown as {
        resolved_head_ts: number | null;
        recheck_count: number;
      },
    ).toMatchObject({ resolved_head_ts: null, recheck_count: 0 });
  });
});

describe("#907 round 11: the expiry and mismatch re-check budgets are orthogonal; the operator's resolve writes nothing", () => {
  const db = () => relay.moteDb.db;
  type Row = Record<string, unknown> & {
    status: string;
    failure_reason: string | null;
    last_observation: string | null;
    recheck_count: number;
    mismatch_rechecks: number;
    next_recheck_head_ts: number | null;
    mismatch_observed_head_ts: number | null;
    valid_before: number;
    payer: string;
    nonce: string;
  };
  const row = (w: string): Row =>
    db().prepare("SELECT * FROM relay_x402_settlements WHERE delegator_id = ?").get(w) as Row;
  /**
   * The operator's resolve, asserting the property: unless it credits, it
   * changes NO column (a fortiori none the loop's selection or scan reads).
   */
  async function operatorResolve(w: string, reader: ReturnType<typeof fakeChainReader>) {
    const before = row(w);
    const decision = await reconcileX402Settlement(
      db(),
      reader,
      findX402Settlement(db(), before.payer, before.nonce)!,
      { ...X402_SCAN, ...NOW.scan },
      { operator: true },
    );
    if (decision !== "credited") {
      expect(row(w), `operator resolve (${decision}) wrote nothing`).toEqual(before);
    }
    return decision;
  }
  /** A refused payment (failed at once) that executes late, inside its window. */
  async function refusedLandsLate(label: string) {
    const w = await pricedAgent();
    const body = { prompt: `907 r11 ${label} ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, `0x${label}`);
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const auth = authorizationOf(pay);
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    facilitator.chainTime = row(w).valid_before + 10_000;
    return w;
  }
  const loop = (reader: ReturnType<typeof fakeChainReader>, scan: object = NOW) =>
    reconcilePendingX402Settlements(db(), reader, scan as typeof NOW);
  const quirk = () => fakeChainReader({ receiptQuirkOnce: true });
  /** A node that returns the paired Transfer with a WRONG value once — a paired mismatch. */
  const corrupt = () => fakeChainReader({ receiptCorruptOnce: true });
  const lagging = () => fakeChainReader({ lagging: true });
  const honest = () => fakeChainReader();

  it("sequence 1 — refused, lands late; re-check 1 reads a corrupt receipt (a paired mismatch); a lagging read follows: the expiry re-checks left still credit on the honest read", async () => {
    const w = await refusedLandsLate("R11s1");
    await loop(corrupt());
    expect(row(w)).toMatchObject({
      failure_reason: "invalid_exact_evm_insufficient_balance",
      last_observation: "execution_mismatch",
      recheck_count: 1,
      mismatch_rechecks: 0,
    });
    await loop(lagging()); // the mismatch re-check, on a lagging node
    expect(row(w)).toMatchObject({ status: "failed", recheck_count: 1, mismatch_rechecks: 1 });
    await loop(honest());
    expect(row(w).status).toBe("credited");
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("sequence 2 — pending, lagging reads expire it; re-check 1 reads a corrupt receipt; lagging again: still credits on the honest read", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r11 s2 ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xR11s2");
    facilitator.settleMode = "timeout-after-transfer";
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    facilitator.chainTime = row(w).valid_before + 10_000;
    await loop(lagging());
    await loop(lagging());
    expect(row(w)).toMatchObject({
      status: "failed",
      failure_reason: "authorization_expired_unused",
    });
    await loop(corrupt());
    await loop(lagging());
    expect(row(w)).toMatchObject({
      status: "failed",
      failure_reason: "authorization_expired_unused",
      last_observation: "execution_mismatch",
      recheck_count: 1,
      mismatch_rechecks: 1,
    });
    await loop(honest());
    expect(row(w).status).toBe("credited");
  });

  it("sequence 3 — refused, lands late; re-check 1 lagging, re-check 2 reads a corrupt receipt, then lagging: the third expiry re-check credits", async () => {
    const w = await refusedLandsLate("R11s3");
    await loop(lagging());
    await loop(corrupt());
    await loop(lagging());
    expect(row(w)).toMatchObject({ status: "failed", recheck_count: 2, mismatch_rechecks: 1 });
    await loop(honest());
    expect(row(w).status).toBe("credited");
  });

  it("sequence 4 — refused, lands late; re-check 1 reads a corrupt receipt: the mismatch's OWN re-check credits on the honest read", async () => {
    const w = await refusedLandsLate("R11s4");
    await loop(corrupt());
    // Freeze the expiry budget's wait so only the mismatch clause can admit it.
    db()
      .prepare("UPDATE relay_x402_settlements SET next_recheck_head_ts = ? WHERE delegator_id = ?")
      .run(facilitator.chainTime + 1_000_000, w);
    await loop(honest());
    expect(row(w)).toMatchObject({ status: "credited" });
  });

  it("operator first — its resolve past validBefore reads a corrupt receipt (and a quirk) and writes NOTHING; all three expiry re-checks remain and the loop credits", async () => {
    const w = await refusedLandsLate("R11op");
    await loop(lagging()); // stamps the failure's chain time, spends re-check 1
    expect(row(w)).toMatchObject({ recheck_count: 1 });
    expect(await operatorResolve(w, corrupt())).toBe("execution_mismatch");
    expect(await operatorResolve(w, quirk())).toBe("used_unpaired");
    expect(await operatorResolve(w, lagging())).toBe("no_execution_found");
    expect(row(w)).toMatchObject({
      recheck_count: 1,
      mismatch_rechecks: 0,
      last_observation: null,
    });
    await loop(honest());
    expect(row(w).status).toBe("credited");
  });

  it("property: across every state a record passes through, a non-crediting operator resolve changes no column", async () => {
    const w = await refusedLandsLate("R11prop");
    const readers = [lagging, quirk, corrupt, () => fakeChainReader({ failing: true })];
    const probe = async () => {
      for (const make of readers) await operatorResolve(w, make());
    };
    await probe(); // failed, never seen by the loop
    await loop(lagging());
    await probe(); // one expiry re-check spent
    await loop(corrupt());
    await probe(); // a mismatch observed
    await loop(lagging());
    await probe(); // the mismatch budget spent
    // A pending record, before and after its validBefore, and with an observed expiry.
    const w2 = await pricedAgent();
    const body = { prompt: `907 r11 prop2 ${crypto.randomUUID()}`, submitted_by: w2 };
    const pay = await paymentFor(w2, body, "0xR11prop2");
    facilitator.settleMode = { refuse: "upstream 502" };
    await submit(w2, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    for (const make of readers) await operatorResolve(w2, make());
    facilitator.chainTime = row(w2).valid_before + 10_000;
    for (const make of readers) await operatorResolve(w2, make());
    await loop(lagging(), { scan: { ...NOW.scan, expiryConfirmGapMs: 3_600_000 } });
    expect(row(w2).expiry_observed_head_ts).not.toBeNull();
    for (const make of readers) await operatorResolve(w2, make());
    // The honest read: the operator may credit (the one write it may make).
    expect(await operatorResolve(w, honest())).toBe("credited");
  });

  it("q3 corner — a corrupt receipt on the THIRD expiry re-check: the mismatch re-check waits its own chain-time backoff (10 min), then credits", async () => {
    const w = await refusedLandsLate("R11q3");
    const PROD = { scan: { ...X402_SCAN } };
    const failedAt = () => row(w).resolved_head_ts as number;
    await loop(lagging(), PROD); // stamps the failure's chain time
    facilitator.chainTime = failedAt() + 10 * 60;
    await loop(lagging(), PROD); // re-check 1
    facilitator.chainTime = row(w).next_recheck_head_ts!;
    await loop(lagging(), PROD); // re-check 2
    facilitator.chainTime = row(w).next_recheck_head_ts!;
    await loop(corrupt(), PROD); // re-check 3 reads a corrupt receipt
    const seen = row(w);
    expect(seen).toMatchObject({ recheck_count: 3, last_observation: "execution_mismatch" });
    expect(seen.next_recheck_head_ts, "every spend leaves a chain-time wait").not.toBeNull();
    facilitator.chainTime = seen.mismatch_observed_head_ts! + 9 * 60;
    await loop(honest(), PROD);
    expect(row(w).status, "not before the mismatch's 10-minute backoff").toBe("failed");
    facilitator.chainTime = seen.mismatch_observed_head_ts! + 10 * 60;
    await loop(honest(), PROD);
    expect(row(w).status).toBe("credited");
  });
});

describe("#907 round 11: the x402 gate is never armed for a network the reconciler cannot read", () => {
  it("x402ReconcilerCanRead needs an RPC URL (override or default) AND a confirmation depth", async () => {
    const { x402ReconcilerCanRead } = await import("../x402-settlements.js");
    const rpc = { "eip155:8453": "https://mainnet.base.org" };
    const depth = { "eip155:8453": 12 };
    expect(x402ReconcilerCanRead("eip155:8453", rpc, depth, {})).toBe(true);
    expect(x402ReconcilerCanRead("eip155:424242", rpc, depth, {})).toBe(false);
    // An RPC override alone is not enough: no confirmation depth for the chain.
    const env = { X402_RPC_URL_EIP155_424242: "https://my.rpc" };
    expect(x402ReconcilerCanRead("eip155:424242", rpc, depth, env)).toBe(false);
    expect(x402ReconcilerCanRead("eip155:424242", rpc, { "eip155:424242": 3 }, env)).toBe(true);
  });

  it("a relay configured to take x402 payments on an unreadable network refuses to boot", async () => {
    await expect(
      createTestRelay({
        x402: { ...X402_TEST_CONFIG, network: "eip155:424242" },
        x402ChainReader: undefined, // the production path: no injected reader
      }),
    ).rejects.toThrow(/cannot read that chain.*Refusing to arm the x402 gate/);
  });
});

describe("#907 round 12: evidence of execution is sticky; one head per run; the operator reads the whole window", () => {
  const db = () => relay.moteDb.db;
  const PROD = { scan: { ...X402_SCAN } };
  /** The USDC contract the test relay prices in (Base Sepolia). */
  const USDC_TOKEN = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
  type Mode = "L" | "Q" | "F" | "H";
  type Start = "P0" | "P1" | "R";
  interface Cell {
    id: string;
    start: Start;
    executed: boolean;
    seq: Mode[];
    payer: string;
    nonce: string;
  }
  const rowOf = (c: Cell) =>
    db()
      .prepare("SELECT * FROM relay_x402_settlements WHERE payer = ? AND nonce = ?")
      .get(c.payer, c.nonce) as Record<string, unknown> & { status: string };

  /** Every sequence over {L, Q, F} of length 0..n (1 + 3 + 9 + … ). */
  function sequencesUpTo(n: number): Mode[][] {
    const out: Mode[][] = [[]];
    let frontier: Mode[][] = [[]];
    for (let len = 1; len <= n; len++) {
      const next: Mode[][] = [];
      for (const q of frontier) for (const m of ["L", "Q", "F"] as const) next.push([...q, m]);
      out.push(...next);
      frontier = next;
    }
    return out;
  }
  /** A deterministic sample of `k` sequences of length `len`. */
  function sampleSequences(len: number, k: number): Mode[][] {
    let x = 907;
    const out: Mode[][] = [];
    for (let i = 0; i < k; i++) {
      const q: Mode[] = [];
      for (let j = 0; j < len; j++) {
        x = (x * 1103515245 + 12345) % 2147483648;
        q.push((["L", "Q", "F"] as const)[x % 3]!);
      }
      out.push(q);
    }
    return out;
  }

  /**
   * The stated exception, as a model: an EXECUTED record the loop can never
   * credit is one whose three expiry re-checks were all spent by lagging reads
   * before any read saw its Used log. A refused start is eligible from step 1
   * (step 0 stamps its chain time); a pending one fails `expired` after two
   * lagging passes and is eligible the step after. A Used log seen (Q, or any
   * honest read) makes it sticky, and sticky never gives up.
   */
  function modelStuck(start: Start, seq: Mode[]): boolean {
    let phase: "p0" | "p1" | "f" | "sticky" = start === "P0" ? "p0" : start === "P1" ? "p1" : "f";
    let rc = 0;
    let eligibleFrom = start === "R" ? 1 : 0;
    for (let i = 0; i < seq.length; i++) {
      const m = seq[i]!;
      if (phase === "sticky") continue;
      if (phase === "p0") {
        if (m === "L") phase = "p1";
        else if (m === "Q") phase = "sticky";
        continue;
      }
      if (phase === "p1") {
        if (m === "L") {
          phase = "f";
          eligibleFrom = i + 1;
        } else if (m === "Q") phase = "sticky";
        continue;
      }
      if (i < eligibleFrom || rc >= 3) continue;
      if (m === "L") rc += 1;
      else if (m === "Q") phase = "sticky";
    }
    return phase === "f" && rc >= 3;
  }

  /** A reader that routes every record-specific read by that record's current mode. */
  function routedReader(modeOf: (payer: string, nonce: string) => Mode) {
    const honest = fakeChainReader();
    const quirked = new Set<string>();
    const reader: X402ChainReaderT = {
      getConfirmedHead: () => honest.getConfirmedHead(),
      getBlockTimestamp: (n) => honest.getBlockTimestamp(n),
      getAuthorizationEvents: async (a) => {
        const m = modeOf(a.authorizer, a.nonce);
        if (m === "F") throw new Error("rpc down");
        if (m === "L") return [];
        return honest.getAuthorizationEvents(a);
      },
      getReceiptLogs: async (tx) => {
        const ev = facilitator.events.find((e) => e.txHash === tx);
        const m = ev != null ? modeOf(ev.from, ev.nonce) : "H";
        if (m === "F") throw new Error("rpc down");
        const logs = await honest.getReceiptLogs(tx);
        if (m === "Q" && !quirked.has(tx)) {
          quirked.add(tx); // one dropped Transfer log per step
          return logs.filter((l) => l.topics[0] !== TRANSFER_TOPIC);
        }
        return logs;
      },
    };
    return reader;
  }

  /** Build every cell's record (and its execution) in one relay. */
  function buildCells(seqs: Mode[][]): Cell[] {
    const cells: Cell[] = [];
    const t0 = facilitator.chainTime;
    let i = 0;
    for (const start of ["P0", "P1", "R"] as const) {
      for (const executed of [true, false]) {
        for (const seq of seqs) {
          i += 1;
          const payer = "0x" + (0x907000 + i).toString(16).padStart(40, "0");
          const nonce = "0x" + (0x907000 + i).toString(16).padStart(64, "0");
          const id = `cell-${i}`;
          recordX402Intent(db(), {
            payer,
            nonce,
            network: "eip155:84532",
            token: USDC_TOKEN,
            pay_to: TREASURY.toLowerCase(),
            amount_micro: GROSS,
            valid_after: t0 - 600,
            valid_before: t0 + 1_800,
            idempotency_key: id,
            motebit_id: "m",
            delegator_id: id,
            task_id: id,
          });
          if (executed) {
            facilitator.chainExecute({
              token: USDC_TOKEN,
              from: payer,
              nonce,
              to: TREASURY,
              value: BigInt(GROSS),
            });
          }
          cells.push({ id, start, executed, seq, payer, nonce });
        }
      }
    }
    return cells;
  }

  /**
   * Prepare the start states: P1 records see one lagging pass (expiry
   * observed); R records are refused (failed, chain time stamped at step 0).
   */
  async function prepareStarts(cells: Cell[]) {
    facilitator.chainTime = t0Of(cells) + 1_800 + 10_000;
    const byKey = new Map(cells.map((c) => [`${c.payer}|${c.nonce}`, c]));
    await reconcilePendingX402Settlements(
      db(),
      routedReader((payer, nonce) => (byKey.get(`${payer}|${nonce}`)!.start === "P1" ? "L" : "F")),
      { limit: 10_000, ...PROD },
    );
    for (const c of cells) {
      if (c.start === "P1") expect(rowOf(c).expiry_observed_head_ts, c.id).not.toBeNull();
      if (c.start === "R") {
        markX402Failed(db(), c.payer, c.nonce, "invalid_exact_evm_insufficient_balance");
      }
    }
    return byKey;
  }
  const t0Of = (cells: Cell[]) => (rowOf(cells[0]!).valid_before as number) - 1_800;
  const STEP = 6 * 3_600 + 60; // past every chain-time wait (the longest is 6 h)

  it("loop: every {L,Q,F} sequence up to length 4 (+ a length-6 sample) from three start states, then honest reads — exactly-once credit whenever the transfer executed, except the modelled budget exhaustion; never a credit when it did not", async () => {
    const seqs = [...sequencesUpTo(4), ...sampleSequences(6, 40)];
    const cells = buildCells(seqs);
    const byKey = await prepareStarts(cells);
    const maxLen = Math.max(...seqs.map((q) => q.length));
    let step = 0;
    const modeAt = (payer: string, nonce: string): Mode => {
      const c = byKey.get(`${payer}|${nonce}`)!;
      return step < c.seq.length ? c.seq[step]! : "H";
    };
    for (step = 0; step < maxLen + 3; step++) {
      facilitator.chainTime += STEP;
      await reconcilePendingX402Settlements(db(), routedReader(modeAt), {
        limit: 10_000,
        ...PROD,
      });
    }
    const failures: string[] = [];
    let credited = 0;
    let stuck = 0;
    for (const c of cells) {
      const deposits = x402Deposits(c.id).length;
      const status = rowOf(c).status;
      const label = `${c.start} ${c.executed ? "executed" : "unexecuted"} [${c.seq.join("")}]`;
      if (!c.executed) {
        if (deposits !== 0 || status === "credited") failures.push(`${label}: credited`);
        continue;
      }
      if (modelStuck(c.start, c.seq)) {
        stuck += 1;
        if (deposits !== 0) failures.push(`${label}: modelled stuck, but credited`);
        continue;
      }
      if (deposits !== 1 || status !== "credited") {
        failures.push(`${label}: ${deposits} credits, ${status}`);
      } else credited += 1;
    }
    expect(failures).toEqual([]);
    expect(cells).toHaveLength(3 * 2 * (121 + 40));
    // The stated exception is small and exactly the modelled cells.
    expect({ credited, stuck }).toEqual({
      credited: cells.filter((c) => c.executed && !modelStuck(c.start, c.seq)).length,
      stuck: cells.filter((c) => c.executed && modelStuck(c.start, c.seq)).length,
    });
    expect(
      cells
        .filter((c) => c.executed && c.seq.length <= 4 && modelStuck(c.start, c.seq))
        .map((c) => `${c.start}:${c.seq.join("")}`),
      // A refused start: 4 non-honest reads (step 0 only stamps its chain
      // time), the three re-checks all lagging. P1 is a pending start that
      // already had one lagging read, so LLLL is its fifth.
      "within length 4, only starts whose three re-checks were all spent by lagging reads",
    ).toEqual(["P1:LLLL", "R:LLLL", "R:QLLL", "R:FLLL"]);
  }, 120_000);

  it("operator: after every sequence up to length 4, one honest operator resolve credits EVERY executed record exactly once (budgets never bind the last resort) and never an unexecuted one — writing nothing then", async () => {
    const seqs = sequencesUpTo(4);
    const cells = buildCells(seqs);
    const byKey = await prepareStarts(cells);
    let step = 0;
    const modeAt = (payer: string, nonce: string): Mode => {
      const c = byKey.get(`${payer}|${nonce}`)!;
      return step < c.seq.length ? c.seq[step]! : "F"; // no honest loop read
    };
    for (step = 0; step < 4; step++) {
      facilitator.chainTime += STEP;
      await reconcilePendingX402Settlements(db(), routedReader(modeAt), {
        limit: 10_000,
        ...PROD,
      });
    }
    const failures: string[] = [];
    for (const c of cells) {
      const label = `${c.start} ${c.executed ? "executed" : "unexecuted"} [${c.seq.join("")}]`;
      const before = rowOf(c);
      const decision = await reconcileX402Settlement(
        db(),
        fakeChainReader(),
        findX402Settlement(db(), c.payer, c.nonce)!,
        PROD.scan,
        { operator: true },
      );
      const deposits = x402Deposits(c.id).length;
      if (c.executed) {
        if (deposits !== 1) failures.push(`${label}: ${deposits} credits (${decision})`);
      } else {
        if (deposits !== 0) failures.push(`${label}: credited`);
        if (JSON.stringify(rowOf(c)) !== JSON.stringify(before)) failures.push(`${label}: wrote`);
      }
    }
    expect(failures).toEqual([]);
    expect(cells).toHaveLength(3 * 2 * 121);
  }, 120_000);

  it("the operator scans the WHOLE window from its start, never from the loop's cursor: pending → L, L (cursor at the end) → an honest operator resolve credits", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r12 opwhole ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xOpWhole");
    facilitator.settleMode = "timeout-after-transfer";
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const rec = () =>
      x402Records().find((x) => x.delegator_id === w)! as unknown as {
        status: string;
        valid_before: number;
        scanned_to_block: number;
        scan_end_block: number;
        payer: string;
        nonce: string;
      };
    facilitator.chainTime = rec().valid_before + 10_000;
    await reconcilePendingX402Settlements(db(), fakeChainReader({ lagging: true }), PROD);
    await reconcilePendingX402Settlements(db(), fakeChainReader({ lagging: true }), PROD);
    expect(rec().status).toBe("pending");
    expect(rec().scanned_to_block).toBe(rec().scan_end_block);
    const decision = await reconcileX402Settlement(
      db(),
      fakeChainReader(),
      findX402Settlement(db(), rec().payer, rec().nonce)!,
      PROD.scan,
      { operator: true },
    );
    expect(decision).toBe("credited");
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("the operator reads the entire window in ONE call under a provider range cap of 10 blocks (no page budget), and reports an accurate decision on a failed record", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r12 opcap ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xOpCap");
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const auth = authorizationOf(pay);
    const full = () => {
      const r0 = x402Records().find((x) => x.delegator_id === w)!;
      return findX402Settlement(db(), r0.payer, r0.nonce)!;
    };
    // Executed late in the window: past what 25 pages of 7 blocks would reach.
    facilitator.head += 100; // ~400 blocks into a ~510-block window
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    const execBlock = facilitator.head;
    facilitator.chainTime = full().valid_before + 10_000;
    const capped = fakeChainReader({ rangeCap: 10 });
    // A node whose head is below the window's end is, by construction, before
    // validBefore + margin: the accurate answer, never "still_pending".
    expect(
      await reconcileX402Settlement(
        db(),
        fakeChainReader({ headAt: execBlock - 1 }),
        full(),
        PROD.scan,
        { operator: true },
      ),
    ).toBe("authorization_still_valid");
    expect(await reconcileX402Settlement(db(), capped, full(), PROD.scan, { operator: true })).toBe(
      "credited",
    );
    expect(x402Deposits(w).map((d) => d.amount)).toEqual([GROSS]);
  });

  it("a REAL underpayment (Used paired to a wrong-amount Transfer) is terminal after its one mismatch re-check; a later missing-log read never reopens it", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r12 under ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xUnder");
    // The settle answer is lost; the chain carries an underpayment.
    facilitator.settleMode = { refuse: "upstream 502" };
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const auth = authorizationOf(pay);
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value) - 1n,
    });
    const row = () =>
      x402Records().find((x) => x.delegator_id === w)! as unknown as {
        status: string;
        valid_before: number;
        used_state: string | null;
        mismatch_rechecks: number;
      };
    facilitator.chainTime = row().valid_before + 10_000;
    await reconcilePendingX402Settlements(db(), fakeChainReader(), NOW);
    expect(row()).toMatchObject({ status: "failed", used_state: "mismatched" });
    // Its one mismatch re-check reads a node that drops the Transfer log.
    await reconcilePendingX402Settlements(db(), fakeChainReader({ receiptQuirkOnce: true }), NOW);
    expect(row()).toMatchObject({ used_state: "mismatched", mismatch_rechecks: 1 });
    for (let i = 0; i < 3; i++) {
      facilitator.chainTime += 7 * 3_600;
      await reconcilePendingX402Settlements(db(), fakeChainReader({ receiptQuirkOnce: true }), NOW);
    }
    const sel = selectX402Candidates(
      db(),
      facilitator.chainTime,
      { ...X402_SCAN, ...NOW.scan },
      100,
    );
    expect(
      [...sel.pending, ...sel.failed].filter((x) => x.delegator_id === w),
      "terminal: never selected again",
    ).toEqual([]);
    expect(x402Deposits(w)).toEqual([]);
  });

  it("one head per run: a second, regressed head read never changes which budget a pass spends", async () => {
    const w = await pricedAgent();
    const body = { prompt: `907 r12 onehead ${crypto.randomUUID()}`, submitted_by: w };
    const pay = await paymentFor(w, body, "0xOneHead");
    facilitator.settleMode = { refuse: "invalid_exact_evm_insufficient_balance" };
    await submit(w, crypto.randomUUID(), body, pay);
    facilitator.settleMode = "ok";
    const auth = authorizationOf(pay);
    // A genuine underpayment: paired to a Transfer of the wrong amount.
    facilitator.chainExecute({
      token: tokenOf(pay),
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value) - 1n,
    });
    const row = () =>
      x402Records().find((x) => x.delegator_id === w)! as unknown as {
        valid_before: number;
        resolved_head_ts: number;
        recheck_count: number;
        mismatch_rechecks: number;
        mismatch_observed_head_ts: number;
        next_recheck_head_ts: number;
      };
    facilitator.chainTime = row().valid_before + 10_000;
    await reconcilePendingX402Settlements(db(), fakeChainReader(), PROD); // stamps
    facilitator.chainTime = row().resolved_head_ts + 10 * 60;
    await reconcilePendingX402Settlements(db(), fakeChainReader(), PROD); // re-check 1: mismatch
    expect(row()).toMatchObject({ recheck_count: 1, mismatch_rechecks: 0 });
    // Ten minutes later the mismatch re-check is due; the expiry one (1 h) is not.
    facilitator.chainTime = row().mismatch_observed_head_ts + 10 * 60;
    expect(row().next_recheck_head_ts).toBeGreaterThan(facilitator.chainTime);
    const regressed = fakeChainReader();
    const honestHead = regressed.getConfirmedHead.bind(regressed);
    let reads = 0;
    const back = row().mismatch_observed_head_ts;
    regressed.getConfirmedHead = async () => {
      reads += 1;
      const h = await honestHead();
      if (reads === 1) return h;
      const n = h.number - Math.ceil((h.timestamp - back) / 2);
      return { number: n, timestamp: facilitator.genesis + 2 * n };
    };
    await reconcilePendingX402Settlements(db(), regressed, PROD);
    expect(row(), "the mismatch budget, as selection admitted").toMatchObject({
      recheck_count: 1,
      mismatch_rechecks: 1,
    });
    expect(x402Deposits(w)).toEqual([]);
  });
});
