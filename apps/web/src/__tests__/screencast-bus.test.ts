/**
 * v1.3 — `ScreencastFrameBus` is a 1-many publish/subscribe relay
 * between the cloud-browser dispatcher and the slab's live_browser
 * item. Tests cover subscribe/publish basics + the latest-frame
 * replay on subscribe + isolation of throwing subscribers.
 */
import { describe, it, expect, vi } from "vitest";
import type { ScreencastFrame } from "@motebit/sdk";

import { ScreencastFrameBus } from "../screencast-bus.js";

function makeFrame(overrides: Partial<ScreencastFrame> = {}): ScreencastFrame {
  return {
    jpeg_base64: "x",
    timestamp: 1,
    device_width: 1,
    device_height: 1,
    ...overrides,
  };
}

describe("ScreencastFrameBus", () => {
  it("publish delivers to every subscriber in order", () => {
    const bus = new ScreencastFrameBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);
    const f = makeFrame({ jpeg_base64: "F1" });
    bus.publish(f);
    expect(a).toHaveBeenCalledWith(f);
    expect(b).toHaveBeenCalledWith(f);
  });

  it("a new subscriber receives the most recent frame immediately", () => {
    const bus = new ScreencastFrameBus();
    const f = makeFrame({ jpeg_base64: "old" });
    bus.publish(f);
    const sub = vi.fn();
    bus.subscribe(sub);
    expect(sub).toHaveBeenCalledWith(f);
  });

  it("unsubscribe stops delivery for that subscriber only", () => {
    const bus = new ScreencastFrameBus();
    const a = vi.fn();
    const b = vi.fn();
    const stopA = bus.subscribe(a);
    bus.subscribe(b);
    stopA();
    const f = makeFrame({ jpeg_base64: "after" });
    bus.publish(f);
    expect(a).not.toHaveBeenCalledWith(f);
    expect(b).toHaveBeenCalledWith(f);
  });

  it("a throwing subscriber does not break the broadcast to others", () => {
    const bus = new ScreencastFrameBus();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    bus.subscribe(bad);
    bus.subscribe(good);
    const f = makeFrame();
    expect(() => bus.publish(f)).not.toThrow();
    expect(good).toHaveBeenCalledWith(f);
  });

  it("a throwing replay-on-subscribe does not break subscribe()", () => {
    const bus = new ScreencastFrameBus();
    bus.publish(makeFrame());
    const bad = vi.fn(() => {
      throw new Error("replay boom");
    });
    expect(() => bus.subscribe(bad)).not.toThrow();
  });

  it("reset() drops existing subscribers — they stop receiving frames", () => {
    const bus = new ScreencastFrameBus();
    const sub = vi.fn();
    bus.subscribe(sub);
    bus.publish(makeFrame({ jpeg_base64: "before" }));
    const callCountBeforeReset = sub.mock.calls.length;
    bus.reset();
    bus.publish(makeFrame({ jpeg_base64: "after-reset" }));
    expect(sub.mock.calls.length).toBe(callCountBeforeReset);
  });

  it("reset() forgets the latest frame — new subscribers don't get a stale replay", () => {
    const bus = new ScreencastFrameBus();
    bus.publish(makeFrame({ jpeg_base64: "before-reset" }));
    bus.reset();
    // A subscriber added after reset, with no fresh publish in
    // between, must NOT see the pre-reset frame.
    const fresh = vi.fn();
    bus.subscribe(fresh);
    expect(fresh).not.toHaveBeenCalled();
  });

  // v1.3 hardening — `hasFrame()` is the predicate the slab uses to
  // decide whether per-action `tool_call` cards should be hidden in
  // favor of the live surface. False until the first frame; true
  // until reset. The duplicate-card suppression contract depends on
  // this gating: per-action cards stay visible while we're still
  // waiting for the first frame, so a screencast that never starts
  // doesn't leave the slab empty.

  it("hasFrame() is false on a fresh bus", () => {
    const bus = new ScreencastFrameBus();
    expect(bus.hasFrame()).toBe(false);
  });

  it("hasFrame() flips to true after the first publish", () => {
    const bus = new ScreencastFrameBus();
    bus.publish(makeFrame());
    expect(bus.hasFrame()).toBe(true);
  });

  it("hasFrame() stays true across multiple publishes", () => {
    const bus = new ScreencastFrameBus();
    bus.publish(makeFrame({ timestamp: 1 }));
    bus.publish(makeFrame({ timestamp: 2 }));
    bus.publish(makeFrame({ timestamp: 3 }));
    expect(bus.hasFrame()).toBe(true);
  });

  it("hasFrame() returns to false after reset()", () => {
    const bus = new ScreencastFrameBus();
    bus.publish(makeFrame());
    bus.reset();
    expect(bus.hasFrame()).toBe(false);
  });
});
