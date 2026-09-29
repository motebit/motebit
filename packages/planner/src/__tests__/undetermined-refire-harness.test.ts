/**
 * #890 harness — a goal whose delegated step ended with an UNKNOWN paid
 * outcome is never delegated a second time until that outcome is resolved.
 *
 * Exhaustive over:
 *
 *   first-run outcome  success | failure | undetermined (task id known) |
 *                      undetermined (no task id) | crash mid-submit (task id
 *                      persisted) | crash mid-submit (no task id)
 *   relay truth        the admitted task completes | fails | stays pending
 *   resolution tick    the relay's answer is readable from fire 2, 3, 4, or never
 *   restart mask       a fresh PlanEngine (a process restart) before any fire
 *   scheduler model    RESUME — the CLI / desktop / mobile runner: resume the
 *                      goal's active plan, else create a new one;
 *                      CREATE — the runtime's `executePlan` as main has it:
 *                      always create a new plan.
 *
 * Four fires per case. The oracle, asserted over every cell:
 *
 *   SAFETY    a submission is never made while an earlier submission's
 *             outcome is unknown to the delegator (the #890 law);
 *   COUNTING  a fire whose only problem is an unknown outcome is never
 *             reported as a failure (no `plan_failed`, no thrown error that
 *             is not flagged undetermined) — a failure count re-fires and
 *             eventually auto-pauses the goal;
 *   LIVENESS  (RESUME model) once the relay's signed receipt is readable, the
 *             next fire settles the held step from it — completes the plan on
 *             a completed receipt, fails it on a failed one — without a new
 *             submission.
 *
 * Red on main: an undetermined step failed its plan, so the next fire made a
 * new plan and a second submission; a crash left a Running step that resume
 * re-delegated.
 */
import { describe, it, expect, vi } from "vitest";
import { PlanStatus, StepStatus } from "@motebit/sdk";
import type {
  DelegatedStepResult,
  ExecutionReceipt,
  PlanStep,
  MotebitId,
  DeviceId,
  SensitivityCleared,
} from "@motebit/sdk";
import type { MotebitLoopDependencies } from "@motebit/ai-core";
import { PlanEngine } from "../plan-engine.js";
import type { PlanChunk, StepDelegationAdapter } from "../plan-engine.js";
import { InMemoryPlanStore } from "../types.js";
import { DelegationUndeterminedError } from "../delegation-adapter.js";

type FirstOutcome =
  | "success"
  | "failure"
  | "undetermined_task"
  | "undetermined_no_task"
  | "crash_task"
  | "crash_no_task";
type Truth = "completes" | "fails" | "pending";
type Model = "resume" | "create";

const OUTCOMES: FirstOutcome[] = [
  "success",
  "failure",
  "undetermined_task",
  "undetermined_no_task",
  "crash_task",
  "crash_no_task",
];
const TRUTHS: Truth[] = ["completes", "fails", "pending"];
const RESOLVE_AT: Array<number | null> = [1, 2, 3, null];
const FIRES = 4;
const MODELS: Model[] = ["resume", "create"];

function receipt(taskId: string, status: "completed" | "failed"): ExecutionReceipt {
  return {
    task_id: taskId,
    motebit_id: "worker" as MotebitId,
    device_id: "dev" as DeviceId,
    submitted_at: 1,
    completed_at: 2,
    status,
    result: status === "completed" ? "the work" : "could not do it",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
  };
}

function deps(): SensitivityCleared<MotebitLoopDependencies> {
  return {
    provider: {
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          title: "Hire for it",
          steps: [
            { description: "remote work", prompt: "do it", required_capabilities: ["stdio_mcp"] },
          ],
        }),
      }),
    },
  } as unknown as SensitivityCleared<MotebitLoopDependencies>;
}

/** One submission as the relay sees it, and whether the delegator knows how it ended. */
interface Submission {
  taskId: string;
  known: boolean;
}

/** Thrown out of the fire loop to model the process dying mid-submit. */
const CRASH = Symbol("crash");

class FakeRelay implements StepDelegationAdapter {
  readonly submissions: Submission[] = [];
  readonly violations: string[] = [];
  /** The fire currently running (1-based). */
  fire = 0;
  crashPending = false;

  constructor(
    private readonly first: FirstOutcome,
    private readonly truth: Truth,
    private readonly resolveAt: number | null,
  ) {}

