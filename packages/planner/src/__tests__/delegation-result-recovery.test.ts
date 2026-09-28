/**
 * #816 / #433 — a missing task_result frame is a DELIVERY failure, never a
 * task failure. When the frame does not arrive in time the adapter asks the
 * relay how the SAME task ended; only when the relay cannot say does it
 * resubmit, and then under the same Idempotency-Key, so the relay replays
 * the task it already admitted instead of running and charging for a second.
 * A task that conclusively FAILED is retried as a new task (new key,
 * failed agent excluded), as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RelayDelegationAdapter } from "../delegation-adapter.js";
import { DeviceCapability, StepStatus } from "@motebit/sdk";
import type { ExecutionReceipt, MotebitId, DeviceId, PlanStep, PlanId } from "@motebit/sdk";

type Frame = { type: string; [key: string]: unknown };

function receipt(taskId: string, status: "completed" | "failed" = "completed", by = "worker") {
  return {
    task_id: taskId,
    motebit_id: by as MotebitId,
    device_id: "d" as DeviceId,
    submitted_at: 0,
    completed_at: 0,
    status,
    result: status === "completed" ? "done" : "broke",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "s",
  } as ExecutionReceipt;
}

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

/**
 * A relay: admits a task per NEW Idempotency-Key, replays the same task for
 * a key it has seen, and answers `GET /task/:id` from `taskState`.
 */
function fakeRelay() {
  const keys: string[] = [];
  const admitted = new Map<string, string>(); // key → task_id
  const queries: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  let taskState: (taskId: string) => Response = () =>
    new Response(JSON.stringify({ task: { status: "pending" }, receipt: null }), { status: 200 });
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
      return new Response(JSON.stringify({ task_id: id }), { status: 201 });
    }
    const taskId = String(url).split("/").pop()!;
    queries.push(taskId);
    return taskState(taskId);
  });
  return {
    fetchMock,
    keys,
    bodies,
    queries,
    /** Distinct tasks the relay admitted — what it would run and charge for. */
    admittedCount: () => admitted.size,
    setTaskState(fn: (taskId: string) => Response) {
      taskState = fn;
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function makeAdapter() {
  const listeners = new Set<(m: Frame) => void>();
  const adapter = new RelayDelegationAdapter({
    syncUrl: "http://relay",
    motebitId: "me",
    sendRaw: () => {},
    onCustomMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    maxDelegationRetries: 1,
  });
  const push = (frame: Frame) => {
    for (const l of [...listeners]) l(frame);
  };
  return { adapter, push };
}

const TIMEOUT = 300_000;

describe("RelayDelegationAdapter: a lost result frame is recovered, not resubmitted", () => {
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

  it("frame lost, the relay has the receipt: resolves from it, one task", async () => {
    const { adapter } = makeAdapter();
    relay.setTaskState((id) => json({ task: { status: "completed" }, receipt: receipt(id) }));
    const p = adapter.delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1);

    const r = await p;
    expect(r.task_id).toBe("task-1");
    expect(r.receipt.status).toBe("completed");
    expect(relay.keys).toHaveLength(1);
    expect(relay.admittedCount()).toBe(1);
    expect(relay.queries).toEqual(["task-1"]);
  });

  it("frame lost, the relay says still running: keeps listening and a late frame resolves it", async () => {
    const { adapter, push } = makeAdapter();
    const p = adapter.delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1); // times out; relay: pending
    push({ type: "task_result", task_id: "task-1", receipt: receipt("task-1") });

    const r = await p;
    expect(r.task_id).toBe("task-1");
    expect(relay.keys).toHaveLength(1);
  });

  it("frame lost, pending then done on a later ask: resolves, one task", async () => {
    const { adapter } = makeAdapter();
    let asks = 0;
    relay.setTaskState((id) =>
      ++asks < 3
        ? json({ task: { status: "running" }, receipt: null })
        : json({ task: { status: "completed" }, receipt: receipt(id) }),
    );
    const p = adapter.delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT + 60_000);

    const r = await p;
    expect(r.receipt.status).toBe("completed");
    expect(relay.admittedCount()).toBe(1);
    expect(asks).toBe(3);
  });

  it("frame lost and the relay cannot say: the retry reuses the Idempotency-Key, so one task", async () => {
    const { adapter, push } = makeAdapter();
    let asks = 0;
    relay.setTaskState(() => (++asks === 1 ? json({}, 503) : json({}, 404)));
    const p = adapter.delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1); // attempt 1: timeout, relay 503
    // attempt 2 resubmitted under the same key; the relay replays task-1
    expect(relay.keys).toHaveLength(2);
    expect(relay.keys[1]).toBe(relay.keys[0]);
    push({ type: "task_result", task_id: "task-1", receipt: receipt("task-1") });

    const r = await p;
    expect(r.task_id).toBe("task-1");
    expect(relay.admittedCount()).toBe(1);
  });

  it("still running past the bound: resubmits under the same key", async () => {
    const { adapter } = makeAdapter();
    const p = adapter.delegateStep(step, TIMEOUT);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT + 60_000); // wait + bounded pending wait
    expect(relay.keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(relay.keys).size).toBe(1);
    expect(relay.admittedCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * TIMEOUT);
    await expect(p).rejects.toThrow(/Delegation failed/);
  });

  it("a task that genuinely FAILED retries once as a new task, the failed agent excluded", async () => {
    const { adapter, push } = makeAdapter();
    const p = adapter.delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(10);
    push({ type: "task_result", task_id: "task-1", receipt: receipt("task-1", "failed", "bad") });
    await vi.advanceTimersByTimeAsync(10);
    push({ type: "task_result", task_id: "task-2", receipt: receipt("task-2") });

    const r = await p;
    expect(r.task_id).toBe("task-2");
    expect(relay.keys).toHaveLength(2);
    expect(relay.keys[1]).not.toBe(relay.keys[0]);
    expect(relay.bodies[1]!.exclude_agents).toEqual(["bad"]);
    expect(relay.queries).toEqual([]);
  });

  it("the relay's answer is a FAILED receipt: retries as a new task, the failed agent excluded", async () => {
    const { adapter, push } = makeAdapter();
    relay.setTaskState((id) =>
      id === "task-1"
        ? json({ task: { status: "failed" }, receipt: receipt(id, "failed", "bad") })
        : json({ task: { status: "pending" }, receipt: null }),
    );
    const p = adapter.delegateStep(step, TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1);
    expect(relay.keys).toHaveLength(2);
    expect(relay.keys[1]).not.toBe(relay.keys[0]);
    expect(relay.bodies[1]!.exclude_agents).toEqual(["bad"]);
    push({ type: "task_result", task_id: "task-2", receipt: receipt("task-2") });

    const r = await p;
    expect(r.task_id).toBe("task-2");
  });
});

