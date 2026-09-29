/**
 * #890 round 3 — findings from the cold review of 535967659, each a test
 * that was red there.
 *
 *   1. Offline at submit: the step is held with no task id. It must be
 *      resolvable by RE-POSTING under the same derived key (the relay
 *      replays, or 409s naming the task), within the relay's idempotency
 *      window — never wedged forever. A 409 that names the task is used.
 *   4. Biting tests for the lease mechanics that stayed green when
 *      reverted: per-step renewal, the lease TTL's floor, the step re-read,
 *      the plan re-read, and the re-plan child's lease.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@motebit/ai-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/ai-core")>();
  return { ...actual, runTurnStreaming: vi.fn() };
});

import { runTurnStreaming } from "@motebit/ai-core";
import { PlanStatus, StepStatus } from "@motebit/sdk";
import type {
  DelegatedStepResult,
  ExecutionReceipt,
  PlanStep,
  MotebitId,
  DeviceId,
  PlanId,
  SensitivityCleared,
} from "@motebit/sdk";
import type { MotebitLoopDependencies } from "@motebit/ai-core";
import { PlanEngine } from "../plan-engine.js";
import type { PlanChunk, StepDelegationAdapter } from "../plan-engine.js";
import { InMemoryPlanStore } from "../types.js";
import { RelayDelegationAdapter } from "../delegation-adapter.js";
import { PlanDriverLocks } from "../plan-lease.js";

const MOTE = "mote-890";
const PLAN = "plan-890" as PlanId;
const deps = {} as SensitivityCleared<MotebitLoopDependencies>;

function receipt(taskId: string, status: "completed" | "failed" = "completed"): ExecutionReceipt {
  return {
    task_id: taskId,
    motebit_id: "worker" as MotebitId,
    device_id: "dev" as DeviceId,
    submitted_at: 1,
    completed_at: 2,
    status,
    result: "the work",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
  };
}

function mkStep(id: string, ordinal: number, over: Partial<PlanStep> = {}): PlanStep {
  return {
    step_id: id,
    plan_id: PLAN,
    ordinal,
    description: `remote ${id}`,
    prompt: "do it",
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
    updated_at: 0,
    ...over,
  };
}

function planStore(steps: PlanStep[]): InMemoryPlanStore {
  const store = new InMemoryPlanStore();
  store.savePlan({
    plan_id: PLAN,
    goal_id: "goal-890",
    motebit_id: MOTE as MotebitId,
    title: "Hire",
    status: PlanStatus.Active,
    created_at: 1,
    updated_at: 1,
    current_step_index: 0,
    total_steps: steps.length,
  });
  for (const s of steps) store.saveStep(s);
  return store;
}

function withoutLease(store: InMemoryPlanStore): InMemoryPlanStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "acquirePlanLease" || prop === "releasePlanLease") return undefined;
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

async function collect(gen: AsyncGenerator<PlanChunk>): Promise<PlanChunk[]> {
  const out: PlanChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const ok = (step: PlanStep, id: string): DelegatedStepResult => ({
  step_id: step.step_id,
  task_id: id,
  receipt: receipt(id),
  result_text: "the work",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Finding 1 ───────────────────────────────────────────────────────────

/** A relay reachable only when `online`; admits one task per key; has every receipt. */
function relay() {
  const state = { online: false, posts: [] as string[], attempts: 0 };
  const admitted = new Map<string, string>();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    state.attempts++;
    if (!state.online) throw new TypeError("fetch failed: getaddrinfo ENOTFOUND relay");
    if (init?.method === "POST") {
      const key = (init.headers as Record<string, string>)["Idempotency-Key"]!;
      state.posts.push(key);
      let id = admitted.get(key);
      if (id == null) {
        id = `task-${admitted.size + 1}`;
        admitted.set(key, id);
      }
      return new Response(JSON.stringify({ task_id: id }), { status: 201 });
    }
    const id = String(url).split("/").pop()!;
    return new Response(JSON.stringify({ task: { status: "completed" }, receipt: receipt(id) }), {
      status: 200,
    });
  });
  return { state, admitted, fetchMock };
}

function relayAdapter(): RelayDelegationAdapter {
  return new RelayDelegationAdapter({
    syncUrl: "http://relay",
    motebitId: MOTE,
    sendRaw: () => {},
    onCustomMessage: () => () => {},
    maxDelegationRetries: 2,
  });
}

