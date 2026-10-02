/**
 * #890 round 5.
 *
 *   1. Any response that NAMES a task — whatever its status — is adoption of
 *      that task: hold and settle from its receipt; never rotate. Only a 4xx
 *      that names no task is a refusal before admission.
 *   2. The re-post window is measured from the CURRENT key's first
 *      submission: a rotation records its own submission time.
 *   3. A failed receipt is positive evidence only when it is bound to the
 *      step's current task and signed by the worker the relay routed it to.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PlanStatus, StepStatus } from "@motebit/sdk";
import type {
  ExecutionReceipt,
  MotebitId,
  DeviceId,
  PlanId,
  PlanStep,
  SensitivityCleared,
} from "@motebit/sdk";
import type { MotebitLoopDependencies } from "@motebit/ai-core";
import { PlanEngine } from "../plan-engine.js";
import type { PlanChunk } from "../plan-engine.js";
import { InMemoryPlanStore } from "../types.js";
import { RelayDelegationAdapter, DelegationUndeterminedError } from "../delegation-adapter.js";

const PLAN = "plan-r5" as PlanId;
const deps = {} as SensitivityCleared<MotebitLoopDependencies>;

function receipt(
  taskId: string,
  status: "completed" | "failed",
  signer = "worker",
  relayTaskId: string = taskId,
): ExecutionReceipt {
  return {
    task_id: taskId,
    relay_task_id: relayTaskId,
    motebit_id: signer as MotebitId,
    device_id: "dev" as DeviceId,
    submitted_at: 1,
    completed_at: 2,
    status,
    result: status,
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
  } as ExecutionReceipt;
}

const step: PlanStep = {
  step_id: "s1",
  plan_id: PLAN,
  ordinal: 0,
  description: "remote",
  prompt: "do",
  depends_on: [],
  optional: false,
  required_capabilities: ["stdio_mcp" as never],
  status: StepStatus.Pending,
  result_summary: null,
  error_message: null,
  tool_calls_made: 0,
  started_at: null,
  completed_at: null,
  retry_count: 0,
  updated_at: 1,
};

function adapter(): RelayDelegationAdapter {
  return new RelayDelegationAdapter({
    syncUrl: "http://relay",
    motebitId: "m",
    sendRaw: () => {},
    onCustomMessage: () => () => {},
    maxDelegationRetries: 2,
  });
}

async function collect(gen: AsyncGenerator<PlanChunk>): Promise<PlanChunk[]> {
  const out: PlanChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("#890 r5 finding 1: a response naming a task is adoption, whatever its status", () => {
  it("a post-admission 402 naming task-1: the adapter holds task-1, never rotates to a new key", async () => {
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          keys.push((init.headers as Record<string, string>)["Idempotency-Key"]!);
          return new Response(
            JSON.stringify({ error: "Payment required", status: 402, task_id: "task-1" }),
            { status: 402 },
          );
        }
        const id = String(url).split("/").pop()!;
        return new Response(JSON.stringify({ receipt: receipt(id, "completed") }), {
          status: 200,
        });
      }),
    );
    const seen: string[] = [];
    const r = await adapter().delegateStep(step, 20, (id) => seen.push(id));
    expect(r.task_id).toBe("task-1");
    expect(seen).toEqual(["task-1"]);
    expect(new Set(keys)).toEqual(new Set([`plan-step:${PLAN}:s1:0`]));
  });

  it("a 4xx that names NO task is still a refusal before admission (conclusive)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "bad input" }), {
            status: 400,
          }),
      ),
    );
    await expect(adapter().delegateStep(step, 20)).rejects.toThrow(/Relay task submission failed/);
  });
});

describe("#890 r5 finding 3: positive evidence is bound to the current task and its routed worker", () => {
  function stub(answer: (id: string) => ExecutionReceipt): string[] {
    const keys: string[] = [];
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          keys.push((init.headers as Record<string, string>)["Idempotency-Key"]!);
          n++;
          return new Response(
            JSON.stringify({ task_id: `task-${n}`, routing_choice: { selected_agent: "worker" } }),
            { status: 201 },
          );
        }
        const id = String(url).split("/").pop()!;
        return new Response(JSON.stringify({ receipt: answer(id) }), { status: 200 });
      }),
    );
    return keys;
  }

  it("a FAILED receipt signed by a worker the task was not routed to is not evidence: hold, no rotation", async () => {
    const keys = stub((id) => receipt(id, "failed", "evil-worker"));
    await expect(adapter().delegateStep(step, 20)).rejects.toBeInstanceOf(
      DelegationUndeterminedError,
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("a receipt bound to a DIFFERENT task settles nothing: hold, no rotation", async () => {
    const keys = stub((id) => receipt(id, "failed", "worker", "task-victim-elsewhere"));
    await expect(adapter().delegateStep(step, 20)).rejects.toBeInstanceOf(
      DelegationUndeterminedError,
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("the routed worker's signed failure is evidence: rotation to the next key", async () => {
    let first = true;
    const keys = stub((id) => {
      const r = receipt(id, first ? "failed" : "completed");
      first = false;
      return r;
    });
    const res = await adapter().delegateStep(step, 20);
    expect(res.task_id).toBe("task-2");
    expect(keys).toEqual([`plan-step:${PLAN}:s1:0`, `plan-step:${PLAN}:s1:1`]);
  });

  it("a held step is not settled from a polled receipt bound to another task", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ receipt: receipt("task-x", "failed", "worker", "task-y") }),
            {
              status: 200,
            },
          ),
      ),
    );
    const s = new InMemoryPlanStore();
    s.savePlan({
      plan_id: PLAN,
      goal_id: "g",
      motebit_id: "m" as MotebitId,
      title: "t",
      status: PlanStatus.Active,
      created_at: 1,
      updated_at: 1,
      current_step_index: 0,
      total_steps: 1,
    });
    s.saveStep({ ...step, status: StepStatus.Running, delegation_task_id: "task-x" });
    const engine = new PlanEngine(s, {
      delegationAdapter: adapter(),
      localCapabilities: [],
      enableReflection: false,
    });
    const chunks = await collect(engine.resumePlan(PLAN, deps));
    expect(chunks.map((c) => c.type)).toEqual(["plan_undetermined"]);
    expect(s.getStep("s1")!.status).toBe(StepStatus.Running);
  });
});

describe("#890 r5 finding 2: the re-post window runs from the CURRENT key's first submission", () => {
  it("a rotation records its own submission time on the step", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      let n = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === "POST") {
            n++;
            if (n === 1) {
              return new Response(
                JSON.stringify({ task_id: "task-1", routing_choice: { selected_agent: "worker" } }),
                { status: 201 },
              );
            }
            throw new TypeError("fetch failed"); // key :1's submissions never arrive
          }
          vi.setSystemTime(5_000_000); // the failure is learned later
          return new Response(JSON.stringify({ receipt: receipt("task-1", "failed") }), {
            status: 200,
          });
        }),
      );
      const s = new InMemoryPlanStore();
      s.savePlan({
        plan_id: PLAN,
        goal_id: "g",
        motebit_id: "m" as MotebitId,
        title: "t",
        status: PlanStatus.Active,
        created_at: 1,
        updated_at: 1,
        current_step_index: 0,
        total_steps: 1,
      });
      s.saveStep({ ...step });
      const engine = new PlanEngine(s, {
        delegationAdapter: adapter(),
        localCapabilities: [],
        enableReflection: false,
        delegationTimeoutMs: 20,
      });
      const p = collect(engine.executePlan(PLAN, deps));
      await vi.advanceTimersByTimeAsync(10_000);
      await p;
      const held = s.getStep("s1")!;
      expect(held.retry_count).toBe(1);
      expect(held.started_at).toBe(5_000_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
