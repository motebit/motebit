/**
 * @vitest-environment jsdom
 *
 * Slice 2c — DOM input capture tests.
 *
 * Two contracts under test:
 *
 *   1. **Coordinate translation.** `translateClick` maps CSS-rect
 *      clicks to Chromium logical viewport pixels, with proper
 *      bounds-check + zero-width-rect defensiveness. Tests cover
 *      center, edge, scaled image, and zero-rect cases.
 *
 *   2. **Capture surface determinism.** Every captured event invokes
 *      `forwardEvent` (the typed capability) — never any AI-loop
 *      backchannel. Pure modifier presses are suppressed. Composition
 *      keys are suppressed. Detach restores the element.
 */

import { describe, it, expect, vi } from "vitest";
import type { UserInputEvent } from "@motebit/sdk";
import type { UserInputForwardResult } from "@motebit/runtime";
import { attachInputCapture, translateClick } from "../ui/cobrowse-input-capture";

function makeImg(width = 640, height = 400): HTMLImageElement {
  const img = document.createElement("img");
  document.body.appendChild(img);
  // jsdom doesn't compute a real layout, but we can stub
  // getBoundingClientRect to return a deterministic rect.
  img.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
  // Stub naturalWidth/naturalHeight — by default jsdom reports 0
  // for un-loaded images. Production frames set these via JPEG
  // decode; tests pin them explicitly.
  Object.defineProperty(img, "naturalWidth", { value: 1280, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: 800, configurable: true });
  return img;
}

function makeForward() {
  const events: UserInputEvent[] = [];
  const forward = vi.fn(async (event: UserInputEvent): Promise<UserInputForwardResult> => {
    events.push(event);
    return {
      outcome: "forwarded",
      audit: {
        session_id: "cs_test",
        motebit_id: "mb_test",
        outcome: "forwarded",
        control_state_at_forwarding: { kind: "user" },
        detail: { kind: "click", x_norm: 0, y_norm: 0, button: "left" },
        timestamp: 0,
      },
    };
  });
  return { forward, events };
}

// ── translateClick ──────────────────────────────────────────────────────

