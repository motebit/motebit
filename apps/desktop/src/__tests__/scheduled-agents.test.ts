/**
 * Tests for the scheduled-agents runner.
 *
 * Covers:
 *   - localStorage persistence + malformed-row filtering
 *   - add / list / setEnabled / remove / runNow
 *   - subscribe / subscribeRuns — snapshot isolation, unsubscribe
 *   - fireAgent lifecycle: running → fired / skipped / error
 *   - skipped results do NOT advance next_run_at
 *   - in-flight dedup: re-fire while a previous call is pending is a no-op
 *   - tick via setInterval fires only due + enabled + non-inflight agents
 *   - dispose clears timers and listeners
 *   - formatCountdownUntil branches
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  createScheduledAgentsRunner,
  formatCountdownUntil,
  type ScheduledAgent,
  type ScheduledAgentsDeps,
  type ScheduledFireResult,
} from "../scheduled-agents";

const STORAGE_KEY = "motebit.scheduled_agents";

/**
 * Flush pending microtasks + the fireAgent promise chain without
 * running vi.runAllTimersAsync() (which would loop forever on the
 * scheduler's setInterval).
 */
async function flushFireAgent(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

beforeEach(() => {
  // Fresh localStorage per test.
  (globalThis as unknown as { localStorage: Storage }).localStorage = makeLocalStorage();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createScheduledAgentsRunner — basic CRUD + persistence", () => {
  it("loads zero agents on first boot and fires no initial ticks", () => {
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(async () => ({
      status: "fired",
    }));
    const runner = createScheduledAgentsRunner({ fire });
    expect(runner.list()).toEqual([]);
    expect(runner.listRuns()).toEqual([]);
    runner.dispose();
  });

  it("add() persists to localStorage and next_run_at is now + interval", () => {
    vi.setSystemTime(new Date(1_000_000_000));
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(async () => ({
      status: "fired",
    }));
    const runner = createScheduledAgentsRunner({ fire });
    const a = runner.add({ prompt: "brief me", cadence: "hourly" });
    expect(a.prompt).toBe("brief me");
    expect(a.cadence).toBe("hourly");
    expect(a.enabled).toBe(true);
    expect(a.interval_ms).toBe(60 * 60 * 1000);
    expect(a.next_run_at).toBe(1_000_000_000 + 60 * 60 * 1000);

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toHaveLength(1);
    runner.dispose();
  });

  it("add() supports daily + weekly cadences", () => {
    vi.setSystemTime(new Date(0));
    const runner = createScheduledAgentsRunner({ fire: async () => ({ status: "fired" }) });
    const d = runner.add({ prompt: "x", cadence: "daily" });
    const w = runner.add({ prompt: "y", cadence: "weekly" });
    expect(d.interval_ms).toBe(24 * 60 * 60 * 1000);
    expect(w.interval_ms).toBe(7 * 24 * 60 * 60 * 1000);
    runner.dispose();
  });

  it("setEnabled flips the flag and persists", () => {
    const runner = createScheduledAgentsRunner({ fire: async () => ({ status: "fired" }) });
    const a = runner.add({ prompt: "x", cadence: "hourly" });
    runner.setEnabled(a.id, false);
    expect(runner.list()[0]!.enabled).toBe(false);
    runner.setEnabled(a.id, true);
    expect(runner.list()[0]!.enabled).toBe(true);
    runner.dispose();
  });

  it("remove() drops the agent and emits", () => {
    const runner = createScheduledAgentsRunner({ fire: async () => ({ status: "fired" }) });
    const a = runner.add({ prompt: "x", cadence: "hourly" });
    runner.remove(a.id);
    expect(runner.list()).toEqual([]);
    runner.dispose();
  });

  it("list() returns shallow clones (callers can't mutate internal state)", () => {
    const runner = createScheduledAgentsRunner({ fire: async () => ({ status: "fired" }) });
    runner.add({ prompt: "x", cadence: "hourly" });
    const snap = runner.list();
    snap[0]!.prompt = "tampered";
    expect(runner.list()[0]!.prompt).toBe("x");
    runner.dispose();
  });

  it("persists across runner instances (localStorage round-trip)", () => {
    const r1 = createScheduledAgentsRunner({ fire: async () => ({ status: "fired" }) });
    const a = r1.add({ prompt: "x", cadence: "hourly" });
    r1.dispose();

    const r2 = createScheduledAgentsRunner({ fire: async () => ({ status: "fired" }) });
    expect(r2.list()).toHaveLength(1);
    expect(r2.list()[0]!.id).toBe(a.id);
    r2.dispose();
  });

  it("filters malformed rows from localStorage", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        null,
        "garbage",
        { id: 1, prompt: "bad shape" }, // id wrong type
        {
          id: "ok",
          prompt: "valid",
          cadence: "hourly",
          interval_ms: 1000,
          enabled: true,
          created_at: 1,
          last_run_at: null,
          next_run_at: 2,
        },
      ]),
    );
    const runner = createScheduledAgentsRunner({ fire: async () => ({ status: "fired" }) });
    expect(runner.list()).toHaveLength(1);
    expect(runner.list()[0]!.id).toBe("ok");
    runner.dispose();
  });

  it("returns [] when localStorage is non-JSON", () => {
    localStorage.setItem(STORAGE_KEY, "not-json");
    const runner = createScheduledAgentsRunner({ fire: async () => ({ status: "fired" }) });
    expect(runner.list()).toEqual([]);
    runner.dispose();
  });

  it("returns [] when localStorage contains a non-array JSON value", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: "an array" }));
    const runner = createScheduledAgentsRunner({ fire: async () => ({ status: "fired" }) });
    expect(runner.list()).toEqual([]);
    runner.dispose();
  });
});

