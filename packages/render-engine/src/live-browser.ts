/**
 * `buildLiveBrowserElement` — the DOM form of a `live_browser` slab
 * item (v1.3). Renders a continuous JPEG screencast from the cloud-
 * browser dispatcher onto an `<img>` element whose `src` updates per
 * frame.
 *
 * Why `<img>` and not `<canvas>`. The browser already has a JPEG
 * decode pipeline behind `<img>` — assigning a `data:` URL to `src`
 * defers decode + paint to the rendering thread, no JS-side canvas
 * pixel manipulation. Canvas would buy us composite control we don't
 * need at v1.3 (no overlays, no scaling math, no per-pixel access).
 * If a future slice needs cursor overlays or click ripples on the
 * frame, swap to canvas as a contained renderer change — the
 * `pushFrame` contract stays.
 *
 * Memory shape. Each frame creates one base64 string and reuses the
 * same `<img>` element. The previous decode is GC'd as the new src
 * lands. Sub-2MB JPEGs at ~15fps are well within mainstream browser
 * decode budgets; the slab's existing register doesn't require more.
 *
 * Lifecycle. The element subscribes to the supplied `ScreencastFrameSource`
 * on construction and unsubscribes on `dispose()`. Dispose is called
 * by the slab manager when the item dissolves (apps wire
 * `dispose()` to the slab item's end-of-life).
 *
 * Doctrine binding. Mode contract: `virtual_browser`. The default
 * `defaultEmbodimentMode` mapping for `live_browser` returns
 * `virtual_browser` so a caller that doesn't pass `mode` explicitly
 * lands at the right mode boundary.
 */

import type { ScreencastFrame, ScreencastFrameSource } from "@motebit/sdk";
import { INSCRIBED_INSET_PX, BODY_TOP_INSET_PX } from "./slab.js";

