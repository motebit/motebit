/**
 * #816 — `delegate --plan`'s HTTP-polling step adapter. A deadline that
 * passes while the relay still reports the task running (or cannot be
 * reached) says nothing about the task: the retry resubmits under the SAME
 * Idempotency-Key, so the relay replays the task it already admitted. Only a
 * task that conclusively FAILED is retried as a new task — new key, the failed
 * worker excluded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeviceCapability, StepStatus } from "@motebit/sdk";
import type { PlanStep, PlanId, MotebitId, SensitivityCleared } from "@motebit/sdk";
import { PlanStatus } from "@motebit/sdk";
import type { MotebitLoopDependencies } from "@motebit/ai-core";
import { PlanEngine, InMemoryPlanStore } from "@motebit/planner";
import {
  createHttpPollingDelegationAdapter,
  DelegationUndeterminedError,
} from "../subcommands/delegate.js";

const step: PlanStep = {
  step_id: "step-1",
  plan_id: "plan-1" as PlanId,
  ordinal: 0,
  description: "Test step",
  prompt: "Do the thing",
  depends_on: [],
  optional: false,
  status: StepStatus.Pending,
  required_capabilities: [DeviceCapability.HttpMcp],
  result_summary: null,
  error_message: null,
  tool_calls_made: 0,
  started_at: null,
  completed_at: null,
  retry_count: 0,
  updated_at: 0,
};

function receipt(taskId: string, status: "completed" | "failed", by = "worker") {
  return { task_id: taskId, status, result: status, motebit_id: by };
}

/** A relay that admits one task per NEW Idempotency-Key and replays for a seen one. */
function fakeRelay() {
  const keys: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const admitted = new Map<string, string>();
  let answer: (taskId: string) => { status: number; body: unknown } = () => ({
    status: 200,
    body: { task: { status: "running" }, receipt: null },
  });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const key = (init.headers as Record<string, string>)["Idempotency-Key"]!;
      keys.push(key);
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      let id = admitted.get(key);
      if (id == null) {
        id = `task-${admitted.size + 1}`;
        admitted.set(key, id);
      }
      return new Response(
        JSON.stringify({ task_id: id, routing_choice: { selected_agent: `worker-${id}` } }),
        { status: 201 },
      );
    }
    const a = answer(String(url).split("/").pop()!);
    return new Response(JSON.stringify(a.body), { status: a.status });
  });
  return {
    fetchMock,
    keys,
    bodies,
    admittedCount: () => admitted.size,
    answerWith(fn: (taskId: string) => { status: number; body: unknown }) {
      answer = fn;
    },
  };
}

function makeAdapter() {
  return createHttpPollingDelegationAdapter({
    relayUrl: "http://relay",
    motebitId: "me",
    submitHeaders: {},
    queryHeaders: async () => ({}),
    maxRetries: 1,
  });
}

const TIMEOUT = 10_000;