describe("createScheduledAgentsRunner — subscribe", () => {
  it("subscribe fires on add/setEnabled/remove and unsubscribes cleanly", () => {
    const runner = createScheduledAgentsRunner({ fire: async () => ({ status: "fired" }) });
    const listener = vi.fn<(agents: ScheduledAgent[]) => void>();
    const unsub = runner.subscribe(listener);

    const a = runner.add({ prompt: "x", cadence: "hourly" });
    expect(listener).toHaveBeenCalledTimes(1);
    runner.setEnabled(a.id, false);
    expect(listener).toHaveBeenCalledTimes(2);
    runner.remove(a.id);
    expect(listener).toHaveBeenCalledTimes(3);

    unsub();
    runner.add({ prompt: "y", cadence: "daily" });
    expect(listener).toHaveBeenCalledTimes(3);
    runner.dispose();
  });

  it("isolates subscriber faults", () => {
    const runner = createScheduledAgentsRunner({ fire: async () => ({ status: "fired" }) });
    const good = vi.fn();
    runner.subscribe(() => {
      throw new Error("boom");
    });
    runner.subscribe(good);
    runner.add({ prompt: "x", cadence: "hourly" });
    expect(good).toHaveBeenCalled();
    runner.dispose();
  });

  it("subscribeRuns emits on fireAgent lifecycle and unsubscribes", async () => {
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(async () => ({
      status: "fired",
      responsePreview: "ok",
    }));
    const runner = createScheduledAgentsRunner({ fire });
    const runListener = vi.fn();
    const unsub = runner.subscribeRuns(runListener);

    const a = runner.add({ prompt: "x", cadence: "hourly" });
    runner.runNow(a.id);

    // Running record fires synchronously before the await deps.fire(...)
    expect(runListener).toHaveBeenCalledTimes(1);
    expect(runListener.mock.calls[0]![0][0].status).toBe("running");

    // Let the fire promise resolve — the terminal upsert runs.
    await flushFireAgent();
    expect(runListener.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(runner.listRuns()[0]!.status).toBe("fired");

    unsub();
    runner.dispose();
  });

  it("isolates run-subscriber faults", async () => {
    const runner = createScheduledAgentsRunner({
      fire: async () => ({ status: "fired" }),
    });
    const good = vi.fn();
    runner.subscribeRuns(() => {
      throw new Error("boom");
    });
    runner.subscribeRuns(good);
    const a = runner.add({ prompt: "x", cadence: "hourly" });
    runner.runNow(a.id);
    await flushFireAgent();
    expect(good).toHaveBeenCalled();
    runner.dispose();
  });
});

describe("createScheduledAgentsRunner — fireAgent lifecycle", () => {
  it("fired → advances next_run_at and records last_run_at", async () => {
    vi.setSystemTime(new Date(1000));
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(async () => ({
      status: "fired",
      responsePreview: "hi",
    }));
    const runner = createScheduledAgentsRunner({ fire });
    const a = runner.add({ prompt: "x", cadence: "hourly" });
    runner.runNow(a.id);
    vi.setSystemTime(new Date(2000));
    await flushFireAgent();

    const updated = runner.list().find((x) => x.id === a.id)!;
    expect(typeof updated.last_run_at).toBe("number");
    expect(updated.last_run_at).toBeGreaterThanOrEqual(1000);
    expect(updated.next_run_at).toBeGreaterThanOrEqual(2000 + a.interval_ms);
    expect(runner.listRuns()[0]!.status).toBe("fired");
    expect(runner.listRuns()[0]!.responsePreview).toBe("hi");
    runner.dispose();
  });

  it("error → advances next_run_at (prevents tight loops) and records errorMessage", async () => {
    vi.setSystemTime(new Date(1000));
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(async () => ({
      status: "error",
      error: "llm down",
    }));
    const runner = createScheduledAgentsRunner({ fire });
    const a = runner.add({ prompt: "x", cadence: "hourly" });
    const originalNext = a.next_run_at;
    runner.runNow(a.id);
    vi.setSystemTime(new Date(2000));
    await flushFireAgent();

    const updated = runner.list().find((x) => x.id === a.id)!;
    expect(updated.next_run_at).not.toBe(originalNext);
    const run = runner.listRuns()[0]!;
    expect(run.status).toBe("error");
    expect(run.errorMessage).toBe("llm down");
    runner.dispose();
  });

  it("skipped → does NOT advance next_run_at; no error row", async () => {
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(async () => ({
      status: "skipped",
    }));
    const runner = createScheduledAgentsRunner({ fire });
    const a = runner.add({ prompt: "x", cadence: "hourly" });
    const originalNext = a.next_run_at;
    runner.runNow(a.id);
    await flushFireAgent();

    const updated = runner.list().find((x) => x.id === a.id)!;
    expect(updated.next_run_at).toBe(originalNext);
    const run = runner.listRuns()[0]!;
    expect(run.status).toBe("skipped");
    expect(run.errorMessage).toBeNull();
  });

  it("thrown error inside fire() is caught and becomes an error record", async () => {
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(async () => {
      throw new Error("network exploded");
    });
    const runner = createScheduledAgentsRunner({ fire });
    const a = runner.add({ prompt: "x", cadence: "hourly" });
    runner.runNow(a.id);
    await flushFireAgent();
    const run = runner.listRuns()[0]!;
    expect(run.status).toBe("error");
    expect(run.errorMessage).toContain("network exploded");
    runner.dispose();
  });

  it("thrown non-Error inside fire() stringifies", async () => {
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- testing non-Error reject path
      throw "plain-string-error";
    });
    const runner = createScheduledAgentsRunner({ fire });
    const a = runner.add({ prompt: "x", cadence: "hourly" });
    runner.runNow(a.id);
    await flushFireAgent();
    expect(runner.listRuns()[0]!.errorMessage).toBe("plain-string-error");
    runner.dispose();
  });

  it("runNow is a no-op when the agent id is unknown", () => {
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(async () => ({
      status: "fired",
    }));
    const runner = createScheduledAgentsRunner({ fire });
    runner.runNow("nonexistent");
    expect(fire).not.toHaveBeenCalled();
    runner.dispose();
  });

  it("in-flight dedup: re-fire while a previous call is pending is a no-op", async () => {
    let resolveFire: ((r: ScheduledFireResult) => void) | null = null;
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(
      () =>
        new Promise((r) => {
          resolveFire = r;
        }),
    );
    const runner = createScheduledAgentsRunner({ fire });
    const a = runner.add({ prompt: "x", cadence: "hourly" });
    runner.runNow(a.id);
    runner.runNow(a.id); // should be a no-op
    expect(fire).toHaveBeenCalledTimes(1);

    resolveFire!({ status: "fired" });
    await flushFireAgent();
    runner.dispose();
  });
});

