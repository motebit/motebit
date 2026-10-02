/**
 * #890 round 4 — the submission-lifecycle harness.
 *
 * The REAL PlanEngine + RelayDelegationAdapter + InMemoryPlanStore against a
 * model of the relay that has what the real one has:
 *
 *   - Idempotency-Key records kept 24 h, then forgotten (a key reused after
 *     that admits — and charges for — a NEW task);
 *   - a task dropped from the queue 10 min after its receipt, after which
 *     `GET task` is 404 unless the receipt ARCHIVE answers (dimension);
 *   - a 409 naming the task while a key's first request is still processing.
 *
 * Exhaustive over:
 *   POST faults   each of the first 3 POSTs: ok | request lost (never
 *                 reached the relay: offline, DNS) | response lost (admitted,
 *                 answer lost) | still processing (admitted, answer lost, the
 *                 next same-key POST gets a 409 naming the task)
 *   first task    completes | fails (a signed failed receipt)
 *   resume at     +1 h (inside every window) | +21 h (past the 20 h re-post
 *                 window, inside the 24 h key TTL) | +25 h (past both)
 *   archive       the relay answers an evicted task from its receipt archive
 *                 | it does not (404)
 *   drivers       one resume | two concurrent resumes (two processes)
 *
 * Oracle:
 *   ONE PAID TASK  a task is admitted for the step only when every task it
 *                  admitted before carries a signed FAILED receipt — never
 *                  while an earlier one completed or is unknown;
 *   RIGHT RECEIPT  the step never ends failed while its latest task did not
 *                  fail (settled from an earlier task's receipt);
 *   LIVENESS       inside every window with the archive, the step ends
 *                  completed or conclusively failed — never held.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { PlanDriverLocks } from "../plan-lease.js";

type Fault = "ok" | "lost_request" | "lost_response" | "processing" | "admitted_402";
type Outcome = "completes" | "fails";

const FAULTS: Fault[] = ["ok", "lost_request", "lost_response", "processing", "admitted_402"];
const OUTCOMES: Outcome[] = ["completes", "fails"];
const HOUR = 60 * 60 * 1000;
const RESUME_AT = [1 * HOUR, 21 * HOUR, 25 * HOUR];
const KEY_TTL = 24 * HOUR;
const EVICT_AFTER_RECEIPT = 10 * 60 * 1000;
const MOTE = "mote-890";
const PLAN = "plan-890" as PlanId;
const T0 = Date.UTC(2026, 8, 29, 0, 0, 0);

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

interface TaskRec {
  id: string;
  key: string;
  admittedAt: number;
  receipt: ExecutionReceipt;
}

/** The relay, as far as a delegator can observe it. */
class RelayModel {
  readonly tasks: TaskRec[] = [];
  readonly violations: string[] = [];
  private readonly keys = new Map<
    string,
    {
      taskId: string;
      createdAt: number;
      processing: boolean;
      /** The terminal response a replay of this key returns. */
      response: { status: number; body: Record<string, unknown> };
    }
  >();
  private posts = 0;

  constructor(
    private readonly faults: Fault[],
    private readonly firstOutcome: Outcome,
    private readonly archive: boolean,
  ) {}