describe("delegate --plan HTTP-polling adapter: retries never double-admit a task", () => {
  let relay: ReturnType<typeof fakeRelay>;
  beforeEach(() => {
    vi.useFakeTimers();
    relay = fakeRelay();
    vi.stubGlobal("fetch", relay.fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("still running past the deadline: the retry reuses the Idempotency-Key, one task admitted", async () => {
    const adapter = makeAdapter();
    let polls = 0;
    relay.answerWith((id) =>
      // Running through the first attempt's deadline; done early in the retry.
      ++polls <= 6
        ? { status: 200, body: { task: { status: "running" }, receipt: null } }
        : {
            status: 200,
            body: { task: { status: "completed" }, receipt: receipt(id, "completed") },
          },
    );
    const p = adapter.delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT);

    const r = await p;
    expect(r.task_id).toBe("task-1");
    expect(relay.keys).toHaveLength(2);
    expect(relay.keys[1]).toBe(relay.keys[0]);
    expect(relay.admittedCount()).toBe(1);
  });

  it("the relay unreachable past the deadline: the retry reuses the key, and it ends UNDETERMINED", async () => {
    const adapter = makeAdapter();
    relay.answerWith(() => ({ status: 503, body: {} }));
    const p = adapter.delegateStep(step, TIMEOUT);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT);

    await expect(p).rejects.toBeInstanceOf(DelegationUndeterminedError);
    await expect(p).rejects.toThrow(/the task may still complete/);
    expect(relay.keys).toHaveLength(2);
    expect(new Set(relay.keys).size).toBe(1);
    expect(relay.admittedCount()).toBe(1);
  });

  it("#890 r4: the relay no longer knows the step's task (404): UNKNOWN — held on that key, never a new task", async () => {
    const adapter = makeAdapter();
    relay.answerWith((id) =>
      id === "task-1"
        ? { status: 404, body: {} }
        : {
            status: 200,
            body: { task: { status: "completed" }, receipt: receipt(id, "completed") },
          },
    );
    const p = adapter.delegateStep(step, TIMEOUT);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(TIMEOUT);

    await expect(p).rejects.toBeInstanceOf(DelegationUndeterminedError);
    expect(relay.keys).toHaveLength(1);
    expect(relay.admittedCount()).toBe(1);
  });

  it("counts attempts when every answer is a signed failure", async () => {
    const adapter = makeAdapter();
    relay.answerWith((id) => ({
      status: 200,
      body: { task: { status: "failed" }, receipt: receipt(id, "failed", "") },
    }));
    const p = adapter.delegateStep(step, TIMEOUT);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT);

    await expect(p).rejects.toThrow(/Delegation failed after 2 attempt\(s\)/);
  });

  it("#890 r4: a 5xx on submission is not a refusal — same key again, then undetermined", async () => {
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]!);
        return new Response("boom", { status: 503 });
      }),
    );
    const p = makeAdapter().delegateStep(step, TIMEOUT);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT);
    await expect(p).rejects.toBeInstanceOf(DelegationUndeterminedError);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("#890 r4: rotation starts from the step's current one, and is reported before the new submission", async () => {
    const adapter = makeAdapter();
    relay.answerWith((id) =>
      id === "task-1"
        ? { status: 200, body: { task: { status: "failed" }, receipt: receipt(id, "failed") } }
        : {
            status: 200,
            body: { task: { status: "completed" }, receipt: receipt(id, "completed") },
          },
    );
    const rotations: Array<{ rotation: number; keysSoFar: number }> = [];
    const p = adapter.delegateStep(
      { ...step, retry_count: 2 },
      TIMEOUT,
      undefined,
      undefined,
      (r) => rotations.push({ rotation: r, keysSoFar: relay.keys.length }),
    );
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT);
    await p;
    expect(relay.keys).toEqual(["plan-step:plan-1:step-1:2", "plan-step:plan-1:step-1:3"]);
    expect(rotations).toEqual([{ rotation: 3, keysSoFar: 1 }]);
  });

  it("a task that genuinely FAILED retries as a new task: new key, the failed worker excluded", async () => {
    const adapter = makeAdapter();
    relay.answerWith((id) =>
      id === "task-1"
        ? {
            status: 200,
            body: { task: { status: "failed" }, receipt: receipt(id, "failed", "bad") },
          }
        : {
            status: 200,
            body: { task: { status: "completed" }, receipt: receipt(id, "completed") },
          },
    );
    const p = adapter.delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT);

    const r = await p;
    expect(r.task_id).toBe("task-2");
    expect(relay.keys).toHaveLength(2);
    expect(relay.keys[1]).not.toBe(relay.keys[0]);
    expect(relay.bodies[1]!.exclude_agents).toEqual(["bad"]);
  });

  it("a receipt landing right at the deadline is taken, not resubmitted", async () => {
    const adapter = makeAdapter();
    let polls = 0;
    // 5 polls fit in the deadline; the 6th ask (after it) finds the receipt.
    relay.answerWith((id) =>
      ++polls <= 5
        ? { status: 200, body: { task: { status: "running" }, receipt: null } }
        : {
            status: 200,
            body: { task: { status: "completed" }, receipt: receipt(id, "completed") },
          },
    );
    const p = adapter.delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1);

    const r = await p;
    expect(r.task_id).toBe("task-1");
    expect(relay.keys).toHaveLength(1);
  });
});