describe("createScheduledAgentsRunner — tick via setInterval", () => {
  it("ticks after the 2s kickstart and fires due + enabled agents", async () => {
    vi.setSystemTime(new Date(0));
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(async () => ({
      status: "fired",
    }));
    const runner = createScheduledAgentsRunner({ fire });
    // Inject an overdue agent directly so we don't wait an hour.
    const overdue: ScheduledAgent = {
      id: "due",
      prompt: "run me",
      cadence: "hourly",
      interval_ms: 60 * 60 * 1000,
      enabled: true,
      created_at: 0,
      last_run_at: null,
      next_run_at: -1, // overdue
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([overdue]));

    // Rebuild the runner so it reloads the overdue agent.
    runner.dispose();
    const runner2 = createScheduledAgentsRunner({ fire });

    // Advance past the 2s initial timer.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fire).toHaveBeenCalledWith("run me");
    runner2.dispose();
  });

  it("disabled agents are not fired by tick", async () => {
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(async () => ({
      status: "fired",
    }));
    const overdue: ScheduledAgent = {
      id: "disabled",
      prompt: "should not fire",
      cadence: "hourly",
      interval_ms: 60 * 60 * 1000,
      enabled: false,
      created_at: 0,
      last_run_at: null,
      next_run_at: -1,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([overdue]));
    const runner = createScheduledAgentsRunner({ fire });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fire).not.toHaveBeenCalled();
    runner.dispose();
  });

  it("dispose stops future ticks and listeners", async () => {
    const fire = vi.fn<(p: string) => Promise<ScheduledFireResult>>(async () => ({
      status: "fired",
    }));
    const runner = createScheduledAgentsRunner({ fire });
    runner.dispose();
    // Second dispose is a no-op.
    runner.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fire).not.toHaveBeenCalled();
  });
});