/**
 * The relay answers a same-key resubmission with 409 ("a request with this
 * idempotency key is already being processed") while the original is still
 * in its handler. Documented, not changed (#816 review): a 409 is treated as
 * a non-retryable submission failure today.
 */
describe("RelayDelegationAdapter: a 409 on a same-key retry", () => {
  let relay: ReturnType<typeof fakeRelay>;
  let posts = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    relay = fakeRelay();
    posts = 0;
    // Attempt 1 is admitted as task-1; its result frame is lost and the relay
    // cannot answer the query. The same-key retry meets a 409.
    relay.setTaskState(() => json({}, 503));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && ++posts > 1) {
          relay.keys.push((init.headers as Record<string, string>)["Idempotency-Key"]!);
          return new Response("already being processed", { status: 409 });
        }
        return relay.fetchMock(url, init);
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not admit a second task", async () => {
    const { adapter } = makeAdapter();
    const p = adapter.delegateStep(step, TIMEOUT);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1);

    await expect(p).rejects.toThrow(/Relay task submission failed \(409\)/);
    expect(relay.keys).toHaveLength(2);
    expect(relay.keys[1]).toBe(relay.keys[0]);
    expect(relay.admittedCount()).toBe(1);
  });

  // KNOWN GAP (reported, not changed): the 409 ends the step as a hard
  // failure even though task-1 is still running and later completes. Marked
  // `fails`: it turns red — as an unexpected pass — once the 409 path learns
  // to wait on the task it already admitted.
  it.fails("resolves when the relay later reports the admitted task completed", async () => {
    const { adapter } = makeAdapter();
    const p = adapter.delegateStep(step, TIMEOUT);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1);
    relay.setTaskState((id) => json({ task: { status: "completed" }, receipt: receipt(id) }));
    await vi.advanceTimersByTimeAsync(TIMEOUT);

    const r = await p;
    expect(r.task_id).toBe("task-1");
  });
});