describe("translateClick — coordinate translation", () => {
  it("center click maps to viewport center", () => {
    const img = makeImg(640, 400);
    const result = translateClick(img, { clientX: 320, clientY: 200 }, 1280, 800);
    expect(result).toEqual({ x: 640, y: 400 });
  });

  it("edge click at (0, 0) maps to (0, 0)", () => {
    const img = makeImg(640, 400);
    const result = translateClick(img, { clientX: 0, clientY: 0 }, 1280, 800);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it("edge click at the bottom-right corner maps to viewport bottom-right", () => {
    const img = makeImg(640, 400);
    const result = translateClick(img, { clientX: 640, clientY: 400 }, 1280, 800);
    expect(result).toEqual({ x: 1280, y: 800 });
  });

  it("scaled image (smaller CSS rect than viewport) translates correctly", () => {
    const img = makeImg(320, 200); // half-size CSS rect, but viewport is still 1280x800
    const result = translateClick(img, { clientX: 160, clientY: 100 }, 1280, 800);
    expect(result).toEqual({ x: 640, y: 400 });
  });

  it("scaled image (larger CSS rect than viewport) translates correctly", () => {
    const img = makeImg(2560, 1600); // 2x CSS rect
    const result = translateClick(img, { clientX: 1280, clientY: 800 }, 1280, 800);
    expect(result).toEqual({ x: 640, y: 400 });
  });

  it("falls back to displayWidth/displayHeight when naturalWidth/Height are 0 (no frame yet)", () => {
    const img = makeImg(640, 400);
    Object.defineProperty(img, "naturalWidth", { value: 0, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 0, configurable: true });
    const result = translateClick(img, { clientX: 320, clientY: 200 }, 1024, 768);
    expect(result).toEqual({ x: 512, y: 384 });
  });

  it("returns null on out-of-bounds clicks (defensive)", () => {
    const img = makeImg(640, 400);
    expect(translateClick(img, { clientX: -1, clientY: 0 }, 1280, 800)).toBeNull();
    expect(translateClick(img, { clientX: 0, clientY: -1 }, 1280, 800)).toBeNull();
    expect(translateClick(img, { clientX: 700, clientY: 100 }, 1280, 800)).toBeNull();
    expect(translateClick(img, { clientX: 100, clientY: 500 }, 1280, 800)).toBeNull();
  });

  it("returns null on a zero-width rect (img not laid out)", () => {
    const img = makeImg(640, 400);
    img.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    expect(translateClick(img, { clientX: 0, clientY: 0 }, 1280, 800)).toBeNull();
  });
});

// ── attachInputCapture — click ──────────────────────────────────────────

describe("attachInputCapture — click", () => {
  it("forwards a click event with translated logical coords", () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });

    const evt = new MouseEvent("click", { clientX: 320, clientY: 200, button: 0 });
    img.dispatchEvent(evt);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "click", x: 640, y: 400, button: "left" });
  });

  it("maps mouse button enum to wire format (left/right/middle)", () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });

    img.dispatchEvent(new MouseEvent("click", { clientX: 1, clientY: 1, button: 0 }));
    img.dispatchEvent(new MouseEvent("click", { clientX: 1, clientY: 1, button: 2 }));
    img.dispatchEvent(new MouseEvent("click", { clientX: 1, clientY: 1, button: 1 }));

    expect(events.map((e) => (e.kind === "click" ? e.button : "?"))).toEqual([
      "left",
      "right",
      "middle",
    ]);
  });

  it("focuses the img on click (so subsequent keystrokes target the slab)", () => {
    const img = makeImg(640, 400);
    const { forward } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });

    img.dispatchEvent(new MouseEvent("click", { clientX: 1, clientY: 1, button: 0 }));
    expect(document.activeElement).toBe(img);
  });
});

// ── attachInputCapture — keyboard ───────────────────────────────────────

describe("attachInputCapture — keyboard", () => {
  it("forwards a printable key with no modifiers", () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    img.focus();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(events).toEqual([
      {
        kind: "key",
        key: "a",
        modifiers: { ctrl: false, meta: false, alt: false, shift: false },
      },
    ]);
  });

  it("forwards Cmd+C with the right modifier flags", () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    img.focus();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: true }));
    expect(events).toEqual([
      {
        kind: "key",
        key: "c",
        modifiers: { ctrl: false, meta: true, alt: false, shift: false },
      },
    ]);
  });

  it("forwards named keys (Enter, Tab, ArrowUp)", () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    img.focus();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));

    expect(events.map((e) => (e.kind === "key" ? e.key : "?"))).toEqual([
      "Enter",
      "Tab",
      "ArrowUp",
    ]);
  });

  it("does NOT forward when the img is not focused (keystrokes scoped to slab)", () => {
    const img = makeImg(640, 400);
    const other = document.createElement("input");
    document.body.appendChild(other);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    other.focus();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(events).toHaveLength(0);
  });

  it("suppresses pure modifier keys (Shift / Control / Alt / Meta)", () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    img.focus();

    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key }));
    }
    expect(events).toHaveLength(0);
  });

  it("suppresses IME composition synthetic keys (Process / Dead / isComposing)", () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    img.focus();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Process" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead" }));
    expect(events).toHaveLength(0);
  });
});

// ── attachInputCapture — click ripple (Slice 2e) ────────────────────────

