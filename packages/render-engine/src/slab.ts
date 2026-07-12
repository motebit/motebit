/**
 * Slab Manager — desktop / web renderer for the "Motebit Computer."
 *
 * State machine lives in `slab-core.ts` (Ring 1 — same on every surface
 * that renders a slab). This module owns the desktop / web rendering
 * primitive: a liquescent plane floating to the right of the
 * creature, items mounted via `CSS3DObject`, sympathetic breathing,
 * Rayleigh-Plateau pinch displacement on the plane mesh.
 *
 * One state machine, two renderers (desktop here, spatial in
 * `slab-spatial.ts`). The Ring 1 / Ring 3 split is structural:
 *
 *   - `SlabCore` tracks ids, phases, lifecycle timings, ambient counts.
 *     Rendering-free.
 *   - `SlabManager` and `SpatialSlabManager` each consume the core and
 *     apply surface-native visuals.
 *
 * What this module is:
 *
 *   - A `THREE.Group` containing the liquescent plane mesh + a
 *     CSS3DObject anchor for HTML items mounted on its surface. Same
 *     material family as the creature — both liquescent, optical
 *     character borrowed from glass-physics (borosilicate IOR,
 *     transmission, low roughness) — body-adjacent, not a UI element. CSS3D is
 *     load-bearing here: the plane sits at SLAB_TILT_X (~12° forward)
 *     and SLAB_TILT_Y (~5° yaw toward creature), and CSS3DObject
 *     respects that 3D transform — items tilt with the plane the way
 *     the creature's eyes tilt with the head. The earlier CSS2D
 *     implementation billboarded items to the camera, which made the
 *     chrome float off as a flat sticker disconnected from the
 *     plane's pose (visible in the 2026-05-07 angled-view triage).
 *
 *   - Per-frame DOM animation (emerge / dissolve / pinch) driven from
 *     the core's snapshot — phase + phaseTime in, element transforms
 *     out.
 *
 *   - Plane vertex displacement during pinches (Rayleigh-Plateau bump).
 *
 *   - Soul-color coupling on the plane material, eased on top of the
 *     core's `activeWarmth`.
 */

import * as THREE from "three";
import { CSS3DObject, CSS3DRenderer } from "three/addons/renderers/CSS3DRenderer.js";
import type {
  ArtifactSpec,
  ArtifactHandle,
  InteriorColor,
  SlabBodyRegister,
  SlabItemSpec,
  SlabItemHandle,
} from "./spec.js";
import { CANONICAL_MATERIAL } from "./spec.js";
import { GOLDEN_RATIO } from "./design-ratios.js";
import {
  SlabCore,
  SLAB_EMERGE_DURATION_S,
  SLAB_DISSOLVE_DURATION_S,
  SLAB_PINCH_DURATION_S,
  SLAB_PINCH_PHASE2_START,
  SLAB_PINCH_PHASE2_END,
  SLAB_BREATHE_FREQUENCY_HZ,
  SLAB_BREATHE_AMPLITUDE_FACTOR,
  MEMBRANE_OPACITY,
  type DetachArtifactHandler,
  type SlabCoreItemSnapshot,
} from "./slab-core.js";
import {
  createPlaneGestureDetector,
  attachPlaneGestureToTarget,
  type PlaneGestureDetector,
} from "./slab-plane-gesture.js";

export type { DetachArtifactHandler } from "./slab-core.js";

// ── Geometry + positioning constants (desktop renderer only) ─────────

/**
 * Slab position relative to the creature. Held-tablet pose — offset
 * right, at the creature's eye level, tilted forward toward the
 * camera (~12°) and turned toward the creature (~9° yaw). Values
 * chosen to read as "the motebit is holding up a glass slate and
 * showing you what's on it."
 *
 * X/width tuned so the right edge stays on-screen on a 16:9 canvas
 * at the default camera (pos z=0.85, fov 45°, half-screen-width at
 * slab depth ≈ 0.35m). At the previous offset/width (0.42/0.42)
 * the plane's right edge sat past the viewport; cards mounted on
 * the outer slots clipped out of view on narrower windows.
 */
// Exported so the bite-geometry lock (`slab-bite.test.ts`) can assert the
// creature↔computer joint — the "bite crescent" signature — is a designed
// constant, not emergent. The offsets are creature-LOCAL (the slab group is a
// child of the creature group, slab.ts `creatureGroup.add(this.group)`), so
// this geometry is pose-invariant: every camera that sees the front hemisphere
// sees the same crescent. docs/doctrine/creature-canon.md.
export const SLAB_OFFSET_X = 0.38; // right of creature (meters)
export const SLAB_OFFSET_Y = 0.0; // creature eye level
export const SLAB_OFFSET_Z = -0.02; // just behind creature's front face
const SLAB_TILT_X = -0.22; // ~12.5° forward (radians)
const SLAB_TILT_Y = -0.09; // ~5° yaw toward creature (radians) — doctrine

/**
 * Plane dimensions — sized to host window-pane cards (~520×334 CSS px
 * at the default camera) without visible empty margins around the
 * container. Aspect locked to the golden ratio (φ ≈ 1.618) via the
 * shared `GOLDEN_RATIO` constant; see `design-ratios.ts` for the rule
 * and scope (body-adjacent display surfaces in the droplet/material
 * family).
 */
export const SLAB_WIDTH = 0.54;
const SLAB_HEIGHT = SLAB_WIDTH / GOLDEN_RATIO;

/**
 * Corner radius for the meniscus silhouette. The plane geometry's
 * outer ring snaps onto a rounded-rectangle of this radius (see
 * `createMeniscusPlaneGeometry`); the side-wall geometry samples
 * the same rounded-rect outline so the perimeter of the front pane,
 * the back pane, and the side wall all trace the same curve.
 *
 * 28% of the shorter side reads as a droplet rather than a softened
 * rectangle. Doctrine: motebit-computer.md §"Visual properties" —
 * `Edges: meniscus, no frame, no border, no corner radius. Droplet
 * family.`
 */
const SLAB_CORNER_RADIUS = Math.min(SLAB_WIDTH, SLAB_HEIGHT) * 0.28;

/**
 * Volumetric thickness of the slab. The body is a 3D droplet — eyes,
 * mouth, and soul-glow are *embedded inside* its glass, not painted
 * on. A flat-plane slab read as a "razor-thin paper sticker next to
 * the body" (2026-05-07 angled-view triage); doctrine
 * (motebit-computer.md §"Visual properties") names the slab as
 * body-adjacent, same material family as the creature, so it must
 * share the body's volumetric register.
 *
 * 0.04m matches the `MeshPhysicalMaterial.thickness` shader hint
 * already declared on `planeMaterial` — keeping geometry and
 * refraction-thickness aligned avoids the discrepancy where the
 * shader believed the front pane was 4cm thick while the geometry
 * presented as 0mm.
 *
 * The slab is built as a front pane + back pane separated by this
 * thickness; the open volume between them is where embodiment
 * content lives — both the WebGL `screenMesh` (screencast pixels)
 * and the CSS3D `stageAnchor` (chrome, address-bar slot,
 * input-capture geometry) co-locate at the volume's center plane
 * (z=0), composing as one window plane suspended in the liquescent volume.
 * Step 3 of the volume arc renders content as a back-pane texture
 * so it refracts through the front; step 2 (this) gets the
 * geometry depth in place first so the perceptual register
 * changes.
 */
export const SLAB_THICKNESS = 0.04;

/**
 * CSS3DObject pixel→world scale. The stage div is sized in CSS pixels
 * (480×300 from createContainerElement); CSS3D treats those pixels as
 * world units unless scaled. Map the stage edge-to-edge with the
 * plane's projected extent so content fills the perceptual organ —
 * `SLAB_WIDTH / stage_pixel_width = 0.54 / 480 ≈ 0.001125`. Single
 * scalar holds for both axes because the stage's 480×300 (1.6:1) and
 * the plane's 0.54×0.334 (φ ≈ 1.618:1) aspect ratios are within 1%.
 *
 * `STAGE_PIXEL_WIDTH` mirrors the value in `createContainerElement`
 * below; if that footprint changes (e.g., for a denser embodiment),
 * update both. The duplication is intentional — the constant lives
 * here so the per-pixel scale derivation reads at the construction
 * site, and `createContainerElement` stays a pure DOM factory the
 * test fakes can substitute without importing this module's geometry.
 */
const STAGE_PIXEL_WIDTH = 480;
const STAGE_PIXEL_TO_WORLD = SLAB_WIDTH / STAGE_PIXEL_WIDTH;

// Stage z-position is `0` — same plane as the WebGL screen mesh.
// In `virtual_browser` mode the chrome (URL bar, nav arrows) and
// the content (screencast) are ONE browser window; they belong on
// one plane. Earlier designs split them across z-depths (chrome at
// front face, content at volume center) which produced a visible
// depth split at angles — chrome read as floating in front of the
// liquescent body while content read as recessed into the volume,
// fragmenting a unified concept into two registers. CSS3DRenderer composites
// above the WebGL canvas regardless of 3D position, so chrome still
// visually layers above content via DOM stacking; the only thing
// that changed is the geometry, which now agrees with the concept:
// one window plane, suspended in the volume per liquescentia-as-
// substrate's "pixels embed in liquescent volume" principle. From any
// angle, chrome and content read as the same surface.

/**
 * Chrome region — top fraction of the slab reserved for the
 * `live_browser` shell's chrome strip (URL bar + nav arrows). The
 * WebGL `screenMesh` occupies only the BODY region below this so
 * page content never renders behind chrome. Closes the click-
 * stealing bug where chrome's compositor-stacking obscured AND
 * intercepted clicks for the top portion of the page.
 *
 * 0.18 derives from the chrome strip's natural CSS-pixel height
 * (~54px in `cobrowse-chrome.ts`'s URL bar + margins) divided by
 * the stage's pixel height (~300). The alignment between the
 * WebGL body-region top edge and the DOM chrome strip's bottom
 * edge is visual, not structurally enforced — if the chrome strip
 * height drifts (added controls, taller font), update this
 * constant to match. Drift is visible: chrome would either spill
 * onto body region (overlap returns) or leave a sliver of empty
 * glass between chrome and screencast.
 */
const CHROME_REGION_FRACTION = 0.18;
const BODY_REGION_HEIGHT = SLAB_HEIGHT * (1 - CHROME_REGION_FRACTION);
/**
 * Body region center y in slab-local coords — shifted down from
 * slab center by half the chrome region's height. Body region top
 * edge sits at slab-local y = +SLAB_HEIGHT/2 - chrome_height,
 * bottom edge at y = -SLAB_HEIGHT/2 (the slab's bottom).
 */
const BODY_REGION_CENTER_Y = -SLAB_HEIGHT * (CHROME_REGION_FRACTION / 2);