  delegateStep(
    step: PlanStep,
    _timeoutMs: number,
    onTaskSubmitted?: (taskId: string) => void,
  ): Promise<DelegatedStepResult> {
    const unknown = this.submissions.filter((s) => !s.known);
    if (unknown.length > 0) {
      this.violations.push(
        `fire ${this.fire}: submitted again while ${unknown.map((s) => s.taskId).join(",")} unresolved`,
      );
    }
    const n = this.submissions.length;
    const taskId = `task-${n}`;
    const sub: Submission = { taskId, known: false };
    this.submissions.push(sub);
    const kind: FirstOutcome = n === 0 ? this.first : "success";
    switch (kind) {
      case "success":
        onTaskSubmitted?.(taskId);
        sub.known = true;
        return Promise.resolve({
          step_id: step.step_id,
          task_id: taskId,
          receipt: receipt(taskId, "completed"),
          result_text: "the work",
        });
      case "failure": {
        onTaskSubmitted?.(taskId);
        sub.known = true;
        const err = new Error("Delegated step failed: could not do it");
        (err as Error & { failedAgentId?: string }).failedAgentId = "worker";
        return Promise.reject(err);
      }
      case "undetermined_task":
        onTaskSubmitted?.(taskId);
        return Promise.reject(new DelegationUndeterminedError(step.description));
      case "undetermined_no_task":
        return Promise.reject(new DelegationUndeterminedError(step.description));
      case "crash_task":
        onTaskSubmitted?.(taskId);
        this.crashPending = true;
        return new Promise<DelegatedStepResult>(() => {});
      case "crash_no_task":
        this.crashPending = true;
        return new Promise<DelegatedStepResult>(() => {});
    }
  }

  pollTaskResult(taskId: string, stepId: string): Promise<DelegatedStepResult | null> {
    const sub = this.submissions.find((s) => s.taskId === taskId);
    if (sub == null) return Promise.resolve(null);
    if (sub.known) {
      return Promise.resolve({
        step_id: stepId,
        task_id: taskId,
        receipt: receipt(taskId, "completed"),
        result_text: "the work",
      });
    }
    if (this.truth === "pending" || this.resolveAt == null || this.fire < this.resolveAt) {
      return Promise.resolve(null);
    }
    sub.known = true;
    const status = this.truth === "completes" ? "completed" : "failed";
    return Promise.resolve({
      step_id: stepId,
      task_id: taskId,
      receipt: receipt(taskId, status),
      result_text: receipt(taskId, status).result,
    });
  }
}

/** Is this error the "outcome unknown" signal, anywhere in its cause chain? */
function flaggedUndetermined(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if ((e as { undetermined?: unknown }).undetermined === true) return true;
  }
  return false;
}

interface FireResult {
  chunks: PlanChunk[];
  threw: unknown;
  crashed: boolean;
}

/** Drain a plan stream; a crash mid-submit abandons it with the process. */
async function drain(stream: AsyncGenerator<PlanChunk>, relay: FakeRelay): Promise<FireResult> {
  const chunks: PlanChunk[] = [];
  try {
    for (;;) {
      const next = stream.next();
      const r = await Promise.race([
        next,
        new Promise<typeof CRASH>((resolve) => {
          const poll = (): void => {
            if (relay.crashPending) resolve(CRASH);
            else setTimeout(poll, 0);
          };
          poll();
        }),
      ]);
      if (r === CRASH) return { chunks, threw: undefined, crashed: true };
      if (r.done === true) return { chunks, threw: undefined, crashed: false };
      chunks.push(r.value);
    }
  } catch (err: unknown) {
    return { chunks, threw: err, crashed: false };
  }
}

interface CaseResult {
  violations: string[];
  countedFailures: string[];
  finalPlanStatus: PlanStatus | null;
  submissions: number;
  completedFires: number[];
  failedFires: number[];
}

async function runCase(
  first: FirstOutcome,
  truth: Truth,
  resolveAt: number | null,
  restartMask: number,
  model: Model,
): Promise<CaseResult> {
  const store = new InMemoryPlanStore();
  const relay = new FakeRelay(first, truth, resolveAt);
  const newEngine = (): PlanEngine =>
    new PlanEngine(store, {
      delegationAdapter: relay,
      localCapabilities: [],
      enableReflection: false,
      maxPlanRetries: 0,
    });
  let engine = newEngine();
  const planIds: string[] = [];
  const countedFailures: string[] = [];
  const completedFires: number[] = [];
  const failedFires: number[] = [];
  const d = deps();

  for (let fire = 1; fire <= FIRES; fire++) {
    relay.fire = fire;
    // A restart before this fire: a fresh engine over the same durable store.
    if (fire > 1 && (restartMask & (1 << (fire - 2))) !== 0) engine = newEngine();

    let result: FireResult;
    try {
      const latest = planIds.length > 0 ? store.getPlan(planIds[planIds.length - 1]!) : null;
      if (model === "resume" && latest != null && latest.status === PlanStatus.Active) {
        result = await drain(engine.resumePlan(latest.plan_id, d), relay);
      } else {
        const { plan } = await engine.createPlan("goal-890", "mote-890", { goalPrompt: "hire" }, d);
        planIds.push(plan.plan_id);
        result = await drain(engine.executePlan(plan.plan_id, d), relay);
      }
    } catch (err: unknown) {
      result = { chunks: [], threw: err, crashed: false };
    }

    if (result.crashed) {
      // The process died with the submission in flight: the next fire is a
      // new process.
      relay.crashPending = false;
      engine = newEngine();
      continue;
    }
    if (result.chunks.some((c) => c.type === "plan_completed")) completedFires.push(fire);
    const planFailed = result.chunks.find((c) => c.type === "plan_failed");
    if (planFailed != null) {
      failedFires.push(fire);
      countedFailures.push(`fire ${fire}: plan_failed (${planFailed.reason})`);
    }
    if (result.threw !== undefined && !flaggedUndetermined(result.threw)) {
      countedFailures.push(`fire ${fire}: threw ${String(result.threw)}`);
    }
  }

  const last = planIds.length > 0 ? store.getPlan(planIds[planIds.length - 1]!) : null;
  return {
    violations: relay.violations,
    countedFailures,
    finalPlanStatus: last?.status ?? null,
    submissions: relay.submissions.length,
    completedFires,
    failedFires,
  };
}

