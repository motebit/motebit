/**
 * #918 — one P2P payment proof admits at most one task.
 *
 * The only proof-reuse guard used to read `relay_settlements.p2p_tx_hash`, so
 * it saw SETTLED proofs only. The same unsettled `payment_proof` under a NEW
 * Idempotency-Key admitted and dispatched a second task: two tasks, two
 * dispatches, one payment (the unique settlement index stopped only the
 * second settlement).
 *
 * The fix binds the proof to the task it admits, inside the #888 admission
 * transaction, under a unique claim on the tx hash (`bindP2pProofToTask`,
 * idempotency.ts). A claim exists exactly when its task was admitted: a
 * refusal before admission, or inside the admission transaction, leaves no
 * claim, so a corrected retry admits once.
 *
 * Federated forwards (the 502 guidance, the executor relay's own binding) are
 * covered in federation-e2e.test.ts under "#918".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex, createSignedToken } from "@motebit/encryption";
import { createTestRelay, createAgent, buildP2pPaymentProof, JSON_AUTH } from "./test-helpers.js";
import { toMicro } from "../accounts.js";

const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

let relay: SyncRelay;
beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

interface Agent {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
}

async function newAgent(): Promise<Agent> {
  const kp = await generateKeypair();
  const a = await createAgent(relay, bytesToHex(kp.publicKey));
  return { ...a, privateKey: kp.privateKey };
}

/** A `task:submit` bearer the agent signs with its own device key. */
async function submitBearer(a: Agent): Promise<Record<string, string>> {
  const now = Date.now();
  const token = await createSignedToken(
    {
      mid: a.motebitId,
      did: a.deviceId,
      iat: now,
      exp: now + 300_000,
      jti: crypto.randomUUID(),
      aud: "task:submit",
    },
    a.privateKey,
  );
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function tasksWithPrompt(prompt: string): string[] {
  return (
    relay.moteDb.db
      .prepare("SELECT task_id FROM relay_task_queue WHERE prompt = ?")
      .all(prompt) as { task_id: string }[]
  ).map((r) => r.task_id);
}

function claimOf(txHash: string): { task_id: string; submitted_by: string } | undefined {
  return relay.moteDb.db
    .prepare("SELECT task_id, submitted_by FROM relay_p2p_proof_claims WHERE tx_hash = ?")
    .get(txHash) as { task_id: string; submitted_by: string } | undefined;
}

/** A priced local worker with a P2P settlement address and an open socket. */
async function pricedWorker(): Promise<{ worker: Agent; dispatched: () => number }> {
  const worker = await newAgent();
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: worker.motebitId,
      endpoint_url: "http://127.0.0.1:18999/mcp",
      capabilities: ["web_search"],
      settlement_address: WORKER_SOLANA_ADDR,
      settlement_modes: "relay,p2p",
    }),
  });
  await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "918 worker",
      pay_to_address: WORKER_SOLANA_ADDR,
    }),
  });
  const ws = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  relay.connections.set(worker.motebitId, [
    { ws: ws as never, deviceId: worker.deviceId, capabilities: ["web_search"] },
  ]);
  const dispatched = () =>
    ws.send.mock.calls.filter((call) => String(call[0]).includes('"task_request"')).length;
  return { worker, dispatched };
}

/** An established pair, so P2P eligibility is not under test. */
function establishPair(delegator: string, worker: string): void {
  relay.moteDb.db
    .prepare(
      `INSERT OR REPLACE INTO agent_trust
       (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
       VALUES (?, ?, 'verified', 10, ?, ?)`,
    )
    .run(delegator, worker, Date.now(), Date.now());
}

function newProof() {
  return buildP2pPaymentProof(relay, {
    workerAddress: WORKER_SOLANA_ADDR,
    unitCostMicro: toMicro(0.5),
  });
}