/**
 * Inscribed-safe-area inset — the iOS / visionOS pattern for
 * rendering rectangular web content inside a rounded container
 * whose corner radius is large enough to cause visible clipping.
 *
 * The slab has a corner radius of `SLAB_CORNER_RADIUS` ≈ 16% of
 * slab width — five times larger than Apple Vision Pro Safari's
 * typical 3% window-corner radius. At that scale, content rendered
 * edge-to-edge inside the rounded silhouette has visibly clipped
 * corners (Google.com's "Privacy / Terms" footer at bottom-right,
 * "Sign in" at top-right). Rounding the content's own corners to
 * match the slab makes those critical UI elements *more* clipped,
 * not less.
 *
 * Apple's pattern when corner radius is large: inscribed rectangle.
 * Content lives in the safe area — the largest rectangle that fits
 * inside the rounded silhouette without poking past at the corners.
 * The rounded portion of the silhouette becomes explicitly visible
 * glass framing the content. Same shape as iPhone's notch and
 * Dynamic Island: content fills the safe area; the curve is the
 * device's character, not part of the content.
 *
 * The diagonal-touch inset (r × (1 − 1/√2) ≈ 0.293r) is the smallest
 * inset where the rectangle's corners exactly graze the rounded
 * corners at 45°. Any smaller, the rectangle pokes past the
 * silhouette. Any larger, more glass is visible around the
 * content. 0.293r is the canonical inscribed-rectangle constant.
 */
const INSCRIBED_INSET_WORLD = SLAB_CORNER_RADIUS * (1 - 1 / Math.sqrt(2));

/**
 * Inscribed inset in **stage-pixel** space — the same geometric inset
 * the WebGL screen-mesh applies, expressed in CSS pixels so the
 * CSS3D side (chrome strip + body wrapper + click-capture img) can
 * align with the WebGL projection.
 *
 * Why it's exported: the click-capture img in `live-browser.ts` must
 * occupy the same screen-space rect as the WebGL screen-mesh; if the
 * two diverge, the user clicks on what they see in WebGL but the
 * pointer event lands on a DOM element at a different position
 * (witnessed 2026-05-12: post-takeback CAPTCHA checkbox unclickable
 * because the DOM img was letterbox-centered in the full body while
 * the WebGL mesh occupied the inscribed-inset rect). Same constants,
 * single source of truth — `live-browser.ts` imports rather than
 * duplicates.
 */
export const INSCRIBED_INSET_PX = INSCRIBED_INSET_WORLD / STAGE_PIXEL_TO_WORLD;

/**
 * Chrome-to-body breathing inset — a small visible glass strip
 * between the chrome strip's bottom edge and the body mesh's top.
 *
 * The chrome strip (CSS3D, in `stageEl`) has its own internal
 * padding + 1px border-bottom; the chrome region boundary in
 * world coords (y = +SLAB_HEIGHT/2 − CHROME_REGION_HEIGHT) is the
 * region's bottom, NOT the chrome strip's visual bottom. Without
 * a top inset on the body mesh, the page's natural top row (e.g.
 * Google's "About / Store / Sign in" nav) visually crowds into the
 * chrome strip's bottom-border area — they read as one continuous
 * stack instead of chrome + suspended body.
 *
 * 10pt creates a comfortable visible glass strip without dominating.
 * Combined with the inscribed-safe lateral + bottom insets, the
 * body mesh now sits as a clean rectangle suspended in the body
 * region with consistent glass margins on all four sides — the
 * "suspended in air within the slab" register motebit needs.
 */
const BODY_TOP_INSET_WORLD = 10 * STAGE_PIXEL_TO_WORLD;

/**
 * Chrome-to-body breathing inset in **stage-pixel** space. By
 * construction = 10 (since BODY_TOP_INSET_WORLD = 10 × pixel-to-
 * world). Exported alongside `INSCRIBED_INSET_PX` so the CSS3D side
 * can position the click-capture img to match the WebGL screen-
 * mesh's vertical position. See `INSCRIBED_INSET_PX` for the
 * load-bearing rationale.
 */
export const BODY_TOP_INSET_PX = 10;

/**
 * Screen mesh dimensions — rectangular mesh suspended in the
 * body region's safe area with glass margins on all four sides.
 *
 *   width   = SLAB_WIDTH − 2 × inscribed_inset    (lateral safe area)
 *   height  = body_region_height − top_inset − bottom_inset
 *   centerY = body_region_center + (bottom_inset − top_inset)/2
 *
 * The center shifts slightly upward because the bottom inset
 * (inscribed_inset, ~25pt) is larger than the top inset (10pt) —
 * the bottom needs more inset to avoid the slab's rounded bottom
 * corners, while the top only needs visual breathing from the
 * chrome strip.
 */
const SCREEN_MESH_WIDTH = SLAB_WIDTH - 2 * INSCRIBED_INSET_WORLD;
const SCREEN_MESH_HEIGHT = BODY_REGION_HEIGHT - INSCRIBED_INSET_WORLD - BODY_TOP_INSET_WORLD;
const SCREEN_MESH_CENTER_Y =
  BODY_REGION_CENTER_Y + (INSCRIBED_INSET_WORLD - BODY_TOP_INSET_WORLD) / 2;

// ── Renderer-side per-item state ─────────────────────────────────────

interface ManagedElement {
  element: HTMLElement;
  /** Tracked once per item — `slab-item-resting` class application. */
  restingApplied: boolean;
}

// ── Slab Manager ─────────────────────────────────────────────────────

export class SlabManager {
  private readonly group: THREE.Group;
  /**
   * Front (camera-facing) pane. Pinch displacement targets this one.
   * `group.children` ordering puts this first so consumers (tests,
   * adapters) that read `group.children.find(c => c instanceof Mesh)`
   * still resolve to the visible-from-the-front pane.
   */
  private readonly planeMesh: THREE.Mesh;
  /**
   * Back pane. Mirrors the front geometry, sealed against camera-
   * side. Stays rigid during pinches — only the front face arcs
   * toward the viewer when an item detaches as an artifact.
   */
  private readonly backPaneMesh: THREE.Mesh;
  /**
   * Side-wall mesh wrapping front pane perimeter to back pane
   * perimeter. Closes the volume so the slab reads as a single
   * solid glass slate from any angle. Without it, off-axis views
   * showed two parallel membranes with hollow space between
   * (the 2026-05-07 19:03 angled-view triage).
   */
  private readonly sideWallMesh: THREE.Mesh;
  /**
   * Texture surface for the live screencast — a third meniscus-shaped
   * plane embedded inside the slab volume (same z as the stage,
   * 1mm in front of the back pane), carrying the cloud browser's
   * JPEG frames as a `MeshBasicMaterial.map`. Sibling to the front
   * + back panes; lives in the WebGL scene graph so it shares the
   * depth buffer with the creature and is naturally clipped by the
   * slab's meniscus silhouette. Replaces the prior
   * `<img>`-via-`CSS3DObject` path, which had no shared depth (HTML
   * overlay punched through the creature on rotation) and no
   * silhouette-clip (rectangular img on a rounded slab — Daniel's
   * "doesn't follow the slab shape" / 2026-05-09 04:23 triage).
   */
  private readonly screenMesh: THREE.Mesh;
  private readonly screenMaterial: THREE.MeshBasicMaterial;
  private screenTexture: THREE.Texture | null = null;
  private readonly planeMaterial: THREE.MeshPhysicalMaterial;
  /**
   * Silhouette companion to `planeMaterial`. Same `MeshPhysicalMaterial`
   * family — same `ior` / `clearcoat` / `sheen` / `color` /
   * `attenuation` / `opacity` — but with `transmission: 0`, so the back
   * pane and side wall keep their glassy shading register without
   * trying to refract a backbuffer.
   *
   * Why two materials, not one. Three.js's `MeshPhysicalMaterial`
   * transmission renders by capturing a backbuffer that excludes ALL
   * transmissive meshes, then refracting that buffer through the
   * transmissive surface. With three transmissive panes (front + back
   * + sideWall) all sharing one material, every pane's backbuffer
   * excluded the other two — and the screen mesh inside the volume
   * never composited reliably through the front pane's transmission.
   * Witnessed 2026-05-09: opening yahoo.com / google.com showed slab
   * chrome but no page interior; the texture path uploaded per frame
   * but the front pane refracted a backbuffer that didn't reliably
   * include the inner screen mesh.
   *
   * Three.js's transmission is designed for ONE transmissive surface
   * + opaque backdrop (every official glass demo — jewelry, bottles,
   * wine glasses — uses this pattern). Keeping the front pane
   * transmissive and demoting back+sideWall to a non-transmissive
   * silhouette companion follows the design boundary instead of
   * fighting it. From the user's typical front-on POV
   * (slab pinned in front of the creature), the visual register is
   * indistinguishable; off-axis, the back+side now shade glassy
   * without seeing through env light, a perceptual register the user
   * mostly doesn't observe in normal use.
   *
   * Both materials share the same opacity-easing + soul-tint +
   * emissive driver below — the silhouette is the front pane's twin
   * in every dimension except the one three.js can't reliably stack.
   */
  private readonly silhouetteMaterial: THREE.MeshPhysicalMaterial;
  /**
   * One CSS3DObject anchored at the plane's center, holding a single
   * "stage" div — the plane renders ONE primary embodiment at a time
   * (doctrine: motebit-computer.md §"Embodiment modes"). Cards-on-
   * glass don't exist; the stage's child is whatever the motebit is
   * currently working on (browser page, terminal, IDE). CSS3D
   * (vs. CSS2D) means the stage element follows the plane's tilt
   * and rotation in 3D space rather than billboarding flat against
   * the camera — the slab's pose is the content's pose.
   */
  private readonly stageAnchor: CSS3DObject;
  private readonly stageEl: HTMLDivElement;
  /**
   * Identity face — a second CSS3D stage on the BACK of the slab (rotated to
   * face outward, so its content reads correctly from behind rather than
   * mirrored). Holds the web-provided identity mark (sigil + id). Crossfaded
   * with the front interface by the same camera-facing dot: orbit front→back
   * and the interface dissolves as the identity blooms. Front = what it does;
   * back = whose it is. The web owns the pixels (params-not-pixels); this only
   * mounts + crossfades them. docs/doctrine/motebit-computer.md.
   */
  private readonly backStageAnchor: CSS3DObject;
  private readonly backStageEl: HTMLDivElement;
  private _hasBackPlate = false;
  private readonly css3dRenderer: CSS3DRenderer;
  /**
   * The interface's base opacity from the membrane (set in `update`), before
   * the render-loop facing fade is applied — so `render` can modulate by camera
   * angle without re-deriving the membrane term.
   */
  private _stageBaseOpacity = 0;
  // Scratch vectors for the front-facing fade (allocated once, reused per frame).
  private readonly _slabWorldPos = new THREE.Vector3();
  private readonly _slabWorldQuat = new THREE.Quaternion();
  private readonly _slabForward = new THREE.Vector3();
  private readonly _camWorldPos = new THREE.Vector3();
  private readonly _viewDir = new THREE.Vector3();
  /** Per-id renderer state — DOM element + per-render flags. */
  private readonly elements = new Map<string, ManagedElement>();
  private readonly core: SlabCore;
  /**
   * Current soul color. Body-coherence rule: the slab is an organ of
   * the motebit, so it carries the soul tint *always* — same as the
   * creature's iris carries soul color whether the motebit is idle
   * or working. Two coupled axes:
   *
   *   - `soulTint` → `attenuationColor`. Always present. The slab's
   *     glass takes on the motebit's color at idle just as the
   *     creature does.
   *   - `soulGlow` → `emissive`. Modulated by `activeWarmth`: a
   *     faint baseline at idle (the slab is alive, not extinguished),
   *     rising to the doctrine's gentle peak when work is happening.
   *
   * Earlier implementation lerped attenuationColor between neutral
   * cool and soulTint based on activeWarmth, so an empty slab
   * "switched identity" away from the creature's soul. Body
   * coherence — same body, same soul — restored 2026-05-07.
   */
  private soulTint: [number, number, number] = [0.95, 0.97, 1.0];
  private soulGlow: [number, number, number] = [0.55, 0.78, 1.0];

