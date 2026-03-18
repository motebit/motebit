/**
 * CursorPresence tests — mouse/touch position to state vector mapping.
 * Tests the computation logic without requiring a real browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CursorPresence } from "../cursor-presence.js";

// Minimal DOM stubs for CursorPresence event handlers
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

function stubDOM(): void {
  const addListener =
    (target: string) => (event: string, handler: (...args: unknown[]) => void) => {
      const key = `${target}:${event}`;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(handler);
    };
  const removeListener = (_event: string, _handler: (...args: unknown[]) => void) => {};

  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: addListener("window"),
      removeEventListener: removeListener,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: {
      addEventListener: addListener("document"),
      removeEventListener: removeListener,
    },
    writable: true,
    configurable: true,
  });
}

function fireEvent(target: string, event: string, data: Record<string, unknown> = {}): void {
  const key = `${target}:${event}`;
  const handlers = listeners.get(key);
  if (handlers) {
    for (const handler of handlers) handler(data);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  stubDOM();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CursorPresence", () => {
  it("initializes with idle state", () => {
    const presence = new CursorPresence();
    const state = presence.getUpdates();
    expect(state.attention).toBeCloseTo(0.1, 1);
    expect(state.curiosity).toBeCloseTo(0.1, 1);
    expect(state.social_distance).toBeCloseTo(0.7, 1);
  });

  it("increases attention when mouse moves to center", () => {
    const presence = new CursorPresence();
    presence.start();

    // Mouse at center of viewport
    fireEvent("window", "mousemove", { clientX: 960, clientY: 540 });

    // Advance tick (33ms interval)
    vi.advanceTimersByTime(33);
    const state = presence.getUpdates();

    // Attention should increase from 0.1 toward 1.0 (center = max attention)
    expect(state.attention!).toBeGreaterThan(0.1);
    presence.stop();
  });

  it("increases curiosity on rapid mouse movement", () => {
    const presence = new CursorPresence();
    presence.start();

    // Two moves in quick succession = velocity
    fireEvent("window", "mousemove", { clientX: 100, clientY: 100 });
    fireEvent("window", "mousemove", { clientX: 900, clientY: 900 });

    vi.advanceTimersByTime(33);
    const state = presence.getUpdates();

    expect(state.curiosity!).toBeGreaterThan(0.1);
    presence.stop();
  });

  it("decays state when mouse leaves viewport", () => {
    const presence = new CursorPresence();
    presence.start();

    // Move to center, tick to raise attention
    fireEvent("window", "mousemove", { clientX: 960, clientY: 540 });
    vi.advanceTimersByTime(33 * 10);
    const before = presence.getUpdates();
    const attentionBefore = before.attention!;

    // Mouse leaves
    fireEvent("document", "mouseleave", {});
    vi.advanceTimersByTime(33 * 30);

    const after = presence.getUpdates();
    expect(after.attention!).toBeLessThan(attentionBefore);
    expect(after.social_distance!).toBeGreaterThan(before.social_distance!);

    presence.stop();
  });

  it("fires entrance spike on first mouseenter", () => {
    const presence = new CursorPresence();
    presence.start();

    // Enter viewport
    fireEvent("document", "mouseenter", {});
    // Move to center so attention has a base
    fireEvent("window", "mousemove", { clientX: 960, clientY: 540 });
    vi.advanceTimersByTime(33);

    const state = presence.getUpdates();
    // Spike adds 0.5 to attention — should be noticeably higher than normal
    expect(state.attention!).toBeGreaterThan(0.2);

    presence.stop();
  });

  it("stop() cleans up intervals", () => {
    const presence = new CursorPresence();
    presence.start();
    presence.stop();
    // No errors on double stop
    presence.stop();
  });
});
