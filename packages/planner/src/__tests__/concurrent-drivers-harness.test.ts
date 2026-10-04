/**
 * #890 round 2 — at most one driver per plan.
 *
 * A held plan (step 1 delegated, its receipt now readable; step 2 pending)
 * is driven by TWO drivers at once. Before the lease, both settled step 1
 * from the receipt and both submitted step 2 under different keys: two paid
 * relay tasks, one untracked.
 *
 * Exhaustive over:
 *   driver pair       recover (reconnect) × resume (runner) × tick (a
 *                     scheduler fire: resume the active plan, else create)
 *   topology          same engine | two engines, one process (shared
 *                     in-process locks) | two processes (own locks, a store
 *                     with a persisted lease) | two processes, a store with
 *                     NO lease (only the derived Idempotency-Key protects)
 *   start offset      the second driver starts 0, 1, 2, 4 or 8 macrotasks late
 *
 * Oracle:
 *   ONE DRIVER   where a lease can see both drivers, step 2 is delegated at
 *                most once;
 *   ONE TASK     everywhere, the relay admits at most one task for step 2
 *                (distinct derived keys);
 *   LIVENESS     afterwards, a fresh resume finishes the plan with step 2
 *                admitted exactly once.
 */
import { describe, it, expect } from "vitest";
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
import { planStepIdempotencyKey } from "../delegation-adapter.js";
import { PlanDriverLocks } from "../plan-lease.js";

type Driver = "recover" | "resume" | "tick";
type Topology = "same-engine" | "same-process" | "two-processes" | "two-processes-no-lease";

const DRIVERS: Driver[] = ["recover", "resume", "tick"];
const TOPOLOGIES: Topology[] = [
  "same-engine",
  "same-process",
  "two-processes",
  "two-processes-no-lease",
];
const OFFSETS = [0, 1, 2, 4, 8];
const MOTE = "mote-890";
const GOAL = "goal-890";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function receipt(taskId: string): ExecutionReceipt {
  return {
    task_id: taskId,
    motebit_id: "worker" as MotebitId,
    device_id: "dev" as DeviceId,
    submitted_at: 1,
    completed_at: 2,
    status: "completed",
    result: "the work",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
  };
}

/** A relay that admits one task per Idempotency-Key and has step 1's receipt. */
class Relay implements StepDelegationAdapter {
  readonly calls: Array<{ stepId: string; key: string }> = [];
  readonly admitted = new Map<string, string>();

  async delegateStep(
    step: PlanStep,
    _t: number,
    onTaskSubmitted?: (taskId: string) => void,
  ): Promise<DelegatedStepResult> {
    const key = planStepIdempotencyKey(step, 0);
    this.calls.push({ stepId: step.step_id, key });
    await tick();
    let id = this.admitted.get(key);
    if (id == null) {
      id = `task-${this.admitted.size + 1}`;
      this.admitted.set(key, id);
    }
    onTaskSubmitted?.(id);
    await tick();
    return { step_id: step.step_id, task_id: id, receipt: receipt(id), result_text: "the work" };
  }

  async pollTaskResult(taskId: string, stepId: string): Promise<DelegatedStepResult | null> {
    await tick();
    if (taskId !== "t-held" && ![...this.admitted.values()].includes(taskId)) return null;
    return { step_id: stepId, task_id: taskId, receipt: receipt(taskId), result_text: "the work" };
  }

  step2Calls(): number {
    return this.calls.filter((c) => c.stepId === "step-2").length;
  }

  step2Tasks(): number {
    return new Set(this.calls.filter((c) => c.stepId === "step-2").map((c) => c.key)).size;
  }
}

