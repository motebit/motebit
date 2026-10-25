/**
 * Single-relay `/resolve`: the signed resolution is the money that moves
 * (spec/dispute-v1.md §7.2 / §7.3).
 *
 * The operator's body supplied `fund_action` and `split_ratio` independently,
 * and `executeFundAction` moves money by `split_ratio` alone. An omitted
 * ratio defaulted by outcome only (`upheld → 0` whoever filed), so a worker's
 * upheld dispute was recorded as `release_to_worker` while the worker's whole
 * settlement was clawed back to the delegator. Both fields are now derived
 * from the `(resolution, filer_role)` table, as on the federation path; a body
 * that contradicts the table is refused before anything is written.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { deriveSingleRelayFundAction } from "../disputes.js";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  signDisputeRequest,
  hash as sha256,
} from "@motebit/encryption";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import {
  AUTH_HEADER,
  JSON_AUTH,
  createTestRelay,
  createAgent,
  seedX402PaidTask,
} from "./test-helpers.js";

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

/** Close the appeal window and read: the lazy finalize executes the fund action. */
async function finalize(disputeId: string): Promise<void> {
  relay.moteDb.db
    .prepare("UPDATE relay_disputes SET resolved_at = ? WHERE dispute_id = ?")
    .run(Date.now() - 25 * 3600_000, disputeId);
  await relay.app.request(`/api/v1/disputes/${disputeId}`, { headers: AUTH_HEADER });
}

const bal = (id: string): number =>
  (
    relay.moteDb.db.prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?").get(id) as
      { balance: number } | undefined
  )?.balance ?? 0;

const resolutionRows = (disputeId: string): number =>
  (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_dispute_resolutions WHERE dispute_id = ?")
      .get(disputeId) as { n: number }
  ).n;

describe("single-relay /resolve: the signed resolution is the money that moves", () => {
  it("a worker's upheld dispute with no split_ratio leaves the worker's settlement in place", async () => {
    const w = await settledWorld();
    const id = await file(w, "worker");
    const workerBefore = bal(w.worker);
    const delegatorBefore = bal(w.delegator);
    expect(workerBefore).toBeGreaterThan(0);

    const res = await resolve(id, { resolution: "upheld", fund_action: "release_to_worker" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fund_action: string; split_ratio: number };
    expect(body).toMatchObject({ fund_action: "release_to_worker", split_ratio: 1 });
    await finalize(id);

    // On main: worker −workerBefore, delegator +workerBefore.
    expect(bal(w.worker)).toBe(workerBefore);
    expect(bal(w.delegator)).toBe(delegatorBefore);
  });

  it("a delegator's upheld dispute claws the settlement back to the delegator", async () => {
    const w = await settledWorld();
    const id = await file(w, "delegator");
    const workerBefore = bal(w.worker);
    const delegatorBefore = bal(w.delegator);

    const res = await resolve(id, { resolution: "upheld" });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({
      fund_action: "refund_to_delegator",
      split_ratio: 0,
    });
    await finalize(id);

    expect(bal(w.worker)).toBe(0);
    expect(bal(w.delegator)).toBe(delegatorBefore + workerBefore);
  });

  it("refuses a fund_action the table contradicts, and writes no resolution", async () => {
    const w = await settledWorld();
    const id = await file(w, "worker");
    const res = await resolve(id, { resolution: "upheld", fund_action: "refund_to_delegator" });
    expect(res.status).toBe(400);
    expect(resolutionRows(id)).toBe(0);
  });

  it("refuses a split_ratio the table contradicts for a non-split verdict", async () => {
    const w = await settledWorld();
    const id = await file(w, "worker");
    const res = await resolve(id, { resolution: "upheld", split_ratio: 0 });
    expect(res.status).toBe(400);
    expect(resolutionRows(id)).toBe(0);
  });

  it("refuses an unknown resolution", async () => {
    const w = await settledWorld();
    const id = await file(w, "worker");
    const res = await resolve(id, { resolution: "maybe" });
    expect(res.status).toBe(400);
    expect(resolutionRows(id)).toBe(0);
  });
});

describe("deriveSingleRelayFundAction — the §7.2 table", () => {
  const cells: Array<[string, "worker" | "delegator" | null, string, number]> = [
    ["upheld", "worker", "release_to_worker", 1],
    ["upheld", "delegator", "refund_to_delegator", 0],
    ["overturned", "worker", "refund_to_delegator", 0],
    ["overturned", "delegator", "release_to_worker", 1],
    ["upheld", null, "split", 1],
    ["overturned", null, "split", 0],
  ];
  for (const [resolution, role, fundAction, ratio] of cells) {
    it(`${resolution} × ${role ?? "legacy"} → ${fundAction} @ ${ratio}`, () => {
      expect(deriveSingleRelayFundAction({ resolution }, role)).toEqual({
        fund_action: fundAction,
        split_ratio: ratio,
      });
      // The derived pair, stated explicitly, is accepted.
      expect(
        deriveSingleRelayFundAction(
          { resolution, fund_action: fundAction, split_ratio: ratio },
          role,
        ),
      ).toEqual({ fund_action: fundAction, split_ratio: ratio });
    });
  }

  it("split keeps the adjudicator's ratio, 0.5 when omitted", () => {
    expect(deriveSingleRelayFundAction({ resolution: "split" }, "worker")).toEqual({
      fund_action: "split",
      split_ratio: 0.5,
    });
    expect(
      deriveSingleRelayFundAction({ resolution: "split", split_ratio: 0.3 }, "delegator"),
    ).toEqual({ fund_action: "split", split_ratio: 0.3 });
  });

  it("refuses a ratio outside [0, 1] or not a number", () => {
    for (const split_ratio of [-0.1, 1.5, Number.NaN, "0.5"]) {
      expect(
        "refused" in deriveSingleRelayFundAction({ resolution: "split", split_ratio }, "worker"),
      ).toBe(true);
    }
  });
});
