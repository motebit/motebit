/**
 * Slab plane two-finger-hold gesture — pure detector tests.
 *
 * The detector has no DOM dependency; tests drive it directly through
 * the pointer-event handler API + tick. The DOM-attach helper is
 * smoke-tested at the end via a synthetic EventTarget.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createPlaneGestureDetector,
  attachPlaneGestureToTarget,
  type PlaneGestureDetector,
} from "../slab-plane-gesture.js";

function makeDetector(opts?: { holdMs?: number; moveTolerancePx?: number }) {
  const onHaltTriggered = vi.fn();
  const onProgress = vi.fn();
  const onCancel = vi.fn();
  const detector = createPlaneGestureDetector({ onHaltTriggered, onProgress, onCancel }, opts);
  return { detector, onHaltTriggered, onProgress, onCancel };
}

describe("PlaneGestureDetector — arming", () => {
  it("starts unarmed with zero pointers", () => {
    const { detector } = makeDetector();
    expect(detector.pointerCount()).toBe(0);
    expect(detector.isArmed()).toBe(false);
    expect(detector.hasFired()).toBe(false);
  });

  it("one pointer alone does not arm", () => {
    const { detector, onProgress } = makeDetector();
    detector.onPointerDown(1, 100, 100, 0);
    expect(detector.pointerCount()).toBe(1);
    expect(detector.isArmed()).toBe(false);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("two pointers arm and emit progress 0", () => {
    const { detector, onProgress } = makeDetector();
    detector.onPointerDown(1, 100, 100, 1000);
    detector.onPointerDown(2, 200, 200, 1000);
    expect(detector.isArmed()).toBe(true);
    expect(onProgress).toHaveBeenLastCalledWith(0);
  });

  it("third pointer is tracked but does not re-arm", () => {
    const { detector, onProgress } = makeDetector();
    detector.onPointerDown(1, 100, 100, 1000);
    detector.onPointerDown(2, 200, 200, 1000);
    onProgress.mockClear();
    detector.onPointerDown(3, 300, 300, 1500);
    expect(detector.pointerCount()).toBe(3);
    expect(detector.isArmed()).toBe(true);
    // No additional progress emission — already armed.
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe("PlaneGestureDetector — completion", () => {
  it("tick before hold threshold emits progress, does not fire", () => {
    const { detector, onHaltTriggered, onProgress } = makeDetector({ holdMs: 700 });
    detector.onPointerDown(1, 0, 0, 1000);
    detector.onPointerDown(2, 50, 50, 1000);
    detector.tick(1350); // 50% of hold
    expect(onProgress).toHaveBeenLastCalledWith(0.5);
    expect(onHaltTriggered).not.toHaveBeenCalled();
  });

  it("tick at hold threshold fires halt exactly once", () => {
    const { detector, onHaltTriggered, onProgress } = makeDetector({ holdMs: 700 });
    detector.onPointerDown(1, 0, 0, 1000);
    detector.onPointerDown(2, 50, 50, 1000);
    detector.tick(1700);
    expect(onHaltTriggered).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(1);
    expect(detector.hasFired()).toBe(true);
    // Subsequent ticks must not re-fire.
    detector.tick(2000);
    detector.tick(3000);
    expect(onHaltTriggered).toHaveBeenCalledTimes(1);
  });

  it("tick past threshold clamps progress to 1", () => {
    const { detector, onProgress } = makeDetector({ holdMs: 500 });
    detector.onPointerDown(1, 0, 0, 0);
    detector.onPointerDown(2, 10, 10, 0);
    detector.tick(2000);
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });
});

describe("PlaneGestureDetector — cancellation", () => {
  it("releasing one pointer mid-hold cancels and emits onCancel", () => {
    const { detector, onHaltTriggered, onCancel } = makeDetector({ holdMs: 700 });
    detector.onPointerDown(1, 0, 0, 1000);
    detector.onPointerDown(2, 50, 50, 1000);
    detector.tick(1300);
    detector.onPointerUp(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(detector.isArmed()).toBe(false);
    detector.tick(1700);
    expect(onHaltTriggered).not.toHaveBeenCalled();
  });

  it("moving one pointer past tolerance cancels", () => {
    const { detector, onHaltTriggered, onCancel } = makeDetector({
      holdMs: 700,
      moveTolerancePx: 12,
    });
    detector.onPointerDown(1, 0, 0, 1000);
    detector.onPointerDown(2, 50, 50, 1000);
    detector.onPointerMove(1, 100, 100); // way past 12px
    expect(onCancel).toHaveBeenCalledTimes(1);
    detector.tick(1700);
    expect(onHaltTriggered).not.toHaveBeenCalled();
  });

  it("micro-jitter within tolerance does NOT cancel", () => {
    const { detector, onHaltTriggered, onCancel } = makeDetector({
      holdMs: 700,
      moveTolerancePx: 12,
    });
    detector.onPointerDown(1, 0, 0, 1000);
    detector.onPointerDown(2, 50, 50, 1000);
    // Jitter both fingers by <12px — common touch noise.
    detector.onPointerMove(1, 5, 5);
    detector.onPointerMove(2, 53, 47);
    detector.tick(1700);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onHaltTriggered).toHaveBeenCalledTimes(1);
  });

  it("cancel + re-arm: lifting and re-pressing both fingers can hold again", () => {
    const { detector, onHaltTriggered, onCancel } = makeDetector({ holdMs: 700 });
    detector.onPointerDown(1, 0, 0, 1000);
    detector.onPointerDown(2, 50, 50, 1000);
    detector.tick(1200);
    detector.onPointerUp(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onHaltTriggered).not.toHaveBeenCalled();

    // Re-press.
    detector.onPointerDown(1, 0, 0, 2000);
    expect(detector.isArmed()).toBe(true);
    detector.tick(2700);
    expect(onHaltTriggered).toHaveBeenCalledTimes(1);
  });

  it("pointercancel-style release (onPointerUp) for an unknown id is a no-op", () => {
    const { detector, onCancel } = makeDetector();
    detector.onPointerDown(1, 0, 0, 0);
    detector.onPointerDown(2, 0, 0, 0);
    detector.onPointerUp(99); // unknown
    expect(detector.isArmed()).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("PlaneGestureDetector — fired state lockout", () => {
  it("after firing, new pointers do NOT re-arm until reset()", () => {
    const { detector, onHaltTriggered, onProgress } = makeDetector({ holdMs: 500 });
    detector.onPointerDown(1, 0, 0, 0);
    detector.onPointerDown(2, 50, 50, 0);
    detector.tick(500);
    expect(onHaltTriggered).toHaveBeenCalledTimes(1);

    onProgress.mockClear();
    // User lifts and presses again.
    detector.onPointerUp(1);
    detector.onPointerUp(2);
    detector.onPointerDown(1, 0, 0, 1000);
    detector.onPointerDown(2, 0, 0, 1000);
    detector.tick(2000);
    // Still fired; no second halt fired.
    expect(onHaltTriggered).toHaveBeenCalledTimes(1);
  });

  it("reset() clears state; gesture can fire again", () => {
    const { detector, onHaltTriggered } = makeDetector({ holdMs: 500 });
    detector.onPointerDown(1, 0, 0, 0);
    detector.onPointerDown(2, 50, 50, 0);
    detector.tick(500);
    expect(onHaltTriggered).toHaveBeenCalledTimes(1);

    detector.reset();
    expect(detector.hasFired()).toBe(false);
    expect(detector.pointerCount()).toBe(0);
    expect(detector.isArmed()).toBe(false);

    detector.onPointerDown(1, 0, 0, 1000);
    detector.onPointerDown(2, 50, 50, 1000);
    detector.tick(1500);
    expect(onHaltTriggered).toHaveBeenCalledTimes(2);
  });
});

describe("PlaneGestureDetector — progress emission deduplication", () => {
  it("emits progress only when the value changes", () => {
    const { detector, onProgress } = makeDetector({ holdMs: 700 });
    detector.onPointerDown(1, 0, 0, 0);
    detector.onPointerDown(2, 0, 0, 0);
    // Initial arm fires progress(0).
    expect(onProgress).toHaveBeenCalledTimes(1);
    detector.tick(0); // same time → progress 0, no re-emit
    expect(onProgress).toHaveBeenCalledTimes(1);
    detector.tick(350); // 0.5
    expect(onProgress).toHaveBeenCalledTimes(2);
    detector.tick(350); // same value, no re-emit
    expect(onProgress).toHaveBeenCalledTimes(2);
  });
});

describe("attachPlaneGestureToTarget — DOM wiring", () => {
  function makeMockDetector(): PlaneGestureDetector {
    return {
      pointerCount: () => 0,
      isArmed: () => false,
      hasFired: () => false,
      onPointerDown: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerUp: vi.fn(),
      tick: vi.fn(),
      reset: vi.fn(),
    };
  }

  it("removes all four event listeners on dispose", () => {
    const target = new EventTarget();
    const addSpy = vi.spyOn(target, "addEventListener");
    const removeSpy = vi.spyOn(target, "removeEventListener");
    const detector = makeMockDetector();
    const dispose = attachPlaneGestureToTarget(target, detector);
    expect(addSpy).toHaveBeenCalledTimes(4);
    dispose();
    expect(removeSpy).toHaveBeenCalledTimes(4);
  });

  it("non-PointerEvent events are filtered out (early return)", () => {
    // Node's runtime has no global PointerEvent class — `instanceof`
    // returns false on a plain Event. This covers the
    // `typeof PointerEvent === "undefined"` defensive branch and
    // exercises every handler's early-return path.
    const target = new EventTarget();
    const detector = makeMockDetector();
    attachPlaneGestureToTarget(target, detector);
    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("pointermove"));
    target.dispatchEvent(new Event("pointerup"));
    target.dispatchEvent(new Event("pointercancel"));
    expect(detector.onPointerDown).not.toHaveBeenCalled();
    expect(detector.onPointerMove).not.toHaveBeenCalled();
    expect(detector.onPointerUp).not.toHaveBeenCalled();
  });

  it("touch PointerEvents drive the detector via the wiring (PointerEvent shim)", () => {
    // Inject a minimal PointerEvent into the global scope so the
    // `instanceof` check inside attachPlaneGestureToTarget passes.
    // This tests the production path without requiring a full DOM.
    class FakePointerEvent extends Event {
      pointerId: number;
      pointerType: string;
      clientX: number;
      clientY: number;
      constructor(
        type: string,
        init: {
          pointerId: number;
          pointerType: string;
          clientX: number;
          clientY: number;
        },
      ) {
        super(type);
        this.pointerId = init.pointerId;
        this.pointerType = init.pointerType;
        this.clientX = init.clientX;
        this.clientY = init.clientY;
      }
    }
    const prev = (globalThis as { PointerEvent?: unknown }).PointerEvent;
    (globalThis as { PointerEvent?: unknown }).PointerEvent = FakePointerEvent;
    try {
      const target = new EventTarget();
      const detector = makeMockDetector();
      attachPlaneGestureToTarget(target, detector);

      const ev = new FakePointerEvent("pointerdown", {
        pointerId: 1,
        pointerType: "touch",
        clientX: 50,
        clientY: 60,
      });
      target.dispatchEvent(ev);
      expect(detector.onPointerDown).toHaveBeenCalledWith(1, 50, 60, expect.any(Number));

      const moveEv = new FakePointerEvent("pointermove", {
        pointerId: 1,
        pointerType: "touch",
        clientX: 51,
        clientY: 62,
      });
      target.dispatchEvent(moveEv);
      expect(detector.onPointerMove).toHaveBeenCalledWith(1, 51, 62);

      const upEv = new FakePointerEvent("pointerup", {
        pointerId: 1,
        pointerType: "touch",
        clientX: 51,
        clientY: 62,
      });
      target.dispatchEvent(upEv);
      expect(detector.onPointerUp).toHaveBeenCalledWith(1);

      const cancelEv = new FakePointerEvent("pointercancel", {
        pointerId: 1,
        pointerType: "touch",
        clientX: 0,
        clientY: 0,
      });
      target.dispatchEvent(cancelEv);
      expect(detector.onPointerUp).toHaveBeenCalledTimes(2);
    } finally {
      (globalThis as { PointerEvent?: unknown }).PointerEvent = prev;
    }
  });

  it("non-touch pointer types (mouse, pen) are filtered out", () => {
    class FakePointerEvent extends Event {
      pointerId = 1;
      pointerType: string;
      clientX = 0;
      clientY = 0;
      constructor(type: string, pointerType: string) {
        super(type);
        this.pointerType = pointerType;
      }
    }
    const prev = (globalThis as { PointerEvent?: unknown }).PointerEvent;
    (globalThis as { PointerEvent?: unknown }).PointerEvent = FakePointerEvent;
    try {
      const target = new EventTarget();
      const detector = makeMockDetector();
      attachPlaneGestureToTarget(target, detector);
      target.dispatchEvent(new FakePointerEvent("pointerdown", "mouse"));
      target.dispatchEvent(new FakePointerEvent("pointerdown", "pen"));
      expect(detector.onPointerDown).not.toHaveBeenCalled();
    } finally {
      (globalThis as { PointerEvent?: unknown }).PointerEvent = prev;
    }
  });

  it("getBoundsRect undefined → all touch events accepted", () => {
    class FakePointerEvent extends Event {
      pointerId = 1;
      pointerType = "touch";
      clientX: number;
      clientY: number;
      constructor(type: string, x: number, y: number) {
        super(type);
        this.clientX = x;
        this.clientY = y;
      }
    }
    const prev = (globalThis as { PointerEvent?: unknown }).PointerEvent;
    (globalThis as { PointerEvent?: unknown }).PointerEvent = FakePointerEvent;
    try {
      const target = new EventTarget();
      const detector = makeMockDetector();
      // No third argument — bounds check is bypassed.
      attachPlaneGestureToTarget(target, detector);
      target.dispatchEvent(new FakePointerEvent("pointerdown", -9999, -9999));
      expect(detector.onPointerDown).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as { PointerEvent?: unknown }).PointerEvent = prev;
    }
  });

  it("getBoundsRect present: events outside rect are rejected; inside accepted", () => {
    class FakePointerEvent extends Event {
      pointerId = 1;
      pointerType = "touch";
      clientX: number;
      clientY: number;
      constructor(type: string, x: number, y: number) {
        super(type);
        this.clientX = x;
        this.clientY = y;
      }
    }
    const prev = (globalThis as { PointerEvent?: unknown }).PointerEvent;
    (globalThis as { PointerEvent?: unknown }).PointerEvent = FakePointerEvent;
    try {
      const target = new EventTarget();
      const detector = makeMockDetector();
      attachPlaneGestureToTarget(target, detector, () => ({
        left: 100,
        top: 100,
        right: 300,
        bottom: 200,
      }));
      target.dispatchEvent(new FakePointerEvent("pointerdown", 50, 50)); // outside
      target.dispatchEvent(new FakePointerEvent("pointerdown", 150, 150)); // inside
      target.dispatchEvent(new FakePointerEvent("pointerdown", 400, 150)); // outside (right)
      expect(detector.onPointerDown).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as { PointerEvent?: unknown }).PointerEvent = prev;
    }
  });

  it("getBoundsRect returning null: all events rejected", () => {
    class FakePointerEvent extends Event {
      pointerId = 1;
      pointerType = "touch";
      clientX = 50;
      clientY = 50;
      constructor(type: string) {
        super(type);
      }
    }
    const prev = (globalThis as { PointerEvent?: unknown }).PointerEvent;
    (globalThis as { PointerEvent?: unknown }).PointerEvent = FakePointerEvent;
    try {
      const target = new EventTarget();
      const detector = makeMockDetector();
      attachPlaneGestureToTarget(target, detector, () => null);
      target.dispatchEvent(new FakePointerEvent("pointerdown"));
      expect(detector.onPointerDown).not.toHaveBeenCalled();
    } finally {
      (globalThis as { PointerEvent?: unknown }).PointerEvent = prev;
    }
  });
});
