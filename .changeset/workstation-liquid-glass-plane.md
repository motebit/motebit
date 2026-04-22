---
"@motebit/render-engine": minor
"@motebit/web": minor
---

Workstation panel now mounts on a liquid-glass plane in the scene,
next to the creature — not as a fixed overlay. The spatial treatment
is motebit-native: one body, one material family, sympathetic
breathing locked to the creature's time base. Every other agent UI
collapses into a conventional browser tab; motebit's spatial
embodiment is the differentiator.

New render primitive: `WorkstationPlane` (`packages/render-engine/
src/workstation-plane.ts`). A lean ~230-line class — plane mesh with
borosilicate-IOR + clearcoat chemistry, CSS2DObject stage for mounting
arbitrary HTML, held-tablet tilt (~12° forward, ~5° yaw), 0.3 Hz
breathing at 30% creature amplitude, soul-color tint coupling on
attenuation + emissive, user-visibility toggle with smooth fade.

No per-item management, no pinch physics, no embodiment-mode
machinery — just the primitive the workstation needs. The per-tool
state lives in `@motebit/panels/workstation/controller`; the plane
only knows how to host one stage element.

`RenderAdapter` interface gains:

- `setWorkstationStageChild?(el: HTMLElement | null): void`
- `setWorkstationVisible?(visible: boolean): void`

`ThreeJSAdapter` instantiates a `WorkstationPlane` as a child of the
creature group so it inherits the creature's world transform (drift,
bob, sag). `setInteriorColor` mirrors the soul color onto the plane
so the plane and creature read as one body when the plane is open.
`resize` and `dispose` forward to the plane.

`apps/web`:

- `WebApp.getRenderer()` exposes the `ThreeJSAdapter` so surface
  modules can reach scene primitives without threading the reference
  through every seam.
- `initWorkstationPanel` detects the renderer's workstation methods
  at construction. Primary path: mount the panel DOM into the plane's
  stage via `setWorkstationStageChild`, reveal the plane via
  `setWorkstationVisible`. Fallback path (WebGL unavailable / headless
  tests / NullAdapter): float as a fixed overlay as before so the
  surface still functions without 3D.
- Panel visual treatment retuned for the glass substrate: transparent
  background (the plane IS the surface), light-on-glass typography,
  frosted-droplet receipt rows on white-alpha backdrops, serif reader
  view switched from dark-mode palette to glass-appropriate colors.
  No backdrop overlay, no drop-shadow chrome, no z-index battles.
- Launcher button restyled to match (semi-transparent white with
  blur, low-saturation icon color).

The controller stays untouched — the spatial reshape is purely
rendering. Ring-1 text fallback (the fixed-overlay path) keeps the
surface functional when the plane isn't available.

All 28 drift gates pass. 249/249 render-engine tests, 178/178 web
tests green. Full workspace build clean.