describe("attachInputCapture — click-ripple feedback", () => {
  it("spawns a ripple element on click as a sibling of the img", () => {
    // Wrap img in a parent so the ripple has a mount point.
    const parent = document.createElement("div");
    parent.style.position = "relative";
    document.body.appendChild(parent);
    const img = makeImg(640, 400);
    parent.appendChild(img);

    const { forward } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });

    img.dispatchEvent(new MouseEvent("click", { clientX: 320, clientY: 200, button: 0 }));

    const ripple = parent.querySelector(".cobrowse-click-ripple");
    expect(ripple).not.toBeNull();
  });

  it("ripple positions at the click coordinate (offset within parent)", () => {
    const parent = document.createElement("div");
    parent.style.position = "relative";
    document.body.appendChild(parent);
    const img = makeImg(640, 400);
    parent.appendChild(img);
    // Force img's offset within parent so the test exercises
    // offset-aware positioning.
    Object.defineProperty(img, "offsetLeft", { value: 10, configurable: true });
    Object.defineProperty(img, "offsetTop", { value: 20, configurable: true });

    const { forward } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });

    img.dispatchEvent(new MouseEvent("click", { clientX: 320, clientY: 200, button: 0 }));

    const ripple = parent.querySelector(".cobrowse-click-ripple") as HTMLElement;
    // Click at clientX/Y (320, 200) → img-local (320, 200) (rect at
    // 0,0) → parent-local (10+320, 20+200) = (330, 220).
    expect(ripple.style.left).toBe("330px");
    expect(ripple.style.top).toBe("220px");
  });

  it("ripple auto-removes after the animation duration", async () => {
    const parent = document.createElement("div");
    parent.style.position = "relative";
    document.body.appendChild(parent);
    const img = makeImg(640, 400);
    parent.appendChild(img);

    const { forward } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });

    img.dispatchEvent(new MouseEvent("click", { clientX: 1, clientY: 1, button: 0 }));
    expect(parent.querySelectorAll(".cobrowse-click-ripple").length).toBe(1);

    // Wait beyond the 400ms animation duration.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(parent.querySelectorAll(".cobrowse-click-ripple").length).toBe(0);
  });

  it("multiple clicks spawn multiple ripples (one per click, not coalesced)", () => {
    const parent = document.createElement("div");
    parent.style.position = "relative";
    document.body.appendChild(parent);
    const img = makeImg(640, 400);
    parent.appendChild(img);

    const { forward } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });

    img.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100, button: 0 }));
    img.dispatchEvent(new MouseEvent("click", { clientX: 200, clientY: 200, button: 0 }));
    img.dispatchEvent(new MouseEvent("click", { clientX: 300, clientY: 300, button: 0 }));

    expect(parent.querySelectorAll(".cobrowse-click-ripple").length).toBe(3);
  });

  it("does NOT spawn a ripple on out-of-bounds clicks (no event forwarded either)", () => {
    const parent = document.createElement("div");
    parent.style.position = "relative";
    document.body.appendChild(parent);
    const img = makeImg(640, 400);
    parent.appendChild(img);

    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });

    // Out-of-bounds click — translateClick returns null.
    img.dispatchEvent(new MouseEvent("click", { clientX: -10, clientY: -10, button: 0 }));

    expect(parent.querySelectorAll(".cobrowse-click-ripple").length).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("silently no-ops when the img has no parent (defensive — feedback is best-effort)", () => {
    const img = makeImg(640, 400);
    // Detach from any parent.
    img.remove();

    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });

    expect(() => {
      img.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100, button: 0 }));
    }).not.toThrow();
    // Forward still happens — feedback is best-effort, click
    // forwarding is load-bearing.
    expect(events).toHaveLength(1);
  });
});

// ── attachInputCapture — wheel (Slice 2c-batching) ──────────────────────