  // Two-finger-hold-on-plane → halt gesture (v1.2b). The detector is
  // a pure state machine; `attachPlaneGestureToTarget` wires it to the
  // CSS3D-renderer container's pointer events. The detector's `tick`
  // is driven from `update()` so progress visuals stay locked to the
  // sympathetic-breathing frame. `haltGestureHandler` is set by the
  // app at slab-binding time (it can't be set in the constructor —
  // the session manager that owns `halt()` lives in the app surface).
  // Doctrine: motebit-computer.md §"The user's touch — supervised
  // agency"; primitive at packages/runtime/src/computer-use.ts
  // (`ComputerSessionManager.halt()`, v1.2).
  private readonly gestureDetector: PlaneGestureDetector;
  private readonly gestureDetach: () => void;
  private haltGestureHandler: (() => void) | null = null;
  private holdProgress = 0;
  private halted = false;

  constructor(
    creatureGroup: THREE.Group,
    container: HTMLElement,
    opts?: { detachHandler?: DetachArtifactHandler },
  ) {
    this.core = new SlabCore({ detachHandler: opts?.detachHandler ?? null });

    // Group hosts the plane + its items, mounted as a child of the
    // creature so it inherits the creature's world transform.
    this.group = new THREE.Group();
    this.group.name = "slab";
    this.group.position.set(SLAB_OFFSET_X, SLAB_OFFSET_Y, SLAB_OFFSET_Z);
    this.group.rotation.set(SLAB_TILT_X, SLAB_TILT_Y, 0);
    creatureGroup.add(this.group);

    // Plane geometry — meniscus-curved outline, dense interior grid
    // (see createMeniscusPlaneGeometry).
    const planeGeo = createMeniscusPlaneGeometry(SLAB_WIDTH, SLAB_HEIGHT, 16, 16);
    const posAttr = planeGeo.attributes.position;
    if (posAttr != null) {
      const restPositions = posAttr.array.slice();
      (planeGeo.userData as { restPositions?: ArrayLike<number> }).restPositions = restPositions;
    }
    const sharedMaterialConfig = {
      // Same material family as the creature — same IOR, same
      // clearcoat chemistry. The slab is body-adjacent.
      //
      // Tuning history: when the slab gained closed volume (slices E
      // + F), the original transmission 0.55 + roughness 0.12 + sheen
      // 0.35 read as opaque white plastic — the creature's glass
      // register didn't carry over. Pushed transmission, dropped
      // roughness + sheen, tightened attenuationDistance so the soul
      // tint shows through the 4cm volume rather than barely tinting
      // it (4cm / 0.6m old distance = 6.7% attenuation; 4cm / 0.3m
      // new = 13.3% — twice as much color shows). Creature reference:
      // transmission 0.94, roughness 0.0, attenuationDistance =
      // BODY_R * 0.7 ≈ 0.063m. The slab stays slightly less
      // transparent than the creature so it reads as "slate of the
      // same family" rather than "second creature."
      ior: CANONICAL_MATERIAL.ior,
      // Tuning history: roughness 0.12 → 0.05 (slate-of-creature-
      // family) → 0.02 (content-bearing optical glass). The slab
      // reads readable content through itself; surface scatter at
      // 0.05 frosted the page slightly. Creature is roughness 0.0;
      // 0.02 is a faint material reference, not enough to frost
      // transmitted text.
      roughness: 0.02,
      // Tuning history: 0.04 (matched SLAB_THICKNESS literally) →
      // 0.02 (matches actual screen-to-front-pane distance).
      // Three.js's transmission shader uses `thickness` to compute
      // the refraction UV offset — `thickness * (1 / ior) *
      // viewDir`. With the screen mesh centered (z=0), the actual
      // glass-distance from the screen to the front pane is 2cm,
      // not 4cm. The shader was computing 4cm of refraction for
      // 2cm of physical glass; the page rendered with overshoot
      // refraction and read as blurry. 0.02 matches the actual
      // path length so the refraction lands where the screen is.
      thickness: 0.02,
      // Tuning history: 0.4 was sized when the slab differentiated
      // from the creature via clearcoat sheen rather than content.
      // Post-2026-05-09 the slab is content-bearing; clearcoat at
      // 0.4 stacked a glossy top-layer wash on top of transmission
      // and read as a milky veil over readable content. 0.25
      // preserves the slate's surface highlight register for the
      // edges and the soul-tint emissive bloom without veiling
      // through-pane content.
      clearcoat: 0.25,
      clearcoatRoughness: 0.05,
      color: new THREE.Color(0.98, 0.985, 1.0),
      attenuationColor: new THREE.Color(0.92, 0.95, 1.0),
      // Tuning history: 0.15m gave 4cm/15cm = 27% Beer-Lambert
      // absorption — page-pixels-through-the-glass read as foggy
      // lavender once the soul tint drove attenuationColor each
      // frame. 0.4m drops absorption to 4cm/40cm = 10%, so the page
      // reads cleanly while still picking up the soul tint and the
      // glass-volume depth feel. Calibrated to the post-2026-05-09
      // single-pane-transmission shape where the screen mesh is
      // visible through the front pane and the soul tint shouldn't
      // wash it out. Creature is `BODY_R * 0.7` ≈ 0.063m for a
      // 0.27m-diameter sphere; the slab's analog ratio at 4cm
      // thickness would be ~0.063m, but the slab is content-bearing
      // (page pixels must read), so the attenuation is gentler than
      // pure ratio would predict.
      attenuationDistance: 0.4,
      // Tuning history: 0.35 → 0.15 → 0.04. Sheen is the canonical
      // "satin/fabric veil" surface-reflection layer; the slab's
      // earlier tunings used it to differentiate from the creature
      // ("slate of the same family, not a second sphere"). With the
      // slab content-bearing, the sheen layer stacked on top of the
      // page's transmitted pixels and read as a milky/satin veil —
      // exactly the foggy-content register Daniel surfaced
      // 2026-05-09. 0.04 keeps a faint hint at grazing angles
      // (slate identity preserved at silhouette edges) without
      // veiling content read straight-on through the front pane.
      // Geometry + soul tint + emissive carry the slab's identity
      // now; sheen is no longer load-bearing for differentiation.
      sheen: 0.04,
      sheenRoughness: 0.9,
      sheenColor: new THREE.Color(0.75, 0.85, 1.0),
      emissive: new THREE.Color(0, 0, 0),
      emissiveIntensity: 0,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    };
    this.planeMaterial = new THREE.MeshPhysicalMaterial({
      ...sharedMaterialConfig,
      // Tuning history: 0.55 (initial slate-shape) → 0.85 (closed-
      // volume rebalance) → 0.92 (content-bearing optical glass,
      // 2026-05-09). Higher transmission means less of the
      // material's own diffuse contribution stacks on top of the
      // refracted screen content; 0.92 brings the slab close to the
      // creature's 0.94 (pure optical-glass register) while leaving
      // 8% diffuse for the surface to still read as a glass tile
      // rather than empty space.
      transmission: 0.92,
      // Front-pane refraction override — calm-software readability
      // tuning, 2026-05-12. The screencast mesh sits at depth ½
      // inside the slab volume (harmony, balance — see
      // intent-gated-slab.md + the suspended-
      // in-glass register from liquescentia-as-substrate.md). Light
      // refracts through the front pane to reach the texture; even
      // gentle IOR 1.22 + thickness 0.02 (the canonical body
      // register) produced sub-pixel sample offsets that softened
      // text below readability — witnessed 2026-05-12 (Google search
      // results, LinkedIn snippet text both soft on the slab).
      //
      // Override ior 1.22 → 1.10 (water = 1.33; below 1.05 reads as
      // plastic; 1.10 is the calm middle that still bends light from
      // the side view, just less aggressively). Override thickness
      // 0.02 → 0.01 — half the refraction sampling depth. Combined
      // ~60% reduction in shader-induced softening at the content
      // rect specifically.
      //
      // Doctrine: liquescentia-as-substrate.md's "shared medium" stays
      // intact at the creature (which has no internal content, where
      // dramatic refraction is the visual feature). This override is
      // the content-bearing exception — readability wins over
      // optical-purity at the slab's content rect. Geometry
      // unchanged: mesh still at depth ½, side-view "airy room front,
      // content middle, airy room back" register preserved.
      //
      // Side view stays liquescent: IOR 1.10 still bends environment
      // light around the meniscus, just at a softer angle. Apple-grade
      // calm: the liquescent shell reads as liquescent (glass-like
      // optics); the content inside reads as content; neither overrides
      // the other.
      ior: 1.1,
      thickness: 0.01,
    });
    // Non-transmissive companion for the back pane + side wall. See
    // the field declaration above for the architectural why; in short,
    // three.js's transmission is single-surface-plus-opaque-backdrop
    // by design, and stacking three transmissive meshes around an
    // inner opaque screen mesh prevented the front pane from
    // refracting the screen reliably. The silhouette material reads
    // glassy in shading (same ior + clearcoat + sheen + attenuation)
    // but doesn't pretend to transmit — making the front pane the
    // sole transmissive surface, which is the pattern three.js's
    // physical-glass shader was built for. Independent THREE.Color
    // instances so per-frame setRGB writes (soul tint, emissive)
    // don't alias across the two materials.
    this.silhouetteMaterial = new THREE.MeshPhysicalMaterial({
      ...sharedMaterialConfig,
      transmission: 0,
      attenuationColor: new THREE.Color(0.92, 0.95, 1.0),
      color: new THREE.Color(0.98, 0.985, 1.0),
      emissive: new THREE.Color(0, 0, 0),
      sheenColor: new THREE.Color(0.75, 0.85, 1.0),
    });
    // Front + back panes form the slab volume. Front holds the
    // pinch-displacement geometry (its restPositions live in
    // userData); back is a clone of the same geometry so its position
    // buffer is independent — pinch displacement writes to front
    // vertex positions only, and the clone keeps the back rigid.
    // Both panes share planeMaterial so opacity / soul-color easing
    // applies uniformly with one assignment. Both attach directly
    // to `group` so existing consumers that walk `group.children`
    // for the slab mesh still resolve (front is added first; the
    // first Mesh in children is the front pane).
    this.planeMesh = new THREE.Mesh(planeGeo, this.planeMaterial);
    this.planeMesh.position.z = SLAB_THICKNESS / 2;
    this.planeMesh.visible = false; // skip GL work when truly recessed
    this.group.add(this.planeMesh);

    const backPaneGeo = planeGeo.clone();
    // Back pane STAYS transmissive — the user observes the slab from
    // off-axis (orbiting the creature, viewing from behind through
    // the body) and that view should still read as glass: page
    // pixels visible through the back, env light passing through.
    // The original triple-transmissive failure was specifically about
    // THREE transmissive surfaces stacking; two transmissive (front +
    // back) with the screen mesh between them is the canonical
    // glass-bottle pattern three.js handles cleanly. The sideWall is
    // the only demoted surface (silhouette), since side-on views are
    // rare and the wall is what was tipping the stack into the
    // pathological triple.
    this.backPaneMesh = new THREE.Mesh(backPaneGeo, this.planeMaterial);
    this.backPaneMesh.position.z = -SLAB_THICKNESS / 2;
    // Back pane faces "outward" relative to the volume — flip it so
    // its normals point away from the camera, letting the sheen and
    // clearcoat read on the side a viewer never directly sees but
    // whose silhouette is what gives the slab its depth from any
    // angle off-axis.
    this.backPaneMesh.rotation.y = Math.PI;
    this.backPaneMesh.visible = false;
    this.group.add(this.backPaneMesh);

    // Side wall — closes the volume. Without this the dual-pane
    // construction reads as two parallel membranes with hollow space
    // (visible from off-axis angles); the wall makes the silhouette
    // continuous so the slab reads as one solid glass tile, the way
    // the creature reads as one droplet rather than a sphere with
    // open seams.
    const sideWallGeo = createSideWallGeometry(
      SLAB_WIDTH,
      SLAB_HEIGHT,
      SLAB_THICKNESS,
      SLAB_CORNER_RADIUS,
    );
    // Silhouette companion — non-transmissive. The wall closes the
    // volume visually; see `silhouetteMaterial` field for the
    // single-transmissive-surface rationale.
    this.sideWallMesh = new THREE.Mesh(sideWallGeo, this.silhouetteMaterial);
    this.sideWallMesh.visible = false;
    this.group.add(this.sideWallMesh);

    // Screen mesh — meniscus plane occupying the slab's BODY region
    // only. Page content lives below the chrome region; the chrome
    // strip (CSS3D, in `stageEl`) occupies the top of the slab. The
    // mesh's top edge is FLAT (where chrome ends); its bottom
    // corners are rounded to match the slab's silhouette curvature.
    // Chrome region above the mesh shows the empty liquescent body
    // (front + back panes only), giving the chrome a clean translucent
    // backdrop and ensuring page pixels never render behind chrome.
    //
    // **Suspended in fluid (z=0).** The earlier "press against the
    // back pane" placement read as "poster behind glass" — a Model
    // A display register fighting the slab's Model B liquescentia
    // substrate. liquescentia-as-substrate.md says pixels embed in
    // the liquescent volume, and the creature's analog (eyes suspended
    // in the droplet body, not pressed against the back of the
    // skull) argues for centered. Symmetric optical register too:
    // 2cm of liquescent body from front + 2cm from back means similar
    // Beer-Lambert absorption from any orbit angle, the slab
    // reading as one uniform liquescent-volume-with-content rather than
    // a wall-mounted display.
    //
    // **Body region (y-offset).** Shifted down from slab center by
    // `BODY_REGION_CENTER_Y` so the mesh's top edge aligns with the
    // chrome strip's bottom edge. The body-meniscus geometry has
    // flat top + rounded bottom corners; the slab's full silhouette
    // is the union of (chrome region: stage's rounded top corners
    // via `borderRadius` on `stageEl`) + (body region: this mesh's
    // rounded bottom corners). Closes the click-stealing bug — page
    // content cannot render in the chrome region anymore.
    //
    // **DoubleSide.** The back face shows the same texture mirrored
    // (text reads backward from behind the slab) — calm-software
    // acceptance: that's how every real-world glass-from-behind
    // looks. v1 ships this. A "right-way-round from back" register
    // (separate texture / shader UV-flip on the back face) is a
    // future polish if a use-case emerges.
    //
    // `MeshBasicMaterial` (unlit) keeps the screen pixels at face
    // value — environment lighting shouldn't tint a display
    // surface. Initial state hidden + no map; populated by
    // `setScreencastImage(...)` when a live screencast is active.
    // Mesh dimensions = body region shrunk uniformly by CONTENT_INSET
    // on all four sides. Width and height each lose 2×inset. The
    // inset creates the "meniscus breathes" margin: a visible glass
    // ring around the screencast where the slab's silhouette curve
    // is legible without content abutting it. Top inset doubles as
    // the visual gap between chrome strip and screen mesh.
    const screenGeo = createBodyMeniscusGeometry(SCREEN_MESH_WIDTH, SCREEN_MESH_HEIGHT, 16, 16);
    this.screenMaterial = new THREE.MeshBasicMaterial({
      // The screencast JPEG is opaque — no alpha channel. Marking the
      // material `transparent: true` was a v1 mistake: Three.js's
      // transmission render path samples a "scene minus transmissive
      // objects" texture, and transparent screen content competed for
      // depth with the back pane (the slab's plane material itself
      // has `transparent: true` for opacity-easing). Opaque material
      // lands in the opaque pre-pass, gets rendered into the
      // transmission target cleanly, and the front pane's
      // `transmission` samples it via the standard refraction shader.
      // Result: screen pixels show through the front pane at face value.
      //
      // (Confirmed again 2026-05-11: tried `transparent: true` +
      // opacity 0.96 + depthWrite:false to add "liquescent volume"
      // character — Three.js excluded the screen mesh from the
      // transmission backbuffer and content disappeared behind the
      // front pane. The constraint is structural, not a tuning
      // problem. Glass-volume feel for the body must come from the
      // FRONT PANE's material, not from the screen mesh's alpha.)
      //
      // Display pixels at face value — tone-mapping (ACES, etc.) on
      // a screencast washes out colors. Same register Three.js
      // recommends for video surfaces (`VideoTexture` examples).
      toneMapped: false,
      // Visible from front AND back — the slab is a fluid glass
      // volume observed from any orbit angle (user circling the
      // creature). Back-face texture mirroring is the natural
      // glass-physics register; documented above.
      side: THREE.DoubleSide,
    });
    this.screenMesh = new THREE.Mesh(screenGeo, this.screenMaterial);
    this.screenMesh.position.set(0, SCREEN_MESH_CENTER_Y, 0);
    this.screenMesh.visible = false;
    this.screenMesh.name = "slab-screen";
    this.group.add(this.screenMesh);

    // Items container — one CSS3DObject rooted near the back pane.
    // `CSS3DObject`'s constructor force-sets `pointer-events: auto` and
    // `position: absolute` on the wrapped element; the stage's
    // pointer-events: none (so empty stage passes camera-control
    // gestures through) is re-applied AFTER the wrap.
    this.stageEl = createContainerElement();
    this.stageAnchor = new CSS3DObject(this.stageEl);
    this.stageEl.style.pointerEvents = "none";
    // The interface is forward-facing (attention-is-directional); the
    // render-loop facing fade (see `render`) hides it as the camera orbits
    // past the front hemisphere, so the back never shows the UI mirrored
    // through the transmissive pane. One mechanism, not CSS backface culling.

    // Stage at z=0, same plane as the WebGL screen mesh. Chrome and
    // content compose as ONE window plane suspended in the volume.
    // See the stage-position comment block above for the rationale.
    this.stageAnchor.position.set(0, 0, 0);
    // Pixel→world scale so the 480×300 CSS-pixel stage maps to the
    // plane's 0.54×0.334m extent edge-to-edge. Without this, CSS3D
    // would render 480 world units across — the stage would be a
    // building, not a panel.
    this.stageAnchor.scale.set(STAGE_PIXEL_TO_WORLD, STAGE_PIXEL_TO_WORLD, 1);
    this.group.add(this.stageAnchor);

    // Identity face — a second stage on the BACK, rotated π about Y so it faces
    // outward (-Z): its content then reads UPRIGHT + non-mirrored from behind
    // (a front-facing stage viewed from behind is exactly what mirrored). Same
    // pixel→world scale; empty until the surface sets a back plate. Crossfaded
    // to 0 from the front by the render-loop facing dot, so it never competes
    // with the interface.
    this.backStageEl = createContainerElement();
    this.backStageAnchor = new CSS3DObject(this.backStageEl);
    this.backStageEl.style.pointerEvents = "none";
    this.backStageEl.style.opacity = "0";
    this.backStageAnchor.position.set(0, 0, -SLAB_THICKNESS / 2);
    this.backStageAnchor.rotation.y = Math.PI;
    this.backStageAnchor.scale.set(STAGE_PIXEL_TO_WORLD, STAGE_PIXEL_TO_WORLD, 1);
    this.group.add(this.backStageAnchor);

    this.css3dRenderer = new CSS3DRenderer();
    this.css3dRenderer.setSize(container.clientWidth, container.clientHeight);
    this.css3dRenderer.domElement.style.position = "absolute";
    this.css3dRenderer.domElement.style.top = "0";
    this.css3dRenderer.domElement.style.left = "0";
    this.css3dRenderer.domElement.style.zIndex = "2";
    // The renderer's container holds CSS3D-transformed children whose
    // pointer-events are managed per-item; the container itself never
    // captures input.
    this.css3dRenderer.domElement.style.pointerEvents = "none";
    container.appendChild(this.css3dRenderer.domElement);

    // Plane gesture detector — two-finger hold for ~700ms fires
    // `halt()` on whatever handler the app has wired. The attach
    // helper listens on the renderer container (the parent of the
    // canvas + CSS3D layers); it filters to `pointerType === "touch"`
    // so trackpad and mouse interactions never spuriously arm.
    // `addEventListener` is missing on test fakes that aren't a real
    // EventTarget — the optional chain keeps SlabManager construction
    // safe in headless tests where the container is a `{}` shim.
    this.gestureDetector = createPlaneGestureDetector({
      onHaltTriggered: () => {
        // Mirror halt state into the manager so the visual sustains
        // until the app explicitly calls `setHalted(false)` after
        // resume. The handler call is what propagates into the
        // session-manager primitive.
        this.halted = true;
        this.holdProgress = 0;
        this.haltGestureHandler?.();
      },
      onProgress: (fraction) => {
        this.holdProgress = fraction;
      },
      onCancel: () => {
        this.holdProgress = 0;
      },
    });
    this.gestureDetach =
      typeof (container as { addEventListener?: unknown }).addEventListener === "function"
        ? attachPlaneGestureToTarget(container, this.gestureDetector, () => {
            // Bounding rect is the slab's HTML container in screen
            // space — gates pointer events that bubbled from outside
            // (e.g. the chat list scrolled past).
            if (
              typeof (container as { getBoundingClientRect?: unknown }).getBoundingClientRect !==
              "function"
            )
              return null;
            return container.getBoundingClientRect();
          })
        : () => {};
  }