  private admit(key: string): TaskRec {
    // ONE PAID TASK: every earlier task for this step must have failed.
    const unresolved = this.tasks.filter((t) => t.receipt.status !== "failed");
    if (unresolved.length > 0) {
      this.violations.push(
        `DOUBLE PAY: ${key} admitted a new task while ${unresolved.map((t) => `${t.id}(${t.receipt.status})`).join(",")} stood`,
      );
    }
    const id = `task-${this.tasks.length + 1}`;
    const status =
      this.tasks.length === 0 && this.firstOutcome === "fails" ? "failed" : "completed";
    const rec: TaskRec = { id, key, admittedAt: Date.now(), receipt: receipt(id, status) };
    this.tasks.push(rec);
    return rec;
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const now = Date.now();
    if (init?.method === "POST") {
      const fault = this.faults[this.posts++] ?? "ok";
      if (fault === "lost_request") throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
      const key = (init.headers as Record<string, string>)["Idempotency-Key"]!;
      let rec = this.keys.get(key);
      if (rec != null && now - rec.createdAt > KEY_TTL) {
        this.keys.delete(key); // the relay forgot this key
        rec = undefined;
      }
      if (rec != null && rec.processing) {
        rec.processing = false;
        return new Response(
          JSON.stringify({ code: "TASK_CONFLICT", status: 409, task_id: rec.taskId }),
          { status: 409 },
        );
      }
      if (rec == null) {
        const task = this.admit(key);
        // A post-admission refusal (the ranking loop's 402): the relay's #888
        // seam records it as the key's outcome WITH the admitted task id.
        const response =
          fault === "admitted_402"
            ? {
                status: 402,
                body: { error: "Payment required after admission", status: 402, task_id: task.id },
              }
            : {
                status: 201,
                body: { task_id: task.id, routing_choice: { selected_agent: "worker" } },
              };
        rec = { taskId: task.id, createdAt: now, processing: fault === "processing", response };
        this.keys.set(key, rec);
      }
      if (fault === "lost_response" || fault === "processing") {
        throw new TypeError("fetch failed: socket hang up");
      }
      return new Response(JSON.stringify(rec.response.body), { status: rec.response.status });
    }
    const id = String(url).split("/").pop()!;
    const task = this.tasks.find((t) => t.id === id);
    if (task == null) return new Response("{}", { status: 404 });
    const evicted = now - task.admittedAt > EVICT_AFTER_RECEIPT;
    if (evicted) {
      const keyAlive = now - task.admittedAt <= KEY_TTL;
      if (!this.archive || !keyAlive) return new Response("{}", { status: 404 });
    }
    return new Response(JSON.stringify({ task: { status: "done" }, receipt: task.receipt }), {
      status: 200,
    });
  };
}

function freshStore(): InMemoryPlanStore {
  const store = new InMemoryPlanStore();
  store.savePlan({
    plan_id: PLAN,
    goal_id: "goal-890",
    motebit_id: MOTE as MotebitId,
    title: "Hire",
    status: PlanStatus.Active,
    created_at: T0,
    updated_at: T0,
    current_step_index: 0,
    total_steps: 1,
  });
  const step: PlanStep = {
    step_id: "s1",
    plan_id: PLAN,
    ordinal: 0,
    description: "remote work",
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
    updated_at: T0,
  };
  store.saveStep(step);
  return store;
}

const deps = {} as SensitivityCleared<MotebitLoopDependencies>;

async function drain(gen: AsyncGenerator<PlanChunk>): Promise<PlanChunk[]> {
  const out: PlanChunk[] = [];
  const p = (async () => {
    try {
      for await (const c of gen) out.push(c);
    } catch {
      // a driver that throws drove nothing further
    }
  })();
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  await p;
  return out;
}

interface CellResult {
  violations: string[];
  status: StepStatus;
  tasks: TaskRec[];
}

async function runCell(
  faults: Fault[],
  outcome: Outcome,
  resumes: number[],
  archive: boolean,
  drivers: 1 | 2,
): Promise<CellResult> {
  vi.setSystemTime(T0);
  const relay = new RelayModel(faults, outcome, archive);
  vi.stubGlobal("fetch", relay.fetch);
  const store = freshStore();
  const engine = (): PlanEngine =>
    new PlanEngine(store, {
      delegationAdapter: new RelayDelegationAdapter({
        syncUrl: "http://relay",
        motebitId: MOTE,
        sendRaw: () => {},
        onCustomMessage: () => () => {},
        maxDelegationRetries: 2,
      }),
      localCapabilities: [],
      enableReflection: false,
      delegationTimeoutMs: 1_000,
      driverLocks: new PlanDriverLocks(),
    });

  await drain(engine().executePlan(PLAN, deps));

  // Later: one or two processes resume the goal's plan on the schedule.
  for (const at of resumes) {
    vi.setSystemTime(T0 + at);
    const plan = store.getPlan(PLAN)!;
    if (plan.status !== PlanStatus.Active) break;
    if (drivers === 1) await drain(engine().resumePlan(PLAN, deps));
    else {
      const a = engine().resumePlan(PLAN, deps);
      const b = engine().resumePlan(PLAN, deps);
      await Promise.all([drain(a), drain(b)]);
    }
  }

  const step = store.getStep("s1")!;
  const violations = [...relay.violations];
  const latest = relay.tasks.at(-1);
  if (step.status === StepStatus.Failed && latest != null && latest.receipt.status !== "failed") {
    violations.push(`WRONG RECEIPT: step failed while its latest task ${latest.id} did not`);
  }
  return { violations, status: step.status, tasks: relay.tasks };
}