describe("formatCountdownUntil", () => {
  const now = 10_000_000;

  it("returns 'any moment' when target is in the past or exactly now", () => {
    expect(formatCountdownUntil(now - 1, now)).toBe("any moment");
    expect(formatCountdownUntil(now, now)).toBe("any moment");
  });

  it("renders seconds when under a minute", () => {
    expect(formatCountdownUntil(now + 45_000, now)).toBe("in 45s");
  });

  it("renders minutes when under an hour", () => {
    expect(formatCountdownUntil(now + 15 * 60_000, now)).toBe("in 15m");
  });

  it("renders hours only when minutes is zero", () => {
    expect(formatCountdownUntil(now + 3 * 60 * 60_000, now)).toBe("in 3h");
  });

  it("renders hours + minutes when minutes is non-zero", () => {
    expect(formatCountdownUntil(now + 3 * 60 * 60_000 + 20 * 60_000, now)).toBe("in 3h 20m");
  });

  it("renders days only when hours is zero", () => {
    expect(formatCountdownUntil(now + 2 * 24 * 60 * 60_000, now)).toBe("in 2d");
  });

  it("renders days + hours when hours is non-zero", () => {
    expect(formatCountdownUntil(now + 2 * 24 * 60 * 60_000 + 5 * 60 * 60_000, now)).toBe(
      "in 2d 5h",
    );
  });

  it("uses Date.now() as default", () => {
    vi.setSystemTime(new Date(1000));
    expect(formatCountdownUntil(1000 + 10_000)).toBe("in 10s");
  });
});

describe("createScheduledAgentsRunner — misc", () => {
  it("handles localStorage absence (define/undefine)", () => {
    // Remove localStorage entirely.
    const orig = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    delete (globalThis as { localStorage?: Storage }).localStorage;

    const deps: ScheduledAgentsDeps = { fire: async () => ({ status: "fired" }) };
    const runner = createScheduledAgentsRunner(deps);
    expect(runner.list()).toEqual([]);
    runner.add({ prompt: "x", cadence: "hourly" });
    // No throw even though setItem is unreachable.
    runner.dispose();

    (globalThis as unknown as { localStorage: Storage }).localStorage = orig!;
  });

  it("tolerates a saveAgents throw (quota exceeded simulation)", () => {
    const throwing: Storage = {
      ...makeLocalStorage(),
      setItem: () => {
        throw new Error("quota");
      },
    };
    (globalThis as unknown as { localStorage: Storage }).localStorage = throwing;
    const runner = createScheduledAgentsRunner({ fire: async () => ({ status: "fired" }) });
    // Should not throw even though setItem explodes.
    expect(() => runner.add({ prompt: "x", cadence: "hourly" })).not.toThrow();
    runner.dispose();
  });
});
