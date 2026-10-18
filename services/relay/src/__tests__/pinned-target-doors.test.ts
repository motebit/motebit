/**
 * The pin's doors, each on its own (task-pin.ts).
 *
 * `pinned-target-only-executor.test.ts` drives the routes end to end, where
 * the doors cover each other: a substitute is never routed, so its receipt
 * never arrives; were it to arrive, the answer door refuses it before the
 * settlement step runs. This file takes the cover away so each door is seen
 * holding alone — the answer door is mocked permissive here, and settlement
 * attribution must still refuse to pay anyone but the target.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  hash as sha256,
  // eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
} from "@motebit/encryption";
import type { SyncRelay } from "../index.js";
import { recordTaskRoute } from "../task-routing.js";
import { TaskQueue } from "../task-queue.js";
import { candidatesUnderPin, executorAllowed, pinnedSelection, taskPinOf } from "../task-pin.js";
import { TaskClaims } from "../task-claim.js";
import type { TaskQueueEntry } from "../tasks.js";
import { AgentTaskStatus } from "@motebit/sdk";
import { JSON_AUTH, createAgent, createTestRelay, seedX402PaidTask } from "./test-helpers.js";

// The answer door, bypassed: only settlement attribution stands between a
// substitute's receipt and its payment.
vi.mock("../task-pin.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../task-pin.js")>();
  return { ...orig, pinRefusesAnswer: () => false };
});

const CAP = "web_search";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

describe("taskPinOf — how a pin is read from a submission", () => {
  const base = {
    submitter: "D",
    submitterIsIdentity: true,
    p2p: false,
    routedTo: "P",
    pathAgentId: "P",
    explicitTarget: null,
  };
  it.each([
    ["CLI --target: path agent is not the submitter", base, "P"],
    ["runtime capability routing: path agent is the submitter", { ...base, submitter: "P" }, null],
    ["operator submission: no submitter", { ...base, submitter: undefined }, null],
    [
      "planner label under the master token: not an identity, so no pin",
      { ...base, submitter: "plan_engine", submitterIsIdentity: false },
      null,
    ],
    [
      "explicit self-pin: target_agent = path = submitter",
      { ...base, submitter: "P", explicitTarget: "P" },
      "P",
    ],
    [
      "P2P: target_agent names the paid worker; path is the delegator",
      { ...base, p2p: true, routedTo: "W", pathAgentId: "D", explicitTarget: "W" },
      "W",
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(taskPinOf(input)).toBe(expected);
  });
});

describe("grantForward — the relay's MCP forward takes a pinned task only for its target", () => {
  it("refused to a non-target worker (the claim door's predicate); granted to the target", () => {
    const taskQueue = new Map<string, TaskQueueEntry>();
    const entry = {
      task: { task_id: "t1", motebit_id: "T", status: AgentTaskStatus.Pending },
      pinned_executor: "T",
    } as unknown as TaskQueueEntry;
    taskQueue.set("t1", entry);
    const claims = new TaskClaims({
      taskQueue,
      connections: new Map(),
      logger: { info: () => {} },
    });

    expect(claims.grantForward("t1", "DECOY")).toBe(false);
    expect(taskQueue.get("t1")!.task.status).toBe(AgentTaskStatus.Pending);
    expect(claims.grantForward("t1", "T")).toBe(true);
    expect(taskQueue.get("t1")!.task.claimed_by).toBe("mcp:T");
  });

  it("an unpinned task is granted to whichever worker routing chose", () => {
    const taskQueue = new Map<string, TaskQueueEntry>();
    taskQueue.set("t2", {
      task: { task_id: "t2", motebit_id: "P", status: AgentTaskStatus.Pending },
    } as unknown as TaskQueueEntry);
    const claims = new TaskClaims({
      taskQueue,
      connections: new Map(),
      logger: { info: () => {} },
    });
    expect(claims.grantForward("t2", "ANY")).toBe(true);
  });
});

describe("candidate selection under a pin", () => {
  it("unpinned: the candidate set is returned unchanged (the same array)", () => {
    const cands = [{ motebit_id: "A" }, { motebit_id: "B" }];
    expect(candidatesUnderPin(null, cands, (c) => c.motebit_id)).toBe(cands);
  });
  it("pinned: the target, or nothing", () => {
    const cands = [{ motebit_id: "A" }, { motebit_id: "B" }];
    expect(candidatesUnderPin("B", cands, (c) => c.motebit_id)).toEqual([{ motebit_id: "B" }]);
    expect(candidatesUnderPin("C", cands, (c) => c.motebit_id)).toEqual([]);
    expect(executorAllowed("B", "A")).toBe(false);
    expect(executorAllowed(null, "A")).toBe(true);
  });
  it("the scored phase selects the target on its own route, never ranks it", () => {
    expect(pinnedSelection("B", [{ motebit_id: "A" }])).toEqual([]);
    expect(pinnedSelection("B", [{ motebit_id: "B", reachable_via: "peer-1" }])[0]).toMatchObject({
      motebit_id: "B",
      routing_paths: [["peer-1", "B"]],
    });
    expect(pinnedSelection("B", [{ motebit_id: "B" }])[0]!.routing_paths).toEqual([["B"]]);
  });
});

describe("settlement attribution holds with the answer door bypassed", () => {
  async function agent(relay: SyncRelay) {
    const kp = await generateKeypair();
    const ids = await createAgent(relay, bytesToHex(kp.publicKey));
    return { ...ids, kp };
  }

  it("a substitute's receipt for a priced pinned task is never settled", async () => {
    const relay = await createTestRelay();
    cleanups.push(() => relay.close());
    const delegator = await agent(relay);
    const target = await agent(relay);
    const decoy = await agent(relay);
    for (const a of [target, decoy]) {
      await relay.app.request("/api/v1/agents/register", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: a.motebitId,
          endpoint_url: "http://127.0.0.1:1/mcp",
          capabilities: [CAP],
          public_key: bytesToHex(a.kp.publicKey),
        }),
      });
      await relay.app.request(`/api/v1/agents/${a.motebitId}/listing`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          capabilities: [CAP],
          pricing: [{ capability: CAP, unit_cost: 0.5, currency: "USD", per: "task" }],
          description: "pin door test",
        }),
      });
    }
    const taskId = seedX402PaidTask(relay, {
      workerId: target.motebitId,
      delegatorId: delegator.motebitId,
      prompt: "push test",
      unitCostUsd: 0.5,
      pinnedExecutor: target.motebitId,
    });
    recordTaskRoute(relay.moteDb.db, taskId, decoy.motebitId);

    const enc = new TextEncoder();
    const receipt = await signExecutionReceipt(
      {
        task_id: taskId,
        relay_task_id: taskId,
        motebit_id: decoy.motebitId as never,
        device_id: decoy.deviceId as never,
        public_key: bytesToHex(decoy.kp.publicKey),
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "substitute",
        tools_used: [],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("push test")),
        result_hash: await sha256(enc.encode("substitute")),
      },
      decoy.kp.privateKey,
    );
    const res = await relay.app.request(`/agent/${target.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(receipt),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const payees = relay.moteDb.db
      .prepare("SELECT motebit_id FROM relay_settlements WHERE task_id = ?")
      .all(taskId) as Array<{ motebit_id: string }>;
    expect(payees.map((p) => p.motebit_id)).not.toContain(decoy.motebitId);
    const bal = relay.moteDb.db
      .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
      .get(decoy.motebitId) as { balance: number } | undefined;
    expect(bal?.balance ?? 0).toBe(0);
    // Never settled: the entry carries no settled mark for the substitute.
    expect(new TaskQueue(relay.moteDb.db).get(taskId)?.settled).not.toBe(true);
  });
});