export interface LiveBrowserElementHandle {
  /** Mountable HTMLElement — the slab manager appends this to the plane. */
  readonly element: HTMLElement;
  /**
   * The actual `<img>` rendering the JPEG frames. Surfaces (apps/web)
   * use this for Slice 2c input capture: attaching `click` /
   * `keydown` / `paste` listeners against the visible frame so the
   * capture surface coincides with the visible frame surface — what
   * the user clicks IS what gets forwarded to Chromium.
   *
   * Returning the inner element rather than just the root keeps
   * coordinate math honest: `getBoundingClientRect()` on this img
   * IS the rendered screencast rect; no object-fit / letterbox
   * compensation needed because the img itself adopts the
   * screencast's aspect ratio (set in `pushFrame`).
   */
  readonly frameElement: HTMLImageElement;
  /**
   * Slice 2d — mount slot for an address-bar element placed above
   * the screencast img. Empty by default; surfaces fill it via
   * `addressBarSlot.replaceChildren(...)` when state.kind === "user"
   * and clear it otherwise. The render engine knows nothing about
   * navigation; the slot is just a generic mounting point for
   * surface-built browser chrome.
   *
   * The address bar is part of the "browser-inside-the-slab," not
   * chrome of the slab itself. Same way Chrome's address bar is
   * part of Chrome's window, not separate from it. Visually +
   * semantically belongs with the live_browser item, and rides
   * inside `stageEl` so the slab's lifecycle (visibility, fade)
   * carries the chrome with it.
   */
  readonly addressBarSlot: HTMLElement;
  /**
   * Slice 2f — mount slot for the co-browse control band (the
   * Grant/Deny doorbell, "Motebit is driving / Take back",
   * "Paused / Resume"). Sits above the address bar — it's the
   * highest-priority chrome on the live_browser item because it
   * carries consent decisions.
   *
   * Why on the live_browser item rather than at the slab outer
   * container (the original Slice 2b position): the band's natural
   * home is on the browser surface, not on the page. The previous
   * slot positioned the band at the top of the entire 3D scene
   * wrapper, where it eclipsed the chat-chrome icons and got
   * clipped at the viewport edge — confirmed UI bug from the smoke
   * test. Mounting here keeps the band attached to the surface it
   * controls.
   *
   * Render engine remains co-browse-agnostic — the slot is generic
   * chrome plumbing; surfaces fill it via
   * `controlBandSlot.replaceChildren(...)`.
   */
  readonly controlBandSlot: HTMLElement;
  /**
   * Slab home view mount slot — the slab body's READY-state content
   * surface. Sibling pattern of `addressBarSlot` / `controlBandSlot`:
   * empty by default, surfaces fill it via `bodySlot.replaceChildren
   * (...)` when the empty register is active.
   *
   * Mounted inside the body wrapper alongside the screencast img.
   * Visibility is mutually exclusive with the screencast — when a
   * real URL is being browsed, the screencast occupies the body
   * (via the WebGL screen mesh) and this slot is hidden; when no
   * session has navigated to a meaningful URL (cold-start, post-
   * dismiss, post-`about:blank`), the slot is visible and the
   * surface populates it with forward affordances or a breathing
   * mark fallback. Toggle via `setHomeState("hidden" | "register" |
   * "overlay")`.
   *
   * Doctrine: `motebit-computer.md` §"What appears on the slab"
   * names the slab as the surface showing what the motebit is, has
   * been, or could be attending to. The home view's forward-framed
   * affordances are the "could be" register — informed by past
   * activity (signed receipts), framed as the next act.
   * `records-vs-acts.md` distinguishes records (panels) from acts
   * (slab): home tiles are act-framed launchpads, not record
   * listings.
   */
  readonly bodySlot: HTMLElement;
  /**
   * Tri-state for the body-slot home view, replacing the earlier
   * boolean `setHomeVisible`:
   *
   *   - `"hidden"`: bodySlot is `display: none`. Screencast occupies
   *     the body alone (real-URL session register).
   *   - `"register"`: bodySlot is `display: flex` with no backdrop.
   *     Home view IS the body's primary content (cold-start / no
   *     session / post-dismiss). Screen mesh is hidden via the
   *     per-frame visibility binding (no texture installed).
   *   - `"overlay"`: bodySlot is `display: flex` WITH backdrop-blur +
   *     low-alpha background. Home view sits ON TOP of the
   *     screencast which keeps streaming behind, faintly visible.
   *     The user is mid-decision — URL bar focused, picking the
   *     next destination — and the session waits behind the
   *     overlay rather than being torn down.
   *
   * Pairs with the surface's URL-state + focus-state observation:
   * URL state drives session/home, focus state drives overlay on
   * top of session. Both transitions are calm — backdrop-blur fades
   * via the slot's CSS transition; no scene-graph mutation needed.
   */
  setHomeState(state: "hidden" | "register" | "overlay"): void;
  /**
   * Stop the subscription and clear the rendered frame. Idempotent —
   * a second call is a no-op. The element itself is left in the DOM
   * for the slab's dissolve animation to take it the rest of the way.
   */
  dispose(): void;
}

/**
 * Texture-uploadable frame surfaces handed off to the slab. The decode
 * pipeline picks the sharpest tier available (see `decodeFrameForTexture`):
 *
 *   ImageBitmap      — produced by either WebCodecs `ImageDecoder` →
 *                      `createImageBitmap(VideoFrame)` bridge (tier 1)
 *                      OR `createImageBitmap(blob)` direct (tier 2).
 *                      Both routes converge on the same texture-uploadable
 *                      type. Universal across modern browsers.
 *   HTMLImageElement — `<img>.decode()` output. Last-resort path for
 *                      jsdom and ancient browsers.
 *
 * Three.js Texture accepts both directly via `Texture.image`. The
 * architectural seam: every tier produces an `ImageBitmap` (or
 * equivalent texture-uploadable surface), so the upload path is
 * tier-agnostic. When WebGPU + `importExternalTexture` lands, tier-1
 * graduates from "decode → bridge → ImageBitmap → texImage2D" to
 * "decode → VideoFrame → importExternalTexture" — single tier swap,
 * no consumer change.
 *
 * Why ImageBitmap as the bridge target rather than VideoFrame:
 * Chrome's WebGL `texImage2D(VideoFrame)` upload path has a decoder-
 * lifecycle race — `ImageDecoder.close()` shares backing buffers with
 * the produced `VideoFrame` in some Chrome versions, invalidating the
 * frame before the next render tick can upload it. `createImageBitmap
 * (videoFrame)` takes a GPU-side snapshot into an independently-
 * lifecycled `ImageBitmap`, sidestepping the race. The canonical zero-
 * copy path is `importExternalTexture` (WebGPU); WebGL doesn't have a
 * race-free equivalent, so the bridge IS the WebGL-tier answer.
 */