describe("#890 r4 submission-lifecycle harness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  for (const archive of [false, true]) {
    it(`POST faults × first outcome × resume time × drivers — archive ${archive ? "on" : "off"}`, async () => {
      const failures: string[] = [];
      let cells = 0;
      for (const f1 of FAULTS) {
        for (const f2 of FAULTS) {
          for (const f3 of FAULTS) {
            for (const outcome of OUTCOMES) {
              for (const resumeAt of RESUME_AT) {
                for (const drivers of [1, 2] as const) {
                  cells++;
                  const label = `${f1},${f2},${f3}/${outcome}/+${resumeAt / HOUR}h/x${drivers}`;
                  const r = await runCell(
                    [f1, f2, f3],
                    outcome,
                    [resumeAt, resumeAt + 60_000],
                    archive,
                    drivers,
                  );
                  for (const v of r.violations) failures.push(`${label}: ${v}`);
                  // LIVENESS inside every window, with the archive.
                  if (
                    archive &&
                    resumeAt === RESUME_AT[0] &&
                    r.status !== StepStatus.Completed &&
                    r.status !== StepStatus.Failed
                  ) {
                    failures.push(`${label}: LIVENESS step ${r.status}, tasks ${r.tasks.length}`);
                  }
                }
              }
            }
          }
        }
      }
      expect(cells).toBe(FAULTS.length ** 3 * OUTCOMES.length * RESUME_AT.length * 2);
      const tally = (tag: string) => failures.filter((f) => f.includes(tag)).length;
      expect(
        failures.slice(0, 30),
        `${failures.length} failing: ${tally("DOUBLE PAY")} double-pay, ${tally("WRONG RECEIPT")} wrong-receipt, ${tally("LIVENESS")} liveness`,
      ).toEqual([]);
    }, 600_000);
  }

  // #890 r5: a rotation LATE in the first key's window. Task-1's answer is
  // lost at T0; at +19 h a resume learns task-1 failed and rotates to key :1,
  // whose answer is lost too. Key :1 was first used at +19 h, so at +21 h it
  // is deep inside its own relay window: the resume must re-post it, not hold
  // it on key :0's clock.
  const TAILS: Array<[Fault, Fault]> = [];
  for (const a of ["lost_request", "lost_response", "processing"] as Fault[]) {
    for (const b of ["lost_request", "lost_response", "processing"] as Fault[]) TAILS.push([a, b]);
  }
  it("a rotation late in the window × lost answers on the new key × archive × drivers", async () => {
    const failures: string[] = [];
    for (const [a, b] of TAILS) {
      for (const archive of [false, true]) {
        for (const drivers of [1, 2] as const) {
          const label = `late ${a},${b}/archive ${archive}/x${drivers}`;
          const r = await runCell(
            ["lost_response", "lost_request", "lost_request", "ok", a, b],
            "fails",
            [19 * HOUR, 21 * HOUR, 41 * HOUR],
            archive,
            drivers,
          );
          for (const v of r.violations) failures.push(`${label}: ${v}`);
          if (archive && r.status !== StepStatus.Completed) {
            failures.push(`${label}: LIVENESS step ${r.status}, tasks ${r.tasks.length}`);
          }
        }
      }
    }
    const tally = (tag: string) => failures.filter((f) => f.includes(tag)).length;
    expect(
      failures.slice(0, 30),
      `${failures.length} failing: ${tally("DOUBLE PAY")} double-pay, ${tally("WRONG RECEIPT")} wrong-receipt, ${tally("LIVENESS")} liveness`,
    ).toEqual([]);
  }, 600_000);
});
