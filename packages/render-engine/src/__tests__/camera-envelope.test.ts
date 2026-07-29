/**
 * The camera frustum and the orbit-zoom envelope are COUPLED through the
 * backdrop dome (the visible sky is world geometry): every camera
 * position the controls permit must keep the dome's far wall inside the
 * far plane, or the sky clips into a screen-centered hole — witnessed
 * live 2026-07-29 on motebit.com as a giant flat disc behind the creature
 * (far=10, dome=8, maxDistance=3: clipping began at distance 2, INSIDE
 * the sanctioned envelope). Definition and consumption live in different
 * files, so this is a composition invariant — locked here, not assumed
 * (docs/doctrine/composition-preserves-enforcement.md).
 */
import { describe, it, expect } from "vitest";
import {
  CAMERA_NEAR_M,
  CAMERA_FAR_M,
  BACKDROP_DOME_RADIUS_M,
  ORBIT_MIN_DISTANCE_M,
  ORBIT_MAX_DISTANCE_M,
  CANONICAL_CAMERA,
} from "../spec.js";

describe("camera envelope × backdrop dome", () => {
  it("the far plane covers the dome's far wall from the deepest sanctioned zoom-out", () => {
    // Worst case: camera at maxDistance from the target, dome centered at
    // the origin — the far wall sits at (distance + radius) from the camera.
    expect(CAMERA_FAR_M).toBeGreaterThan(ORBIT_MAX_DISTANCE_M + BACKDROP_DOME_RADIUS_M);
  });

  it("the camera can never exit the dome inside the sanctioned envelope", () => {
    // Outside the dome, its BackSide shell vanishes and the sky with it.
    expect(ORBIT_MAX_DISTANCE_M).toBeLessThan(BACKDROP_DOME_RADIUS_M);
  });

  it("every canonical pose sits inside the orbit envelope and the dome", () => {
    for (const [name, pose] of Object.entries(CANONICAL_CAMERA)) {
      const [x, y, z] = pose.position;
      const dist = Math.hypot(x - pose.lookAt[0], y - pose.lookAt[1], z - pose.lookAt[2]);
      expect(dist, `${name} pose distance`).toBeLessThanOrEqual(ORBIT_MAX_DISTANCE_M);
      expect(dist + BACKDROP_DOME_RADIUS_M, `${name} far-wall reach`).toBeLessThan(CAMERA_FAR_M);
    }
  });

  it("near plane clears the closest sanctioned zoom-in", () => {
    expect(CAMERA_NEAR_M).toBeLessThan(ORBIT_MIN_DISTANCE_M);
  });
});
