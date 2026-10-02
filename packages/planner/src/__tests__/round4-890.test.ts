/**
 * #890 round 4 — the step remembers its key rotation next to its task id.
 *
 * A rotation (positive evidence the old key owes nothing) records the new
 * rotation on the step and clears the old task id BEFORE the new submission,
 * so the step can only ever be settled from its CURRENT key's task, and a
 * resume re-posts under the current key — never an earlier one.
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
import { RelayDelegationAdapter } from "../delegation-adapter.js";

const PLAN = "plan-r4" as PlanId;
const deps = {} as SensitivityCleared<MotebitLoopDependencies>;

function receipt(taskId: string, status: "completed" | "failed"): ExecutionReceipt {
  return {
    task_id: taskId,
    motebit_id: "worker" as MotebitId,
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
  };
}

function store(): InMemoryPlanStore {
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
  s.saveStep(step);
  return s;
}

async function collect(gen: AsyncGenerator<PlanChunk>): Promise<PlanChunk[]> {
  const out: PlanChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("#890 r4: a rotation is recorded on the step and forgets the old task", () => {
  it("task-A fails, task-B's answer is lost: the step holds on rotation 1 with no task, and resumes at key 1", async () => {
    const posts: string[] = [];
    let online = true;
    let lostB = 2;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const key = (init.headers as Record<string, string>)["Idempotency-Key"]!;
          if (!online) throw new TypeError("fetch failed");
          posts.push(key);
          if (key.endsWith(":0")) {
            return new Response(JSON.stringify({ task_id: "task-A" }), { status: 201 });
          }
          if (lostB-- > 0) throw new TypeError("socket hang up"); // task-B admitted, answer lost
          return new Response(JSON.stringify({ task_id: "task-B" }), { status: 201 });
        }
        const id = String(url).split("/").pop()!;
        const status = id === "task-A" ? "failed" : "completed";
        return new Response(JSON.stringify({ receipt: receipt(id, status) }), { status: 200 });
      }),
    );
    const s = store();
    const engine = new PlanEngine(s, {
      delegationAdapter: new RelayDelegationAdapter({
        syncUrl: "http://relay",
        motebitId: "m",
        sendRaw: () => {},
        onCustomMessage: () => () => {},
        maxDelegationRetries: 2,
      }),
      localCapabilities: [],
      enableReflection: false,
      delegationTimeoutMs: 20,
    });

    const first = await collect(engine.executePlan(PLAN, deps));
    expect(first.map((c) => c.type)).toContain("plan_undetermined");
    const held = s.getStep("s1")!;
    expect(held.retry_count).toBe(1);
    expect(held.delegation_task_id ?? "").toBe(""); // never settled from task-A

    online = true;
    posts.length = 0;
    const second = await collect(engine.resumePlan(PLAN, deps));
    expect(second.map((c) => c.type)).toContain("plan_completed");
    expect(posts[0]).toBe(`plan-step:${PLAN}:s1:1`);
    expect(posts.some((k) => k.endsWith(":0"))).toBe(false);
  });
});
