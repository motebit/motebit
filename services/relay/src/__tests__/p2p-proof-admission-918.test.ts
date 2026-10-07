/**
 * #918 — one P2P payment proof admits at most one task, and only its PAYER
 * may submit it.
 *
 * Round 1: the only proof-reuse guard read `relay_settlements.p2p_tx_hash`,
 * so it saw SETTLED proofs only. The same unsettled `payment_proof` under a
 * NEW Idempotency-Key admitted and dispatched a second task. The fix binds the
 * proof to the task it admits, inside the #888 admission transaction
 * (`bindP2pProofToTask`, idempotency.ts).
 *
 * Round 2: a tx hash is public the moment it lands. With the binding alone, a
 * stranger who submitted the payer's proof first got the task AND locked the
 * payer out forever. So a proof is admissible only from its payer: the tx's
 * payer must be the Solana address the submitter's key derives (p2p-payer.ts),
 * checked before any admission write, failing closed when the chain cannot be
 * read.
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
import type { SolanaRpcAdapter } from "@motebit/wallet-solana";
import {
  createTestRelay,
  createAgent,
  buildP2pPaymentProof,
  createFakePaymentChain,
  walletOf,
  JSON_AUTH,
  type FakePaymentChain,
  INSECURE_DEV_POSTURE,
} from "./test-helpers.js";
import { toMicro } from "../accounts.js";
import { mayDiscloseAdmittedTask } from "../tasks.js";
import { paymentChainFromAdapter } from "../p2p-payer.js";

const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

let relay: SyncRelay;
let chain: FakePaymentChain;
beforeEach(async () => {
  // Strict chain: an unregistered tx hash is not found. Every proof in this
  // file is registered with its real payer.
  chain = createFakePaymentChain("absent");
  relay = await createTestRelay({ p2pPaymentChain: chain });
});
afterEach(async () => {
  await relay.close();
});

interface Agent {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
  publicKeyHex: string;
}

async function newAgent(): Promise<Agent> {
  const kp = await generateKeypair();
  const publicKeyHex = bytesToHex(kp.publicKey);
  const a = await createAgent(relay, publicKeyHex);
  return { ...a, privateKey: kp.privateKey, publicKeyHex };
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

interface ClaimRow {
  task_id: string;
  submitted_by: string;
  submitter_verified: number;
}

function claimOf(txHash: string): ClaimRow | undefined {
  return relay.moteDb.db
    .prepare(
      "SELECT task_id, submitted_by, submitter_verified FROM relay_p2p_proof_claims WHERE tx_hash = ?",
    )
    .get(txHash) as ClaimRow | undefined;
}

/** A priced local worker with a P2P settlement address and an open socket. */
async function pricedWorker(): Promise<{
  worker: Agent;
  dispatched: () => number;
  prompts: () => string[];
}> {
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
  const requests = () =>
    ws.send.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { type: string; task?: { prompt: string } })
      .filter((m) => m.type === "task_request");
  return {
    worker,
    dispatched: () => requests().length,
    prompts: () => requests().map((m) => m.task!.prompt),
  };
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

