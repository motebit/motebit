/**
 * Tests for the surface-neutral slab bridge. Uses a fake renderer
 * target that records method calls — no DOM, no Three.js — so the
 * diffing + transition logic is tested in isolation.
 */

import { describe, it, expect, vi } from "vitest";
import {
  bindSlabControllerToRenderer,
  createSlabController,
  type ArtifactKindForDetach,
  type SlabItem,
  type SlabRendererTarget,
  type TimeoutHandle,
} from "../index.js";

// ── Test utilities ────────────────────────────────────────────────────

/** Synthetic scheduler mirroring the one in slab-controller.test.ts. */
function makeSyntheticScheduler() {
  let now = 1_000_000_000;
  const queue: Array<{ at: number; cb: () => void; cancelled: boolean }> = [];
  return {
    now: () => now,
    scheduleTimeout: (cb: () => void, delayMs: number): TimeoutHandle => {
      const entry = { at: now + delayMs, cb, cancelled: false };
      queue.push(entry);
      return { cancel: () => (entry.cancelled = true) };
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

/** Minimal HTMLElement-shaped mock — the bridge only stores + passes. */
function fakeElement(label: string): HTMLElement {
  return { __label: label } as unknown as HTMLElement;
}

function makeRendererTarget(): {
  renderer: SlabRendererTarget;
  addCalls: Array<{ id: string; kind: string; element: unknown }>;
  dissolveCalls: string[];
  detachCalls: Array<{ id: string; artifact: { id: string; kind: string; element: unknown } }>;
} {
  const addCalls: Array<{ id: string; kind: string; element: unknown }> = [];
  const dissolveCalls: string[] = [];
  const detachCalls: Array<{
    id: string;
    artifact: { id: string; kind: string; element: unknown };
  }> = [];
  const renderer: SlabRendererTarget = {
    addSlabItem: (spec) => {
      addCalls.push(spec);
      return undefined;
    },
    dissolveSlabItem: async (id) => {
      dissolveCalls.push(id);
    },
    detachSlabItemAsArtifact: async (id, artifact) => {
      detachCalls.push({ id, artifact });
      return undefined;
    },
    clearSlabItems: () => {},
  };
  return { renderer, addCalls, dissolveCalls, detachCalls };
}

function setupBridge(overrides?: {
  renderItem?: (item: SlabItem) => HTMLElement;
  updateItem?: (item: SlabItem, element: HTMLElement) => void;
  renderDetachArtifact?: (
    item: SlabItem,
    kind: ArtifactKindForDetach,
  ) => { id: string; kind: ArtifactKindForDetach; element: HTMLElement };
}) {
  const sched = makeSyntheticScheduler();
  // Use a monotonic synthetic `now` that increments on every read so
  // each controller mutation gets a distinct `lastUpdatedAt`. The test
  // doesn't care about absolute time values, just ordering.
  let nowTick = 0;
  const controller = createSlabController({
    now: () => ++nowTick,
    scheduleTimeout: sched.scheduleTimeout,
    logger: { warn: vi.fn() },
  });
  const targets = makeRendererTarget();
  const renderItem = overrides?.renderItem ?? ((item: SlabItem) => fakeElement(`el-${item.id}`));
  const unsubscribe = bindSlabControllerToRenderer({
    controller,
    renderer: targets.renderer,
    renderItem,
    updateItem: overrides?.updateItem,
    renderDetachArtifact: overrides?.renderDetachArtifact,
    logger: { warn: vi.fn() },
  });
  return { controller, ...targets, unsubscribe, sched };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("bindSlabControllerToRenderer — mount + unmount", () => {
  it("calls addSlabItem once when a new item opens", () => {
    const { controller, addCalls } = setupBridge();
    controller.openItem({ id: "s1", kind: "stream" });
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]!.id).toBe("s1");
    expect(addCalls[0]!.kind).toBe("stream");
  });

  it("does not double-mount on the next state transition", () => {
    const { controller, addCalls } = setupBridge();
    controller.openItem({ id: "s1", kind: "stream" });
    controller.updateItem("s1", { payload: "updated" });
    expect(addCalls).toHaveLength(1);
  });

  it("mounts a fresh item with the same id after a prior item has left state", () => {
    const { controller, addCalls, sched } = setupBridge();
    controller.openItem({ id: "s1", kind: "stream" });
    controller.endItem("s1", { kind: "interrupted" });
    sched.advance(300); // past the dissolve tail — item drops from state
    controller.openItem({ id: "s1", kind: "stream" });
    expect(addCalls).toHaveLength(2);
  });

  it("isolates renderItem exceptions — state consistency preserved", () => {
    const addCalls: Array<{ id: string; kind: string; element: unknown }> = [];
    const renderer: SlabRendererTarget = {
      addSlabItem: (spec) => {
        addCalls.push(spec);
        return undefined;
      },
    };
    const sched = makeSyntheticScheduler();
    const controller = createSlabController({
      now: sched.now,
      scheduleTimeout: sched.scheduleTimeout,
      logger: { warn: vi.fn() },
    });
    let callCount = 0;
    bindSlabControllerToRenderer({
      controller,
      renderer,
      renderItem: (item) => {
        callCount++;
        if (item.id === "bad") throw new Error("bad render");
        return fakeElement(item.id);
      },
      logger: { warn: vi.fn() },
    });
    controller.openItem({ id: "bad", kind: "stream" });
    controller.openItem({ id: "good", kind: "stream" });
    // Both items reached renderItem; only the good one mounted
    expect(callCount).toBe(2);
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]!.id).toBe("good");
  });
});