describe("#890 r3 finding 1: offline at submit is resolved by re-posting under the same key", () => {
  it("offline, then online: the next resume re-posts under the derived key and completes", async () => {
    const r = relay();
    vi.stubGlobal("fetch", r.fetchMock);
    const store = planStore([mkStep("s1", 0)]);
    const engine = new PlanEngine(store, {
      delegationAdapter: relayAdapter(),
      localCapabilities: [],
      enableReflection: false,
      delegationTimeoutMs: 20,
    });

    const first = await collect(engine.executePlan(PLAN, deps));
    expect(first.map((c) => c.type)).toContain("plan_undetermined");
    expect(store.getStep("s1")!.delegation_task_id ?? null).toBeNull();
    expect(r.state.posts).toEqual([]); // nothing ever left the device

    r.state.online = true;
    const second = await collect(engine.resumePlan(PLAN, deps));
    expect(second.map((c) => c.type)).toContain("plan_completed");
    expect(r.state.posts).toEqual([`plan-step:${PLAN}:s1:0`]);
    expect(r.admitted.size).toBe(1);
    expect(engine.findUnresolvedDelegation("goal-890", MOTE)).toBeNull();
  });

  it("past the relay's idempotency window a key could admit a NEW task: hold, never re-post", async () => {
    const r = relay();
    r.state.online = true;
    vi.stubGlobal("fetch", r.fetchMock);
    const startedAt = Date.now();
    const store = planStore([
      mkStep("s1", 0, { status: StepStatus.Running, started_at: startedAt }),
    ]);
    const engine = new PlanEngine(store, {
      delegationAdapter: relayAdapter(),
      localCapabilities: [],
      enableReflection: false,
      delegationTimeoutMs: 20,
      now: () => startedAt + 25 * 60 * 60 * 1000,
    });
    const chunks = await collect(engine.resumePlan(PLAN, deps));
    expect(chunks.map((c) => c.type)).toEqual(["plan_undetermined"]);
    expect(r.state.posts).toEqual([]);
  });

  it("an adapter that cannot re-post idempotently (sovereign pay-forward) holds, never re-delegates", async () => {
    const delegateStep = vi.fn();
    const store = planStore([
      mkStep("s1", 0, { status: StepStatus.Running, started_at: Date.now() }),
    ]);
    const engine = new PlanEngine(store, {
      delegationAdapter: { delegateStep },
      localCapabilities: [],
      enableReflection: false,
    });
    const chunks = await collect(engine.resumePlan(PLAN, deps));
    expect(chunks.map((c) => c.type)).toEqual(["plan_undetermined"]);
    expect(delegateStep).not.toHaveBeenCalled();
  });

  it("a 409 that names the task (#888) hands over that task — no waiting out the key", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts++;
          return new Response(
            JSON.stringify({ code: "TASK_CONFLICT", status: 409, task_id: "task-named" }),
            { status: 409 },
          );
        }
        const id = String(url).split("/").pop()!;
        return new Response(JSON.stringify({ receipt: receipt(id) }), { status: 200 });
      }),
    );
    const seen: string[] = [];
    const result = await relayAdapter().delegateStep(mkStep("s1", 0), 20, (id) => seen.push(id));
    expect(result.task_id).toBe("task-named");
    expect(seen).toEqual(["task-named"]);
    expect(posts).toBe(1);
  });
});

// ── Finding 4: biting tests for the lease mechanics ─────────────────────