function submit(
  path: string,
  key: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
) {
  return relay.app.request(path, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

function p2pBody(
  prompt: string,
  submitter: string,
  worker: string,
  proof: ReturnType<typeof newProof>,
): Record<string, unknown> {
  return {
    prompt,
    submitted_by: submitter,
    target_agent: worker,
    payment_proof: proof,
    required_capabilities: ["web_search"],
  };
}

describe("#918 one P2P payment proof admits at most one task", () => {
  it("the same proof under a NEW key is refused (409, naming the task to its operator): one task, one dispatch", async () => {
    const delegator = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(delegator.motebitId, worker.motebitId);
    const proof = newProof();
    const prompt = `918 new-key ${crypto.randomUUID()}`;
    const path = `/agent/${delegator.motebitId}/task`;
    const body = p2pBody(prompt, delegator.motebitId, worker.motebitId, proof);

    const first = await submit(path, crypto.randomUUID(), JSON_AUTH, body);
    expect(first.status, await first.clone().text()).toBe(201);
    const { task_id } = (await first.json()) as { task_id: string };
    expect(claimOf(proof.tx_hash)?.task_id, "the proof is bound to the task it admitted").toBe(
      task_id,
    );

    const second = await submit(path, crypto.randomUUID(), JSON_AUTH, body);
    expect(second.status, await second.clone().text()).toBe(409);
    const b2 = (await second.json()) as { code: string; task_id?: string; error: string };
    expect(b2.code).toBe("TASK_P2P_PROOF_ALREADY_ADMITTED");
    expect(b2.task_id, "the operator is entitled to see the admitted task").toBe(task_id);
    expect(b2.error).not.toMatch(/new Idempotency-Key/i);

    expect(tasksWithPrompt(prompt), "no second task").toEqual([task_id]);
    expect(dispatched(), "the worker is sent the task once").toBe(1);

    // The refusal freed its own key: that key is not stuck 'processing'.
    const stuck = relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_idempotency_keys WHERE status = 'processing'")
      .get() as { n: number };
    expect(stuck.n).toBe(0);
  });

  it("the same proof under the SAME key is the #888 replay, unchanged: the first answer, one task, one dispatch", async () => {
    const delegator = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(delegator.motebitId, worker.motebitId);
    const proof = newProof();
    const prompt = `918 same-key ${crypto.randomUUID()}`;
    const path = `/agent/${delegator.motebitId}/task`;
    const body = p2pBody(prompt, delegator.motebitId, worker.motebitId, proof);
    // The #885 client's key IS the proof's tx_hash.
    const key = proof.tx_hash;

    const first = await submit(path, key, JSON_AUTH, body);
    expect(first.status, await first.clone().text()).toBe(201);
    const b1 = (await first.json()) as { task_id: string };

    const replay = await submit(path, key, JSON_AUTH, body);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { task_id: string }).task_id).toBe(b1.task_id);
    expect(tasksWithPrompt(prompt)).toEqual([b1.task_id]);
    expect(dispatched()).toBe(1);
  });

  it("a refusal BEFORE admission writes no claim: the corrected retry — same key or a new one — admits once", async () => {
    const delegator = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    // No trust edge yet: the P2P eligibility gate refuses before admission.
    const proof = newProof();
    const prompt = `918 pre-admission ${crypto.randomUUID()}`;
    const path = `/agent/${delegator.motebitId}/task`;
    const body = p2pBody(prompt, delegator.motebitId, worker.motebitId, proof);
    const key = crypto.randomUUID();

    const refused = await submit(path, key, JSON_AUTH, body);
    expect(refused.status, await refused.clone().text()).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("TASK_P2P_INELIGIBLE");
    expect(claimOf(proof.tx_hash), "a refusal before admission claims nothing").toBeUndefined();
    expect(tasksWithPrompt(prompt)).toEqual([]);

    establishPair(delegator.motebitId, worker.motebitId);
    // The corrected retry under a NEW key: the proof was never spent.
    const retry = await submit(path, crypto.randomUUID(), JSON_AUTH, body);
    expect(retry.status, await retry.clone().text()).toBe(201);
    const { task_id } = (await retry.json()) as { task_id: string };
    expect(tasksWithPrompt(prompt)).toEqual([task_id]);
    expect(claimOf(proof.tx_hash)?.task_id).toBe(task_id);

    // And the original key, still free, now meets the spent proof.
    const again = await submit(path, key, JSON_AUTH, body);
    expect(again.status).toBe(409);
    expect(tasksWithPrompt(prompt)).toEqual([task_id]);
    expect(dispatched()).toBe(1);
  });

  it("a refusal INSIDE the admission transaction rolls the claim back with the task: the retry admits once", async () => {
    const delegator = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(delegator.motebitId, worker.motebitId);
    const proof = newProof();
    const prompt = `918 rollback ${crypto.randomUUID()}`;
    const path = `/agent/${delegator.motebitId}/task`;
    const body = p2pBody(prompt, delegator.motebitId, worker.motebitId, proof);

    // The enqueue — the last write of the admission transaction — aborts once.
    relay.moteDb.db.exec(
      `CREATE TRIGGER zz918_fail_enqueue BEFORE INSERT ON relay_task_queue
       BEGIN SELECT RAISE(ABORT, 'forced failure inside admission'); END;`,
    );
    const failed = await submit(path, crypto.randomUUID(), JSON_AUTH, body);
    expect(failed.status, await failed.clone().text()).toBe(500);
    expect(tasksWithPrompt(prompt)).toEqual([]);
    expect(claimOf(proof.tx_hash), "the rollback undid the claim").toBeUndefined();
    relay.moteDb.db.exec("DROP TRIGGER zz918_fail_enqueue");

    const retry = await submit(path, crypto.randomUUID(), JSON_AUTH, body);
    expect(retry.status, await retry.clone().text()).toBe(201);
    const { task_id } = (await retry.json()) as { task_id: string };
    expect(tasksWithPrompt(prompt)).toEqual([task_id]);
    expect(dispatched()).toBe(1);
  });

  it("another submitter presenting the same proof is refused, and is never told the other principal's task id", async () => {
    const alice = await newAgent();
    const mallory = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(alice.motebitId, worker.motebitId);
    establishPair(mallory.motebitId, worker.motebitId);
    const proof = newProof();
    const prompt = `918 cross ${crypto.randomUUID()}`;

    const first = await submit(
      `/agent/${alice.motebitId}/task`,
      crypto.randomUUID(),
      await submitBearer(alice),
      p2pBody(prompt, alice.motebitId, worker.motebitId, proof),
    );
    expect(first.status, await first.clone().text()).toBe(201);
    const { task_id } = (await first.json()) as { task_id: string };
    expect(claimOf(proof.tx_hash)).toEqual({ task_id, submitted_by: alice.motebitId });

    const stolen = await submit(
      `/agent/${mallory.motebitId}/task`,
      crypto.randomUUID(),
      await submitBearer(mallory),
      // The body even names alice as submitter; the verified token wins.
      p2pBody(prompt, alice.motebitId, worker.motebitId, proof),
    );
    expect(stolen.status, await stolen.clone().text()).toBe(409);
    const raw = await stolen.text();
    const bm = JSON.parse(raw) as { code: string; task_id?: string };
    expect(bm.code).toBe("TASK_P2P_PROOF_ALREADY_ADMITTED");
    expect(bm.task_id).toBeUndefined();
    expect(raw, "the foreign task id appears nowhere in the refusal").not.toContain(task_id);

    // Alice herself, under a new key, is told which task her payment funds.
    const own = await submit(
      `/agent/${alice.motebitId}/task`,
      crypto.randomUUID(),
      await submitBearer(alice),
      p2pBody(prompt, alice.motebitId, worker.motebitId, proof),
    );
    expect(own.status).toBe(409);
    expect(((await own.json()) as { task_id?: string }).task_id).toBe(task_id);

    expect(tasksWithPrompt(prompt)).toEqual([task_id]);
    expect(dispatched()).toBe(1);
  });

  it("two concurrent submissions of one proof under different keys admit exactly one task", async () => {
    const delegator = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(delegator.motebitId, worker.motebitId);
    const proof = newProof();
    const prompt = `918 race ${crypto.randomUUID()}`;
    const path = `/agent/${delegator.motebitId}/task`;
    const body = p2pBody(prompt, delegator.motebitId, worker.motebitId, proof);

    const results = await Promise.all(
      [0, 1, 2, 3].map(async () => submit(path, crypto.randomUUID(), JSON_AUTH, body)),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409]);
    expect(tasksWithPrompt(prompt)).toHaveLength(1);
    expect(dispatched()).toBe(1);
  });

  it("migration v47 backfills: a proof admitted or settled before the upgrade stays spent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zz918-upgrade-"));
    const dbPath = join(dir, "relay.db");
    try {
      await relay.close();
      relay = await createTestRelay({ dbPath });
      const delegator = await newAgent();
      const { worker } = await pricedWorker();
      establishPair(delegator.motebitId, worker.motebitId);
      const queued = newProof();
      const settled = newProof();
      const prompt = `918 upgrade ${crypto.randomUUID()}`;
      const path = `/agent/${delegator.motebitId}/task`;
      const body = p2pBody(prompt, delegator.motebitId, worker.motebitId, queued);
      const first = await submit(path, crypto.randomUUID(), JSON_AUTH, body);
      expect(first.status, await first.clone().text()).toBe(201);
      const { task_id } = (await first.json()) as { task_id: string };
      relay.moteDb.db
        .prepare(
          `INSERT INTO relay_settlements
           (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled,
            platform_fee, platform_fee_rate, status, settled_at, settlement_mode, p2p_tx_hash,
            delegator_id)
           VALUES (?, 'p2p-gone', 'gone-task', ?, 'rh', 500000, 26316, 0.05, 'completed', ?, 'p2p', ?, ?)`,
        )
        .run(
          `s-${crypto.randomUUID()}`,
          worker.motebitId,
          Date.now(),
          settled.tx_hash,
          delegator.motebitId,
        );
      // Back to the pre-v47 shape: no claims table, v47 not recorded.
      relay.moteDb.db.exec(`
        DROP TABLE relay_p2p_proof_claims;
        DELETE FROM relay_schema_migrations WHERE version >= 47;
      `);
      await relay.close();

      relay = await createTestRelay({ dbPath }); // boot runs v47
      expect(claimOf(queued.tx_hash)).toEqual({ task_id, submitted_by: delegator.motebitId });
      expect(claimOf(settled.tx_hash)).toEqual({
        task_id: "gone-task",
        submitted_by: delegator.motebitId,
      });
      establishPair(delegator.motebitId, worker.motebitId);
      const again = await submit(path, crypto.randomUUID(), JSON_AUTH, body);
      expect(again.status, await again.clone().text()).toBe(409);
      expect(((await again.json()) as { task_id?: string }).task_id).toBe(task_id);
      expect(tasksWithPrompt(prompt)).toEqual([task_id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a proof whose task already SETTLED keeps its code (TASK_P2P_PROOF_REPLAYED)", async () => {
    const delegator = await newAgent();
    const { worker } = await pricedWorker();
    establishPair(delegator.motebitId, worker.motebitId);
    const proof = newProof();
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_settlements
         (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled,
          platform_fee, platform_fee_rate, status, settled_at, settlement_mode, p2p_tx_hash)
         VALUES (?, ?, ?, ?, 'rh', 500000, 26316, 0.05, 'completed', ?, 'p2p', ?)`,
      )
      .run(
        `s-${crypto.randomUUID()}`,
        `p2p-old`,
        "old-task",
        worker.motebitId,
        Date.now(),
        proof.tx_hash,
      );
    const res = await submit(
      `/agent/${delegator.motebitId}/task`,
      crypto.randomUUID(),
      JSON_AUTH,
      p2pBody(`918 settled ${crypto.randomUUID()}`, delegator.motebitId, worker.motebitId, proof),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("TASK_P2P_PROOF_REPLAYED");
  });
});