export type DecodedScreencastFrame = HTMLImageElement | ImageBitmap;

/**
 * Optional consumer hooks. The most-load-bearing today is
 * `onFrameDecoded`: each pre-decoded frame is delivered upstream so
 * the surface can route it to the slab's WebGL screen-mesh texture
 * (`renderer.setSlabScreencastImage`) — the screencast lives in the
 * scene graph, depth-tested with the creature, silhouette-clipped by
 * the meniscus. The HTML `<img>` stays mounted with `opacity: 0` so
 * cobrowse-input-capture's existing pointer + keyboard pipeline keeps
 * working unchanged; it's the input surface, the texture is the visual.
 *
 * Decoupled by design: live-browser doesn't import `@motebit/render-
 * engine`'s adapter. The surface chooses what to do with each decoded
 * frame (slab texture, an artifact preview, telemetry); we just hand
 * it the best-tier decoded surface (`VideoFrame`, `ImageBitmap`, or
 * `HTMLImageElement` — see `DecodedScreencastFrame`).
 */
export interface BuildLiveBrowserDeps {
  readonly onFrameDecoded?: (image: DecodedScreencastFrame, frame: ScreencastFrame) => void;
}

/**
 * WebCodecs `ImageDecoder` global — minimum structural type so the
 * code typechecks in environments where lib.dom doesn't yet expose
 * it (older @types/web). Detected at runtime; not used unless present.
 */
type ImageDecoderCtor = new (init: { type: string; data: BufferSource }) => {
  decode(): Promise<{ image: VideoFrame }>;
  close(): void;
};
type ImageDecoderStatic = ImageDecoderCtor & {
  isTypeSupported(type: string): Promise<boolean>;
};

/**
 * Decode one JPEG frame onto a texture-uploadable surface, picking
 * the sharpest tier available.
 *
 * Tier 1 — WebCodecs `ImageDecoder` + `createImageBitmap` bridge.
 * Hardware-accelerated JPEG decode (CoreVideo on Apple, libjpeg-turbo
 * via Chromium codec layer on others), off-main-thread. Decodes to
 * `VideoFrame`, then `createImageBitmap(videoFrame)` takes a GPU-side
 * snapshot into a lifecycle-independent `ImageBitmap`. The bridge is
 * mandatory on WebGL — Chrome's `texImage2D(VideoFrame)` upload races
 * with `ImageDecoder.close()` (shared backing buffers), invalidating
 * the frame before the next render tick can upload it. The canonical
 * zero-copy path is WebGPU's `importExternalTexture`; until the
 * renderer promotes, the bridge IS the right answer. When WebGPU
 * lands, this tier graduates from "decode → bridge → ImageBitmap →
 * texImage2D" to "decode → VideoFrame → importExternalTexture" — a
 * single tier-internal change, the slab's upload path doesn't move.
 *
 * Tier 2 — `createImageBitmap(blob)` direct. The browser's native
 * image decoder, runs off-main-thread, produces `ImageBitmap`.
 * Universal across modern browsers including Firefox. Same texture-
 * uploadable output type as tier 1 — the slab's upload path doesn't
 * branch on tier. `colorSpaceConversion: "none"` preserves the JPEG's
 * sRGB encoding so the slab's `SRGBColorSpace` texture tag decodes it
 * correctly (the alternative — "default" — would convert to the
 * display color space pre-upload, double-correcting the gamma when
 * Three.js applies sRGB decode).
 *
 * Tier 3 — `HTMLImageElement` + `.decode()`. Last resort for jsdom
 * and ancient browsers without `createImageBitmap`.
 *
 * Any tier failure (codec unsupported, fetch error, decode throw)
 * cascades to the next tier — the call returns the best result the
 * environment can produce.
 */
/**
 * True when any decode primitive is available in the current
 * environment. Synchronous probe — when this returns false, the
 * caller can take a sync fallback path rather than going through a
 * Promise that would just reject. Preserves the original
 * `if (Image.prototype.decode) { ... } else { paint() }` semantics
 * for jsdom and other environments without decode primitives.
 */
function hasAnyDecodePrimitive(): boolean {
  const g = globalThis as unknown as {
    ImageDecoder?: unknown;
    createImageBitmap?: unknown;
  };
  if (typeof g.ImageDecoder === "function") return true;
  if (typeof g.createImageBitmap === "function") return true;
  const proto = Image.prototype as { decode?: () => Promise<void> };
  if (typeof proto.decode === "function") return true;
  return false;
}

