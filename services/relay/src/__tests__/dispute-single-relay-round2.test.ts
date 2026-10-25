/**
 * Single-relay appeal round 2 — spec/dispute-v1.md §8.3: "Single-relay
 * appeals go to operator review with the additional evidence."
 *
 * The appeal parked the dispute in `appealed`, and the operator's round-2
 * verdict at `/resolve` fell into the cached-resolution check, which answered
 * 200 with round 1 and dropped the verdict: no single-relay appeal could ever
 * be decided, and the funds stayed locked. `/resolve` on a single-relay
 * `appealed` dispute now commits the operator's round-2 verdict, with the
 * money derived from the §7.2 table, through the same guarded transaction
 * the federation round 2 uses.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  signDisputeRequest,
  signDisputeAppeal,
  hash as sha256,
} from "@motebit/encryption";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import { JSON_AUTH, createTestRelay, createAgent, seedX402PaidTask } from "./test-helpers.js";

type Keypair = { publicKey: Uint8Array; privateKey: Uint8Array };

let relay: SyncRelay;
afterEach(async () => {
  await relay?.close();
});

interface World {
  wKp: Keypair;
  dKp: Keypair;
  worker: string;
  delegator: string;
  taskId: string;
  allocId: string;
}

/** An x402-paid task, settled by the worker's completed receipt. */
async function settledWorld(): Promise<World> {
  relay = await createTestRelay();
  const wKp = await generateKeypair();
  const dKp = await generateKeypair();
  const worker = await createAgent(relay, bytesToHex(wKp.publicKey));
  const delegator = await createAgent(relay, bytesToHex(dKp.publicKey));
  for (const [a, kp, port] of [
    [worker, wKp, 3200],
    [delegator, dKp, 3201],
  ] as const) {
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: a.motebitId,
        endpoint_url: `http://localhost:${port}/mcp`,
        capabilities: ["web_search"],
        public_key: bytesToHex(kp.publicKey),
      }),
    });
  }
  const taskId = seedX402PaidTask(relay, {
    workerId: worker.motebitId,
    delegatorId: delegator.motebitId,
    prompt: "p",
    unitCostUsd: 1.0,
  });
  const { allocation_id } = relay.moteDb.db
    .prepare("SELECT allocation_id FROM relay_allocations WHERE task_id = ?")
    .get(taskId) as { allocation_id: string };
  const w: World = {
    wKp,
    dKp,
    worker: worker.motebitId,
    delegator: delegator.motebitId,
    taskId,
    allocId: allocation_id,
  };
  const enc = new TextEncoder();
  const receipt = await signExecutionReceipt(
    {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: w.worker as unknown as MotebitId,
      device_id: "svc" as unknown as DeviceId,
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed",
      result: "done",
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: await sha256(enc.encode("p")),
      result_hash: await sha256(enc.encode("done")),
    },
    wKp.privateKey,
  );
  const res = await relay.app.request(`/agent/${w.worker}/task/${taskId}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(receipt),
  });
  expect(res.status).toBe(200);
  return w;
}

async function file(w: World, by: "worker" | "delegator"): Promise<string> {
  const req = await signDisputeRequest(
    {
      dispute_id: `dsp-money-${crypto.randomUUID()}`,
      task_id: w.taskId,
      allocation_id: w.allocId,
      filed_by: by === "worker" ? w.worker : w.delegator,
      respondent: by === "worker" ? w.delegator : w.worker,
      category: "quality",
      description: "d",
      evidence_refs: ["r"],
      filed_at: Date.now(),
    },
    by === "worker" ? w.wKp.privateKey : w.dKp.privateKey,
  );
  const res = await relay.app.request(`/api/v1/allocations/${w.allocId}/dispute`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(req),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { dispute_id: string }).dispute_id;
}

function resolve(disputeId: string, body: Record<string, unknown>) {
  return relay.app.request(`/api/v1/disputes/${disputeId}/resolve`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ rationale: "r", ...body }),
  });
}

const bal = (id: string): number =>
  (
    relay.moteDb.db.prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?").get(id) as
      { balance: number } | undefined
  )?.balance ?? 0;

async function appeal(w: World, disputeId: string, by: "worker" | "delegator") {
  const signed = await signDisputeAppeal(
    {
      dispute_id: disputeId,
      appealed_by: by === "worker" ? w.worker : w.delegator,
      reason: "new evidence",
      appealed_at: Date.now(),
    },
    by === "worker" ? w.wKp.privateKey : w.dKp.privateKey,
  );
  return relay.app.request(`/api/v1/disputes/${disputeId}/appeal`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(signed),
  });
}

const disputeState = (id: string): string =>
  (
    relay.moteDb.db.prepare("SELECT state FROM relay_disputes WHERE dispute_id = ?").get(id) as {
      state: string;
    }
  ).state;

const round2Rows = (id: string): number =>
  (
    relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) AS n FROM relay_dispute_resolutions WHERE dispute_id = ? AND round = 2",
      )
      .get(id) as { n: number }
  ).n;

/** A delegator's dispute, round 1 `overturned` (worker wins), appealed by the delegator. */
async function appealedWorld(): Promise<{ w: World; id: string }> {
  const w = await settledWorld();
  const id = await file(w, "delegator");
  const r1 = await resolve(id, { resolution: "overturned" });
  expect(r1.status).toBe(200);
  const ap = await appeal(w, id, "delegator");
  expect(ap.status).toBe(200);
  expect(disputeState(id)).toBe("appealed");
  return { w, id };
}

describe("single-relay appeal: the operator's round-2 verdict is committed (§8.3)", () => {
  it("an upheld round 2 finalizes the dispute and claws the settlement back to the delegator", async () => {
    const { w, id } = await appealedWorld();
    const workerBefore = bal(w.worker);
    const delegatorBefore = bal(w.delegator);
    expect(workerBefore).toBeGreaterThan(0);

    const res = await resolve(id, { resolution: "upheld" });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({
      state: "final",
      round: 2,
      resolution: "upheld",
      fund_action: "refund_to_delegator",
      split_ratio: 0,
    });
    // On main: 200 with round 1, the dispute still `appealed`, no round-2 row.
    expect(disputeState(id)).toBe("final");
    expect(round2Rows(id)).toBe(1);
    expect(bal(w.worker)).toBe(0);
    expect(bal(w.delegator)).toBe(delegatorBefore + workerBefore);
  });

  it("a repeated round-2 call moves no money twice", async () => {
    const { w, id } = await appealedWorld();
    expect((await resolve(id, { resolution: "upheld" })).status).toBe(200);
    const workerAfter = bal(w.worker);
    const delegatorAfter = bal(w.delegator);
    await resolve(id, { resolution: "overturned" });
    expect(round2Rows(id)).toBe(1);
    expect(disputeState(id)).toBe("final");
    expect(bal(w.worker)).toBe(workerAfter);
    expect(bal(w.delegator)).toBe(delegatorAfter);
  });

  it("refuses a round-2 body the table contradicts, and stays appealed", async () => {
    const { id } = await appealedWorld();
    const res = await resolve(id, { resolution: "upheld", fund_action: "release_to_worker" });
    expect(res.status).toBe(400);
    expect(disputeState(id)).toBe("appealed");
    expect(round2Rows(id)).toBe(0);
  });

  it("refuses a round-2 verdict without a rationale", async () => {
    const { id } = await appealedWorld();
    const res = await relay.app.request(`/api/v1/disputes/${id}/resolve`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ resolution: "upheld" }),
    });
    expect(res.status).toBe(400);
    expect(disputeState(id)).toBe("appealed");
  });
});
