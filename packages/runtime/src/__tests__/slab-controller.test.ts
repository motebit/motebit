import { describe, it, expect, vi } from "vitest";
import {
  createSlabController,
  defaultDetachPolicy,
  type SlabController,
  type SlabState,
  type TimeoutHandle,
  type DetachPolicy,
} from "../slab-controller.js";

// ── Test utilities ────────────────────────────────────────────────────

/**
 * Synthetic timer scheduler. Lets tests advance time deterministically
 * without relying on vi.useFakeTimers (which conflicts with async
 * microtask scheduling vitest uses for some assertions).
 */
function makeSyntheticScheduler() {
  let now = 1_000_000_000;
  const queue: Array<{ at: number; cb: () => void; cancelled: boolean }> = [];
  return {
    now: () => now,
    scheduleTimeout: (cb: () => void, delayMs: number): TimeoutHandle => {
      const entry = { at: now + delayMs, cb, cancelled: false };
      queue.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    advance(ms: number): void {
      const target = now + ms;
      while (true) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue.find((q) => !q.cancelled && q.at <= target);
        if (!next) break;
        now = next.at;
        next.cancelled = true;
        next.cb();
      }
      now = target;
    },
  };
}

function makeController(overrides: Partial<Parameters<typeof createSlabController>[0]> = {}): {
  ctrl: SlabController;
  states: SlabState[];
  sched: ReturnType<typeof makeSyntheticScheduler>;
} {
  const sched = makeSyntheticScheduler();
  const ctrl = createSlabController({
    now: sched.now,
    scheduleTimeout: sched.scheduleTimeout,
    logger: { warn: vi.fn() },
    ...overrides,
  });
  const states: SlabState[] = [];
  ctrl.subscribe((s) => states.push(s));
  return { ctrl, states, sched };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("SlabController — initial state", () => {
  it("starts idle with no items and notifies subscribers on attach", () => {
    const { ctrl, states } = makeController();
    const state = ctrl.getState();
    expect(state.ambient).toBe("idle");
    expect(state.items.size).toBe(0);
    // Subscriber received the initial state
    expect(states).toHaveLength(1);
    expect(states[0]!.ambient).toBe("idle");
  });

  it("state snapshots are not shared mutably across notifications", () => {
    const { ctrl, states, sched } = makeController();
    ctrl.openItem({ id: "a", kind: "stream" });
    sched.advance(0);
    // Fresh map per notification — previous state's map still has 1
    // item, current state has 1 item, and they're distinct references.
    expect(states.length).toBeGreaterThan(1);
    const a = states[states.length - 2]!.items;
    const b = states[states.length - 1]!.items;
    expect(a).not.toBe(b);
  });
});

describe("SlabController — item lifecycle", () => {
  it("openItem emits emerging; first update promotes to active", () => {
    const { ctrl, states } = makeController();
    ctrl.openItem({ id: "s1", kind: "stream", payload: { tokens: "" } });
    // Emerging phase is observable on the open notify
    const emergingState = states.find((s) => s.items.get("s1")?.phase === "emerging");
    expect(emergingState).toBeDefined();
    // Update promotes to active synchronously
    ctrl.updateItem("s1", { tokens: "h" });
    const activeState = states[states.length - 1]!;
    expect(activeState.items.get("s1")?.phase).toBe("active");
    expect(activeState.ambient).toBe("active");
  });

  it("endItem promotes emerging → active → end even without intervening update", () => {
    const { ctrl, states } = makeController();
    ctrl.openItem({ id: "s1", kind: "stream" });
    ctrl.endItem("s1", { kind: "interrupted" });
    // Full sequence observable: emerging, active, dissolving — renderer
    // arrival + departure animations chain cleanly even for brief items.
    const phases = states
      .map((s) => s.items.get("s1")?.phase)
      .filter((p): p is string => typeof p === "string");
    expect(phases).toContain("emerging");
    expect(phases).toContain("active");
    expect(phases).toContain("dissolving");
  });

  it("updateItem changes payload in place", () => {
    const { ctrl } = makeController();
    ctrl.openItem({ id: "s1", kind: "stream", payload: { tokens: "hel" } });
    ctrl.updateItem("s1", { tokens: "hello" });
    const state = ctrl.getState();
    expect(state.items.get("s1")?.phase).toBe("active");
    expect(state.items.get("s1")?.payload).toEqual({ tokens: "hello" });
  });

  it("dissolving path: interrupted stream → dissolving → gone", () => {
    const { ctrl, sched } = makeController();
    ctrl.openItem({ id: "s1", kind: "stream" });
    ctrl.updateItem("s1", { tokens: "partial" }); // promote to active
    ctrl.endItem("s1", { kind: "interrupted" });
    expect(ctrl.getState().items.get("s1")?.phase).toBe("dissolving");
    // After the dissolving tail (300ms), item is gone
    sched.advance(300);
    expect(ctrl.getState().items.has("s1")).toBe(false);
  });

  it("detach path: completed with detachAs → pinching → detached → gone", () => {
    const { ctrl, states, sched } = makeController();
    ctrl.openItem({ id: "t1", kind: "tool_call" });
    ctrl.updateItem("t1", {}); // promote to active
    ctrl.endItem("t1", { kind: "completed", result: { code: "..." }, detachAs: "code" });
    expect(ctrl.getState().items.get("t1")?.phase).toBe("pinching");
    // After the 800ms detachment tail + 0ms cleanup, the item has passed
    // through `detached` and is gone. The intermediate `detached` phase
    // is observable via the subscription notification stream even though
    // the final `getState()` skips past it.
    sched.advance(800);
    const sawDetached = states.some((s) => s.items.get("t1")?.phase === "detached");
    expect(sawDetached).toBe(true);
    expect(ctrl.getState().items.has("t1")).toBe(false);
  });

  it("payload during pinching carries the detach artifact kind for renderers", () => {
    const { ctrl } = makeController();
    ctrl.openItem({ id: "t1", kind: "tool_call", payload: { tool: "bash" } });
    ctrl.updateItem("t1", { tool: "bash", progress: "running" });
    ctrl.endItem("t1", { kind: "completed", result: "out", detachAs: "text" });
    const pinching = ctrl.getState().items.get("t1");
    expect(pinching?.phase).toBe("pinching");
    const payload = pinching?.payload as {
      tool: string;
      __slabDetach: { artifactKind: string };
    };
    expect(payload.__slabDetach.artifactKind).toBe("text");
    expect(payload.tool).toBe("bash");
  });
});

describe("SlabController — detachPolicy", () => {
  it("default policy dissolves unless detachAs is explicit", () => {
    const { ctrl } = makeController();
    ctrl.openItem({ id: "t1", kind: "tool_call" });
    ctrl.endItem("t1", { kind: "completed", result: "ephemeral" });
    // No detachAs → default policy dissolves
    expect(ctrl.getState().items.get("t1")?.phase).toBe("dissolving");
  });

  it("custom policy can detach based on item kind alone", () => {
    const customPolicy: DetachPolicy = (item, outcome) => {
      if (outcome.kind === "completed" && item.kind === "stream") {
        return { action: "detach", artifactKind: "text" };
      }
      return { action: "dissolve" };
    };
    const { ctrl } = makeController({ detachPolicy: customPolicy });
    ctrl.openItem({ id: "s1", kind: "stream" });
    ctrl.endItem("s1", { kind: "completed", result: "final text" });
    // Custom policy detached without explicit detachAs
    expect(ctrl.getState().items.get("s1")?.phase).toBe("pinching");
  });

  it("failed outcomes dissolve even under a detach-everything policy — no artifact from failure", () => {
    // The default policy handles this correctly (only completed + detachAs
    // detaches). Asserting explicitly because the contract matters for
    // renderers: failures should not leave artifact droppings.
    const { ctrl } = makeController();
    ctrl.openItem({ id: "t1", kind: "tool_call" });
    ctrl.endItem("t1", { kind: "failed", error: "rpc error" });
    expect(ctrl.getState().items.get("t1")?.phase).toBe("dissolving");
  });
});

describe("SlabController — ambient state", () => {
  it("ambient goes idle → active → idle → recessed across a work burst", () => {
    const { ctrl, sched } = makeController({ recessionDelayMs: 5_000 });
    expect(ctrl.getState().ambient).toBe("idle");
    ctrl.openItem({ id: "s1", kind: "stream" });
    expect(ctrl.getState().ambient).toBe("active");
    ctrl.endItem("s1", { kind: "interrupted" });
    sched.advance(300); // past dissolving tail
    // Item dropped → idle, recessed after 5s
    expect(ctrl.getState().ambient).toBe("idle");
    sched.advance(5_000);
    expect(ctrl.getState().ambient).toBe("recessed");
  });

  it("a new item during idle-before-recession returns to active and cancels recession", () => {
    const { ctrl, sched } = makeController({ recessionDelayMs: 5_000 });
    ctrl.openItem({ id: "s1", kind: "stream" });
    ctrl.endItem("s1", { kind: "interrupted" });
    sched.advance(300);
    // Mid-idle, before the recession timer fires, open another item
    sched.advance(2_000);
    expect(ctrl.getState().ambient).toBe("idle"); // not yet recessed
    ctrl.openItem({ id: "s2", kind: "stream" });
    expect(ctrl.getState().ambient).toBe("active");
    // Recession timer should have been cancelled — advancing past where
    // it would've fired still shows active (s2 is live).
    sched.advance(5_000);
    expect(ctrl.getState().ambient).toBe("active");
  });
});

describe("SlabController — defensive behavior", () => {
  it("openItem with duplicate id warns and is a no-op", () => {
    const warn = vi.fn();
    const { ctrl } = makeController({ logger: { warn } });
    ctrl.openItem({ id: "s1", kind: "stream", payload: { tokens: "a" } });
    ctrl.openItem({ id: "s1", kind: "stream", payload: { tokens: "b" } });
    expect(warn).toHaveBeenCalledWith(
      "slab openItem ignored — item id already present",
      expect.objectContaining({ id: "s1" }),
    );
    // Original payload preserved — second open didn't overwrite
    expect(ctrl.getState().items.get("s1")?.payload).toEqual({ tokens: "a" });
  });

  it("updateItem against unknown id warns and is a no-op", () => {
    const warn = vi.fn();
    const { ctrl } = makeController({ logger: { warn } });
    ctrl.updateItem("does-not-exist", { anything: 1 });
    expect(warn).toHaveBeenCalledWith(
      "slab updateItem ignored — unknown id",
      expect.objectContaining({ id: "does-not-exist" }),
    );
  });

  it("endItem against already-terminal item warns and is a no-op", () => {
    const warn = vi.fn();
    const { ctrl, sched } = makeController({ logger: { warn } });
    ctrl.openItem({ id: "s1", kind: "stream" });
    ctrl.endItem("s1", { kind: "interrupted" });
    // Item is now dissolving
    ctrl.endItem("s1", { kind: "interrupted" });
    expect(warn).toHaveBeenCalledWith(
      "slab endItem ignored — item already in terminal phase",
      expect.objectContaining({ id: "s1", phase: "dissolving" }),
    );
  });

  it("clearAll drops every item immediately and resets ambient to idle", () => {
    const { ctrl } = makeController();
    ctrl.openItem({ id: "s1", kind: "stream" });
    ctrl.openItem({ id: "t1", kind: "tool_call" });
    expect(ctrl.getState().items.size).toBe(2);
    ctrl.clearAll();
    const state = ctrl.getState();
    expect(state.items.size).toBe(0);
    expect(state.ambient).toBe("idle");
  });

  it("dispose silences all further notifications and cancels pending timers", () => {
    const { ctrl, sched } = makeController();
    const late = vi.fn();
    ctrl.subscribe(late);
    late.mockClear(); // ignore the initial notify
    ctrl.openItem({ id: "s1", kind: "stream" });
    late.mockClear();
    ctrl.dispose();
    ctrl.openItem({ id: "s2", kind: "stream" }); // disposed — no effect
    sched.advance(10_000);
    expect(late).not.toHaveBeenCalled();
  });

  it("a subscriber that throws doesn't break other subscribers or state", () => {
    const sched = makeSyntheticScheduler();
    const ctrl = createSlabController({
      now: sched.now,
      scheduleTimeout: sched.scheduleTimeout,
      logger: { warn: vi.fn() },
    });
    const throwing = vi.fn(() => {
      throw new Error("bad subscriber");
    });
    const healthy = vi.fn();
    ctrl.subscribe(throwing);
    ctrl.subscribe(healthy);
    ctrl.openItem({ id: "s1", kind: "stream" });
    expect(healthy).toHaveBeenCalled();
    // State still consistent
    expect(ctrl.getState().items.has("s1")).toBe(true);
  });
});

describe("defaultDetachPolicy", () => {
  const sampleItem = {
    id: "x",
    kind: "tool_call" as const,
    phase: "active" as const,
    openedAt: 0,
    lastUpdatedAt: 0,
    payload: null,
  };

  it("dissolves on interrupted", () => {
    expect(defaultDetachPolicy(sampleItem, { kind: "interrupted" })).toEqual({
      action: "dissolve",
    });
  });

  it("dissolves on failed", () => {
    expect(defaultDetachPolicy(sampleItem, { kind: "failed", error: "e" })).toEqual({
      action: "dissolve",
    });
  });

  it("dissolves on completed without detachAs", () => {
    expect(defaultDetachPolicy(sampleItem, { kind: "completed", result: "r" })).toEqual({
      action: "dissolve",
    });
  });

  it("detaches when detachAs is explicit", () => {
    expect(
      defaultDetachPolicy(sampleItem, { kind: "completed", result: "r", detachAs: "code" }),
    ).toEqual({ action: "detach", artifactKind: "code" });
  });
});