async function decodeFrameForTexture(dataUri: string): Promise<DecodedScreencastFrame> {
  const g = globalThis as unknown as {
    ImageDecoder?: ImageDecoderStatic;
    createImageBitmap?: typeof createImageBitmap;
    fetch?: typeof fetch;
  };

  // Tier 1 — WebCodecs ImageDecoder + createImageBitmap bridge.
  // The bridge is mandatory on WebGL — see the doc comment above.
  // Without it, the produced VideoFrame is invalidated by the
  // decoder's close() before Three.js's texImage2D fires, and the
  // slab uploads a black/empty texture (the slab-renders-as-dark-
  // rectangle bug, caught 2026-05-11 on the first live-browser test
  // after the WebCodecs pipeline shipped).
  if (
    typeof g.ImageDecoder === "function" &&
    typeof g.createImageBitmap === "function" &&
    typeof g.fetch === "function"
  ) {
    try {
      const supported =
        typeof g.ImageDecoder.isTypeSupported === "function"
          ? await g.ImageDecoder.isTypeSupported("image/jpeg")
          : true;
      if (supported) {
        const buffer = await g.fetch(dataUri).then((r) => r.arrayBuffer());
        const decoder = new g.ImageDecoder({ type: "image/jpeg", data: buffer });
        let frame: VideoFrame | null = null;
        try {
          const result = await decoder.decode();
          frame = result.image;
          // createImageBitmap takes a GPU-side snapshot of the
          // VideoFrame's pixel data into a lifecycle-independent
          // ImageBitmap. Once this resolves, the source VideoFrame
          // and the decoder are both safe to close; the returned
          // bitmap remains valid for texture upload.
          //
          // `imageOrientation: "flipY"` is mandatory for WebGL
          // upload. Three.js's `texture.flipY = true` (default) is
          // honored for HTMLImageElement uploads but per WebGL spec
          // SILENTLY NO-OPS for ImageBitmap uploads. Without
          // pre-flipping at decode time, the bitmap lands top-left-
          // origin in a bottom-left-origin WebGL coord system →
          // content renders upside-down. Pre-flip here makes the
          // bitmap's native orientation match WebGL's, and the slab's
          // texture.flipY default keeps working for tier-3 HTMLImage.
          return await g.createImageBitmap(frame as unknown as ImageBitmapSource, {
            colorSpaceConversion: "none",
            premultiplyAlpha: "default",
            imageOrientation: "flipY",
          });
        } finally {
          if (frame != null) frame.close();
          decoder.close();
        }
      }
    } catch {
      // Fall through to tier 2 — codec unavailable for this content.
    }
  }

  // Tier 2 — createImageBitmap from Blob (direct, no decoder hop).
  // Same `imageOrientation: "flipY"` requirement as tier 1 — WebGL's
  // `UNPACK_FLIP_Y_WEBGL` is a no-op for ImageBitmap uploads, so the
  // bitmap must be pre-flipped at decode time. Without this, the slab
  // would render upside-down on the Firefox tier-2 path.
  if (typeof g.createImageBitmap === "function" && typeof g.fetch === "function") {
    try {
      const blob = await g.fetch(dataUri).then((r) => r.blob());
      return await g.createImageBitmap(blob, {
        colorSpaceConversion: "none",
        premultiplyAlpha: "default",
        imageOrientation: "flipY",
      });
    } catch {
      // Fall through to tier 3 — environment supports neither WebCodecs nor createImageBitmap fully.
    }
  }

  // Tier 3 — HTMLImage + .decode().
  const img = new Image();
  img.decoding = "async";
  img.src = dataUri;
  await img.decode();
  return img;
}

