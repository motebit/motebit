import { describe, it, expect, vi, afterEach } from "vitest";
import { TaskClaimCoordinator } from "../task-claim.js";

afterEach(() => {
  vi.useRealTimers();
});

function harness(opts: { grantTimeoutMs?: number } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const events: unknown[] = [];
  const c = new TaskClaimCoordinator({
    send: (f) => sent.push(JSON.parse(f) as Record<string, unknown>),
    onEvent: (e) => events.push(e),
    ...opts,
  });
  return { c, sent, events };
}

describe("TaskClaimCoordinator — run only on the relay's grant", () => {
  it("sends a leased task_claim and does not run before the grant", async () => {
    const { c, sent } = harness();
    const run = vi.fn(async () => {});
    expect(c.offer("t1", run)).toBe("claiming");
    expect(sent).toEqual([{ type: "task_claim", task_id: "t1", lease: true }]);
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(c.handleFrame({ type: "task_claimed", task_id: "t1" })).toBe(true);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(c.holds("t1")).toBe(false));
  });

  it("drops the task on task_claim_rejected — never runs it", async () => {
    const { c, events } = harness();
    const run = vi.fn(async () => {});
    c.offer("t1", run);
    expect(
      c.handleFrame({ type: "task_claim_rejected", task_id: "t1", reason: "already_claimed" }),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(run).not.toHaveBeenCalled();
    expect(c.holds("t1")).toBe(false);
    expect(events).toEqual([{ kind: "rejected", taskId: "t1", reason: "already_claimed" }]);
  });

  it("a task presented again while claimed or running is a duplicate", async () => {
    const { c, sent } = harness();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (finish = r)));
    c.offer("t1", run);
    expect(c.offer("t1", run)).toBe("duplicate");
    c.handleFrame({ type: "task_claimed", task_id: "t1" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(c.offer("t1", run)).toBe("duplicate");
    expect(sent.filter((f) => f.type === "task_claim")).toHaveLength(1);
    // A second grant for the same task (a duplicate frame) never runs it twice.
    expect(c.handleFrame({ type: "task_claimed", task_id: "t1" })).toBe(false);
    finish();
    await vi.waitFor(() => expect(c.holds("t1")).toBe(false));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores frames that are not answers to its own claims", () => {
    const { c } = harness();
    expect(c.handleFrame({ type: "task_request", task_id: "t1" })).toBe(false);
    expect(c.handleFrame({ type: "task_claimed", task_id: "unknown" })).toBe(false);
    expect(c.handleFrame({ type: "task_claimed", task_id: 7 })).toBe(false);
  });

  it("renews the lease at a third of lease_ms while running, through the current send", async () => {
    vi.useFakeTimers();
    const { c, sent } = harness();
    let finish!: () => void;
    c.offer("t1", () => new Promise<void>((r) => (finish = r)));
    c.handleFrame({ type: "task_claimed", task_id: "t1", lease_ms: 300 });
    await vi.advanceTimersByTimeAsync(350);
    expect(sent.filter((f) => f.type === "task_claim_renew")).toHaveLength(3);
    const after: string[] = [];
    c.setSend((f) => after.push(f));
    await vi.advanceTimersByTimeAsync(100);
    expect(after).toEqual([JSON.stringify({ type: "task_claim_renew", task_id: "t1" })]);
    finish();
    await vi.advanceTimersByTimeAsync(1);
    after.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(after).toEqual([]);
  });

  it("drops a claim whose grant never arrives", async () => {
    vi.useFakeTimers();
    const { c, events } = harness({ grantTimeoutMs: 100 });
    const run = vi.fn(async () => {});
    c.offer("t1", run);
    await vi.advanceTimersByTimeAsync(101);
    expect(c.holds("t1")).toBe(false);
    expect(events).toEqual([{ kind: "grant_timeout", taskId: "t1" }]);
    expect(c.handleFrame({ type: "task_claimed", task_id: "t1" })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("a failing run is reported and releases the claim", async () => {
    const { c, events } = harness();
    c.offer("t1", async () => {
      throw new Error("boom");
    });
    c.handleFrame({ type: "task_claimed", task_id: "t1" });
    await vi.waitFor(() => expect(c.holds("t1")).toBe(false));
    expect(events).toEqual([{ kind: "run_failed", taskId: "t1", error: "boom" }]);
  });

  it("a send that throws (closed socket) never escapes offer", () => {
    const c = new TaskClaimCoordinator({
      send: () => {
        throw new Error("closed");
      },
    });
    expect(() => c.offer("t1", async () => {})).not.toThrow();
    c.dispose();
    expect(c.holds("t1")).toBe(false);
  });
});