/** A proof whose transaction `payer` paid (registered on the fake chain). */
function paidBy(payer: Agent) {
  const proof = buildP2pPaymentProof(relay, {
    workerAddress: WORKER_SOLANA_ADDR,
    unitCostMicro: toMicro(0.5),
  });
  chain.pay(proof.tx_hash, walletOf(payer.publicKeyHex));
  return proof;
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
  proof: ReturnType<typeof paidBy>,
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
  it("the same proof under a NEW key is refused (409, naming the task to the operator): one task, one dispatch", async () => {
    const delegator = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(delegator.motebitId, worker.motebitId);
    const proof = paidBy(delegator);
    const prompt = `918 new-key ${crypto.randomUUID()}`;
    const path = `/agent/${delegator.motebitId}/task`;
    const body = p2pBody(prompt, delegator.motebitId, worker.motebitId, proof);

    const first = await submit(path, crypto.randomUUID(), JSON_AUTH, body);
    expect(first.status, await first.clone().text()).toBe(201);
    const { task_id } = (await first.json()) as { task_id: string };
    expect(claimOf(proof.tx_hash), "bound to the task; the submitter was asserted").toEqual({
      task_id,
      submitted_by: delegator.motebitId,
      submitter_verified: 0,
    });

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

  it("the payer's own same-key retry is the #888 replay, unchanged: the first answer, one task, one dispatch", async () => {
    const delegator = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(delegator.motebitId, worker.motebitId);
    const proof = paidBy(delegator);
    const prompt = `918 same-key ${crypto.randomUUID()}`;
    const path = `/agent/${delegator.motebitId}/task`;
    const body = p2pBody(prompt, delegator.motebitId, worker.motebitId, proof);
    // The #885 client's key IS the proof's tx_hash, and it signs its own token.
    const key = proof.tx_hash;

    const first = await submit(path, key, await submitBearer(delegator), body);
    expect(first.status, await first.clone().text()).toBe(201);
    const b1 = (await first.json()) as { task_id: string };

    const replay = await submit(path, key, await submitBearer(delegator), body);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { task_id: string }).task_id).toBe(b1.task_id);
    expect(tasksWithPrompt(prompt)).toEqual([b1.task_id]);
    expect(dispatched()).toBe(1);
  });

  it("a refusal BEFORE admission writes no claim: the corrected retry — same key or a new one — admits once", async () => {
    const delegator = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    // No trust edge yet: the P2P eligibility gate refuses before admission.
    const proof = paidBy(delegator);
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
    const proof = paidBy(delegator);
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

  it("two concurrent submissions of one proof under different keys admit exactly one task", async () => {
    const delegator = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(delegator.motebitId, worker.motebitId);
    const proof = paidBy(delegator);
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
      relay = await createTestRelay({ dbPath, p2pPaymentChain: chain });
      const delegator = await newAgent();
      const { worker } = await pricedWorker();
      establishPair(delegator.motebitId, worker.motebitId);
      const queued = paidBy(delegator);
      const settled = paidBy(delegator);
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

      relay = await createTestRelay({ dbPath, p2pPaymentChain: chain }); // boot runs v47
      expect(claimOf(queued.tx_hash)).toEqual({
        task_id,
        submitted_by: delegator.motebitId,
        submitter_verified: 0,
      });
      expect(claimOf(settled.tx_hash)).toEqual({
        task_id: "gone-task",
        submitted_by: delegator.motebitId,
        submitter_verified: 0,
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
    const proof = paidBy(delegator);
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

describe("#918 round 2: a proof is admissible only from its payer", () => {
  it("a stranger front-running the payer's public proof is refused (403, no claim); the payer then admits once and the worker runs only the payer's task", async () => {
    const victim = await newAgent();
    const mallory = await newAgent();
    const { worker, dispatched, prompts } = await pricedWorker();
    establishPair(victim.motebitId, worker.motebitId);
    const proof = paidBy(victim);
    const victimPrompt = `918 victim ${crypto.randomUUID()}`;
    const malloryPrompt = `918 mallory ${crypto.randomUUID()}`;

    // Mallory saw the victim's tx land and submits it first, under her own
    // route and prompt, with her own verified token and the cold-start ack.
    const stolen = await submit(
      `/agent/${mallory.motebitId}/task`,
      crypto.randomUUID(),
      await submitBearer(mallory),
      {
        ...p2pBody(malloryPrompt, mallory.motebitId, worker.motebitId, proof),
        delegator_acknowledges_no_history_risk: true,
      },
    );
    expect(stolen.status, await stolen.clone().text()).toBe(403);
    expect(((await stolen.json()) as { code: string }).code).toBe("TASK_P2P_PROOF_NOT_PAYER");
    expect(claimOf(proof.tx_hash), "a non-payer claims nothing").toBeUndefined();
    expect(tasksWithPrompt(malloryPrompt)).toEqual([]);

    // Even naming the victim as submitter in the body: the verified token's
    // key is what must have paid.
    const posing = await submit(
      `/agent/${mallory.motebitId}/task`,
      crypto.randomUUID(),
      await submitBearer(mallory),
      p2pBody(malloryPrompt, victim.motebitId, worker.motebitId, proof),
    );
    expect(posing.status).toBe(403);

    const own = await submit(
      `/agent/${victim.motebitId}/task`,
      crypto.randomUUID(),
      await submitBearer(victim),
      p2pBody(victimPrompt, victim.motebitId, worker.motebitId, proof),
    );
    expect(own.status, await own.clone().text()).toBe(201);
    const { task_id } = (await own.json()) as { task_id: string };
    expect(claimOf(proof.tx_hash)).toEqual({
      task_id,
      submitted_by: victim.motebitId,
      submitter_verified: 1,
    });
    expect(tasksWithPrompt(victimPrompt)).toEqual([task_id]);
    expect(dispatched()).toBe(1);
    expect(prompts()).toEqual([victimPrompt]);
  });

  it("the operator's submission for a body submitter is checked against the keys held for that identity", async () => {
    const alice = await newAgent();
    const mallory = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(alice.motebitId, worker.motebitId);
    const malloryPaid = paidBy(mallory);
    const refused = await submit(
      `/agent/${alice.motebitId}/task`,
      crypto.randomUUID(),
      JSON_AUTH,
      p2pBody(`918 op ${crypto.randomUUID()}`, alice.motebitId, worker.motebitId, malloryPaid),
    );
    expect(refused.status, await refused.clone().text()).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("TASK_P2P_PROOF_NOT_PAYER");
    expect(dispatched()).toBe(0);
  });

  it("the chain cannot be read (RPC down, tx not visible yet, or no RPC configured) ⇒ 503, nothing admitted, the key freed; the retry admits once", async () => {
    const delegator = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(delegator.motebitId, worker.motebitId);
    const proof = paidBy(delegator);
    const prompt = `918 unverified ${crypto.randomUUID()}`;
    const path = `/agent/${delegator.motebitId}/task`;
    const body = p2pBody(prompt, delegator.motebitId, worker.motebitId, proof);
    const key = crypto.randomUUID();

    chain.down = true;
    const down = await submit(path, key, JSON_AUTH, body);
    expect(down.status, await down.clone().text()).toBe(503);
    expect(((await down.json()) as { code: string }).code).toBe("TASK_P2P_PROOF_UNVERIFIED");
    chain.down = false;

    const unseen = buildP2pPaymentProof(relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    const notYet = await submit(
      path,
      crypto.randomUUID(),
      JSON_AUTH,
      p2pBody(`918 unseen ${crypto.randomUUID()}`, delegator.motebitId, worker.motebitId, unseen),
    );
    expect(notYet.status).toBe(503);
    expect(claimOf(unseen.tx_hash)).toBeUndefined();
    expect(claimOf(proof.tx_hash)).toBeUndefined();
    expect(tasksWithPrompt(prompt)).toEqual([]);

    // The same key, once the chain answers: admitted exactly once.
    const retry = await submit(path, key, JSON_AUTH, body);
    expect(retry.status, await retry.clone().text()).toBe(201);
    expect(tasksWithPrompt(prompt)).toHaveLength(1);
    expect(dispatched()).toBe(1);

    // No chain configured at all: every P2P submission is refused.
    await relay.close();
    relay = await createTestRelay({ p2pPaymentChain: null });
    const d2 = await newAgent();
    const w2 = await pricedWorker();
    establishPair(d2.motebitId, w2.worker.motebitId);
    const res = await submit(
      `/agent/${d2.motebitId}/task`,
      crypto.randomUUID(),
      JSON_AUTH,
      p2pBody(`918 no-rpc ${crypto.randomUUID()}`, d2.motebitId, w2.worker.motebitId, paidBy(d2)),
    );
    expect(res.status).toBe(503);
    expect(w2.dispatched()).toBe(0);
  });

  it("disclosure: the task id goes to a verified submitter of a verified admission, never to an asserted one", async () => {
    const alice = await newAgent();
    const { worker } = await pricedWorker();
    establishPair(alice.motebitId, worker.motebitId);

    // Admitted by alice's own token: her later new-key refusal names the task.
    const p1 = paidBy(alice);
    const prompt1 = `918 disclose ${crypto.randomUUID()}`;
    const a1 = await submit(
      `/agent/${alice.motebitId}/task`,
      crypto.randomUUID(),
      await submitBearer(alice),
      p2pBody(prompt1, alice.motebitId, worker.motebitId, p1),
    );
    expect(a1.status).toBe(201);
    const t1 = ((await a1.json()) as { task_id: string }).task_id;
    const again1 = await submit(
      `/agent/${alice.motebitId}/task`,
      crypto.randomUUID(),
      await submitBearer(alice),
      p2pBody(prompt1, alice.motebitId, worker.motebitId, p1),
    );
    expect(again1.status).toBe(409);
    expect(((await again1.json()) as { task_id?: string }).task_id).toBe(t1);

    // Admitted by the operator asserting alice: alice's own token is refused
    // WITHOUT the id — the admission never proved who submitted it.
    const p2 = paidBy(alice);
    const prompt2 = `918 asserted ${crypto.randomUUID()}`;
    const a2 = await submit(
      `/agent/${alice.motebitId}/task`,
      crypto.randomUUID(),
      JSON_AUTH,
      p2pBody(prompt2, alice.motebitId, worker.motebitId, p2),
    );
    expect(a2.status).toBe(201);
    const t2 = ((await a2.json()) as { task_id: string }).task_id;
    const again2 = await submit(
      `/agent/${alice.motebitId}/task`,
      crypto.randomUUID(),
      await submitBearer(alice),
      p2pBody(prompt2, alice.motebitId, worker.motebitId, p2),
    );
    expect(again2.status).toBe(409);
    const raw = await again2.text();
    expect((JSON.parse(raw) as { task_id?: string }).task_id).toBeUndefined();
    expect(raw).not.toContain(t2);
  });

  it("mayDiscloseAdmittedTask: the operator is never inferred from an unset caller id", () => {
    const verifiedClaim = { task_id: "t", submitted_by: "alice", submitter_verified: 1 as const };
    const assertedClaim = { task_id: "t", submitted_by: "alice", submitter_verified: 0 as const };
    // No caller id and no positive operator mark — e.g. a relay with no API
    // token configured, where the submit route authenticates nobody.
    expect(
      mayDiscloseAdmittedTask(verifiedClaim, { operator: false, verifiedCaller: undefined }),
    ).toBe(false);
    expect(
      mayDiscloseAdmittedTask(assertedClaim, { operator: false, verifiedCaller: undefined }),
    ).toBe(false);
    expect(mayDiscloseAdmittedTask(verifiedClaim, { operator: false, verifiedCaller: "" })).toBe(
      false,
    );
    expect(
      mayDiscloseAdmittedTask(verifiedClaim, { operator: true, verifiedCaller: undefined }),
    ).toBe(true);
    expect(
      mayDiscloseAdmittedTask(verifiedClaim, { operator: false, verifiedCaller: "alice" }),
    ).toBe(true);
    expect(
      mayDiscloseAdmittedTask(verifiedClaim, { operator: false, verifiedCaller: "mallory" }),
    ).toBe(false);
    expect(
      mayDiscloseAdmittedTask(assertedClaim, { operator: false, verifiedCaller: "alice" }),
    ).toBe(false);
  });

  it("paymentChainFromAdapter: the payer is the tx's `from`, compared exactly; RPC errors and throws are unavailable", async () => {
    const tx = (
      r: Awaited<ReturnType<SolanaRpcAdapter["getTransaction"]>>,
    ): Pick<SolanaRpcAdapter, "getTransaction"> => ({ getTransaction: async () => r });
    const confirmed = (from: string): Awaited<ReturnType<SolanaRpcAdapter["getTransaction"]>> => ({
      status: "confirmed",
      from,
      transfers: [],
      slot: 1,
      asset: "USDC",
    });
    const payer = walletOf("11".repeat(32));
    const other = walletOf("22".repeat(32));
    const cands = new Set([payer]);
    expect(await paymentChainFromAdapter(tx(confirmed(payer))).payerOf("h", cands)).toEqual({
      status: "payer",
    });
    expect(await paymentChainFromAdapter(tx(confirmed(other))).payerOf("h", cands)).toEqual({
      status: "not_payer",
    });
    expect(
      await paymentChainFromAdapter(tx(confirmed(payer.toLowerCase()))).payerOf("h", cands),
    ).toEqual({ status: "not_payer" });
    expect(await paymentChainFromAdapter(tx({ status: "not_found" })).payerOf("h", cands)).toEqual({
      status: "not_found",
    });
    expect(
      await paymentChainFromAdapter(tx({ status: "rpc_error", reason: "x" })).payerOf("h", cands),
    ).toEqual({ status: "unavailable", reason: "x" });
    const throwing: Pick<SolanaRpcAdapter, "getTransaction"> = {
      getTransaction: () => Promise.reject(new Error("boom")),
    };
    expect(await paymentChainFromAdapter(throwing).payerOf("h", cands)).toEqual({
      status: "unavailable",
      reason: "boom",
    });
  });

  it("a hung payer read is bounded: the submitter gets a retryable 503, nothing admitted, the key freed", async () => {
    const hanging: Pick<SolanaRpcAdapter, "getTransaction"> = {
      getTransaction: () => new Promise(() => {}),
    };
    const verdict = await paymentChainFromAdapter(hanging, { timeoutMs: 20 }).payerOf(
      "h",
      new Set(["x"]),
    );
    expect(verdict.status).toBe("unavailable");

    await relay.close();
    relay = await createTestRelay({
      p2pPaymentChain: paymentChainFromAdapter(hanging, { timeoutMs: 50 }),
    });
    const delegator = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(delegator.motebitId, worker.motebitId);
    const proof = buildP2pPaymentProof(relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    const prompt = `918 hung ${crypto.randomUUID()}`;
    const res = await submit(
      `/agent/${delegator.motebitId}/task`,
      crypto.randomUUID(),
      JSON_AUTH,
      p2pBody(prompt, delegator.motebitId, worker.motebitId, proof),
    );
    expect(res.status, await res.clone().text()).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("TASK_P2P_PROOF_UNVERIFIED");
    expect(tasksWithPrompt(prompt)).toEqual([]);
    expect(claimOf(proof.tx_hash)).toBeUndefined();
    expect(dispatched()).toBe(0);
    const stuck = relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_idempotency_keys WHERE status = 'processing'")
      .get() as { n: number };
    expect(stuck.n).toBe(0);
  });

  it("a relay with NO API token (the submit route authenticates nobody): an anonymous caller naming the payer in submitted_by is refused NOT_PAYER — never treated as the operator", async () => {
    await relay.close();
    relay = await createTestRelay({
      apiToken: undefined,
      authPosture: INSECURE_DEV_POSTURE,
      p2pPaymentChain: chain,
    });
    const victim = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(victim.motebitId, worker.motebitId);
    const proof = paidBy(victim);
    const prompt = `918 anon ${crypto.randomUUID()}`;
    const res = await submit(
      `/agent/${victim.motebitId}/task`,
      crypto.randomUUID(),
      { "Content-Type": "application/json" },
      p2pBody(prompt, victim.motebitId, worker.motebitId, proof),
    );
    expect(res.status, await res.clone().text()).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("TASK_P2P_PROOF_NOT_PAYER");
    expect(claimOf(proof.tx_hash)).toBeUndefined();
    expect(tasksWithPrompt(prompt)).toEqual([]);
    expect(dispatched()).toBe(0);
  });

  it("end to end through the production comparison: a stub RPC whose tx was paid by the victim admits the victim and refuses the stranger", async () => {
    const payers = new Map<string, string>();
    const rpc: Pick<SolanaRpcAdapter, "getTransaction"> = {
      getTransaction: async (sig) => {
        const from = payers.get(sig);
        return from == null
          ? { status: "not_found" }
          : { status: "confirmed", from, transfers: [], slot: 1, asset: "USDC" };
      },
    };
    await relay.close();
    relay = await createTestRelay({ p2pPaymentChain: paymentChainFromAdapter(rpc) });
    const victim = await newAgent();
    const mallory = await newAgent();
    const { worker, dispatched } = await pricedWorker();
    establishPair(victim.motebitId, worker.motebitId);
    establishPair(mallory.motebitId, worker.motebitId);
    const proof = buildP2pPaymentProof(relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    payers.set(proof.tx_hash, walletOf(victim.publicKeyHex));

    const stolen = await submit(
      `/agent/${mallory.motebitId}/task`,
      crypto.randomUUID(),
      await submitBearer(mallory),
      p2pBody(`918 rpc-m ${crypto.randomUUID()}`, mallory.motebitId, worker.motebitId, proof),
    );
    expect(stolen.status).toBe(403);
    const own = await submit(
      `/agent/${victim.motebitId}/task`,
      crypto.randomUUID(),
      await submitBearer(victim),
      p2pBody(`918 rpc-v ${crypto.randomUUID()}`, victim.motebitId, worker.motebitId, proof),
    );
    expect(own.status, await own.clone().text()).toBe(201);
    expect(dispatched()).toBe(1);
  });
});