/** Every cell where the relay's receipt for the first submission becomes readable. */
function resolvable(first: FirstOutcome, truth: Truth, resolveAt: number | null): boolean {
  return (
    (first === "undetermined_task" || first === "crash_task") &&
    truth !== "pending" &&
    resolveAt != null
  );
}

describe("#890 harness — an unknown paid outcome never leads to a second paid attempt", () => {
  it("holds over outcome × relay truth × resolution tick × restart × scheduler model", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failures: string[] = [];
    let cells = 0;
    for (const model of MODELS) {
      for (const first of OUTCOMES) {
        for (const truth of TRUTHS) {
          for (const resolveAt of RESOLVE_AT) {
            for (let restartMask = 0; restartMask < 1 << (FIRES - 1); restartMask++) {
              cells++;
              const label = `${model}/${first}/${truth}/resolve@${resolveAt ?? "never"}/restart=${restartMask.toString(2)}`;
              const r = await runCase(first, truth, resolveAt, restartMask, model);

              // SAFETY
              for (const v of r.violations) failures.push(`${label}: SAFETY ${v}`);

              // COUNTING — only a conclusively failed outcome may count.
              const unknownFirst = first !== "success" && first !== "failure";
              if (unknownFirst) {
                // Fires before the relay's answer is readable report no failure.
                for (const f of r.countedFailures) {
                  const fireNo = Number(/fire (\d+)/.exec(f)?.[1] ?? "0");
                  const answeredFailed =
                    resolvable(first, truth, resolveAt) &&
                    truth === "fails" &&
                    fireNo >= Math.max(2, resolveAt ?? Infinity);
                  if (!answeredFailed) failures.push(`${label}: COUNTING ${f}`);
                }
              }

              // LIVENESS (resume model): a readable receipt settles the held step.
              if (model === "resume" && resolvable(first, truth, resolveAt)) {
                // The first fire that can read it: the submitting fire is fire 1.
                const at = Math.max(2, resolveAt!);
                if (truth === "completes") {
                  if (!r.completedFires.includes(at)) {
                    failures.push(
                      `${label}: LIVENESS completed receipt readable at fire ${at}, plan not completed then (completed at ${r.completedFires.join(",") || "none"})`,
                    );
                  }
                } else if (!r.failedFires.includes(at)) {
                  failures.push(
                    `${label}: LIVENESS failed receipt readable at fire ${at}, plan not failed then (failed at ${r.failedFires.join(",") || "none"})`,
                  );
                }
              }

              // Nothing resolvable ⇒ exactly one submission, ever.
              if (unknownFirst && !resolvable(first, truth, resolveAt) && r.submissions !== 1) {
                failures.push(`${label}: ${r.submissions} submissions for an unresolvable outcome`);
              }
            }
          }
        }
      }
    }
    expect(cells).toBe(MODELS.length * OUTCOMES.length * TRUTHS.length * RESOLVE_AT.length * 8);
    expect(failures.slice(0, 40), `${failures.length} failing cell assertions`).toEqual([]);
  }, 120_000);

  it("a conclusive outcome keeps main's behaviour: success completes, failure fails and the next fire may hire again", async () => {
    const ok = await runCase("success", "completes", null, 0, "resume");
    expect(ok.completedFires).toEqual([1, 2, 3, 4]);
    expect(ok.submissions).toBe(4);
    const bad = await runCase("failure", "fails", null, 0, "resume");
    expect(bad.failedFires).toEqual([1]);
    expect(bad.submissions).toBe(4);
    expect(bad.violations).toEqual([]);
  });

  it("the held step stays Running with its task handle, and its plan stays Active", async () => {
    const store = new InMemoryPlanStore();
    const relay = new FakeRelay("undetermined_task", "pending", null);
    relay.fire = 1;
    const engine = new PlanEngine(store, {
      delegationAdapter: relay,
      localCapabilities: [],
      enableReflection: false,
    });
    const { plan } = await engine.createPlan("g", "m", { goalPrompt: "hire" }, deps());
    await drain(engine.executePlan(plan.plan_id, deps()), relay);
    const [step] = store.getStepsForPlan(plan.plan_id);
    expect(step!.status).toBe(StepStatus.Running);
    expect(step!.delegation_task_id).toBe("task-0");
    expect(store.getPlan(plan.plan_id)!.status).toBe(PlanStatus.Active);
  });
});
