/**
 * Typed-registry doctrine tests per
 * `docs/doctrine/panel-temporal-registers.md` and
 * `docs/doctrine/panel-presentation-modes.md`.
 *
 * The closed unions + per-surface availability table are the
 * structural enforcement of the doctrine. These tests pin the
 * load-bearing invariants so a future contributor can't quietly
 * widen `PanelPresentationMode` with `"modal"` or `"spatial"` (the
 * two category-error entries the doctrine forbids) without the
 * suite turning red.
 */
import { describe, expect, it } from "vitest";

import {
  SIDE_RAIL_PANELS,
  PANEL_PRESENTATION_AVAILABILITY,
  type PanelPresentationMode,
  type PanelSurface,
} from "../registry.js";

describe("SIDE_RAIL_PANELS — typed registry of six panels", () => {
  it("declares exactly six panels", () => {
    expect(SIDE_RAIL_PANELS).toHaveLength(6);
  });

  it("splits 3 identity + 3 runtime per panel-temporal-registers.md", () => {
    const identity = SIDE_RAIL_PANELS.filter((p) => p.register === "identity");
    const runtime = SIDE_RAIL_PANELS.filter((p) => p.register === "runtime");
    expect(identity).toHaveLength(3);
    expect(runtime).toHaveLength(3);
  });

  it("covers all five protocol primitives (governance deliberately absent)", () => {
    const primitives = new Set(SIDE_RAIL_PANELS.map((p) => p.primitive));
    expect(primitives).toEqual(
      new Set(["identity", "memory", "capability", "execution", "delegation"]),
    );
    // governance is the membrane, not a record. Structurally
    // unrepresentable in `PanelPrimitive`. This guard surfaces if
    // someone adds a `governance` primitive entry.
    expect(primitives.has("governance" as never)).toBe(false);
  });
});

describe("PanelPresentationMode — closed registry per panel-presentation-modes.md", () => {
  it("ships exactly two modes for v1 (rail / immersive) — flat surfaces only", () => {
    // Compile-time guard: the type union is exactly the two modes.
    // If a future contributor adds `"modal"` or `"spatial"` to the
    // union, the exhaustive switch below stops compiling.
    //
    // Spatial is intentionally absent — the spatial surface composes
    // Presentation primitives per `spatial-as-endgame.md`, not panels.
    // Modal is intentionally absent — modals are a category error
    // (rotate interior register instead).
    const modes: PanelPresentationMode[] = ["rail", "immersive"];
    for (const m of modes) {
      switch (m) {
        case "rail":
        case "immersive":
          break;
        default: {
          const _exhaustive: never = m;
          throw new Error(`Unknown presentation mode: ${String(_exhaustive)}`);
        }
      }
    }
    expect(modes).toHaveLength(2);
  });
});

describe("PANEL_PRESENTATION_AVAILABILITY — per-surface availability matrix", () => {
  it("declares one entry per flat surface (web / desktop / mobile)", () => {
    const surfaces: PanelSurface[] = ["web", "desktop", "mobile"];
    for (const s of surfaces) {
      expect(PANEL_PRESENTATION_AVAILABILITY[s]).toBeDefined();
    }
    // Spatial is intentionally absent from the surfaces enumeration
    // — panels don't exist in spatial per `spatial-as-endgame.md`
    // §"The refined 'no panels' rule." The categorical translation
    // for spatial is to a Presentation primitive, governed by
    // `spatial-as-endgame.md`, not this registry.
    expect(Object.keys(PANEL_PRESENTATION_AVAILABILITY).sort()).toEqual([
      "desktop",
      "mobile",
      "web",
    ]);
  });

  it("encodes the doctrine table verbatim", () => {
    expect(PANEL_PRESENTATION_AVAILABILITY.web).toEqual(["rail", "immersive"]);
    expect(PANEL_PRESENTATION_AVAILABILITY.desktop).toEqual(["rail", "immersive"]);
    // Mobile: phone screens are too narrow for a rail. Native default
    // is immersive (iOS slide-up sheet). No transitions.
    expect(PANEL_PRESENTATION_AVAILABILITY.mobile).toEqual(["immersive"]);
  });

  it("never declares `rail` on mobile (screen-width category guard)", () => {
    expect(PANEL_PRESENTATION_AVAILABILITY.mobile).not.toContain("rail");
  });

  it("never declares `modal` on any surface — category guard", () => {
    // Modals are unrepresentable per the doctrine. This guard catches
    // a regression where someone widens `PanelPresentationMode` with
    // `"modal"` AND adds it to the availability table.
    for (const surface of Object.keys(PANEL_PRESENTATION_AVAILABILITY) as PanelSurface[]) {
      expect(PANEL_PRESENTATION_AVAILABILITY[surface]).not.toContain("modal" as never);
    }
  });

  it("never declares `spatial` as a surface or mode — categorical-boundary guard", () => {
    // Spatial is the categorical boundary `spatial-as-endgame.md`
    // draws. Adding `"spatial"` to either `PanelSurface` or
    // `PanelPresentationMode` would re-introduce the doctrine
    // collision corrected at session-end 2026-05-14.
    expect(Object.keys(PANEL_PRESENTATION_AVAILABILITY)).not.toContain("spatial");
    for (const surface of Object.keys(PANEL_PRESENTATION_AVAILABILITY) as PanelSurface[]) {
      expect(PANEL_PRESENTATION_AVAILABILITY[surface]).not.toContain("spatial" as never);
    }
  });
});
