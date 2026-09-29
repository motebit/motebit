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
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

const DAY = 24 * 60 * 60 * 1000;

function admitByKey(relay: SyncRelay, key: string, motebitId: string, taskId: string, at: number) {
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_idempotency_keys (idempotency_key, motebit_id, status, response_status, response_body, created_at, completed_at, task_id)
       VALUES (?, ?, 'completed', 201, ?, ?, ?, ?)`,
    )
    .run(key, motebitId, JSON.stringify({ task_id: taskId }), at, at, taskId);
}

function archiveReceipt(relay: SyncRelay, taskId: string, status: "completed" | "failed") {
  const receipt = {
    task_id: taskId,
    relay_task_id: taskId,
    motebit_id: "worker-1",
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
       VALUES ('worker-1', ?, NULL, 0, ?, 'motebit-jcs-ed25519-b64-v1', 'pk', 'sig', NULL, ?, ?)`,
    )
    .run(taskId, status, JSON.stringify(receipt), Date.now());
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
