/**
 * @vitest-environment jsdom
 *
 * Slab home view — doctrine-locking invariants for the body's
 * READY-state surface.
 *
 * The home view is where forward-framed affordances (signed-receipt-
 * informed launchpads) live, NOT where past records list. This test
 * suite pins the architectural contract:
 *
 *   1. Affordances are forward-framed ("Continue google.com"), never
 *      chronological ("Recent: 5 sessions" / dates).
 *   2. Empty-empty register returns an empty wrapper — no decorative
 *      mark, no caption (chrome strip already has the call-to-action).
 *   3. Dedup is by host (most-recent engagement wins per host).
 *   4. Audit-redacted "unknown" hosts are filtered out (noise, not
 *      affordance).
 *   5. Tap dispatch fires the affordance handler with the typed
 *      affordance (forward action, never a record open).
 *
 * Lock #1 + #2 are the doctrine bind to records-vs-acts.md (body
 * shows acts) and always-already-slab.md (empty IS empty in the
 * calm-software register).
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildSlabHomeView,
  computeSlabHomeAffordances,
  type SlabHomeAffordance,
} from "../ui/slab-home.js";
import type { UserInputForwardedPayload } from "@motebit/sdk";

function makeNavigateEvent(
  host: string,
  timestamp: number,
  scheme: string = "https",
): { payload: UserInputForwardedPayload; timestamp: number } {
  return {
    payload: {
      session_id: `sess-${host}`,
      motebit_id: "did:motebit:test",
      outcome: "forwarded",
      control_state_at_forwarding: { kind: "user" } as never,
      detail: {
        kind: "navigate",
        scheme,
        host,
        has_path: false,
        has_query: false,
      },
      timestamp,
    },
    timestamp,
  };
}

describe("computeSlabHomeAffordances — dedup by host, sort by recency, top N", () => {
  it("dedups by host with most-recent engagement winning per host", () => {
    const events = [
      makeNavigateEvent("google.com", 1_000),
      makeNavigateEvent("google.com", 3_000), // newest
      makeNavigateEvent("google.com", 2_000),
      makeNavigateEvent("news.ycombinator.com", 1_500),
    ];
    const result = computeSlabHomeAffordances(events);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.host)).toEqual(["google.com", "news.ycombinator.com"]);
    // google.com's affordance tracks the LATEST engagement (3_000),
    // not the first one we saw.
    expect(result[0]!.lastEngagedAt).toBe(3_000);
  });

  it("respects maxAffordances — only the top N hosts surface", () => {
    const events = [
      makeNavigateEvent("a.com", 1),
      makeNavigateEvent("b.com", 2),
      makeNavigateEvent("c.com", 3),
      makeNavigateEvent("d.com", 4),
      makeNavigateEvent("e.com", 5),
      makeNavigateEvent("f.com", 6),
    ];
    const result = computeSlabHomeAffordances(events, 4);
    expect(result).toHaveLength(4);
    // Newest first — recency-ordered.
    expect(result.map((a) => a.host)).toEqual(["f.com", "e.com", "d.com", "c.com"]);
  });

  it("filters out 'unknown' hosts — audit redaction collapse, not affordance", () => {
    // The audit format collapses malformed URLs to host: "unknown"
    // per co-browse.ts §"URL-redacted navigate detail". A tile
    // labeled "Continue unknown" is noise; filter at the source.
    const events = [
      makeNavigateEvent("google.com", 1),
      makeNavigateEvent("unknown", 2, "unknown"),
      makeNavigateEvent("news.ycombinator.com", 3),
    ];
    const result = computeSlabHomeAffordances(events);
    expect(result.map((a) => a.host)).toEqual(["news.ycombinator.com", "google.com"]);
  });

  it("returns empty for events with no navigate details — non-navigate audit shapes don't surface as affordances", () => {
    const events = [
      {
        payload: {
          session_id: "s1",
          motebit_id: "did:motebit:test",
          outcome: "forwarded",
          control_state_at_forwarding: { kind: "user" } as never,
          detail: { kind: "click", x_norm: 0.5, y_norm: 0.5, button: "left" } as never,
          timestamp: 1,
        },
        timestamp: 1,
      },
    ];
    expect(computeSlabHomeAffordances(events)).toHaveLength(0);
  });

  it("returns empty when no events exist — first-time-user state", () => {
    expect(computeSlabHomeAffordances([])).toHaveLength(0);
  });
});

describe("buildSlabHomeView — calm Apple-grade tile shape, forward-framed only", () => {
  it("returns an empty wrapper for the empty-empty register — no decorative mark, no redundant caption", () => {
    // Doctrine: always-already-slab.md + the calm-software discipline.
    // The chrome strip's "type a URL · or ask motebit" placeholder is
    // the first-time-user affordance. The body's empty-empty state
    // is honestly empty — pure slab interior shows through.
    const root = buildSlabHomeView([], { onAffordanceTap: vi.fn() });
    expect(root.children).toHaveLength(0);
    expect(root.textContent).toBe("");
  });

  it("renders forward-framed tiles — verb is 'Continue', host is the legible center, no chronological labels", () => {
    const affordances: SlabHomeAffordance[] = [
      { id: "aff-google.com", host: "google.com", scheme: "https", lastEngagedAt: 1 },
      {
        id: "aff-news.ycombinator.com",
        host: "news.ycombinator.com",
        scheme: "https",
        lastEngagedAt: 2,
      },
    ];
    const root = buildSlabHomeView(affordances, { onAffordanceTap: vi.fn() });
    const tiles = root.querySelectorAll(".slab-home-affordance");
    expect(tiles).toHaveLength(2);

    // Each tile is forward-framed — verb + host, never a date or
    // "Recent" header.
    for (const tile of tiles) {
      expect(tile.textContent).toContain("Continue");
      // Doctrine lock: no chronological framing on the body. If a
      // future change adds "yesterday at 3pm" to the tile, this
      // assertion catches it.
      expect(tile.textContent).not.toMatch(/yesterday|ago|recent|history/i);
    }
    // Hosts appear as the legible center label.
    const texts = Array.from(tiles).map((t) => t.textContent);
    expect(texts.some((t) => t?.includes("google.com"))).toBe(true);
    expect(texts.some((t) => t?.includes("news.ycombinator.com"))).toBe(true);
  });

  it("tile tap fires onAffordanceTap with the typed affordance — forward dispatch, never a record-open", () => {
    const handler = vi.fn();
    const aff: SlabHomeAffordance = {
      id: "aff-apple.com",
      host: "apple.com",
      scheme: "https",
      lastEngagedAt: 1,
    };
    const root = buildSlabHomeView([aff], { onAffordanceTap: handler });
    const tile = root.querySelector(".slab-home-affordance") as HTMLButtonElement;
    expect(tile).not.toBeNull();
    tile.click();
    expect(handler).toHaveBeenCalledWith(aff);
  });

  it("uses the soul tint when provided — tile glass composes with slab transmission, not a hard white card", () => {
    const aff: SlabHomeAffordance = {
      id: "aff-x.com",
      host: "x.com",
      scheme: "https",
      lastEngagedAt: 1,
    };
    // Distinctive hex so we can find it in the inline style.
    const root = buildSlabHomeView([aff], {
      onAffordanceTap: vi.fn(),
      soulTint: "#c08040",
    });
    const tile = root.querySelector(".slab-home-affordance") as HTMLButtonElement;
    expect(tile.style.background).toContain("rgba(192, 128, 64");
  });

  it("breathes at the slab's 0.3 Hz rhythm when Element.animate is available — tile group inherits the body's sympathetic register", () => {
    // The home view's opacity pulses at 0.3 Hz to lock the calm
    // rhythm. Sibling of the slab body's eigenmode breathing.
    //
    // jsdom doesn't implement Element.animate; the builder degrades
    // gracefully (no animation, but tiles still render). Install a
    // stub so we can assert the timing parameters we'd pass in a
    // real browser.
    const aff: SlabHomeAffordance = {
      id: "aff-a.com",
      host: "a.com",
      scheme: "https",
      lastEngagedAt: 1,
    };
    const stubAnimate = vi.fn((_keyframes: unknown, options: KeyframeAnimationOptions) => ({
      effect: { getComputedTiming: () => options } as unknown as AnimationEffect,
    }));
    const proto = Element.prototype as { animate?: typeof stubAnimate };
    const original = proto.animate;
    proto.animate = stubAnimate as never;
    try {
      buildSlabHomeView([aff], { onAffordanceTap: vi.fn() });
      expect(stubAnimate).toHaveBeenCalledOnce();
      const [, options] = stubAnimate.mock.calls[0]!;
      // 0.3 Hz → 1000 / 0.3 ≈ 3333 ms per cycle.
      expect(options.duration).toBeCloseTo(1000 / 0.3, 0);
      expect(options.iterations).toBe(Infinity);
    } finally {
      proto.animate = original;
    }
  });
});
