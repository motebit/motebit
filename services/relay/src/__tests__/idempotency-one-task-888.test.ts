/**
 * #888 — one Idempotency-Key admits at most one task.
 *
 * The submit handler enqueued the task and then ran steps that can throw (the
 * budget hold, federation forwards, the ranking loop's 402, token mints). On a
 * throw the error boundary released the idempotency claim while the task stayed
 * queued, so a client whose response was lost and who retried with the SAME
 * key was admitted a SECOND task. The law these tests hold:
 *
 *   for a given (Idempotency-Key, motebit_id) at most one task is ever
 *   admitted, and a replay returns that task's id.
 *
 * Three mechanisms, each tested here (the federation cases — the post-attempt
 * forward 502s and the ranking loop's 402, and the pre-admission refusals S1
 * wrong fee leg, S2 discovery miss, and circuit-open 503 — are in
 * federation-e2e.test.ts § #888):
 *   1. Refusals run BEFORE admission — funding (402, failed deposit) and the
 *      federated-P2P discovery/binding/listing/treasury/leg/circuit checks —
 *      so they admit nothing and the key stays free (a corrected same-key
 *      retry succeeds, as on main).
 *   2. Admission is one transaction: hold + claim bound to the task + queued
 *      task. A failure rolls all of it back.
 *   3. Once admitted, the claim is never released; the admission-outcome
 *      middleware records whatever response the request ended with, plus the
 *      task id, and a replay returns exactly that.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import {
  bindIdempotencyClaimToTask,
  checkIdempotency,
  completeIdempotency,
  recordAdmittedOutcome,
  releaseIdempotency,
} from "../idempotency.js";
import {
  createAgent,
  createTestRelay,
  fakeSolanaTxHash,
  JSON_AUTH,
  p2pTreasuryAddress,
  seedBalance,
} from "./test-helpers.js";

const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

function claimRow(
  relay: SyncRelay,
  key: string,
  motebitId: string,
):
  | {
      status: string;
      task_id: string | null;
      response_status: number | null;
      response_body: string | null;
    }
  | undefined {
  return relay.moteDb.db
    .prepare(
      "SELECT status, task_id, response_status, response_body FROM relay_idempotency_keys WHERE idempotency_key = ? AND motebit_id = ?",
    )
    .get(key, motebitId) as
    | {
        status: string;
        task_id: string | null;
        response_status: number | null;
        response_body: string | null;
      }
    | undefined;
}

function tasksWithPrompt(relay: SyncRelay, prompt: string): string[] {
  return (
    relay.moteDb.db
      .prepare("SELECT task_id FROM relay_task_queue WHERE prompt = ?")
      .all(prompt) as { task_id: string }[]
  ).map((r) => r.task_id);
}

async function newAgent(relay: SyncRelay): Promise<string> {
  const kp = await generateKeypair();
  return (await createAgent(relay, bytesToHex(kp.publicKey))).motebitId;
}

/** A worker with a priced listing ($1.00/task) — relay-custody self-delegation allocates a hold. */
async function pricedWorker(relay: SyncRelay): Promise<string> {
  const id = await newAgent(relay);
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: id,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      settlement_address: WORKER_ADDR,
      settlement_modes: "relay,p2p",
    }),
  });
  await relay.app.request(`/api/v1/agents/${id}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: 1.0, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "888 priced worker",
    }),
  });
  return id;
}

function balanceOf(relay: SyncRelay, motebitId: string): number {
  const row = relay.moteDb.db
    .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
    .get(motebitId) as { balance: number } | undefined;
  return row?.balance ?? 0;
}

function allocationsFor(relay: SyncRelay, motebitId: string): { amount_locked: number }[] {
  return relay.moteDb.db
    .prepare("SELECT amount_locked FROM relay_allocations WHERE motebit_id = ?")
    .all(motebitId) as { amount_locked: number }[];
}

// ── Unit: the claim primitives ─────────────────────────────────────────────

describe("#888 idempotency claim primitives", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  it("releaseIdempotency deletes an unbound claim but never a claim bound to an admitted task", () => {
    const db = relay.moteDb.db;
    expect(checkIdempotency(db, "k-free", "m1").action).toBe("proceed");
    releaseIdempotency(db, "k-free", "m1");
    expect(claimRow(relay, "k-free", "m1")).toBeUndefined();

    expect(checkIdempotency(db, "k-bound", "m1").action).toBe("proceed");
    bindIdempotencyClaimToTask(db, "k-bound", "m1", "task-1");
    releaseIdempotency(db, "k-bound", "m1");
    expect(claimRow(relay, "k-bound", "m1")?.task_id).toBe("task-1");
    // A same-key request while the admitted one is unfinished is a conflict — never a proceed.
    expect(checkIdempotency(db, "k-bound", "m1").action).toBe("conflict");
  });

  it("bindIdempotencyClaimToTask admits only through an unbound processing claim", () => {
    const db = relay.moteDb.db;
    // No claim at all.
    expect(() => bindIdempotencyClaimToTask(db, "k-none", "m1", "t")).toThrow();
    // Already bound — a second task can never be bound to the same key.
    checkIdempotency(db, "k-twice", "m1");
    bindIdempotencyClaimToTask(db, "k-twice", "m1", "t1");
    expect(() => bindIdempotencyClaimToTask(db, "k-twice", "m1", "t2")).toThrow();
    expect(claimRow(relay, "k-twice", "m1")?.task_id).toBe("t1");
    // Completed.
    checkIdempotency(db, "k-done", "m1");
    completeIdempotency(db, "k-done", "m1", 201, "{}");
    expect(() => bindIdempotencyClaimToTask(db, "k-done", "m1", "t")).toThrow();
  });

  it("recordAdmittedOutcome writes only the claim bound to that task, and only once", () => {
    const db = relay.moteDb.db;
    checkIdempotency(db, "k-out", "m1");
    bindIdempotencyClaimToTask(db, "k-out", "m1", "t1");
    expect(recordAdmittedOutcome(db, "k-out", "m1", "other-task", 502, "{}")).toBe(false);
    expect(recordAdmittedOutcome(db, "k-out", "m1", "t1", 502, '{"task_id":"t1"}')).toBe(true);
    expect(recordAdmittedOutcome(db, "k-out", "m1", "t1", 500, "{}")).toBe(false);
    const replay = checkIdempotency(db, "k-out", "m1");
    expect(replay).toEqual({ action: "replay", status: 502, body: '{"task_id":"t1"}' });
  });
});

// ── HTTP: the law over the live submit route ───────────────────────────────

describe("#888 one Idempotency-Key admits at most one task (submit route)", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });
  afterEach(async () => {
    await relay.close();
  });

  const submit = (worker: string, key: string, body: Record<string, unknown>) =>
    relay.app.request(`/agent/${worker}/task`, {
      method: "POST",
      headers: { ...JSON_AUTH, "Idempotency-Key": key },
      body: JSON.stringify(body),
    });

  it("a normal same-key replay returns the stored 201 and the same task; a different key is a different task", async () => {
    const worker = await newAgent(relay);
    const prompt = `888 normal ${crypto.randomUUID()}`;
    const key = crypto.randomUUID();

    const first = await submit(worker, key, { prompt });
    expect(first.status).toBe(201);
    const b1 = (await first.json()) as { task_id: string };
    const replay = await submit(worker, key, { prompt });
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { task_id: string }).task_id).toBe(b1.task_id);
    expect(tasksWithPrompt(relay, prompt)).toEqual([b1.task_id]);

    const other = await submit(worker, crypto.randomUUID(), { prompt });
    expect(other.status).toBe(201);
    const b3 = (await other.json()) as { task_id: string };
    expect(b3.task_id).not.toBe(b1.task_id);
    expect(tasksWithPrompt(relay, prompt).sort()).toEqual([b1.task_id, b3.task_id].sort());
  });

  it("an unanticipated throw AFTER admission: the error carries the task id, a same-key replay returns it, and no second task is admitted", async () => {
    const worker = await newAgent(relay);
    const prompt = `888 late throw ${crypto.randomUUID()}`;
    const key = crypto.randomUUID();

    // Any exception after the admission transaction stands for a throw point
    // added later: the dispatch phases read `connections` only after the
    // task is queued, so a failure there is post-admission by construction.
    const realGet = relay.connections.get.bind(relay.connections);
    let armed = true;
    relay.connections.get = (id: string) => {
      if (armed && id === worker) {
        armed = false;
        throw new Error("forced post-admission failure");
      }
      return realGet(id);
    };

    const first = await submit(worker, key, { prompt });
    expect(first.status).toBe(500);
    const b1 = (await first.json()) as { task_id?: string; code?: string };
    expect(b1.code).toBe("INTERNAL_ERROR");
    expect(tasksWithPrompt(relay, prompt)).toHaveLength(1);

    // The client's fetch failed too; it retries with the SAME key.
    const retry = await submit(worker, key, { prompt });
    const tasks = tasksWithPrompt(relay, prompt);
    expect(tasks, "exactly one task under one key").toHaveLength(1);
    expect(retry.status).toBe(500);
    expect(b1.task_id, "the failed response names the task it admitted").toBe(tasks[0]);
    expect(await retry.json()).toEqual(b1);
    expect(claimRow(relay, key, worker)).toMatchObject({ status: "completed", task_id: tasks[0] });
  });

  it("a federated P2P refusal (pinned remote worker not discoverable, 404) comes before admission: no task, the key is released", async () => {
    const delegator = await newAgent(relay);
    const prompt = `888 fed 404 ${crypto.randomUUID()}`;
    const key = crypto.randomUUID();
    const body = {
      prompt,
      submitted_by: delegator,
      target_agent: "remote-worker-not-on-this-relay",
      required_capabilities: ["remote-cap"],
      payment_proof: {
        tx_hash: fakeSolanaTxHash(),
        chain: "solana",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        to_address: WORKER_ADDR,
        amount_micro: 902_500,
        fee_to_address: p2pTreasuryAddress(relay),
        fee_amount_micro: 50_000,
        b_fee_to_address: WORKER_ADDR,
        b_fee_amount_micro: 47_500,
      },
    };

    const first = await submit(delegator, key, body);
    expect(first.status, await first.clone().text()).toBe(404);
    const b1 = (await first.json()) as { task_id?: string };
    expect(b1.task_id, "a pre-admission refusal names no task").toBeUndefined();
    expect(tasksWithPrompt(relay, prompt), "a pre-admission refusal admits nothing").toEqual([]);
    expect(claimRow(relay, key, delegator), "and releases the key").toBeUndefined();

    // The same key is evaluated afresh (still undiscoverable here — the
    // corrected-retry-succeeds half is federation-e2e § #888 S1/S2).
    const retry = await submit(delegator, key, body);
    expect(retry.status).toBe(404);
    expect(tasksWithPrompt(relay, prompt)).toEqual([]);
  });

  it("a replay of a claim that admitted a task but never recorded its outcome (a crash) is a 409 that names the task", async () => {
    const worker = await newAgent(relay);
    const key = crypto.randomUUID();
    // The state a crash between the admission commit and the outcome record leaves.
    checkIdempotency(relay.moteDb.db, key, worker);
    bindIdempotencyClaimToTask(relay.moteDb.db, key, worker, "task-admitted-before-crash");

    const replay = await submit(worker, key, { prompt: "888 crash replay" });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      code: "TASK_CONFLICT",
      task_id: "task-admitted-before-crash",
    });
    expect(tasksWithPrompt(relay, "888 crash replay"), "no second task").toEqual([]);

    // A claim that admitted nothing yet is still a bare 409.
    const key2 = crypto.randomUUID();
    checkIdempotency(relay.moteDb.db, key2, worker);
    const inFlight = await submit(worker, key2, { prompt: "888 crash replay" });
    expect(inFlight.status).toBe(409);
    expect(((await inFlight.json()) as { task_id?: string }).task_id).toBeUndefined();
  });

  it("a funding refusal (402) admits nothing: no task is queued, and the same key succeeds once funded — one task, one hold", async () => {
    const worker = await pricedWorker(relay);
    const prompt = `888 unfunded ${crypto.randomUUID()}`;
    const key = crypto.randomUUID();

    const refused = await submit(worker, key, { prompt });
    expect(refused.status, await refused.clone().text()).toBe(402);
    expect(tasksWithPrompt(relay, prompt), "a refused task is never queued").toEqual([]);
    expect(
      claimRow(relay, key, worker),
      "a claim that admitted nothing is released",
    ).toBeUndefined();

    seedBalance(relay, worker, 5);
    const funded = await submit(worker, key, { prompt });
    expect(funded.status, await funded.clone().text()).toBe(201);
    const { task_id } = (await funded.json()) as { task_id: string };
    expect(tasksWithPrompt(relay, prompt)).toEqual([task_id]);
    expect(allocationsFor(relay, worker)).toHaveLength(1);
  });

  it("admission is one transaction: a failed enqueue rolls back the hold and releases the key; the retry debits exactly once", async () => {
    const worker = await pricedWorker(relay);
    seedBalance(relay, worker, 5);
    const funded = balanceOf(relay, worker);
    const prompt = `888 atomic ${crypto.randomUUID()}`;
    const key = crypto.randomUUID();

    // Fault injection at the SQL layer: the queued-task insert aborts.
    relay.moteDb.db.exec(
      `CREATE TRIGGER fail_888 BEFORE INSERT ON relay_task_queue WHEN NEW.prompt = '${prompt}'
       BEGIN SELECT RAISE(ABORT, 'forced enqueue failure'); END;`,
    );
    const failed = await submit(worker, key, { prompt });
    expect(failed.status, await failed.clone().text()).toBe(409);
    expect(((await failed.json()) as { code?: string }).code).toBe("ALLOCATION_HOLD_FAILED");
    expect(balanceOf(relay, worker), "the hold rolled back with the enqueue").toBe(funded);
    expect(allocationsFor(relay, worker)).toHaveLength(0);
    expect(tasksWithPrompt(relay, prompt)).toEqual([]);
    expect(claimRow(relay, key, worker), "nothing admitted, so the key is free").toBeUndefined();

    relay.moteDb.db.exec("DROP TRIGGER fail_888");
    const retry = await submit(worker, key, { prompt });
    expect(retry.status, await retry.clone().text()).toBe(201);
    const { task_id } = (await retry.json()) as { task_id: string };
    expect(tasksWithPrompt(relay, prompt)).toEqual([task_id]);
    const holds = allocationsFor(relay, worker);
    expect(holds).toHaveLength(1);
    expect(balanceOf(relay, worker), "debited exactly once").toBe(funded - holds[0]!.amount_locked);
  });
});