  /** Expose the THREE group so the adapter can position/animate externally. */
  getGroup(): THREE.Group {
    return this.group;
  }

  /**
   * Couple the slab's tint to the creature's soul color. The slab
   * is an organ of the motebit; this binding makes that physical.
   * `attenuationColor` carries the tint *always* (body coherence —
   * same body, same soul), and `emissive` brightens with activity
   * but never goes pitch-black. Doctrine: motebit-computer.md
   * §"Visual properties."
   */
  setInteriorColor(color: InteriorColor): void {
    this.soulTint = [color.tint[0], color.tint[1], color.tint[2]];
    this.soulGlow = [color.glow[0], color.glow[1], color.glow[2]];
  }

  /**
   * Wire the halt-gesture handler. Called once by the app after the
   * `ComputerSessionManager` is constructed; the handler is invoked
   * exactly once per arm-and-complete cycle. The slab also
   * self-marks `halted = true` when the handler fires so the
   * sustained visual outlasts the gesture; the app must call
   * `setHalted(false)` after the session manager resumes for the
   * gesture to re-arm.
   */
  setHaltGestureHandler(handler: (() => void) | null): void {
    this.haltGestureHandler = handler;
  }

  /**
   * Mirror the session manager's halted state onto the slab visual.
   * Resets the gesture detector when transitioning halted → live so
   * the next two-finger-hold can fire again.
   */
  setHalted(halted: boolean): void {
    if (this.halted === halted) return;
    this.halted = halted;
    if (!halted) {
      // Resume — clear gesture state so the detector can fire again.
      this.gestureDetector.reset();
      this.holdProgress = 0;
    }
  }