export function buildLiveBrowserElement(
  source: ScreencastFrameSource,
  deps: BuildLiveBrowserDeps = {},
): LiveBrowserElementHandle {
  const root = document.createElement("div");
  root.className = "slab-live-browser";
  // Fill the slab stage — `stageEl` (slab.ts) is 480×300 by design;
  // root adopts those dimensions so the flex-column layout below has
  // a real height to distribute. The chrome strip takes its natural
  // height at top; the body wrapper takes `flex: 1` and letterboxes
  // the screencast img to fit. Without `height: 100%`, root would
  // collapse to chrome-height and the body wrapper would have
  // nothing to fill. Doctrine single-stage discipline
  // (motebit-computer.md §"Embodiment modes — the plane renders ONE
  // primary embodiment at a time") makes 100%/100% the right shape:
  // the live_browser shell IS the slab's primary embodiment, so it
  // owns the whole stage.
  root.style.width = "100%";
  root.style.height = "100%";
  root.style.display = "flex";
  root.style.flexDirection = "column";

  // Slice 2f — control-band mount slot. Sits ABOVE the address bar
  // because it carries the consent decisions (doorbell,
  // motebit-driving, paused). Empty by default; surfaces fill via
  // controlBandSlot.replaceChildren(...) on coBrowseControl
  // transitions. Same pointer-events: none discipline as the
  // address-bar slot.
  const controlBandSlot = document.createElement("div");
  controlBandSlot.className = "slab-live-browser-control-band-slot";
  controlBandSlot.style.pointerEvents = "none";
  root.appendChild(controlBandSlot);

  // Slice 2d — address-bar mount slot above the screencast img.
  // Empty until the surface fills it (apps/web mounts a navigation
  // input when state.kind === "user", clears it otherwise). Render
  // engine knows nothing about navigation; this is generic chrome
  // plumbing parallel to the screencast img.
  const addressBarSlot = document.createElement("div");
  addressBarSlot.className = "slab-live-browser-address-bar-slot";
  // The slot's own pointer-events: none so empty space passes
  // through to underlying canvas controls; the surface-supplied
  // input element opts back in to pointer-events: auto on its
  // interactive children.
  addressBarSlot.style.pointerEvents = "none";
  root.appendChild(addressBarSlot);

  // The frame surface itself — `<img>` updated in place each frame.
  // `decoding="async"` hints the browser to decode off the main
  // thread when supported; harmless when not.
  const img = document.createElement("img");
  img.className = "slab-live-browser-frame";
  img.alt = "live browser";
  img.decoding = "async";
  // Disable native HTML image drag. `<img>` defaults to `draggable=true`,
  // so click+hold on the screencast triggers a native drag operation —
  // the browser shows the frame as a drag-ghost ("captures the image"),
  // then on release fires a `drop` event whose `dataTransfer.text/uri-list`
  // is the frame's data: URI. apps/web's document-level drop handler
  // (`apps/web/src/ui/drop.ts`) classifies that as `kind: "url"`,
  // `feedPerception` opens a new `fetch` slab item, and the live_browser
  // card vanishes. The screencast IS an interactive surface, NOT a
  // saveable image — `draggable=false` aligns the platform default with
  // our usage. Companion CSS properties cover legacy WebKit. Closes the
  // "click+hold+drag → screen disappears" bug end-to-end at the source.
  img.draggable = false;
  img.style.userSelect = "none";
  // `user-drag` is non-standard but recognized by WebKit/Blink; kept for
  // legacy Safari versions that don't fully honor `draggable=false`.
  img.style.setProperty("-webkit-user-drag", "none");
  // The img is invisible by design — the WebGL screen-mesh texture
  // (driven by `onFrameDecoded` → `renderer.setSlabScreencastImage`)
  // is the visible register. The img stays in the DOM as the
  // input-capture geometry: address-bar slot + click/keystroke
  // forwarders read `getBoundingClientRect()` against this element
  // to translate viewport coords to logical-pixel actions on the
  // cloud Chromium. Both `display: none` initial AND `opacity: 0`:
  // display:none suppresses the browser's broken-image glyph during
  // the loading window; the on-first-frame flip below bumps it to
  // `display: block` so getBoundingClientRect returns real pixels,
  // and opacity:0 keeps the visual contribution at zero so the
  // texture is the only register the user sees.
  //
  // 2026-05-09 — the slab's transmission stack landed in
  // `planeMaterial` (front pane only) + `silhouetteMaterial` (back
  // pane + sideWall, transmission:0). Three.js's transmission renders
  // ONE transmissive surface plus an opaque backdrop reliably; the
  // earlier multi-transmissive stack was three.js's design boundary,
  // not a fixable shader interaction. With single-pane transmission,
  // the screen mesh inside the volume composites cleanly through the
  // front pane — pixels embedded in the slab's liquescent volume,
  // sharing depth with the creature, clipped to the meniscus
  // silhouette (`liquescentia-as-substrate.md`).
  img.style.display = "none";
  img.style.opacity = "0";
  // Click-capture geometry MUST match the WebGL screen-mesh's
  // projected screen-space rect — the user clicks on what they
  // see (the WebGL screencast); the pointer event lands on this
  // DOM element. If the two rects diverge by even a few pixels,
  // clicks miss small targets (witnessed 2026-05-12: post-take-
  // back CAPTCHA checkbox unclickable because the DOM img was
  // letterbox-centered in the full body region while the WebGL
  // screen-mesh occupied an inscribed-inset rect 24px smaller on
  // left/right/bottom and 10px from chrome on top).
  //
  // Fix: drop the letterbox aspect-ratio and stretch the img to
  // fill the body wrapper, matching the WebGL screen-mesh's
  // stretch behavior. The body wrapper applies the SAME inscribed
  // insets the WebGL mesh uses (`INSCRIBED_INSET_PX` on left/
  // right/bottom, `BODY_TOP_INSET_PX` on top) — see the body
  // wrapper's CSS below. Same constants, single source of truth
  // (slab.ts exports; live-browser.ts imports) so a future inset
  // tuning lands in one file and both surfaces follow.
  img.style.width = "100%";
  img.style.height = "100%";
  img.style.background = "rgba(255, 255, 255, 0.04)";

  // Body wrapper — takes the remainder of the stage after the
  // chrome strip + address-bar slot, and hosts the screencast
  // img + body slot inside the inscribed-rectangle safe area.
  // `flex: 1 1 0` claims the remainder; `min-height: 0` lets the
  // wrapper actually shrink so its content can fit (the default
  // `min-height: auto` of flex items would force the wrapper to
  // its content's intrinsic size and overflow the stage).
  // `overflow: hidden` is a safety net against any pixel-rounding
  // edge case.
  //
  // Padding applies the inscribed-rectangle insets: top =
  // BODY_TOP_INSET_PX (10px breathing between chrome + body),
  // left/right/bottom = INSCRIBED_INSET_PX (~24px so the rect
  // stays inside the slab's rounded silhouette). These are the
  // SAME insets the WebGL screen-mesh uses (see slab.ts
  // SCREEN_MESH_WIDTH / SCREEN_MESH_HEIGHT / SCREEN_MESH_CENTER_Y).
  // With both sides applying the same insets, the click-capture
  // img's getBoundingClientRect equals the screen-mesh's projected
  // screen-space rect — clicks land where the user sees them.
  // `box-sizing: border-box` so the padding subtracts from the
  // wrapper's outer size rather than adding to it (otherwise the
  // wrapper would overflow the chrome-less remainder).
  const body = document.createElement("div");
  body.className = "slab-live-browser-body";
  body.style.flex = "1 1 0";
  body.style.minHeight = "0";
  body.style.display = "flex";
  body.style.alignItems = "stretch";
  body.style.justifyContent = "stretch";
  body.style.overflow = "hidden";
  body.style.boxSizing = "border-box";
  body.style.paddingTop = `${BODY_TOP_INSET_PX}px`;
  body.style.paddingRight = `${INSCRIBED_INSET_PX}px`;
  body.style.paddingBottom = `${INSCRIBED_INSET_PX}px`;
  body.style.paddingLeft = `${INSCRIBED_INSET_PX}px`;
  // Body slot is positioned absolute over the body wrapper so it
  // composes ON TOP of the screencast-img layer. Both occupy the
  // same body rect; the img is opacity:0 input-geometry while the
  // bodySlot is the visible empty-register content surface. The
  // slot's children inherit pointer-events from their CSS; the slot
  // itself is pointer-events:none so it doesn't block the underlying
  // img's input-capture when hidden (display:none also defeats hit
  // testing, so this is belt-and-suspenders).
  const bodySlot = document.createElement("div");
  bodySlot.className = "slab-live-browser-body-slot";
  bodySlot.style.position = "absolute";
  bodySlot.style.inset = "0";
  bodySlot.style.display = "flex";
  bodySlot.style.alignItems = "center";
  bodySlot.style.justifyContent = "center";
  bodySlot.style.pointerEvents = "none";
  // Make body wrapper position:relative so the absolute slot anchors
  // to it rather than to a distant ancestor.
  body.style.position = "relative";
  body.appendChild(img);
  body.appendChild(bodySlot);
  root.appendChild(body);

  // Track home tri-state so setHomeState can update display/backdrop
  // without touching the slot's mounted children. Default register —
  // the slab boots into the empty register and surfaces transition
  // out on URL navigate / focus.
  let homeState: "hidden" | "register" | "overlay" = "register";
  // CSS transition on the overlay backdrop fades in/out smoothly
  // rather than snapping. Set once; the value flips on state change.
  bodySlot.style.transition = "background-color 200ms ease, backdrop-filter 200ms ease";
  bodySlot.style.pointerEvents = "auto";
  // Initial state marker — keeps the dataset honest from the
  // moment of construction so tests / introspection can read the
  // truth without waiting for the first setHomeState call.
  bodySlot.dataset.homeState = "register";

  const setHomeState = (state: "hidden" | "register" | "overlay"): void => {
    if (homeState === state) return;
    homeState = state;
    if (state === "hidden") {
      bodySlot.style.display = "none";
      bodySlot.style.pointerEvents = "none";
      bodySlot.style.background = "";
      bodySlot.style.backdropFilter = "";
      bodySlot.style.setProperty("-webkit-backdrop-filter", "");
      bodySlot.dataset.homeState = "hidden";
    } else if (state === "register") {
      bodySlot.style.display = "flex";
      bodySlot.style.pointerEvents = "auto";
      bodySlot.style.background = "";
      bodySlot.style.backdropFilter = "";
      bodySlot.style.setProperty("-webkit-backdrop-filter", "");
      bodySlot.dataset.homeState = "register";
    } else {
      // overlay — visually identical to the register state, by
      // design. Apple's Safari pattern: focusing the URL bar on an
      // active page replaces the page render with the Start Page;
      // the previous page is NOT visible behind a blur. Blurring
      // the live screencast under a translucent sheet (the prior
      // implementation) produced two competing readable layers
      // and felt visually noisy; the doctrine answer matches the
      // platform answer.
      //
      // The semantic distinction between "register" (no session
      // beneath) and "overlay" (session suspended beneath) is NOT
      // communicated through the slot's appearance. It's signaled
      // via:
      //   - URL bar state: empty placeholder (register) vs current
      //     URL pre-selected for editing (overlay).
      //   - WebGL screencast: cleared texture (`home` body register)
      //     vs preserved-but-hidden texture (`transition` body
      //     register) — the renderer's per-frame derivation reads
      //     the body register and hides the screen mesh in both
      //     non-`live` states so resuming the session is cold-start-
      //     free. Doctrine: motebit-computer.md §"Body register —
      //     the tri-state."
      //
      // The `dataset.homeState` attribute differs so tests + future
      // CSS rules can branch on the semantic state without it
      // showing in the visible register today.
      bodySlot.style.display = "flex";
      bodySlot.style.pointerEvents = "auto";
      bodySlot.style.background = "";
      bodySlot.style.backdropFilter = "";
      bodySlot.style.setProperty("-webkit-backdrop-filter", "");
      bodySlot.dataset.homeState = "overlay";
    }
  };

  let firstFrameSeen = false;
  let lastTimestamp = 0;
  let disposed = false;

  // Close `VideoFrame` / `ImageBitmap` GPU resources when a decoded
  // surface is dropped without being delivered (stale generation,
  // disposed mid-decode, no consumer wired). `HTMLImageElement` is
  // JS-heap and GC'd normally — no close method, skipped via duck type.
  const closeIfReleasable = (surface: DecodedScreencastFrame | undefined): void => {
    if (surface == null) return;
    const closeable = surface as { close?: () => void };
    if (typeof closeable.close === "function") {
      closeable.close();
    }
  };

  // Per-frame paint coordination. The naive `img.src = newDataURI`
  // pattern triggers a synchronous decode on the visible img, and
  // produces a brief tear/blank during the decode of every frame —
  // perceptible as "flashing" on heavy auto-animating pages
  // (cookie-modal slides, hero-video carousels, ad rotation). World-
  // class screen-share clients pre-decode each frame on a hidden
  // Image, then swap atomically once decode resolves. Generation
  // counter drops stale frames so a burst paints only the latest.
  let pendingGeneration = 0;
  let lastPaintedGeneration = 0;

  function pushFrame(frame: ScreencastFrame): void {
    if (disposed) return;
    // Drop out-of-order frames. CDP frames generally arrive in order
    // but jitter under load can re-order; latest-wins keeps the
    // render-thread paint queue honest.
    if (frame.timestamp < lastTimestamp) return;
    lastTimestamp = frame.timestamp;
    const myGen = ++pendingGeneration;
    const dataUri = `data:image/jpeg;base64,${frame.jpeg_base64}`;

    const paint = (decoded?: DecodedScreencastFrame): void => {
      if (disposed) {
        // Disposed mid-decode — close the GPU-backed surface and bail.
        closeIfReleasable(decoded);
        return;
      }
      // Drop if a newer frame already painted while we were decoding.
      // Prevents back-and-forth churn when frames arrive in bursts.
      // Close the stale decoded surface — `VideoFrame` and `ImageBitmap`
      // hold GPU resources that don't GC; only `HTMLImageElement` is JS-
      // heap and self-cleaning.
      if (myGen <= lastPaintedGeneration) {
        closeIfReleasable(decoded);
        return;
      }
      lastPaintedGeneration = myGen;
      img.src = dataUri;
      // Lock the element's aspect ratio to the captured viewport on
      // first frame so the input-capture's `getBoundingClientRect`
      // math against the screencast natural-dimensions stays honest.
      if (!firstFrameSeen) {
        firstFrameSeen = true;
        // Flip the img to `display: block` (kept at `opacity: 0`) so
        // `getBoundingClientRect()` returns real pixels for the
        // input-capture coordinate translation. Pair with the
        // `display: none` + `opacity: 0` initial state in the
        // constructor; the texture is the visible register, this
        // is just the input-capture geometry made measurable.
        //
        // Note: the prior implementation also set `aspectRatio` on
        // the img to lock its letterbox shape. The img now stretches
        // to fill the inscribed-inset rect (matching the WebGL
        // screen-mesh's stretch behavior) so the aspect-ratio is no
        // longer load-bearing — removed on 2026-05-12 along with the
        // padding-based inscribed-inset alignment that closes the
        // click-misalignment bug.
        img.style.display = "block";
      }
      // Hand the decoded surface to consumers (apps/web routes it to the
      // slab's WebGL screen-mesh texture). When `decoded` is absent
      // (jsdom path with no decode primitives available), fall back to
      // the visible img — by this point its `src` is set, so consumers
      // can read it.
      //
      // Lifecycle: once handed off, the slab owns the surface and
      // calls `.close()` on the previous one when a new frame arrives
      // (`setScreencastImage` cleanup branch). We do NOT close the
      // surface here on success — that would race the slab's texture
      // upload.
      if (deps.onFrameDecoded != null) {
        deps.onFrameDecoded(decoded ?? img, frame);
      } else {
        // No consumer — close the GPU surface immediately so we
        // don't leak. Without this, an unsubscribed live-browser
        // would accumulate GPU-backed frames at the screencast rate.
        closeIfReleasable(decoded);
      }
    };

    // Pre-decode on the sharpest available tier — WebCodecs
    // ImageDecoder → createImageBitmap → HTMLImage.decode (see
    // `decodeFrameForTexture`). The tier produces the highest-quality
    // texture-uploadable surface the environment supports; the slab's
    // texture sampling (anisotropy + mipmaps + sRGB) does the rest.
    //
    // The visible `<img>.src = dataUri` is set inside `paint()` — same
    // contract as before, just now downstream of the WebCodecs path
    // instead of an HTMLImage preload. Input-capture geometry stays
    // honest because `paint()` always sets `img.src` before calling
    // `onFrameDecoded`.
    //
    // Synchronous fast path when no decode primitive exists in the
    // environment (jsdom default — no ImageDecoder, no
    // createImageBitmap, no Image.prototype.decode). Going through the
    // Promise chain in that case would defer paint by a microtask
    // when the original sync `else { paint(); }` branch didn't —
    // tests that publish + read DOM state in the same tick rely on
    // sync semantics. Detect via existence of any decode primitive;
    // if none, paint synchronously with the visible img as source.
    if (!hasAnyDecodePrimitive()) {
      paint();
    } else {
      decodeFrameForTexture(dataUri).then(
        (decoded) => paint(decoded),
        () => paint(),
      );
    }
  }

  const unsubscribe = source.subscribe(pushFrame);

  return {
    element: root,
    frameElement: img,
    addressBarSlot,
    controlBandSlot,
    bodySlot,
    setHomeState,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