function step(id: string, ordinal: number, over: Partial<PlanStep>): PlanStep {
  return {
    step_id: id,
    plan_id: "plan-held" as PlanId,
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

function heldStore(): InMemoryPlanStore {
  const store = new InMemoryPlanStore();
  store.savePlan({
    plan_id: "plan-held" as PlanId,
    goal_id: GOAL,
    motebit_id: MOTE as MotebitId,
    title: "Hire twice",
    status: PlanStatus.Active,
    created_at: 1,
    updated_at: 1,
    current_step_index: 0,
    total_steps: 2,
  });
  store.saveStep(step("step-1", 0, { status: StepStatus.Running, delegation_task_id: "t-held" }));
  store.saveStep(step("step-2", 1, {}));
  return store;
}

/** The same store with its persisted lease hidden (a store that has none). */
function withoutLease(store: InMemoryPlanStore): InMemoryPlanStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "acquirePlanLease" || prop === "releasePlanLease") return undefined;
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

const deps = {} as SensitivityCleared<MotebitLoopDependencies>;

async function drive(
  engine: PlanEngine,
  store: InMemoryPlanStore,
  d: Driver,
): Promise<PlanChunk[]> {
  const out: PlanChunk[] = [];
  let gen: AsyncGenerator<PlanChunk>;
  if (d === "recover") {
    gen = engine.recoverDelegatedSteps(MOTE, deps);
  } else if (d === "resume") {
    gen = engine.resumePlan("plan-held", deps);
  } else {
    // A scheduler fire: resume the goal's active plan, else create a new one.
    const plan = store.getPlanForGoal(GOAL);
    if (plan != null && plan.status === PlanStatus.Active)
      gen = engine.resumePlan(plan.plan_id, deps);
    else return out; // the plan is done; a new plan is new work, out of this harness's scope
  }
  try {
    for await (const c of gen) out.push(c);
  } catch {
    // "not active" after the other driver finished it — nothing was driven
  }
  return out;
}

async function runCase(a: Driver, b: Driver, topology: Topology, offset: number) {
  const base = heldStore();
  const store = topology === "two-processes-no-lease" ? withoutLease(base) : base;
  const relay = new Relay();
  const engineFor = (locks: PlanDriverLocks): PlanEngine =>
    new PlanEngine(store, {
      delegationAdapter: relay,
      localCapabilities: [],
      enableReflection: false,
      driverLocks: locks,
    });
  const shared = new PlanDriverLocks();
  const e1 = engineFor(shared);
  const e2 =
    topology === "same-engine"
      ? e1
      : topology === "same-process"
        ? engineFor(shared)
        : engineFor(new PlanDriverLocks());

  const first = drive(e1, store, a);
  const second = (async () => {
    for (let i = 0; i < offset; i++) await tick();
    return drive(e2, store, b);
  })();
  await Promise.all([first, second]);
  const afterRace = { calls: relay.step2Calls(), tasks: relay.step2Tasks() };

  // Liveness: a fresh process finishes whatever is left.
  await drive(engineFor(new PlanDriverLocks()), store, "resume");
  return {
    ...afterRace,
    finalTasks: relay.step2Tasks(),
    planStatus: store.getPlan("plan-held")!.status,
  };
}

describe("#890 concurrent drivers — at most one driver per plan", () => {
  it("driver pair × topology × start offset", async () => {
    const failures: string[] = [];
    let cells = 0;
    for (const a of DRIVERS) {
      for (const b of DRIVERS) {
        for (const topology of TOPOLOGIES) {
          for (const offset of OFFSETS) {
            cells++;
            const label = `${a}+${b}/${topology}/+${offset}`;
            const r = await runCase(a, b, topology, offset);
            if (topology !== "two-processes-no-lease" && r.calls > 1) {
              failures.push(`${label}: ONE DRIVER step 2 delegated ${r.calls}x`);
            }
            if (r.tasks > 1) failures.push(`${label}: ONE TASK relay admitted ${r.tasks} tasks`);
            if (r.finalTasks !== 1 || r.planStatus !== PlanStatus.Completed) {
              failures.push(
                `${label}: LIVENESS step-2 tasks=${r.finalTasks}, plan ${r.planStatus}`,
              );
            }
          }
        }
      }
    }
    expect(cells).toBe(DRIVERS.length ** 2 * TOPOLOGIES.length * OFFSETS.length);
    expect(failures.slice(0, 40), `${failures.length} failing cell assertions`).toEqual([]);
  }, 120_000);

  it("a reconnect's recovery while a runner drives the plan yields plan_busy and polls nothing", async () => {
    const store = heldStore();
    const relay = new Relay();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const polls: string[] = [];
    const inner = relay.pollTaskResult.bind(relay);
    relay.pollTaskResult = async (taskId: string, stepId: string) => {
      polls.push(taskId);
      await gate; // the runner is mid-settle
      return inner(taskId, stepId);
    };
    const locks = new PlanDriverLocks();
    const mk = (): PlanEngine =>
      new PlanEngine(store, {
        delegationAdapter: relay,
        localCapabilities: [],
        enableReflection: false,
        driverLocks: locks,
      });
    const runner = drive(mk(), store, "resume");
    await tick();
    expect(polls).toEqual(["t-held"]);
    const recovered = await drive(mk(), store, "recover");
    expect(recovered.map((c) => c.type)).toEqual(["plan_busy"]);
    expect(polls).toEqual(["t-held"]); // recovery read nothing, drove nothing
    release();
    await runner;
    expect(relay.step2Tasks()).toBe(1);
  });

  it("a second driver finding the plan leased yields plan_busy and delegates nothing", async () => {
    const store = heldStore();
    const relay = new Relay();
    const locks = new PlanDriverLocks();
    const mk = (): PlanEngine =>
      new PlanEngine(store, {
        delegationAdapter: relay,
        localCapabilities: [],
        driverLocks: locks,
      });
    locks.tryAcquire("plan-held");
    const chunks = await drive(mk(), store, "resume");
    expect(chunks.map((c) => c.type)).toEqual(["plan_busy"]);
    expect(relay.calls).toHaveLength(0);
  });

  it("a crashed holder's persisted lease blocks another process until it expires", async () => {
    const store = heldStore();
    const relay = new Relay();
    let now = 1_000;
    const mk = (): PlanEngine =>
      new PlanEngine(store, {
        delegationAdapter: relay,
        localCapabilities: [],
        enableReflection: false,
        driverLocks: new PlanDriverLocks(),
        now: () => now,
        planLeaseTtlMs: 60_000,
        delegationTimeoutMs: 1_000,
      });
    expect(store.acquirePlanLease("plan-held", "dead-process", now, 60_000)).toBe(true);
    expect((await drive(mk(), store, "resume")).map((c) => c.type)).toEqual(["plan_busy"]);
    now += 60_001;
    const chunks = await drive(mk(), store, "resume");
    expect(chunks.map((c) => c.type)).toContain("plan_completed");
    expect(relay.step2Tasks()).toBe(1);
  });
});