  isHalted(): boolean {
    return this.halted;
  }

  /**
   * Upload a decoded screencast frame as the slab's screen-mesh
   * texture. The mesh becomes visible on first frame; subsequent
   * frames replace the texture image in place (`needsUpdate = true`)
   * so per-frame allocation is bounded.
   *
   * Accepts the two texture-uploadable surface types from
   * `live-browser.ts`'s tiered decode pipeline:
   *
   *   ImageBitmap      — tier-1 (WebCodecs `ImageDecoder` →
   *                      `createImageBitmap(VideoFrame)` bridge) and
   *                      tier-2 (`createImageBitmap(blob)`) both
   *                      converge here. Universal across modern
   *                      browsers, lifecycle-independent of any
   *                      decoder, safe to upload via `texImage2D`.
   *   HTMLImageElement — tier-3 (`<img>.decode()`) for jsdom +
   *                      ancient browsers without `createImageBitmap`.
   *
   * VideoFrame is NOT in this type by design: Chrome's WebGL
   * `texImage2D(VideoFrame)` races with `ImageDecoder.close()`'s
   * shared backing buffers and renders as a black texture. The
   * canonical zero-copy `VideoFrame → GPU` path is WebGPU's
   * `importExternalTexture`; when the renderer promotes
   * (`liquescentia-as-substrate.md` §"Renderer promotion"), this
   * type widens to include `VideoFrame` and the upload path branches
   * by renderer kind. Until then, the bridge inside `live-browser.ts`
   * tier-1 keeps the type honest.
   *
   * Replaces the CSS3DObject-mounted `<img>` rendering register: the
   * screencast now lives in the WebGL scene graph, depth-tested with
   * the creature and silhouette-clipped by the meniscus geometry.
   * Closes the "doesn't follow the slab shape" + "punches through the
   * creature on rotation" seam Daniel surfaced 2026-05-09. Doctrine:
   * motebit-computer.md §"v1.3 live screencast", `liquescentia-as-
   * substrate.md` §"Cohesive permeability" (the slab is glass; pixels
   * embed in it, they don't sit in a parallel layer in front of it).
   */
  setScreencastImage(source: HTMLImageElement | ImageBitmap): void {
    if (this.screenTexture == null) {
      this.screenTexture = new THREE.Texture();
      // Hero-surface sampling — the visionOS-window pattern. Three
      // configs make the slab read as sharp at every angle and
      // distance the user could view it from:
      //
      //   colorSpace: SRGBColorSpace — JPEG source is sRGB-encoded;
      //     tagging the texture lets Three.js's tone-mapped pipeline
      //     decode → linear-light → display correctly. Without this,
      //     the content is gamma-shifted darker than the source.
      //
      //   minFilter: LinearMipmapLinearFilter (trilinear) +
      //     generateMipmaps: true — when the texture is minified
      //     (slab tilted away, slab small in frame), trilinear
      //     samples between two mip levels and avoids the sparkle
      //     + broken antialiasing that nearest-mip and no-mipmap
      //     paths produce. Cost: ~2 ms/frame on desktop GPUs to
      //     regenerate the mip chain on each texture update, free
      //     once we move to VideoTexture/GPUExternalTexture (the
      //     end-game pin in motebit-computer.md).
      //
      //   anisotropy: 16 — when the slab is angled, each screen
      //     pixel covers a horizontally-elongated texel footprint;
      //     isotropic sampling averages a circle when it should
      //     average an ellipse → smear on the axis perpendicular
      //     to the tilt. Apple ships max anisotropy on every Metal-
      //     rendered window in visionOS for this reason. Three.js
      //     clamps to `renderer.capabilities.getMaxAnisotropy()`
      //     at upload — 16 is the desktop/visionOS canonical max.
      this.screenTexture.colorSpace = THREE.SRGBColorSpace;
      this.screenTexture.minFilter = THREE.LinearMipmapLinearFilter;
      this.screenTexture.magFilter = THREE.LinearFilter;
      this.screenTexture.generateMipmaps = true;
      this.screenTexture.anisotropy = 16;
      this.screenMaterial.map = this.screenTexture;
      this.screenMaterial.needsUpdate = true;
    }
    // Release the previous frame's GPU resources. `ImageBitmap`
    // holds GPU memory that doesn't GC and exposes `.close()`; the
    // duck-type check is the right shape. `HTMLImageElement` is
    // JS-heap and self-cleaning — no close method, no-ops through
    // the typeof check.
    const prev = this.screenTexture.image as
      (ImageBitmap & { close?: () => void }) | HTMLImageElement | null;
    if (prev != null && "close" in prev && typeof prev.close === "function") {
      prev.close();
    }
    // flipY discipline by source type — the canonical Three.js perf
    // pattern AND the WebGL2-spec-safe one:
    //
    //   HTMLImageElement (tier 3): flipY = true. The image is in
    //     CSS top-down pixel order; WebGL's UNPACK_FLIP_Y_WEBGL
    //     flips it during texImage2D so the texture ends up
    //     bottom-up in GL native order.
    //
    //   ImageBitmap (tiers 1+2): flipY = false. The bitmap was
    //     already pre-flipped at decode time via
    //     `createImageBitmap(..., { imageOrientation: "flipY" })`,
    //     so the texture data is bottom-up already. Setting flipY
    //     would trigger a SECOND flip via UNPACK_FLIP_Y_WEBGL on
    //     WebGL2 implementations that honor it for ImageBitmap,
    //     and the screencast renders upside-down (caught 2026-05-11
    //     on apple.com).
    //
    // Three.js docs claim flipY is ignored for ImageBitmap, but the
    // Three.js source still issues `pixelStorei(UNPACK_FLIP_Y_WEBGL,
    // ...)` before every upload — actual behavior is browser-WebGL2-
    // implementation-defined. Setting flipY explicitly per source
    // type is the only way to guarantee correctness across browsers.
    //
    // Duck-type rather than `instanceof HTMLImageElement` — this code
    // runs in node-environment unit tests where DOM globals don't
    // exist, and `instanceof HTMLImageElement` throws. ImageBitmap +
    // VideoFrame expose `.close()`; HTMLImageElement does not. The
    // check is the same one the GPU-resource-release branch above
    // already uses, just inverted.
    const sourceIsBitmapLike =
      "close" in source && typeof (source as { close?: unknown }).close === "function";
    this.screenTexture.flipY = !sourceIsBitmapLike;
    this.screenTexture.image = source;
    this.screenTexture.needsUpdate = true;
    // Visibility is derived per-frame in the render loop from
    // (user-visible AND screenTexture !== null) — single source of
    // truth, no eager flag here. See the screenMesh.visible binding
    // in the per-frame block.
  }

  /**
   * Tear down the screencast texture and hide the screen mesh. Called
   * when the cloud-browser session closes or the live_browser slab
   * item dissolves. Idempotent — clears state cleanly even if
   * `setScreencastImage` was never called.
   */
  clearScreencast(): void {
    // No eager `screenMesh.visible = false` — the per-frame render
    // loop derives visibility from (user-visible AND screenTexture
    // !== null). Nulling the texture below resolves to false on the
    // next render tick (~16 ms at 60 fps), which is imperceptible
    // and keeps the single-source-of-truth discipline.
    if (this.screenTexture != null) {
      const bitmap = this.screenTexture.image as
        (ImageBitmap & { close?: () => void }) | HTMLImageElement | null;
      if (bitmap != null && "close" in bitmap && typeof bitmap.close === "function") {
        bitmap.close();
      }
      this.screenTexture.dispose();
      this.screenTexture = null;
    }
    this.screenMaterial.map = null;
    this.screenMaterial.needsUpdate = true;
  }

  /**
   * Set the body register — the tri-state truth for what occupies the
   * body region. Forwards to `core.setBodyRegister`; the per-frame
   * derivation reads it next tick and applies screen-mesh visibility:
   *
   *   - `home`       — mesh hidden; pair with `clearScreencast()` to
   *                    release the texture (home is the cold-start /
   *                    post-dismiss state).
   *   - `live`       — mesh visible against installed texture.
   *   - `transition` — mesh hidden; texture preserved so resume on
   *                    blur/commit/Esc is cold-start-free.
   *
   * Doctrine: `motebit-computer.md` §"Body register — the tri-state."
   */
  setBodyRegister(register: SlabBodyRegister): void {
    this.core.setBodyRegister(register);
  }

  /**
   * Hold the empty slab visible. Items always make the plane visible
   * regardless; this flag governs only the empty-state behavior.
   */
  setUserVisible(visible: boolean): void {
    this.core.setUserVisible(visible);
  }

  toggleUserVisible(): boolean {
    return this.core.toggleUserVisible();
  }

  isUserVisible(): boolean {
    return this.core.isUserVisible();
  }

  /**
   * Forward the drag-hover signal to the core. Apps wire this from
   * their drop handlers (`dragenter` / `dragleave` / `drop`) so the
   * slab membrane lifts to the drop-target register during an active
   * drag. Doctrine: motebit-computer.md §"The user's touch."
   */
  setDragHover(hovering: boolean): void {
    this.core.setDragHover(hovering);
  }

  // ── Public API — mirrors the RenderAdapter slab methods ───────────

  addItem(spec: SlabItemSpec): SlabItemHandle {
    // Single-stage model (motebit-computer.md §"Embodiment modes"):
    // the plane renders ONE primary embodiment at a time. Mind-mode
    // items (slabHidden) are tracked by the core for lifecycle
    // contracts but never mounted on the visible stage.
    spec.element.style.pointerEvents = "auto";
    spec.element.style.transform = "scale(0)";
    spec.element.style.transformOrigin = "center center";
    spec.element.style.opacity = "0";

    // `.dataset` may be absent in headless tests — read defensively.
    const slabHidden =
      (spec.element as { dataset?: Record<string, string> }).dataset?.slabHidden === "true";
    if (!slabHidden) {
      // Mount the new element alongside any existing items. Removing
      // prior items happens on their own dissolve completion (phase
      // → gone in `update`), so the previous element's exit physics
      // continues against its own element.
      if (typeof this.stageEl.appendChild === "function") {
        this.stageEl.appendChild(spec.element);
      }
    }

    this.elements.set(spec.id, { element: spec.element, restingApplied: false });
    return this.core.addItem({ id: spec.id, kind: spec.kind, slabHidden });
  }

  dissolveItem(id: string): Promise<void> {
    return this.core.dissolveItem(id);
  }

  detachItemAsArtifact(id: string, artifact: ArtifactSpec): Promise<ArtifactHandle | undefined> {
    return this.core.detachItemAsArtifact(id, artifact);
  }