describe("#890 r3 finding 4: lease mechanics that must bite", () => {
  it("the lease is renewed at every step, so a long plan keeps it", async () => {
    let clock = 0;
    let intruder: boolean | null = null;
    const store = planStore([mkStep("s1", 0), mkStep("s2", 1)]);
    const adapter: StepDelegationAdapter = {
      delegateStep: (step) => {
        clock += 900;
        if (step.step_id === "s2") {
          intruder = store.acquirePlanLease(PLAN, "intruder", clock, 1_000);
        }
        return Promise.resolve(ok(step, `t-${step.step_id}`));
      },
    };
    const engine = new PlanEngine(store, {
      delegationAdapter: adapter,
      localCapabilities: [],
      enableReflection: false,
      driverLocks: new PlanDriverLocks(),
      now: () => clock,
      planLeaseTtlMs: 1_000,
      delegationTimeoutMs: 100,
    });
    const chunks = await collect(engine.executePlan(PLAN, deps));
    expect(chunks.map((c) => c.type)).toContain("plan_completed");
    expect(intruder).toBe(false);
  });

  it("a driver whose lease was taken over stops before the next step", async () => {
    let clock = 0;
    const calls: string[] = [];
    const store = planStore([mkStep("s1", 0), mkStep("s2", 1)]);
    const adapter: StepDelegationAdapter = {
      delegateStep: (step) => {
        calls.push(step.step_id);
        clock += 5_000; // this step outlived the lease…
        store.acquirePlanLease(PLAN, "intruder", clock, 60_000); // …and another driver took it
        return Promise.resolve(ok(step, `t-${step.step_id}`));
      },
    };
    const engine = new PlanEngine(store, {
      delegationAdapter: adapter,
      localCapabilities: [],
      enableReflection: false,
      driverLocks: new PlanDriverLocks(),
      now: () => clock,
      planLeaseTtlMs: 1_000,
      delegationTimeoutMs: 100,
    });
    const chunks = await collect(engine.executePlan(PLAN, deps));
    expect(chunks.at(-1)?.type).toBe("plan_busy");
    expect(calls).toEqual(["s1"]);
  });

  it("the lease outlives a delegated step's own timeout, whatever the configured TTL", async () => {
    let clock = 0;
    let intruder: boolean | null = null;
    const store = planStore([mkStep("s1", 0)]);
    const adapter: StepDelegationAdapter = {
      delegateStep: (step) => {
        clock += 5_000; // well inside 3× the 10 s delegation timeout
        intruder = store.acquirePlanLease(PLAN, "intruder", clock, 1_000);
        return Promise.resolve(ok(step, "t-1"));
      },
    };
    const engine = new PlanEngine(store, {
      delegationAdapter: adapter,
      localCapabilities: [],
      enableReflection: false,
      driverLocks: new PlanDriverLocks(),
      now: () => clock,
      planLeaseTtlMs: 1_000,
      delegationTimeoutMs: 10_000,
    });
    await collect(engine.executePlan(PLAN, deps));
    expect(intruder).toBe(false);
  });

  /** Two lease-less processes; the first poll of the held step waits on a gate. */
  function gatedTwoProcesses() {
    const base = planStore([
      mkStep("s1", 0, { status: StepStatus.Running, delegation_task_id: "t-held" }),
      mkStep("s2", 1),
    ]);
    const store = withoutLease(base);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let polls = 0;
    const calls: string[] = [];
    const adapter: StepDelegationAdapter = {
      delegateStep: (step) => {
        calls.push(step.step_id);
        return Promise.resolve(ok(step, `t-${step.step_id}`));
      },
      pollTaskResult: async (taskId, stepId) => {
        if (polls++ === 0) await gate;
        return { step_id: stepId, task_id: taskId, receipt: receipt(taskId), result_text: "w" };
      },
    };
    const mk = (): PlanEngine =>
      new PlanEngine(store, {
        delegationAdapter: adapter,
        localCapabilities: [],
        enableReflection: false,
        driverLocks: new PlanDriverLocks(),
      });
    return { store, release, calls, mk };
  }

  it("each step is re-read under the lease: a step another process finished is not run again", async () => {
    const { store, release, calls, mk } = gatedTwoProcesses();
    const b = collect(mk().resumePlan(PLAN, deps)); // snapshot taken, then blocked on the poll
    await new Promise((r) => setTimeout(r, 0));
    await collect(mk().resumePlan(PLAN, deps)); // another process finishes the plan
    expect(store.getStep("s2")!.status).toBe(StepStatus.Completed);
    release();
    await b;
    expect(calls).toEqual(["s2"]);
  });

  it("recovery re-reads the plan before resuming it: a plan concluded meanwhile is left alone", async () => {
    const { store, release, calls, mk } = gatedTwoProcesses();
    const rec = collect(mk().recoverDelegatedSteps(MOTE, deps)); // blocked on the poll
    await new Promise((r) => setTimeout(r, 0));
    store.updatePlan(PLAN, { status: PlanStatus.Failed }); // another process concluded it
    release();
    await rec;
    expect(calls).toEqual([]);
  });

  it("a re-plan's replacement plan is driven under its own lease", async () => {
    vi.mocked(runTurnStreaming).mockImplementation(
      // eslint-disable-next-line require-yield
      async function* () {
        throw new Error("local step broke");
      } as never,
    );
    const store = new InMemoryPlanStore();
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({ title: "local first", steps: [{ description: "l", prompt: "x" }] }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: "then hire",
          steps: [{ description: "r", prompt: "y", required_capabilities: ["stdio_mcp"] }],
        }),
      });
    const planDeps = {
      provider: { generate },
    } as unknown as SensitivityCleared<MotebitLoopDependencies>;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let childSubmitted!: () => void;
    const submitted = new Promise<void>((r) => (childSubmitted = r));
    const polled: string[] = [];
    const adapter: StepDelegationAdapter = {
      delegateStep: async (step, _t, onTaskSubmitted) => {
        onTaskSubmitted?.("t-child");
        childSubmitted();
        await gate;
        return ok(step, "t-child");
      },
      pollTaskResult: (taskId) => {
        polled.push(taskId);
        return Promise.resolve(null);
      },
    };
    const locks = new PlanDriverLocks();
    const mk = (): PlanEngine =>
      new PlanEngine(store, {
        delegationAdapter: adapter,
        localCapabilities: [],
        enableReflection: false,
        maxStepRetries: 0,
        maxPlanRetries: 1,
        driverLocks: locks,
      });
    const driver = mk();
    const { plan } = await driver.createPlan("goal-child", MOTE, { goalPrompt: "g" }, planDeps);
    const run = collect(driver.executePlan(plan.plan_id, planDeps, { goalPrompt: "g" }));
    await submitted; // the child plan's step is in flight

    const recovered = await collect(mk().recoverDelegatedSteps(MOTE, planDeps));
    expect(recovered.map((c) => c.type)).toContain("plan_busy");
    expect(polled).toEqual([]);
    release();
    await run;
  });
});