describe("delegate --plan HTTP-polling adapter: an unconfirmed submission keeps its key", () => {
  let relay: ReturnType<typeof fakeRelay>;
  const done = (id: string) => ({
    status: 200,
    body: { task: { status: "completed" }, receipt: receipt(id, "completed") },
  });
  beforeEach(() => {
    vi.useFakeTimers();
    relay = fakeRelay();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("the relay admits the POST but the response is lost: the retry reuses the key, one task, resolves", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const resp = await relay.fetchMock(url, init);
        if (init?.method === "POST" && ++posts === 1) throw new TypeError("fetch failed");
        return resp;
      }),
    );
    relay.answerWith(done);
    const p = makeAdapter().delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT);

    const r = await p;
    expect(r.task_id).toBe("task-1");
    expect(relay.keys).toHaveLength(2);
    expect(relay.keys[1]).toBe(relay.keys[0]);
    expect(relay.admittedCount()).toBe(1);
  });

  it("a 409 backs off and resubmits under the same key: the relay replays the task, resolves", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && ++posts === 1) {
          relay.keys.push((init.headers as Record<string, string>)["Idempotency-Key"]!);
          return new Response("already being processed", { status: 409 });
        }
        return relay.fetchMock(url, init);
      }),
    );
    relay.answerWith(done);
    const p = makeAdapter().delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT);

    const r = await p;
    expect(r.task_id).toBe("task-1");
    expect(new Set(relay.keys).size).toBe(1);
    expect(relay.admittedCount()).toBe(1);
  });

  it("a 409 that outlasts the step's time budget ends the step UNDETERMINED, with no retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          relay.keys.push((init.headers as Record<string, string>)["Idempotency-Key"]!);
          return new Response("already being processed", { status: 409 });
        }
        return relay.fetchMock(url, init);
      }),
    );
    const p = makeAdapter().delegateStep(step, TIMEOUT);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1_000);
    const midway = relay.keys.length;
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT);

    await expect(p).rejects.toBeInstanceOf(DelegationUndeterminedError);
    await expect(p).rejects.toThrow(
      /Submission unconfirmed — the task may still complete; check \/result/,
    );
    expect(midway).toBeGreaterThan(3); // it kept backing off through the budget
    expect(relay.keys.length).toBeLessThanOrEqual(midway + 2); // then stopped: one attempt
    expect(new Set(relay.keys).size).toBe(1);
  });

  it("the relay admits the POST but the 201's body is lost: the retry reuses the key, one task, resolves", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const resp = await relay.fetchMock(url, init);
        if (init?.method === "POST" && ++posts === 1) return new Response("{", { status: 201 });
        return resp;
      }),
    );
    relay.answerWith(done);
    const p = makeAdapter().delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT);

    const r = await p;
    expect(r.task_id).toBe("task-1");
    expect(relay.keys).toHaveLength(2);
    expect(relay.keys[1]).toBe(relay.keys[0]);
    expect(relay.admittedCount()).toBe(1);
  });

  it("a task id first learned on a same-key retry is persisted for recovery", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const resp = await relay.fetchMock(url, init);
        if (init?.method === "POST" && ++posts === 1) throw new TypeError("fetch failed");
        return resp;
      }),
    );
    relay.answerWith(done);
    const persisted: string[] = [];
    const p = makeAdapter().delegateStep(step, TIMEOUT, (id) => persisted.push(id));
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    await p;
    expect(persisted).toEqual(["task-1"]);
  });

  it("#890 r3: the Idempotency-Key is derived from the step, so two drivers present one key", async () => {
    vi.stubGlobal("fetch", relay.fetchMock);
    relay.answerWith(done);
    const a = makeAdapter().delegateStep(step, TIMEOUT);
    const b = makeAdapter().delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    await Promise.all([a, b]);
    expect(relay.keys).toEqual(["plan-step:plan-1:step-1:0", "plan-step:plan-1:step-1:0"]);
    expect(relay.admittedCount()).toBe(1);
  });

  it("#890 r3: a 409 that names the task (#888) hands over that task", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts++;
          return new Response(JSON.stringify({ code: "TASK_CONFLICT", task_id: "task-named" }), {
            status: 409,
          });
        }
        return relay.fetchMock(url, init);
      }),
    );
    relay.answerWith(done);
    const persisted: string[] = [];
    const p = makeAdapter().delegateStep(step, TIMEOUT, (id) => persisted.push(id));
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    const r = await p;
    expect(r.task_id).toBe("task-named");
    expect(persisted).toEqual(["task-named"]);
    expect(posts).toBe(1);
  });
});

describe("#890 r4 T4: the http adapter re-posts a held step through the plan engine", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a step held with no task id (offline at submit) is re-posted under its derived key on resume", async () => {
    const relay = fakeRelay();
    relay.answerWith((id) => ({
      status: 200,
      body: { task: { status: "completed" }, receipt: receipt(id, "completed") },
    }));
    vi.stubGlobal("fetch", relay.fetchMock);
    const store = new InMemoryPlanStore();
    store.savePlan({
      plan_id: "plan-1" as PlanId,
      goal_id: "g",
      motebit_id: "me" as MotebitId,
      title: "t",
      status: PlanStatus.Active,
      created_at: 1,
      updated_at: 1,
      current_step_index: 0,
      total_steps: 1,
    });
    store.saveStep({
      ...step,
      required_capabilities: ["stdio_mcp" as never],
      status: StepStatus.Running,
      started_at: Date.now(),
    });
    const engine = new PlanEngine(store, {
      delegationAdapter: createHttpPollingDelegationAdapter({
        relayUrl: "http://relay",
        motebitId: "me",
        submitHeaders: {},
        queryHeaders: async () => ({}),
        maxRetries: 1,
        pollIntervalMs: 1,
      }),
      localCapabilities: [],
      enableReflection: false,
      delegationTimeoutMs: 50,
    });
    const types: string[] = [];
    for await (const c of engine.resumePlan(
      "plan-1",
      {} as SensitivityCleared<MotebitLoopDependencies>,
    )) {
      types.push(c.type);
    }
    expect(types).toContain("plan_completed");
    expect(relay.keys).toEqual(["plan-step:plan-1:step-1:0"]);
  });
});