  clearItems(): void {
    for (const { element } of this.elements.values()) {
      if (element.parentNode === this.stageEl) {
        this.stageEl.removeChild(element);
      }
    }
    this.elements.clear();
    this.core.clearItems();
  }

  /**
   * Per-frame update. Drives the core forward, applies per-item DOM
   * animations from the core's snapshot, displaces the plane vertices
   * for active pinches, eases plane visibility + soul-color coupling.
   *
   * `t` is total animation time (seconds), matching the creature's
   * render frame. `deltaTime` is the frame delta (seconds).
   */
  update(t: number, deltaTime: number): void {
    // Drive the gesture detector from the same animation tick the
    // creature uses — no parallel rAF loop. The detector and the
    // attach helper share the same clock (`performance.now()`); we
    // can't use `t` here because that's render time (often starts at
    // zero), while pointer events are stamped in wall-clock ms.
    // `performance` is missing in some headless test shims — fall
    // back to Date.now() so SlabManager still drives.
    const nowMs =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    this.gestureDetector.tick(nowMs);

    const frame = this.core.tick(deltaTime);

    // Per-item DOM animation. Items that just transitioned to `gone`
    // arrive once with phase=gone — clean up the parallel element
    // record; the dissolve/pinch animation already brought opacity
    // to ~0, so removal is silent.
    for (const item of frame.items) {
      const managed = this.elements.get(item.id);
      if (!managed) continue;
      this.animateElement(managed, item);
      if (item.phase === "gone") {
        if (managed.element.parentNode === this.stageEl) {
          this.stageEl.removeChild(managed.element);
        }
        this.elements.delete(item.id);
      }
    }

    // Plane vertex displacement from active pinches. Rebuilt every
    // frame from rest positions so vertices return to flat cleanly
    // when no pinch is active; multiple parallel pinches sum.
    this.applyPinchDisplacement(frame.items);

    // Sympathetic breathing — same time base as the creature so phases
    // lock without inter-object signaling.
    const breatheRaw = Math.sin(t * SLAB_BREATHE_FREQUENCY_HZ * Math.PI * 2);
    const breathe =
      (breatheRaw > 0 ? breatheRaw : Math.sign(breatheRaw) * Math.pow(Math.abs(breatheRaw), 0.6)) *
      SLAB_BREATHE_AMPLITUDE_FACTOR *
      0.012;

    // Soul coupling — two axes:
    //
    //   1. `attenuationColor` ← `soulTint`, always. Body coherence:
    //      the slab carries the motebit's soul whether it's working
    //      or idle, the same way the creature's iris does. Earlier
    //      implementation lerped this with `activeWarmth` so an
    //      empty slab went neutral cool — that read as "the organ
    //      switched identity," breaking the one-body register.
    //
    //   2. `emissiveIntensity` ← f(`activeWarmth`). Activity is
    //      visible as light; the slab brightens when the motebit is
    //      working and sits at a faint baseline when idle (alive,
    //      not extinguished). The peak is intentionally gentle so
    //      the slab never outshines the creature.
    const w = frame.activeWarmth;
    // Both materials are driven in lockstep: soul tint flows through
    // attenuationColor on the front pane (refracted through the
    // transmission) AND on the silhouette companion (so back+side
    // pick up the same identity tint in their non-transmissive
    // shading). Emissive is the same — body-coherence reads as one
    // glass tile, not two materials with different identity signals.
    this.planeMaterial.attenuationColor.setRGB(
      this.soulTint[0],
      this.soulTint[1],
      this.soulTint[2],
    );
    this.silhouetteMaterial.attenuationColor.setRGB(
      this.soulTint[0],
      this.soulTint[1],
      this.soulTint[2],
    );
    this.planeMaterial.emissive.setRGB(this.soulGlow[0], this.soulGlow[1], this.soulGlow[2]);
    this.silhouetteMaterial.emissive.setRGB(this.soulGlow[0], this.soulGlow[1], this.soulGlow[2]);
    // Idle baseline 0.020 + activity ramp up to 0.20 at full warmth.
    // 10× range between idle and peak — the slab whispers identity at
    // rest and announces work when active, calm-software meaningful
    // signal rather than always-loud soul glow. Both modulated by
    // breath so the glow inherits the creature's sympathetic rhythm
    // rather than reading as flat back-light.
    const baseline = 0.02;
    const peak = 0.2;
    let emissiveIntensity = (baseline + (peak - baseline) * w) * (0.85 + 0.15 * breatheRaw);
    // Hold-progress nudge — during a two-finger hold, the slab brightens
    // proportionally so the user can feel the gesture register before
    // the halt fires. Pure additive on top of the activity-driven
    // baseline so a working slab still reads as working while the
    // gesture progresses; the brightness is bounded so it can't flash
    // past the soul-coupling peak.
    if (this.holdProgress > 0) {
      emissiveIntensity += 0.15 * this.holdProgress;
    }
    // Halted-sustain — once `halt()` has fired and the app has mirrored
    // halted state via `setHalted(true)`, the slab holds a quiet
    // sustained glow at ~0.5× peak. Calmer than the work-active glow
    // so "halted" reads as paused rather than active. Doctrine:
    // motebit-computer.md §"Visual properties — slab acquires a
    // distinct paused register."
    if (this.halted) {
      emissiveIntensity = Math.max(emissiveIntensity, peak * 0.5);
    }
    this.planeMaterial.emissiveIntensity = emissiveIntensity;
    this.silhouetteMaterial.emissiveIntensity = emissiveIntensity;

    this.planeMaterial.opacity = frame.planeVisibility;
    // Silhouette companion (back pane + side wall) reads at 55% of the
    // front pane's opacity. From off-axis views — looking at the slab
    // edge-on or from below — the prior 1:1 silhouette opacity made
    // the slab read as "panel with solid bottom" rather than "glass
    // volume." Lowering the silhouette pair to 0.55× preserves the
    // front pane's content register (page text crisp through the
    // transmissive front glass) while letting the side wall + back
    // pane read as glass character — what's behind the slab shows
    // through faintly from steep angles.
    //
    // Same pattern Apple visionOS uses for window edges: the title-bar-
    // facing pane is fully present; the edges and back of the window
    // are visibly more translucent so the window reads as "glass
    // volume" rather than "panel with edges." Material tuning, not
    // overlay geometry — the simplest move that lands the brand
    // signature (slab as a liquescent volume) at off-axis views.
    this.silhouetteMaterial.opacity = frame.planeVisibility * 0.55;
    const visible = frame.planeVisibility > 0.01;
    this.planeMesh.visible = visible;
    this.backPaneMesh.visible = visible;
    this.sideWallMesh.visible = visible;
    // Bind the screencast screen mesh's visibility to (a) the slab
    // being user-visible, (b) a texture installed, and (c) the body
    // register being `live`. The register lifts the prior implicit
    // coupling between {screenTexture present, screencastSuppressed
    // flag} into one named state — `home` clears the texture and
    // hides the mesh, `live` shows the mesh against the installed
    // texture, `transition` preserves the texture but hides the mesh
    // so the home overlay reads as the primary body content (Apple
    // Safari URL-bar focus pattern). Without this, the WebGL screen
    // mesh would keep rendering its texture in 3D space even after
    // `/computer` toggles the slab off — the liquescent volume + chrome
    // fade out, but the JPEG texture floats on, content outliving
    // its substrate (intent-gated-slab.md violation, third instance
    // of the slab/stitch desync after chrome band and stage opacity —
    // caught 2026-05-11 on /computer toggle). Per-frame derivation
    // here is the single source of truth; `setScreencastImage` no
    // longer flips `screenMesh.visible` directly — it just installs
    // the texture and lets this loop decide visibility.
    this.screenMesh.visible =
      visible && this.screenTexture !== null && frame.bodyRegister === "live";
    // Sympathetic breathing applies to all three meshes (front, back,
    // sides) uniformly — the slab inflates as one volume. Per-mesh
    // (rather than via a wrapper group) so the CSS3D stage — also a
    // child of `group` — stays at its native scale; if the stage
    // breathed, text glyphs would jitter along the breathe axis at
    // 0.3Hz, fighting readability for visual rhythm.
    const breatheScale = 1 + breathe;
    this.planeMesh.scale.set(breatheScale, breatheScale, 1);
    this.backPaneMesh.scale.set(breatheScale, breatheScale, 1);
    this.sideWallMesh.scale.set(breatheScale, breatheScale, 1);
    // Hide the CSS3D-mounted stage (chrome strip, breathing
    // placeholder, live-browser body) in lockstep with the WebGL
    // plane meshes. CSS3DRenderer.render() OVERWRITES the wrapped
    // element's `display` property on every frame based on the
    // CSS3DObject's `.visible` flag — setting `stageEl.style.display`
    // directly is silently reverted to `""` on the next render. We
    // must flip `stageAnchor.visible` instead so the renderer's
    // built-in display toggle does the work. Without this, /computer
    // toggle hides the WebGL liquescent volume but leaves the chrome
    // strip + breathing dot floating in 3D space without their
    // substrate (the bug Daniel hit 2026-05-09 on /computer toggle).
    this.stageAnchor.visible = visible;
    // Sympathetic chrome fade — bind CSS3D stage opacity to plane
    // visibility so chrome (URL bar, breathing dot, live-browser
    // shell) fades alongside the WebGL liquescent volume rather than
    // hanging at full opacity through the plane's ease-out and then
    // snapping off at the visibility threshold. The snap-off was
    // visible as ~750ms of orphaned chrome after the plane had
    // visibly left (second instance of the slab/chrome desync, after
    // the `stageAnchor.visible` fix above). CSS3DRenderer writes
    // `transform` and `display` per frame but not `opacity`, so the
    // assignment sticks. Mapping: chrome at full opacity once the
    // plane reaches MEMBRANE_OPACITY (the empty-register floor) — at
    // or above that, the chrome reads as content on the membrane; below
    // it, chrome fades proportionally with the membrane leaving.
    this._stageBaseOpacity = Math.min(1, frame.planeVisibility / MEMBRANE_OPACITY);
    this.stageEl.style.opacity = String(this._stageBaseOpacity);
  }

