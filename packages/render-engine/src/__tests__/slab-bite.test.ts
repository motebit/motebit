/**
 * The bite-crescent lock — the creature↔computer JOINT as a designed constant.
 *
 * The motebit computer (slab) is not a floating card and not a summoned
 * artifact: it is a constitutive extension of the droplet, joined at its side.
 * The visible signature of that join is the "bite crescent" — the concave notch
 * where the creature's sphere occludes the near edge of the slab (rhymes with
 * the Apple bite; the *meaning* is the joint of one body). See
 * docs/doctrine/creature-canon.md and docs/doctrine/motebit-computer.md.
 *
 * That crescent must be a designed constant, not emergent from wherever the
 * slab happens to land — "leave it to chance and half the frames look broken."
 * The geometry is pinned by four numbers (creature BODY_R + the slab's
 * creature-LOCAL offset/size), and the slab group is a CHILD of the creature
 * group, so this local geometry is POSE-INVARIANT — every camera that sees the
 * front hemisphere sees the same bite. This suite locks all four so a refactor
 * to any offset or the creature radius cannot silently reshape the signature
 * into a tangent, a gap, a coplanar seam, or a maw over the content.
 *
 * This is the robust lock: a pure-geometry invariant, deterministic and fast —
 * strictly better than a pixel golden for THIS invariant (a golden would be
 * GPU/AA-flaky and only adds material-regression coverage on top).
 */
import { describe, it, expect } from "vitest";
import { BODY_R } from "../creature.js";
import {
  SLAB_OFFSET_X,
  SLAB_OFFSET_Y,
  SLAB_OFFSET_Z,
  SLAB_WIDTH,
  SLAB_THICKNESS,
} from "../slab.js";

// Derived geometry, all in creature-local space (creature centered at x=0,
// radius BODY_R; slab centered at SLAB_OFFSET_X).
const creatureRightEdgeX = BODY_R; // sphere silhouette edge at the equator
const slabNearEdgeX = SLAB_OFFSET_X - SLAB_WIDTH / 2; // slab's left edge
const overlapDepth = creatureRightEdgeX - slabNearEdgeX; // how far the sphere bites in
const slabFrontZ = SLAB_OFFSET_Z + SLAB_THICKNESS / 2; // slab's front face
const creatureFrontZ = BODY_R; // sphere front pole

describe("bite crescent — the creature↔computer joint is a designed constant", () => {
  it("the bite EXISTS: the sphere's edge crosses the slab's near edge (attached, not a tangent or gap)", () => {
    // A tangent (edges kissing) reads as a mistake; a gap reads as a floating
    // card. The crescent needs real overlap. Current: 0.14 − 0.11 = 0.03m.
    expect(overlapDepth).toBeGreaterThan(BODY_R * 0.1); // > ~1.4cm, never a kiss
  });

  it("the bite is a SHALLOW crescent: the sphere's edge stays left of the slab's center (never a maw over content)", () => {
    // If the creature reached past the slab's horizontal center it would eat
    // the primary content (the chips + placeholder live center/right). The
    // bite belongs in the near margin only.
    expect(creatureRightEdgeX).toBeLessThan(SLAB_OFFSET_X);
    // And concretely bounded well shy of center — a designed band, not "barely".
    expect(overlapDepth).toBeLessThan(SLAB_WIDTH * 0.15);
  });

  it("it is a real OCCLUSION, not a coplanar seam: the sphere's front is in front of the slab's front in Z", () => {
    // SLAB_OFFSET_Z sits the slab just behind the creature's front face, so the
    // sphere draws over the near edge — that depth ordering IS the notch. A
    // same-plane slab would show an intersecting seam, not a bite.
    expect(creatureFrontZ).toBeGreaterThan(slabFrontZ);
  });

  it("the bite sits at the body's equator (eye level), so the crescent reads vertically centered", () => {
    // Off-equator, the notch would ride high or low on the slab and lose the
    // clean crescent. SLAB_OFFSET_Y = 0 == creature eye level.
    expect(Math.abs(SLAB_OFFSET_Y)).toBeLessThan(BODY_R * 0.5);
  });

  it("guards the exact tuned values (change these deliberately, and this test with them)", () => {
    // A tripwire so the numbers can't drift silently under a refactor. If you
    // are intentionally re-tuning the joint, update these AND re-shoot the
    // canonical frames — the crescent is a signature, treat it like one.
    expect({
      BODY_R,
      SLAB_OFFSET_X,
      SLAB_OFFSET_Y,
      SLAB_OFFSET_Z,
      SLAB_WIDTH,
      SLAB_THICKNESS,
    }).toEqual({
      BODY_R: 0.14,
      SLAB_OFFSET_X: 0.38,
      SLAB_OFFSET_Y: 0.0,
      SLAB_OFFSET_Z: -0.02,
      SLAB_WIDTH: 0.54,
      SLAB_THICKNESS: 0.04,
    });
  });
});
