/**
 * @vitest-environment jsdom
 *
 * v1.3 hardening — when a live `virtual_browser` screencast is active
 * AND has a frame, the slab's `tool_call` cards for the `computer`
 * tool render slab-hidden so the user doesn't see a slideshow of
 * stills layered over the live frame surface. The predicate fires
 * per-item so the fallback contract holds: until the first frame
 * lands (or the screencast fails to start), per-action cards remain
 * the visible content.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SlabItem, SlabItemActions } from "@motebit/runtime";

import { renderSlabItem, setLiveBrowserSuppressionPredicate } from "../ui/slab-items.js";

const NOOP_ACTIONS: SlabItemActions = {
  dismiss: () => {},
};

function makeItem(overrides: Partial<SlabItem> = {}): SlabItem {
  return {
    id: "tc-1",
    kind: "tool_call",
    mode: "virtual_browser",
    phase: "active",
    payload: { name: "computer", context: "https://example.com", status: "calling" },
    sensitivity: undefined,
    lastUpdatedAt: 0,
    ...overrides,
  } as unknown as SlabItem;
}

describe("renderSlabItem — live_browser suppression of duplicate computer cards", () => {
  // Reset the predicate between tests so cross-test state doesn't
  // leak. Default = "always show" (no suppression).
  afterEach(() => {
    setLiveBrowserSuppressionPredicate(() => false);
  });

  beforeEach(() => {
    setLiveBrowserSuppressionPredicate(() => false);
  });

  it("renders the tool_call card normally when the predicate returns false", () => {
    const el = renderSlabItem(makeItem(), NOOP_ACTIONS);
    expect(el.dataset.slabHidden).not.toBe("true");
  });

  it("renders slab-hidden when the predicate returns true (live screencast active + has frame)", () => {
    setLiveBrowserSuppressionPredicate(() => true);
    const el = renderSlabItem(makeItem(), NOOP_ACTIONS);
    expect(el.dataset.slabHidden).toBe("true");
    expect(el.style.display).toBe("none");
  });

  it("does NOT suppress non-virtual_browser tool_call cards (other modes keep rendering)", () => {
    setLiveBrowserSuppressionPredicate(() => true);
    const el = renderSlabItem(makeItem({ mode: "tool_result" }), NOOP_ACTIONS);
    expect(el.dataset.slabHidden).not.toBe("true");
  });

  it("does NOT suppress non-tool_call kinds (e.g. live_browser itself stays visible)", () => {
    setLiveBrowserSuppressionPredicate(() => true);
    // A `live_browser` slab item must always render — it IS the live
    // surface the suppression is in service of. Different kind, so
    // the suppression branch doesn't fire.
    const liveItem = makeItem({
      id: "lb-1",
      kind: "live_browser",
      mode: "virtual_browser",
      payload: { frameSource: { subscribe: () => () => {} }, sessionId: "cs_1" },
    });
    const el = renderSlabItem(liveItem, NOOP_ACTIONS);
    expect(el.dataset.slabHidden).not.toBe("true");
  });

  it("predicate receives the slab item — future per-item gating is wired", () => {
    let receivedId: string | null = null;
    setLiveBrowserSuppressionPredicate((item) => {
      receivedId = item.id;
      return false;
    });
    renderSlabItem(makeItem({ id: "tc-99" }), NOOP_ACTIONS);
    expect(receivedId).toBe("tc-99");
  });
});
