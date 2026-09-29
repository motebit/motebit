/**
 * #890 round 4, finding 3 — a delegator holding a task id must be able to
 * learn how the task ended after the relay dropped it from its queue.
 *
 * The queue forgets a task minutes after its receipt; the Idempotency-Key
 * record that admitted it lives 24 h and the signed receipt is archived in
 * `relay_receipts`. `GET /agent/:id/task/:taskId` now answers an evicted
 * task from that archive — but ONLY for a task one of the requesting agent's
 * own keys admitted, and only while that key is inside the idempotency
 * window. Otherwise it is 404, which the delegator treats as UNKNOWN (hold),
 * never as failure.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, createTestRelay, createAgent } from "./test-helpers.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation and token signing
import { generateKeypair, bytesToHex, createSignedToken } from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";

const DAY = 24 * 60 * 60 * 1000;

function admitByKey(relay: SyncRelay, key: string, motebitId: string, taskId: string, at: number) {
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_idempotency_keys (idempotency_key, motebit_id, status, response_status, response_body, created_at, completed_at, task_id)
       VALUES (?, ?, 'completed', 201, ?, ?, ?, ?)`,
    )
    .run(key, motebitId, JSON.stringify({ task_id: taskId }), at, at, taskId);
}

function archiveReceipt(
  relay: SyncRelay,
  taskId: string,
  status: "completed" | "failed",
  signer = "worker-1",
) {
  const receipt = {
    task_id: taskId,
    relay_task_id: taskId,
    motebit_id: signer,
    device_id: "dev",
    submitted_at: 1,
    completed_at: 2,
    status,
    result: status === "completed" ? "the work" : "could not",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
  };
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_receipts (motebit_id, task_id, parent_task_id, depth, status, suite, public_key, signature, invocation_origin, receipt_json, received_at)
       VALUES (?, ?, NULL, 0, ?, 'motebit-jcs-ed25519-b64-v1', 'pk', 'sig', NULL, ?, ?)`,
    )
    .run(signer, taskId, status, JSON.stringify(receipt), Date.now());
}

async function poll(relay: SyncRelay, motebitId: string, taskId: string) {
  const resp = await relay.app.request(`/agent/${motebitId}/task/${taskId}`, {
    headers: AUTH_HEADER,
  });
  return {
    status: resp.status,
    body: (await resp.json()) as { receipt?: { status: string; task_id: string } | null },
  };
}

describe("#890 r4: an evicted task is answered from the receipt archive", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  it("the task this agent's own key admitted: the archived signed receipt, after eviction", async () => {
    admitByKey(relay, "plan-step:p:s:0", "agent-a", "task-evicted", Date.now() - 60 * 60 * 1000);
    archiveReceipt(relay, "task-evicted", "completed");
    const r = await poll(relay, "agent-a", "task-evicted");
    expect(r.status).toBe(200);
    expect(r.body.receipt?.status).toBe("completed");
    expect(r.body.receipt?.task_id).toBe("task-evicted");
  });

  it("a failed receipt is answered too — the delegator's evidence to rotate", async () => {
    admitByKey(relay, "plan-step:p:s:0", "agent-a", "task-failed", Date.now());
    archiveReceipt(relay, "task-failed", "failed");
    const r = await poll(relay, "agent-a", "task-failed");
    expect(r.status).toBe(200);
    expect(r.body.receipt?.status).toBe("failed");
  });

  it("a task ANOTHER agent's key admitted is not answered for this agent", async () => {
    admitByKey(relay, "plan-step:p:s:0", "agent-b", "task-theirs", Date.now());
    archiveReceipt(relay, "task-theirs", "completed");
    expect((await poll(relay, "agent-a", "task-theirs")).status).toBe(404);
    expect((await poll(relay, "agent-b", "task-theirs")).status).toBe(200);
  });

  it("past the idempotency window the archive does not answer (the key could admit anew)", async () => {
    admitByKey(relay, "plan-step:p:s:0", "agent-a", "task-old", Date.now() - DAY - 60_000);
    archiveReceipt(relay, "task-old", "completed");
    expect((await poll(relay, "agent-a", "task-old")).status).toBe(404);
  });

  it("no archived receipt: still 404 (unknown to the delegator, never failure)", async () => {
    admitByKey(relay, "plan-step:p:s:0", "agent-a", "task-noreceipt", Date.now());
    expect((await poll(relay, "agent-a", "task-noreceipt")).status).toBe(404);
  });
});

function settle(relay: SyncRelay, taskId: string, payee: string) {
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled, platform_fee, status, settled_at)
       VALUES (?, ?, ?, ?, 'h', 0, 0, 'completed', ?)`,
    )
    .run(crypto.randomUUID(), crypto.randomUUID(), taskId, payee, Date.now());
}

describe("#890 r5 (3ii): the archive answers only the task's own worker's receipt", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  it("a second, FOREIGN-signed receipt under the same task id makes the answer ambiguous: 404, never the foreign one", async () => {
    admitByKey(relay, "plan-step:p:s:0", "agent-a", "task-v", Date.now());
    archiveReceipt(relay, "task-v", "completed", "routed-worker");
    archiveReceipt(relay, "task-v", "failed", "evil-worker");
    expect((await poll(relay, "agent-a", "task-v")).status).toBe(404);
  });

  it("with a settlement record, the archive answers the receipt of the worker the task settled to", async () => {
    admitByKey(relay, "plan-step:p:s:0", "agent-a", "task-s", Date.now());
    archiveReceipt(relay, "task-s", "completed", "routed-worker");
    archiveReceipt(relay, "task-s", "failed", "evil-worker");
    settle(relay, "task-s", "routed-worker");
    const r = await poll(relay, "agent-a", "task-s");
    expect(r.status).toBe(200);
    expect(r.body.receipt?.status).toBe("completed");
  });

  it("a receipt from anyone but the settled worker is never answered", async () => {
    admitByKey(relay, "plan-step:p:s:0", "agent-a", "task-e", Date.now());
    archiveReceipt(relay, "task-e", "failed", "evil-worker");
    settle(relay, "task-e", "routed-worker");
    expect((await poll(relay, "agent-a", "task-e")).status).toBe(404);
  });
});

describe("#890 r5 (3i): the archive's caller boundary, with device tokens", () => {
  let relay: SyncRelay;
  interface Party {
    id: string;
    device: string;
    kp: KeyPair;
  }
  let owner: Party;
  let stranger: Party;
  let worker: Party;

  async function party(): Promise<Party> {
    const kp = await generateKeypair();
    const a = await createAgent(relay, bytesToHex(kp.publicKey));
    return { id: a.motebitId, device: a.deviceId, kp };
  }

  async function token(p: Party, aud: string): Promise<string> {
    const now = Date.now();
    return createSignedToken(
      {
        mid: p.id,
        did: p.device,
        iat: now,
        exp: now + 5 * 60 * 1000,
        jti: crypto.randomUUID(),
        aud,
      },
      p.kp.privateKey,
    );
  }

  async function pollAs(p: Party, path: string, taskId: string, aud = "task:query") {
    const resp = await relay.app.request(`/agent/${path}/task/${taskId}`, {
      headers: { Authorization: `Bearer ${await token(p, aud)}` },
    });
    return resp.status;
  }

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: true });
    owner = await party();
    stranger = await party();
    worker = await party();
    admitByKey(relay, "plan-step:p:s:0", owner.id, "task-owned", Date.now());
    archiveReceipt(relay, "task-owned", "completed", worker.id);
  });
  afterEach(async () => {
    await relay.close();
  });

  it("the owner on its own path: 200", async () => {
    expect(await pollAs(owner, owner.id, "task-owned")).toBe(200);
  });

  it("a stranger on the owner's path: 404 — the archive never answers another agent's task", async () => {
    expect(await pollAs(stranger, owner.id, "task-owned")).toBe(404);
  });

  it("a stranger on its own path: 404 — no key of its admitted the task", async () => {
    expect(await pollAs(stranger, stranger.id, "task-owned")).toBe(404);
  });

  it("the worker on the owner's path: 404", async () => {
    expect(await pollAs(worker, owner.id, "task-owned")).toBe(404);
  });

  it("the owner with a token for another audience: 403", async () => {
    expect(await pollAs(owner, owner.id, "task-owned", "sync")).toBe(403);
  });
});
