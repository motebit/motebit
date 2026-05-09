/**
 * @vitest-environment jsdom
 *
 * Repro for the "click+hold+drag dismisses the live browser" bug
 * Daniel surfaced on /computer: dragging horizontally on the
 * screencast img triggered swipe-to-dismiss on the wrapping slab
 * card, silently unmounting the live_browser frame even though
 * the cloud session was still alive.
 *
 * The fix is in `renderSlabItem`: skip `attachSlabGestures` for
 * `live_browser` items. Hover-close × stays for desktop dismissal;
 * the Take Back chrome button + slash commands cover control
 * transfer. The content area belongs to the cloud browser, not
 * the slab's surface gestures.
 */

import { describe, it, expect } from "vitest";
import type { SlabItem, SlabItemActions } from "@motebit/runtime";

import { renderSlabItem } from "../ui/slab-items.js";

function fakePointerEvent(type: string, clientX: number, clientY: number): Event {
  const ev = new Event(type, { bubbles: true });
  Object.defineProperty(ev, "clientX", { value: clientX });
  Object.defineProperty(ev, "clientY", { value: clientY });
  Object.defineProperty(ev, "button", { value: 0 });
  Object.defineProperty(ev, "pointerType", { value: "mouse" });
  return ev;
}

function makeFetchItem(overrides: Partial<SlabItem> = {}): SlabItem {
  return {
    id: "fetch-1",
    kind: "fetch",
    mode: "tool_result",
    phase: "active",
    payload: { url: "https://example.com", title: "Example" },
    sensitivity: undefined,
    lastUpdatedAt: 0,
    ...overrides,
  } as unknown as SlabItem;
}

function makeLiveBrowserItem(overrides: Partial<SlabItem> = {}): SlabItem {
  return {
    id: "lb-1",
    kind: "live_browser",
    mode: "virtual_browser",
    phase: "active",
    payload: { frameSource: { subscribe: () => () => {} }, sessionId: "cs_1" },
    sensitivity: undefined,
    lastUpdatedAt: 0,
    ...overrides,
  } as unknown as SlabItem;
}

describe("renderSlabItem — live_browser gesture carve-out", () => {
  it("non-live_browser cards still dismiss on horizontal swipe past the threshold", () => {
    let dismissed = false;
    const actions: SlabItemActions = {
      dismiss: () => {
        dismissed = true;
      },
    };

    const card = renderSlabItem(makeFetchItem(), actions);
    document.body.appendChild(card);

    card.dispatchEvent(fakePointerEvent("pointerdown", 100, 100));
    // 200px horizontal — well past the 60px SWIPE_PX threshold.
    card.dispatchEvent(fakePointerEvent("pointerup", 300, 100));

    expect(dismissed).toBe(true);
  });

  it("live_browser cards do NOT dismiss on horizontal swipe — drag belongs to the cloud browser", () => {
    let dismissed = false;
    const actions: SlabItemActions = {
      dismiss: () => {
        dismissed = true;
      },
    };

    const card = renderSlabItem(makeLiveBrowserItem(), actions);
    document.body.appendChild(card);

    // The same gesture that would dismiss every other slab item
    // must NOT dismiss live_browser. Otherwise text-selection,
    // slider drags, and any horizontal pan on the screencast
    // silently unmounts the frame.
    card.dispatchEvent(fakePointerEvent("pointerdown", 100, 100));
    card.dispatchEvent(fakePointerEvent("pointerup", 300, 100));

    expect(dismissed).toBe(false);
  });

  it("live_browser cards still receive hover-close × for desktop dismissal", () => {
    // The × is attached via `attachHoverClose` regardless of kind.
    // It's the desktop-pointer dismissal affordance the gesture
    // carve-out preserves. Find the role=button child to confirm.
    const card = renderSlabItem(makeLiveBrowserItem(), { dismiss: () => {} });
    const closeBtn = card.querySelector('[role="button"][aria-label="Dismiss"]');
    expect(closeBtn).not.toBeNull();
  });
});