  /** Called after WebGL render each frame — syncs CSS overlay. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    // An empty CSS3D layer is not free: its perspective + matrix3d camera
    // container is a preserve-3d compositing plane that follows the
    // camera, and at oblique camera poses that plane intersects the WebGL
    // canvas layer — Chromium's plane-intersection sorting then paints a
    // stair-stepped, color-unmanaged patch at the frame edge (the "blue
    // blob"; creature-canon.md artifact-zero, caught by the golden-frame
    // harness). The layer may exist only while the slab has something to
    // show; recessed slab ⇒ no 3D compositing context at all.
    const active = this.stageAnchor.visible;
    this.css3dRenderer.domElement.style.display = active ? "" : "none";
    if (!active) return;

    // Fade the DOM interface by how squarely the slab faces the camera. The
    // computer's interface is forward-facing (attention-is-directional); as the
    // camera orbits past the front hemisphere it fades to the liquescent body,
    // never showing the UI mirrored through the transmissive back pane. The
    // WebGL glass meshes stay — the body reads as itself from every angle; only
    // the interface turns away. (This facing fade is the deterministic path;
    // CSS3D backface-visibility is unreliable across the chrome strip + items.)
    this.group.getWorldPosition(this._slabWorldPos);
    this.group.getWorldQuaternion(this._slabWorldQuat);
    this._slabForward.set(0, 0, 1).applyQuaternion(this._slabWorldQuat);
    camera.getWorldPosition(this._camWorldPos);
    this._viewDir.copy(this._camWorldPos).sub(this._slabWorldPos).normalize();
    // dot: 1 head-on, 0 edge-on, <0 behind. Interface is full across the front
    // hemisphere and fades out in the last sliver before edge-on; the identity
    // face is the INVERSE — gone from the front, blooming in as the camera
    // crosses to the back. One dot drives both halves of the crossfade. At the
    // pure side profile both are ~0: clean edge-on glass between the two faces.
    const dot = this._slabForward.dot(this._viewDir);
    const facing = THREE.MathUtils.smoothstep(dot, 0, 0.2);
    this.stageEl.style.opacity = String(this._stageBaseOpacity * facing);
    const backFacing = THREE.MathUtils.smoothstep(-dot, 0, 0.2);
    this.backStageEl.style.opacity = String(
      this._hasBackPlate ? this._stageBaseOpacity * backFacing : 0,
    );

    this.css3dRenderer.render(scene, camera);
  }

  /**
   * Mount (or clear) the identity face on the slab's back — the web-rendered
   * mark (sigil + short id). The surface owns the pixels (`sigilToSvg`,
   * params-not-pixels); this only mounts them on the back stage, where the
   * render-loop facing crossfade blooms them in as the viewer orbits behind.
   * Pass `null` to clear.
   */
  setBackPlate(element: HTMLElement | null): void {
    if (typeof this.backStageEl.replaceChildren === "function") {
      if (element) this.backStageEl.replaceChildren(element);
      else this.backStageEl.replaceChildren();
    }
    this._hasBackPlate = element != null;
  }

  resize(width: number, height: number): void {
    this.css3dRenderer.setSize(width, height);
  }

  dispose(): void {
    this.gestureDetach();
    this.haltGestureHandler = null;
    this.clearItems();
    this.css3dRenderer.domElement.remove();
    this.planeMesh.geometry.dispose();
    this.backPaneMesh.geometry.dispose();
    this.sideWallMesh.geometry.dispose();
    this.planeMaterial.dispose();
    this.silhouetteMaterial.dispose();
  }

  // ── Internal: per-item DOM animation ──────────────────────────────

  private animateElement(managed: ManagedElement, item: SlabCoreItemSnapshot): void {
    const el = managed.element;
    switch (item.phase) {
      case "emerging": {
        const tt = item.phaseTime / SLAB_EMERGE_DURATION_S;
        const progress = easeOutQuad(Math.min(1, tt));
        el.style.transform = `scale(${progress})`;
        el.style.opacity = String(progress);
        break;
      }
      case "active":
        // Steady state — ensure the final emerging frame's transform
        // is locked to scale 1 (covers the case where the emerging →
        // active transition fires inside the core mid-frame).
        el.style.transform = "scale(1)";
        el.style.opacity = "1";
        break;
      case "resting":
        // Working-material state. Class hook for surface styling +
        // subtle desaturation reading as "held, not active" without
        // hiding content. Doctrine: motebit-computer.md §"Settling
        // into rest."
        if (!managed.restingApplied) {
          managed.restingApplied = true;
          el.classList.add("slab-item-resting");
          el.classList.remove("slab-item-active");
          el.style.filter = "saturate(0.92)";
        }
        break;
      case "dissolving": {
        const tt = item.phaseTime / SLAB_DISSOLVE_DURATION_S;
        const progress = 1 - easeInQuad(Math.min(1, tt));
        el.style.transform = `scale(${progress})`;
        el.style.opacity = String(progress);
        break;
      }
      case "pinching": {
        // Rayleigh-Plateau-inspired three-phase pinch — same physics
        // story as the prior implementation, now reading phase +
        // phaseTime from the core snapshot.
        const tt = Math.min(1, item.phaseTime / SLAB_PINCH_DURATION_S);
        if (tt < SLAB_PINCH_PHASE2_START) {
          // Tension — bead building
          const local = tt / SLAB_PINCH_PHASE2_START;
          const scale = 1 + easeInOutQuad(local) * 0.15;
          el.style.transform = `scale(${scale.toFixed(3)})`;
          el.style.opacity = "1";
        } else if (tt < SLAB_PINCH_PHASE2_END) {
          // Separation — squash-stretch + launch
          const local =
            (tt - SLAB_PINCH_PHASE2_START) / (SLAB_PINCH_PHASE2_END - SLAB_PINCH_PHASE2_START);
          const scaleY = 1.15 + local * 0.15;
          const scaleX = 1.15 - local * 0.25;
          const liftPx = easeInOutQuad(local) * 14;
          el.style.transform = `translateY(${(-liftPx).toFixed(1)}px) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`;
          el.style.opacity = (1 - local * 0.25).toFixed(3);
        } else {
          // Dissipation — bead gone, slab-mounted copy fades
          const local = (tt - SLAB_PINCH_PHASE2_END) / (1 - SLAB_PINCH_PHASE2_END);
          const scale = 1.15 - local * 0.3;
          const liftPx = 14 + local * 10;
          el.style.transform = `translateY(${(-liftPx).toFixed(1)}px) scale(${scale.toFixed(3)})`;
          el.style.opacity = (0.75 * (1 - easeInQuad(local))).toFixed(3);
        }
        break;
      }
      case "detached":
        // Brief tail — element stays where the dissipation phase left
        // it. Cleanup happens at `gone`.
        break;
      case "gone":
        // No DOM mutation here — caller in `update()` removes the
        // element from the stage and drops the parallel record.
        break;
    }
  }

  // ── Internal: plane vertex displacement ───────────────────────────

  /**
   * Rayleigh-Plateau-inspired plane surface displacement during
   * pinching. For each pinching item, raises a Gaussian bump in the
   * plane's vertex Z around the item's anchor point. Amplitude curve
   * matches the element's three-phase trajectory: tension grows,
   * separation peaks, dissipation collapses back to flat.
   */
  private applyPinchDisplacement(items: readonly SlabCoreItemSnapshot[]): void {
    const geometry = this.planeMesh.geometry as THREE.PlaneGeometry;
    const positionAttr = geometry.attributes.position;
    if (positionAttr == null) return;
    const rest = (geometry.userData as { restPositions?: ArrayLike<number> }).restPositions;
    if (rest == null) return;

    const positions = positionAttr.array as Float32Array;

    const pinches: Array<{ x: number; y: number; amplitude: number }> = [];
    for (const item of items) {
      if (item.phase !== "pinching") continue;
      const managed = this.elements.get(item.id);
      if (!managed) continue;
      const tt = Math.min(1, item.phaseTime / SLAB_PINCH_DURATION_S);
      let amp: number;
      if (tt < SLAB_PINCH_PHASE2_START) {
        amp = easeInOutQuad(tt / SLAB_PINCH_PHASE2_START) * 0.008;
      } else if (tt < SLAB_PINCH_PHASE2_END) {
        const local =
          (tt - SLAB_PINCH_PHASE2_START) / (SLAB_PINCH_PHASE2_END - SLAB_PINCH_PHASE2_START);
        amp = 0.008 + easeInOutQuad(local) * 0.006;
      } else {
        const local = (tt - SLAB_PINCH_PHASE2_END) / (1 - SLAB_PINCH_PHASE2_END);
        amp = 0.014 * (1 - easeInQuad(local));
      }
      const [px, py] = this.pinchCenterForElement(managed.element);
      pinches.push({ x: px, y: py, amplitude: amp });
    }

    if (pinches.length === 0) {
      if (positions[2] !== rest[2]) {
        positions.set(rest);
        positionAttr.needsUpdate = true;
      }
      return;
    }

    // Gaussian bump: z(p) = Σᵢ ampᵢ · exp(-|p - centerᵢ|² / 2σ²)
    // σ ~ half an item-slot width keeps a single dimple locally
    // contained.
    const SIGMA = 0.06;
    const TWO_SIGMA_SQ = 2 * SIGMA * SIGMA;
    for (let i = 0; i < positions.length; i += 3) {
      const x = rest[i]!;
      const y = rest[i + 1]!;
      let z = rest[i + 2]!;
      for (const p of pinches) {
        const dx = x - p.x;
        const dy = y - p.y;
        const r2 = dx * dx + dy * dy;
        z += p.amplitude * Math.exp(-r2 / TWO_SIGMA_SQ);
      }
      positions[i + 2] = z;
    }
    positionAttr.needsUpdate = true;
  }

