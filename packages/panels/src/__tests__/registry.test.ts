/**
 * Typed-registry doctrine tests per
 * `docs/doctrine/panel-temporal-registers.md` and
 * `docs/doctrine/panel-presentation-modes.md`.
 *
 * The closed unions + per-surface availability table are the
 * structural enforcement of the doctrine. These tests pin the
 * load-bearing invariants so a future contributor can't quietly
 * widen `PanelPresentationMode` with `"modal"` (or any other
 * category-error entry) without the suite turning red.
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
  it("ships exactly three modes for v1 (rail / immersive / spatial)", () => {
    // Compile-time guard: the type union is exactly the three modes.
    // If a future contributor adds `"modal"` to the union, the
    // exhaustive switch below stops compiling.
    const modes: PanelPresentationMode[] = ["rail", "immersive", "spatial"];
    for (const m of modes) {
      switch (m) {
        case "rail":
        case "immersive":
        case "spatial":
          break;
        default: {
          const _exhaustive: never = m;
          throw new Error(`Unknown presentation mode: ${String(_exhaustive)}`);
        }
      }
    }
    expect(modes).toHaveLength(3);
  });
});

describe("PANEL_PRESENTATION_AVAILABILITY — per-surface availability matrix", () => {
  it("declares one entry per surface (web / desktop / mobile / spatial)", () => {
    const surfaces: PanelSurface[] = ["web", "desktop", "mobile", "spatial"];
    for (const s of surfaces) {
      expect(PANEL_PRESENTATION_AVAILABILITY[s]).toBeDefined();
    }
    expect(Object.keys(PANEL_PRESENTATION_AVAILABILITY).sort()).toEqual([
      "desktop",
      "mobile",
      "spatial",
      "web",
    ]);
  });

  it("encodes the doctrine table verbatim", () => {
    expect(PANEL_PRESENTATION_AVAILABILITY.web).toEqual(["rail", "immersive"]);
    expect(PANEL_PRESENTATION_AVAILABILITY.desktop).toEqual(["rail", "immersive"]);
    // Mobile: phone screens are too narrow for a rail. Native default
    // is immersive (iOS slide-up sheet). No transitions.
    expect(PANEL_PRESENTATION_AVAILABILITY.mobile).toEqual(["immersive"]);
    // Spatial: no rail surface in 3D. Default `spatial` (glass object
    // in the room) + `immersive` for the pull-close register.
    expect(PANEL_PRESENTATION_AVAILABILITY.spatial).toEqual(["immersive", "spatial"]);
  });

  it("never declares `rail` on a non-flat surface", () => {
    expect(PANEL_PRESENTATION_AVAILABILITY.mobile).not.toContain("rail");
    expect(PANEL_PRESENTATION_AVAILABILITY.spatial).not.toContain("rail");
  });

  it("never declares `modal` on any surface — category guard", () => {
    // Modals are unrepresentable per the doctrine. This guard catches
    // a regression where someone widens `PanelPresentationMode` with
    // `"modal"` AND adds it to the availability table.
    for (const surface of Object.keys(PANEL_PRESENTATION_AVAILABILITY) as PanelSurface[]) {
      expect(PANEL_PRESENTATION_AVAILABILITY[surface]).not.toContain("modal" as never);
    }
  });
});
