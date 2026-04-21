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
      .filter((p): p is NonNullable<typeof p> => p != null);
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
    const { ctrl } = makeController({ logger: { warn } });
    ctrl.openItem({ id: "s1", kind: "stream" });
    ctrl.endItem("s1", { kind: "interrupted" });
    // Item is now dissolving
    ctrl.endItem("s1", { kind: "interrupted" });
    expect(warn).toHaveBeenCalledWith(
      "slab endItem ignored — item already in terminal phase",
      expect.objectContaining({ id: "s1", phase: "dissolving" }),
    );
  });

  it("restItem settles an active item into resting with no tail timer", () => {
    const { ctrl, sched } = makeController();
    ctrl.openItem({ id: "f1", kind: "tool_call", payload: { name: "read_url" } });
    ctrl.updateItem("f1", { name: "read_url", result: { data: "page text" } });
    ctrl.restItem("f1");
    expect(ctrl.getState().items.get("f1")?.phase).toBe("resting");
    // Advance far past any dissolve / detach tail — the resting
    // item persists. A workstation holds open tabs indefinitely.
    sched.advance(60_000);
    expect(ctrl.getState().items.get("f1")?.phase).toBe("resting");
  });

  it("restItem on an emerging item promotes to active first, then rests", () => {
    const { ctrl, states } = makeController();
    ctrl.openItem({ id: "f1", kind: "tool_call" });
    expect(ctrl.getState().items.get("f1")?.phase).toBe("emerging");
    ctrl.restItem("f1", { name: "read_url", data: "page" });
    // Full sequence in the subscription stream: emerging → active → resting
    const phases = states
      .map((s) => s.items.get("f1")?.phase)
      .filter((p): p is NonNullable<typeof p> => p != null);
    expect(phases).toContain("emerging");
    expect(phases).toContain("active");
    expect(phases).toContain("resting");
    expect(ctrl.getState().items.get("f1")?.payload).toEqual({
      name: "read_url",
      data: "page",
    });
  });

  it("restItem is idempotent; re-rest updates payload when provided", () => {
    const { ctrl } = makeController();
    ctrl.openItem({ id: "f1", kind: "tool_call", payload: { v: 1 } });
    ctrl.restItem("f1");
    ctrl.restItem("f1"); // no-op, no warn (no unknown id / terminal)
    expect(ctrl.getState().items.get("f1")?.phase).toBe("resting");
    expect(ctrl.getState().items.get("f1")?.payload).toEqual({ v: 1 });
    ctrl.restItem("f1", { v: 2 });
    expect(ctrl.getState().items.get("f1")?.payload).toEqual({ v: 2 });
  });

  it("resting items are updatable without leaving rest", () => {
    const { ctrl } = makeController();
    ctrl.openItem({ id: "f1", kind: "tool_call" });
    ctrl.restItem("f1", { text: "initial" });
    ctrl.updateItem("f1", { text: "extended" });
    expect(ctrl.getState().items.get("f1")?.phase).toBe("resting");
    expect(ctrl.getState().items.get("f1")?.payload).toEqual({ text: "extended" });
  });

  it("dismissItem on a resting item dissolves it through the normal tail", () => {
    const { ctrl, sched } = makeController();
    ctrl.openItem({ id: "f1", kind: "tool_call" });
    ctrl.restItem("f1", { data: "page" });
    ctrl.dismissItem("f1");
    expect(ctrl.getState().items.get("f1")?.phase).toBe("dissolving");
    sched.advance(300);
    expect(ctrl.getState().items.get("f1")).toBeUndefined();
  });

  it("endItem on a resting item can still detach to an artifact", () => {
    const { ctrl, sched } = makeController();
    ctrl.openItem({ id: "d1", kind: "delegation" });
    ctrl.restItem("d1", { server: "peer", tool: "motebit_task" });
    // Motebit later signs the delegation's result and graduates the
    // resting item to a receipt artifact.
    ctrl.endItem("d1", {
      kind: "completed",
      result: { full_receipt: { task_id: "t1", signature: "s" } },
      detachAs: "receipt",
    });
    expect(ctrl.getState().items.get("d1")?.phase).toBe("pinching");
    sched.advance(900);
    expect(ctrl.getState().items.get("d1")).toBeUndefined();
  });

  it("recomputeAmbient treats resting items as active presence", () => {
    const { ctrl, sched } = makeController();
    ctrl.openItem({ id: "f1", kind: "tool_call" });
    ctrl.restItem("f1");
    expect(ctrl.getState().ambient).toBe("active");
    // Advance past the recession delay — resting items keep the slab
    // from going idle. A workstation with open tabs doesn't recede.
    sched.advance(20_000);
    expect(ctrl.getState().ambient).toBe("active");
    // Once the user dismisses the last resting item, recession fires
    // after the idle delay.
    ctrl.dismissItem("f1");
    sched.advance(300);
    expect(ctrl.getState().ambient).toBe("idle");
    sched.advance(10_000);
    expect(ctrl.getState().ambient).toBe("recessed");
  });

  it("delegation kind opens + ends as a receipt artifact when detachAs is set", () => {
    // The Hand organ's load-bearing entry (motebit-computer.md §Hand):
    // delegation arrives with a signed receipt → end with
    // detachAs: "receipt" → item pinches to artifact. Proves the
    // kind-agnostic controller handles the delegation kind + the
    // receipt graduation path end-to-end.
    const { ctrl, sched } = makeController();
    ctrl.openItem({
      id: "d1",
      kind: "delegation",
      payload: { server: "peer", tool: "motebit_task", motebit_id: "mot_abcd" },
    });
    expect(ctrl.getState().items.get("d1")?.kind).toBe("delegation");
    expect(ctrl.getState().items.get("d1")?.phase).toBe("emerging");

    const fullReceipt = {
      task_id: "task_1",
      status: "completed",
      motebit_id: "mot_abcd",
      signature: "sig_deadbeef",
      tools_used: ["web_search", "read_url"],
    };
    ctrl.endItem("d1", {
      kind: "completed",
      result: { full_receipt: fullReceipt },
      detachAs: "receipt",
    });
    expect(ctrl.getState().items.get("d1")?.phase).toBe("pinching");

    // Mid-tail: item has not detached yet.
    sched.advance(600);
    expect(ctrl.getState().items.get("d1")?.phase).toBe("pinching");
    // Pinch tail + zero-delay detached→gone chain fires within the same
    // advance call: the item graduates to artifact and releases from
    // slab state in one motion. The payload carries the signed receipt
    // so the renderer's detach callback has everything it needs.
    sched.advance(200);
    expect(ctrl.getState().items.get("d1")).toBeUndefined();
  });

  it("delegation kind without detachAs dissolves (unsigned summary)", () => {
    const { ctrl, sched } = makeController();
    ctrl.openItem({
      id: "d1",
      kind: "delegation",
      payload: { server: "peer", tool: "motebit_task" },
    });
    ctrl.endItem("d1", {
      kind: "completed",
      result: { receipt: { task_id: "t1", status: "ok", tools_used: [] } },
    });
    expect(ctrl.getState().items.get("d1")?.phase).toBe("dissolving");
    sched.advance(300);
    expect(ctrl.getState().items.get("d1")).toBeUndefined();
  });

  it("dismissItem force-dissolves — bypasses the detach policy", () => {
    // Detach policy that would graduate *every* item. If dismissItem
    // honored it, this would pinch. It must dissolve instead.
    const detachEverything: DetachPolicy = () => ({ action: "detach", artifactKind: "text" });
    const { ctrl, sched } = makeController({ detachPolicy: detachEverything });
    ctrl.openItem({ id: "s1", kind: "tool_call" });
    ctrl.dismissItem("s1");
    expect(ctrl.getState().items.get("s1")?.phase).toBe("dissolving");
    sched.advance(300);
    expect(ctrl.getState().items.get("s1")).toBeUndefined();
  });

  it("dismissItem on an emerging item promotes to active first, then dissolves", () => {
    const { ctrl, sched } = makeController();
    ctrl.openItem({ id: "s1", kind: "stream" });
    expect(ctrl.getState().items.get("s1")?.phase).toBe("emerging");
    ctrl.dismissItem("s1");
    expect(ctrl.getState().items.get("s1")?.phase).toBe("dissolving");
    sched.advance(300);
    expect(ctrl.getState().items.get("s1")).toBeUndefined();
  });

  it("dismissItem against unknown id warns and is a no-op", () => {
    const warn = vi.fn();
    const { ctrl } = makeController({ logger: { warn } });
    ctrl.dismissItem("does-not-exist");
    expect(warn).toHaveBeenCalledWith(
      "slab dismissItem ignored — unknown id",
      expect.objectContaining({ id: "does-not-exist" }),
    );
  });

  it("dismissItem against terminal-phase item warns and is a no-op", () => {
    const warn = vi.fn();
    const { ctrl } = makeController({ logger: { warn } });
    ctrl.openItem({ id: "s1", kind: "stream" });
    ctrl.endItem("s1", { kind: "interrupted" });
    // Now dissolving
    ctrl.dismissItem("s1");
    expect(warn).toHaveBeenCalledWith(
      "slab dismissItem ignored — item already in terminal phase",
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