  /**
   * Approximate an item element's center in plane-local coordinates,
   * used only by the pinch displacement to place the Gaussian dimple
   * under the item that's graduating.
   *
   * Returns (0, 0) if rects aren't available (headless / not yet
   * attached). The pinch is subtle at that amplitude; a fallback
   * center-of-plane dimple is fine in those cases.
   */
  private pinchCenterForElement(el: HTMLElement): [number, number] {
    if (typeof el.getBoundingClientRect !== "function") return [0, 0];
    const containerEl = this.stageEl;
    if (typeof containerEl.getBoundingClientRect !== "function") return [0, 0];
    const elRect = el.getBoundingClientRect();
    const contRect = containerEl.getBoundingClientRect();
    if (contRect.width === 0 || contRect.height === 0) return [0, 0];
    const cx = elRect.left + elRect.width / 2 - (contRect.left + contRect.width / 2);
    const cy = elRect.top + elRect.height / 2 - (contRect.top + contRect.height / 2);
    const pxPerMeter = contRect.width / SLAB_WIDTH;
    const planeX = cx / pxPerMeter;
    const planeY = -cy / pxPerMeter;
    return [planeX, planeY];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a meniscus-shaped plane: a rectangular grid of vertices with
 * the outer ring snapped onto a rounded-rectangle boundary. Produces
 * the same vertex count + face topology as `THREE.PlaneGeometry` of
 * the same segmentation, so pinch physics, sympathetic breathing,
 * and rest-position deformation all index into the dense interior
 * grid unchanged — only the silhouette softens.
 *
 * Doctrine: motebit-computer.md §"Visual properties (binding)" —
 * `Edges: meniscus (rounded surface-tension curve), no frame, no
 * border, no corner radius. Droplet family.` The creature is a beaded
 * sphere under surface tension; the slab reads as the same material
 * family flattened.
 *
 * Why geometry and not an `alphaMap`: MeshPhysicalMaterial's
 * `transmission` render pass ignores alphaMap (known Three.js
 * behavior through at least r170), so a masked plane reads as a
 * hard rectangle despite the alpha. Rounding the mesh itself fixes
 * the silhouette and sidesteps the conflict in one move.
 */
function createMeniscusPlaneGeometry(
  width: number,
  height: number,
  segX: number,
  segY: number,
): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(width, height, segX, segY);
  const pos = geo.attributes.position;
  if (pos == null) return geo;

  // Corner radius — sourced from the module-level SLAB_CORNER_RADIUS
  // constant so the front pane, back pane, and side wall all trace
  // the same rounded-rectangle outline. Pre-derivation: 28% of the
  // shorter side reads as a droplet rather than "a rectangle with
  // softened corners," while leaving a flat interior large enough
  // to host items.
  const r = SLAB_CORNER_RADIUS;
  const halfW = width / 2;
  const halfH = height / 2;
  const cx = halfW - r;
  const cy = halfH - r;

  const arr = pos.array as Float32Array;
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i]!;
    const y = arr[i + 1]!;
    const absX = Math.abs(x);
    const absY = Math.abs(y);
    if (absX <= cx || absY <= cy) continue;
    const ax = Math.sign(x) * cx;
    const ay = Math.sign(y) * cy;
    const dx = x - ax;
    const dy = y - ay;
    const d = Math.hypot(dx, dy);
    if (d === 0) continue;
    if (d > r) {
      const scale = r / d;
      arr[i] = ax + dx * scale;
      arr[i + 1] = ay + dy * scale;
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Body-region variant of the meniscus plane — flat top edge,
 * rounded BOTTOM corners only. Used by the screen mesh so the
 * screencast occupies the slab's body region (below chrome) while
 * its bottom-corner curvature still matches the slab's silhouette.
 *
 * Top corners are intentionally squared because the body region's
 * top edge sits internally inside the slab volume (where chrome
 * ends); above it is the chrome region rendered via CSS3D, and
 * the slab's actual rounded TOP corners are part of the front/back
 * pane silhouette, not part of the screen mesh. Squaring the top
 * corners keeps the screencast's full width visible right up to
 * the chrome's bottom edge.
 *
 * Bottom corner radius matches `SLAB_CORNER_RADIUS` so the screen
 * mesh's bottom edge traces the same curve as the slab's front
 * and back panes — no visible offset between mesh silhouette and
 * slab silhouette at the bottom.
 */
function createBodyMeniscusGeometry(
  width: number,
  height: number,
  segX: number,
  segY: number,
): THREE.PlaneGeometry {
  // Plain rectangular geometry. The mesh is inscribed inside the
  // slab's rounded silhouette at the diagonal-touch threshold (see
  // INSCRIBED_INSET_WORLD); the slab's rounded character is supplied
  // by the silhouette around this mesh, not by rounding this mesh's
  // own corners. iOS / visionOS inscribed-rectangle pattern: when
  // the container's corner radius is large enough to clip rectangular
  // content, render content in the safe area and let the curve be
  // visible glass framing the content (the iPhone notch / Dynamic
  // Island pattern applied to a slab silhouette).
  //
  // The function keeps its name + signature so the call site doesn't
  // change. Returning a plain PlaneGeometry with no vertex munging is
  // the correct geometry for the inscribed-rectangle approach.
  return new THREE.PlaneGeometry(width, height, segX, segY);
}

/**
 * Build the slab's side-wall geometry — a triangle strip wrapping
 * the perimeter of the rounded-rectangle outline, connecting the
 * front pane (at z = +thickness/2) to the back pane (at z =
 * -thickness/2).
 *
 * Without this, the dual-pane construction reads as two parallel
 * membranes with hollow space (visible from off-axis angles); the
 * wall closes the silhouette so the slab reads as one solid glass
 * tile from any viewpoint — same way the creature reads as one
 * droplet rather than a sphere with open seams.
 *
 * The perimeter samples the same rounded-rect outline that the
 * front + back panes' meniscus snap converges on. Per-side sample
 * count is generous enough (32) that the wall looks smooth as a
 * curve, not faceted; doubled at the corner arcs because that's
 * where curvature is steepest. Outward-facing normals computed per
 * edge so MeshPhysicalMaterial's sheen + clearcoat read on the
 * silhouette correctly.
 */
function createSideWallGeometry(
  width: number,
  height: number,
  thickness: number,
  cornerRadius: number,
): THREE.BufferGeometry {
  const r = cornerRadius;
  const halfW = width / 2;
  const halfH = height / 2;
  const cx = halfW - r;
  const cy = halfH - r;
  const SAMPLES_STRAIGHT = 1; // straight edges don't need subdivision
  const SAMPLES_CORNER = 32; // smooth arc

  const perimeter: { x: number; y: number }[] = [];

  // Bottom edge: (-cx, -halfH) → (cx, -halfH)
  for (let i = 0; i <= SAMPLES_STRAIGHT; i++) {
    const t = i / SAMPLES_STRAIGHT;
    perimeter.push({ x: -cx + t * 2 * cx, y: -halfH });
  }
  // Bottom-right arc: angle -π/2 → 0 around (cx, -cy)
  for (let i = 1; i <= SAMPLES_CORNER; i++) {
    const a = -Math.PI / 2 + (i / SAMPLES_CORNER) * (Math.PI / 2);
    perimeter.push({ x: cx + r * Math.cos(a), y: -cy + r * Math.sin(a) });
  }
  // Right edge: (halfW, -cy) → (halfW, cy)
  for (let i = 1; i <= SAMPLES_STRAIGHT; i++) {
    const t = i / SAMPLES_STRAIGHT;
    perimeter.push({ x: halfW, y: -cy + t * 2 * cy });
  }
  // Top-right arc: angle 0 → π/2 around (cx, cy)
  for (let i = 1; i <= SAMPLES_CORNER; i++) {
    const a = (i / SAMPLES_CORNER) * (Math.PI / 2);
    perimeter.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  // Top edge: (cx, halfH) → (-cx, halfH)
  for (let i = 1; i <= SAMPLES_STRAIGHT; i++) {
    const t = i / SAMPLES_STRAIGHT;
    perimeter.push({ x: cx - t * 2 * cx, y: halfH });
  }
  // Top-left arc: angle π/2 → π around (-cx, cy)
  for (let i = 1; i <= SAMPLES_CORNER; i++) {
    const a = Math.PI / 2 + (i / SAMPLES_CORNER) * (Math.PI / 2);
    perimeter.push({ x: -cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  // Left edge: (-halfW, cy) → (-halfW, -cy)
  for (let i = 1; i <= SAMPLES_STRAIGHT; i++) {
    const t = i / SAMPLES_STRAIGHT;
    perimeter.push({ x: -halfW, y: cy - t * 2 * cy });
  }
  // Bottom-left arc: angle π → 3π/2 around (-cx, -cy). Stop one
  // sample short so we don't duplicate the perimeter[0] start point.
  for (let i = 1; i < SAMPLES_CORNER; i++) {
    const a = Math.PI + (i / SAMPLES_CORNER) * (Math.PI / 2);
    perimeter.push({ x: -cx + r * Math.cos(a), y: -cy + r * Math.sin(a) });
  }

  const N = perimeter.length;
  const halfT = thickness / 2;
  const positions = new Float32Array(N * 6 * 3); // 6 vertices per quad (2 triangles)
  const normals = new Float32Array(N * 6 * 3);
  let p = 0;
  let n = 0;

  for (let i = 0; i < N; i++) {
    const a = perimeter[i]!;
    const b = perimeter[(i + 1) % N]!;

    // Outward normal in the XY plane: rotate edge tangent (b-a) by -90°.
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey) || 1;
    const nx = ey / len;
    const ny = -ex / len;

    // Triangle 1: front_a → back_a → front_b (CCW from outside).
    positions[p++] = a.x;
    positions[p++] = a.y;
    positions[p++] = halfT;
    positions[p++] = a.x;
    positions[p++] = a.y;
    positions[p++] = -halfT;
    positions[p++] = b.x;
    positions[p++] = b.y;
    positions[p++] = halfT;
    // Triangle 2: front_b → back_a → back_b.
    positions[p++] = b.x;
    positions[p++] = b.y;
    positions[p++] = halfT;
    positions[p++] = a.x;
    positions[p++] = a.y;
    positions[p++] = -halfT;
    positions[p++] = b.x;
    positions[p++] = b.y;
    positions[p++] = -halfT;

    for (let v = 0; v < 6; v++) {
      normals[n++] = nx;
      normals[n++] = ny;
      normals[n++] = 0;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  return geo;
}

/**
 * Build the items-container element. In a browser this is a real
 * `<div>`; in headless tests there is no `document`, so return a
 * minimal stand-in with `style`, `className`, `appendChild`,
 * `removeChild`, `replaceChildren`, and a zero-rect
 * `getBoundingClientRect` — enough to satisfy `pinchCenterForElement`
 * without crashing.
 */
function createContainerElement(): HTMLDivElement {
  if (typeof document === "undefined") {
    const children: HTMLElement[] = [];
    const stub = {
      className: "slab-stage",
      style: new Proxy(
        {},
        {
          get: () => "",
          set: () => true,
        },
      ) as unknown as CSSStyleDeclaration,
      appendChild: (child: HTMLElement) => {
        children.push(child);
        (child as unknown as { parentNode: unknown }).parentNode = stub;
        return child;
      },
      removeChild: (child: HTMLElement) => {
        const i = children.indexOf(child);
        if (i >= 0) children.splice(i, 1);
        (child as unknown as { parentNode: unknown }).parentNode = null;
        return child;
      },
      replaceChildren: (...newChildren: HTMLElement[]) => {
        for (const c of children) {
          (c as unknown as { parentNode: unknown }).parentNode = null;
        }
        children.length = 0;
        for (const c of newChildren) {
          children.push(c);
          (c as unknown as { parentNode: unknown }).parentNode = stub;
        }
      },
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
      }),
    };
    return stub as unknown as HTMLDivElement;
  }
  const el = document.createElement("div");
  el.className = "slab-stage";
  // Single-stage — one primary embodiment fills the plane. Sized to
  // fit within the 0.54 × 0.34m plane's on-screen projection at the
  // default camera (~670×410 CSS px on a 900px canvas); kept slightly
  // smaller so content has visible breathing room.
  el.style.width = "480px";
  el.style.height = "300px";
  el.style.boxSizing = "border-box";
  el.style.display = "block";
  el.style.overflow = "hidden";
  // Establish a containing block for absolutely-positioned children
  // (the ghost-ready affordance, future overlays). Without this,
  // children with `position: absolute` escape stageEl and anchor to
  // the next positioned ancestor in the CSS3D-renderer's wrapper —
  // typically body, which makes the affordance float anywhere on
  // screen instead of inside the slab's stage rect.
  el.style.position = "relative";
  // Match the slab plane's φ-meniscus corner radius. Pixel value
  // derived from the world-unit constant: the stage scales to world
  // by STAGE_PIXEL_TO_WORLD, so the inverse maps SLAB_CORNER_RADIUS
  // back to CSS pixels (~83px for the current 480×300 stage). With
  // overflow: hidden already set above, content (chrome strips, page
  // iframes, terminal output) clips to the slab's curve instead of
  // jutting past it as a hard rectangle. Doctrine: motebit-computer.md
  // §"Visual properties — Edges: meniscus, no frame, no border, no
  // corner radius. Droplet family." The stage and the plane trace
  // the same outline.
  el.style.borderRadius = `${SLAB_CORNER_RADIUS / STAGE_PIXEL_TO_WORLD}px`;
  // `pointer-events: none` on the stage so its dead space — when the
  // plane is visible but empty, or in transparent margins around a
  // mounted item — passes pointer events through to the canvas's
  // OrbitControls underneath. Mounted items receive `pointer-events:
  // auto` in addItem, so their bounding boxes still capture events;
  // only unoccupied stage area becomes click-through. Without this,
  // any pointer in the slab's region was stolen from the creature's
  // rotate/zoom controls — the bug fixed by commit 89467720.
  el.style.pointerEvents = "none";
  return el;
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function easeInQuad(t: number): number {
  return t * t;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