describe("attachInputCapture — wheel coalescing", () => {
  it("forwards a single wheel event after the coalesce window flushes", async () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    img.focus();

    const evt = new WheelEvent("wheel", {
      clientX: 320,
      clientY: 200,
      deltaX: 0,
      deltaY: 100,
    });
    img.dispatchEvent(evt);

    // Before flush — the wire is empty (events accumulating in the window).
    expect(events).toHaveLength(0);

    // Flush window — 16ms is the configured coalesce window.
    await new Promise((resolve) => setTimeout(resolve, 32));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "wheel",
      x: 640,
      y: 400,
      dx: 0,
      dy: 100,
      event_count: 1,
    });
  });

  it("coalesces multiple wheels within the window into one event", async () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    img.focus();

    img.dispatchEvent(new WheelEvent("wheel", { clientX: 320, clientY: 200, deltaY: 30 }));
    img.dispatchEvent(new WheelEvent("wheel", { clientX: 320, clientY: 200, deltaY: 40 }));
    img.dispatchEvent(new WheelEvent("wheel", { clientX: 320, clientY: 200, deltaY: 50 }));

    await new Promise((resolve) => setTimeout(resolve, 32));

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.kind).toBe("wheel");
    if (e?.kind === "wheel") {
      expect(e.dy).toBe(120); // 30 + 40 + 50
      expect(e.event_count).toBe(3);
    }
  });

  it("emits separate events across windows (sustained scroll splits correctly)", async () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    img.focus();

    img.dispatchEvent(new WheelEvent("wheel", { clientX: 320, clientY: 200, deltaY: 50 }));
    await new Promise((resolve) => setTimeout(resolve, 32));
    img.dispatchEvent(new WheelEvent("wheel", { clientX: 320, clientY: 200, deltaY: 80 }));
    await new Promise((resolve) => setTimeout(resolve, 32));

    expect(events).toHaveLength(2);
    if (events[0]?.kind === "wheel") expect(events[0].dy).toBe(50);
    if (events[1]?.kind === "wheel") expect(events[1].dy).toBe(80);
  });

  it("uses the LATEST cursor position when coalescing (mid-swipe drift honored)", async () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    img.focus();

    img.dispatchEvent(new WheelEvent("wheel", { clientX: 100, clientY: 100, deltaY: 30 }));
    img.dispatchEvent(new WheelEvent("wheel", { clientX: 320, clientY: 200, deltaY: 40 }));

    await new Promise((resolve) => setTimeout(resolve, 32));

    expect(events).toHaveLength(1);
    if (events[0]?.kind === "wheel") {
      // Latest cursor position (320, 200) → logical (640, 400).
      expect(events[0].x).toBe(640);
      expect(events[0].y).toBe(400);
    }
  });

  it("does NOT capture wheel when the img is not focused", async () => {
    const img = makeImg(640, 400);
    const other = document.createElement("input");
    document.body.appendChild(other);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    other.focus();

    img.dispatchEvent(new WheelEvent("wheel", { clientX: 320, clientY: 200, deltaY: 100 }));
    await new Promise((resolve) => setTimeout(resolve, 32));

    expect(events).toHaveLength(0);
  });

  it("flushes pending wheel window on detach (fast drag-disable doesn't strand events)", async () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    const detach = attachInputCapture({
      img,
      forwardEvent: forward,
      fallbackWidth: 1280,
      fallbackHeight: 800,
    });
    img.focus();

    img.dispatchEvent(new WheelEvent("wheel", { clientX: 320, clientY: 200, deltaY: 100 }));
    // Detach BEFORE the window flushes — flush must happen on detach.
    detach();

    expect(events).toHaveLength(1);
    if (events[0]?.kind === "wheel") expect(events[0].dy).toBe(100);
  });

  it("preserves negative deltas (upward / leftward scroll)", async () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    img.focus();

    img.dispatchEvent(
      new WheelEvent("wheel", { clientX: 320, clientY: 200, deltaX: -50, deltaY: -100 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 32));

    expect(events).toHaveLength(1);
    if (events[0]?.kind === "wheel") {
      expect(events[0].dx).toBe(-50);
      expect(events[0].dy).toBe(-100);
    }
  });
});

// ── attachInputCapture — paste ──────────────────────────────────────────