describe("bindSlabControllerToRenderer — updates", () => {
  it("calls updateItem whenever the payload changes while the item's phase is non-terminal", () => {
    const updateItem = vi.fn();
    const { controller } = setupBridge({ updateItem });
    controller.openItem({ id: "s1", kind: "stream", payload: { tokens: "" } });
    // The bridge fires updateItem whenever the payload changed
    // (lastUpdatedAt advanced) and the current phase is non-terminal
    // (active or resting). This includes the emerging → active
    // promotion on the first update — renderItem saw the emerging
    // payload, updateItem then replays the active-state payload.
    // It also covers active → resting, which is the key fix for the
    // "web_search card stuck on 'calling…'" regression: restItem
    // both changes phase AND updates payload, and the rendered card
    // needs to redraw with the result.
    controller.updateItem("s1", { tokens: "hello" });
    controller.updateItem("s1", { tokens: "hello world" });
    controller.updateItem("s1", { tokens: "hello world!" });
    expect(updateItem).toHaveBeenCalledTimes(3);
    expect(updateItem.mock.calls[2]![0].payload).toEqual({ tokens: "hello world!" });
  });

  it("fires updateItem on the active → resting transition with a payload update", () => {
    const updateItem = vi.fn();
    const { controller } = setupBridge({ updateItem });
    controller.openItem({
      id: "t1",
      kind: "tool_call",
      payload: { name: "web_search", status: "calling", context: "Tesla balance sheet" },
    });
    // Active — the in-flight card.
    controller.updateItem("t1", {
      name: "web_search",
      status: "calling",
      context: "Tesla balance sheet",
    });
    updateItem.mockClear();
    // Controller restItem with the completed result — phase goes
    // active → resting and payload updates in the same state emit.
    controller.restItem("t1", {
      name: "web_search",
      status: "done",
      context: "Tesla balance sheet",
      result: "3 results found",
    });
    expect(updateItem).toHaveBeenCalledTimes(1);
    const lastCall = updateItem.mock.calls[0]!;
    expect((lastCall[0] as { payload: { status: string } }).payload.status).toBe("done");
  });

  it("no-op update when updateItem is not provided", () => {
    const { controller, addCalls } = setupBridge();
    // No updateItem in overrides
    controller.openItem({ id: "s1", kind: "stream" });
    controller.updateItem("s1", { any: "thing" });
    expect(addCalls).toHaveLength(1);
  });
});

describe("bindSlabControllerToRenderer — dissolve", () => {
  it("calls dissolveSlabItem once on dissolving transition", () => {
    const { controller, dissolveCalls } = setupBridge();
    controller.openItem({ id: "s1", kind: "stream" });
    controller.endItem("s1", { kind: "interrupted" });
    expect(dissolveCalls).toEqual(["s1"]);
  });

  it("does not re-call dissolveSlabItem on subsequent updates", () => {
    const { controller, dissolveCalls, sched } = setupBridge();
    controller.openItem({ id: "s1", kind: "stream" });
    controller.endItem("s1", { kind: "interrupted" });
    sched.advance(150); // mid-dissolve
    expect(dissolveCalls).toEqual(["s1"]);
  });
});

describe("bindSlabControllerToRenderer — detach", () => {
  it("routes pinching items through detachSlabItemAsArtifact when policy fires", () => {
    const renderDetachArtifact = vi.fn((item: SlabItem, kind: ArtifactKindForDetach) => ({
      id: `artifact-${item.id}`,
      kind,
      element: fakeElement(`artifact-${item.id}`),
    }));
    const { controller, detachCalls, dissolveCalls } = setupBridge({ renderDetachArtifact });
    controller.openItem({ id: "t1", kind: "tool_call" });
    controller.endItem("t1", { kind: "completed", result: "x", detachAs: "code" });
    expect(detachCalls).toHaveLength(1);
    expect(detachCalls[0]!.id).toBe("t1");
    expect(detachCalls[0]!.artifact.kind).toBe("code");
    expect(detachCalls[0]!.artifact.id).toBe("artifact-t1");
    expect(dissolveCalls).toHaveLength(0);
  });

  it("falls back to dissolve when renderDetachArtifact is not provided", () => {
    const { controller, detachCalls, dissolveCalls } = setupBridge();
    controller.openItem({ id: "t1", kind: "tool_call" });
    controller.endItem("t1", { kind: "completed", result: "x", detachAs: "code" });
    expect(detachCalls).toHaveLength(0);
    expect(dissolveCalls).toEqual(["t1"]);
  });

  it("falls back to dissolve when renderDetachArtifact throws", () => {
    const renderDetachArtifact = vi.fn(() => {
      throw new Error("render failed");
    });
    const { controller, detachCalls, dissolveCalls } = setupBridge({ renderDetachArtifact });
    controller.openItem({ id: "t1", kind: "tool_call" });
    controller.endItem("t1", { kind: "completed", result: "x", detachAs: "code" });
    expect(detachCalls).toHaveLength(0);
    expect(dissolveCalls).toEqual(["t1"]);
  });
});

describe("bindSlabControllerToRenderer — unsubscribe", () => {
  it("stops forwarding events after unsubscribe is called", () => {
    const { controller, addCalls, unsubscribe } = setupBridge();
    controller.openItem({ id: "s1", kind: "stream" });
    expect(addCalls).toHaveLength(1);
    unsubscribe();
    controller.openItem({ id: "s2", kind: "stream" });
    // No second add — bridge stopped observing.
    expect(addCalls).toHaveLength(1);
  });

  it("unsubscribe is idempotent", () => {
    const { unsubscribe } = setupBridge();
    unsubscribe();
    unsubscribe();
    unsubscribe();
    // No throw — test passes.
  });
});
