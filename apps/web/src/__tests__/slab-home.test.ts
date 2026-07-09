/**
 * @vitest-environment jsdom
 *
 * Slab home view — doctrine-locking invariants for the body's
 * READY-state surface, now rendering the DERIVED capability-seed
 * (motebit-computer.md §home: "derive the seed; never author it").
 *
 * Locks:
 *   1. Tiles are forward-framed acts, never chronological records.
 *   2. Empty-empty is UNREPRESENTABLE — the intrinsic identity floor
 *      guarantees content at N=0; the "Anywhere." watermark belongs to
 *      the chrome backdrop, never the body.
 *   3. Dedup/redaction behavior of the resumption basis is preserved.
 *   4. Tap dispatch fires the typed promptless action.
 *   5. Setup chips render only while unmet (recede is structural).
 */

import { describe, it, expect, vi } from "vitest";
import { buildSlabHomeView, computeSlabHomeAffordances } from "../ui/slab-home.js";
import { deriveHomeSeed, type HomeSeedInputs, type HomeConfigKey } from "../ui/slab-home-model.js";
import type { UserInputForwardedPayload } from "@motebit/sdk";

const TEST_ID = "0197f000-0000-7000-8000-0000000000aa";

function seedInputs(overrides: {
  config?: Partial<Record<HomeConfigKey, boolean>>;
  events?: Array<{ payload: UserInputForwardedPayload; timestamp: number }>;
}): HomeSeedInputs {
  return {
    identity: { motebitId: TEST_ID },
    config: { mind: true, relay: true, computer: true, ...overrides.config },
    toolNames: ["web_search"],
    navigateEvents: overrides.events ?? [],
  };
}

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

  it("collapses canonical-host duplicates — `www.google.com` and `google.com` are one tile, most-recent engagement wins", () => {
    // Without canonical dedup, the audit log's `www.` variants
    // would surface as separate tiles for the same destination —
    // exactly the "algorithmically-unfinished" tell Apple's
    // Spotlight never shows. Lock that they collapse here.
    const events = [
      makeNavigateEvent("www.google.com", 1_000),
      makeNavigateEvent("google.com", 3_000), // newest, real
      makeNavigateEvent("www.google.com", 2_000),
    ];
    const result = computeSlabHomeAffordances(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.host).toBe("google.com");
    expect(result[0]!.lastEngagedAt).toBe(3_000);
  });

  it("rejects TLD-less hosts — `gmail` from a URL-bar typo doesn't become a tile", () => {
    // `gmail` (no `.`) is almost always a typo or shorthand from
    // the URL bar that the parser kept as a bare host. A tile
    // "Continue gmail" alongside "Continue gmail.com" reads as
    // algorithmically-broken. Drop the dotless variant.
    const events = [makeNavigateEvent("gmail", 1_000), makeNavigateEvent("gmail.com", 2_000)];
    const result = computeSlabHomeAffordances(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.host).toBe("gmail.com");
  });

  it("preserves localhost — a TLD-less but legitimate destination", () => {
    // The dotless-host filter shouldn't kill localhost (a real
    // destination for dev workflows). Whitelist exception.
    const events = [makeNavigateEvent("localhost", 1)];
    const result = computeSlabHomeAffordances(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.host).toBe("localhost");
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
    const events: Array<{ payload: UserInputForwardedPayload; timestamp: number }> = [
      {
        payload: {
          session_id: "s1",
          motebit_id: "did:motebit:test",
          outcome: "forwarded",
          control_state_at_forwarding: { kind: "user" } as never,
          detail: { kind: "click", x_norm: 0.5, y_norm: 0.5, button: "left" },
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

describe("buildSlabHomeView — renders the derived seed; empty-empty unrepresentable", () => {
  it("N=0 renders the intrinsic identity floor + capability tiles — never an empty body, never a body watermark", () => {
    const seed = deriveHomeSeed(seedInputs({}));
    const root = buildSlabHomeView(seed, { onTileAction: vi.fn() });
    // The identity mark is present at absolute zero.
    expect(root.querySelector(".slab-home-identity")).not.toBeNull();
    // The intrinsic floor guarantees at least one tile ("Set a goal").
    const tiles = root.querySelectorAll(".slab-home-affordance");
    expect(tiles.length).toBeGreaterThan(0);
    // "Anywhere." is the CHROME's watermark backdrop, never body content.
    expect(root.querySelector(".slab-home-watermark")).toBeNull();
    expect(root.textContent).not.toContain("Anywhere.");
  });

  it("renders forward-framed resumption tiles — verb + host, never chronological labels", () => {
    const seed = deriveHomeSeed(
      seedInputs({
        events: [makeNavigateEvent("google.com", 1), makeNavigateEvent("news.ycombinator.com", 2)],
      }),
    );
    const root = buildSlabHomeView(seed, { onTileAction: vi.fn() });
    const resumption = root.querySelectorAll('[data-layer="resumption"]');
    expect(resumption).toHaveLength(2);
    Array.from(resumption).forEach((tile) => {
      expect(tile.textContent).toContain("Continue");
      expect(tile.textContent).not.toMatch(/yesterday|ago|recent|history/i);
    });
    const texts = Array.from(resumption).map((t) => t.textContent);
    expect(texts.some((t) => t?.includes("google.com"))).toBe(true);
    expect(texts.some((t) => t?.includes("news.ycombinator.com"))).toBe(true);
  });

  it("tile tap fires onTileAction with the typed promptless action", () => {
    const handler = vi.fn();
    const seed = deriveHomeSeed(seedInputs({ events: [makeNavigateEvent("apple.com", 1)] }));
    const root = buildSlabHomeView(seed, { onTileAction: handler });
    const tile = root.querySelector('[data-host="apple.com"]') as HTMLButtonElement;
    expect(tile).not.toBeNull();
    tile.click();
    expect(handler).toHaveBeenCalledWith({ kind: "navigate", url: "https://apple.com" });
  });

  it("renders a favicon img on resumption tiles only — capability tiles stay text-quiet", () => {
    const seed = deriveHomeSeed(seedInputs({ events: [makeNavigateEvent("apple.com", 1)] }));
    const root = buildSlabHomeView(seed, { onTileAction: vi.fn() });
    const resumptionTile = root.querySelector('[data-host="apple.com"]');
    const favicon = resumptionTile?.querySelector("img");
    expect(favicon).not.toBeNull();
    expect(favicon?.src).toContain("icons.duckduckgo.com");
    expect(favicon?.loading).toBe("lazy");
    const intrinsic = root.querySelector('[data-layer="intrinsic"]');
    expect(intrinsic?.querySelector("img")).toBeNull();
  });

  it("setup chips render while unmet and are structurally absent when wired", () => {
    const bare = deriveHomeSeed(seedInputs({ config: { mind: false, relay: false } }));
    const bareRoot = buildSlabHomeView(bare, { onTileAction: vi.fn() });
    expect(bareRoot.querySelectorAll(".slab-home-setup")).toHaveLength(2);

    const wired = deriveHomeSeed(seedInputs({}));
    const wiredRoot = buildSlabHomeView(wired, { onTileAction: vi.fn() });
    expect(wiredRoot.querySelectorAll(".slab-home-setup")).toHaveLength(0);
  });

  it("setup chip tap dispatches open_setup with its key", () => {
    const handler = vi.fn();
    const seed = deriveHomeSeed(seedInputs({ config: { mind: false } }));
    const root = buildSlabHomeView(seed, { onTileAction: handler });
    const chip = root.querySelector('[data-setup="setup-mind"]') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    chip.click();
    expect(handler).toHaveBeenCalledWith({ kind: "open_setup", key: "mind" });
  });

  it("uses the soul tint — tile glass composes with slab transmission", () => {
    const seed = deriveHomeSeed(seedInputs({}));
    const root = buildSlabHomeView(seed, { onTileAction: vi.fn(), soulTint: "#c08040" });
    const tile = root.querySelector(".slab-home-affordance") as HTMLButtonElement;
    expect(tile.style.background).toContain("rgba(192, 128, 64");
  });

  it("breathes at the slab's 0.3 Hz rhythm when Element.animate is available", () => {
    const stubAnimate = vi.fn((_keyframes: unknown, options: KeyframeAnimationOptions) => ({
      effect: { getComputedTiming: () => options } as unknown as AnimationEffect,
    }));
    const proto = Element.prototype as unknown as { animate?: typeof stubAnimate };
    const original = proto.animate;
    proto.animate = stubAnimate as never;
    try {
      buildSlabHomeView(deriveHomeSeed(seedInputs({})), { onTileAction: vi.fn() });
      expect(stubAnimate).toHaveBeenCalledOnce();
      const [, options] = stubAnimate.mock.calls[0]!;
      expect(options.duration).toBeCloseTo(1000 / 0.3, 0);
      expect(options.iterations).toBe(Infinity);
    } finally {
      proto.animate = original;
    }
  });
});