describe("attachInputCapture — paste", () => {
  it("forwards a paste event with the clipboard text", () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    img.focus();

    const evt = new Event("paste") as ClipboardEvent;
    Object.defineProperty(evt, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? "https://example.com" : "") },
    });
    document.dispatchEvent(evt);

    expect(events).toEqual([{ kind: "paste", text: "https://example.com" }]);
  });

  it("does NOT forward an empty paste", () => {
    const img = makeImg(640, 400);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    img.focus();

    const evt = new Event("paste") as ClipboardEvent;
    Object.defineProperty(evt, "clipboardData", {
      value: { getData: () => "" },
    });
    document.dispatchEvent(evt);

    expect(events).toHaveLength(0);
  });

  it("does NOT forward when the img is not focused", () => {
    const img = makeImg(640, 400);
    const other = document.createElement("input");
    document.body.appendChild(other);
    const { forward, events } = makeForward();
    attachInputCapture({ img, forwardEvent: forward, fallbackWidth: 1280, fallbackHeight: 800 });
    other.focus();

    const evt = new Event("paste") as ClipboardEvent;
    Object.defineProperty(evt, "clipboardData", {
      value: { getData: () => "leak" },
    });
    document.dispatchEvent(evt);

    expect(events).toHaveLength(0);
  });
});

// ── attachInputCapture — detach lifecycle ───────────────────────────────

describe("attachInputCapture — detach", () => {
  it("removes all listeners and restores tabindex/outline", () => {
    const img = makeImg(640, 400);
    img.tabIndex = -1;
    img.style.outline = "1px solid red";
    const { forward, events } = makeForward();

    const detach = attachInputCapture({
      img,
      forwardEvent: forward,
      fallbackWidth: 1280,
      fallbackHeight: 800,
    });
    // Verify capture is active.
    img.dispatchEvent(new MouseEvent("click", { clientX: 1, clientY: 1, button: 0 }));
    expect(events).toHaveLength(1);

    detach();
    // Restored.
    expect(img.tabIndex).toBe(-1);
    expect(img.style.outline).toBe("1px solid red");

    // No further forwards.
    img.dispatchEvent(new MouseEvent("click", { clientX: 2, clientY: 2, button: 0 }));
    img.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(events).toHaveLength(1);
  });

  it("is idempotent on detach", () => {
    const img = makeImg(640, 400);
    const { forward } = makeForward();
    const detach = attachInputCapture({
      img,
      forwardEvent: forward,
      fallbackWidth: 1280,
      fallbackHeight: 800,
    });
    expect(() => {
      detach();
      detach();
      detach();
    }).not.toThrow();
  });
});

// ── attachInputCapture — surface determinism ────────────────────────────

describe("attachInputCapture — surface determinism", () => {
  it("a transport throw on one event must not block subsequent forwards", () => {
    const img = makeImg(640, 400);
    let throwOnce = true;
    const events: UserInputEvent[] = [];
    const forward = vi.fn(async (event: UserInputEvent) => {
      events.push(event);
      if (throwOnce) {
        throwOnce = false;
        throw new Error("transport boom");
      }
      return {
        outcome: "forwarded" as const,
        audit: {
          session_id: "cs_test",
          motebit_id: "mb_test",
          outcome: "forwarded" as const,
          control_state_at_forwarding: { kind: "user" as const },
          detail: { kind: "click" as const, x_norm: 0, y_norm: 0, button: "left" as const },
          timestamp: 0,
        },
      };
    });
    attachInputCapture({
      img,
      forwardEvent: forward,
      fallbackWidth: 1280,
      fallbackHeight: 800,
      logger: { warn: () => {} },
    });

    img.dispatchEvent(new MouseEvent("click", { clientX: 1, clientY: 1, button: 0 }));
    img.dispatchEvent(new MouseEvent("click", { clientX: 2, clientY: 2, button: 0 }));

    // Both clicks captured; transport handled both attempts.
    expect(events).toHaveLength(2);
  });
});
