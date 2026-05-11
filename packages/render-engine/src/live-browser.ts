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
   * Stop the subscription and clear the rendered frame. Idempotent —
   * a second call is a no-op. The element itself is left in the DOM
   * for the slab's dissolve animation to take it the rest of the way.
   */
  dispose(): void;
}

/**
 * Texture-uploadable frame surfaces. The decode pipeline picks the
 * sharpest path available in the environment (see `decodeFrameForTexture`):
 *
 *   VideoFrame       — WebCodecs `ImageDecoder.decode()` output. Hardware-
 *                      accelerated JPEG decode, off-main-thread, the same
 *                      type the H.264 end-game (`VideoDecoder`) will
 *                      produce. Chrome 94+, Safari 17+, Edge 94+.
 *   ImageBitmap      — `createImageBitmap(blob)` output. Browser-native
 *                      off-main-thread decode. Universal modern fallback
 *                      including Firefox.
 *   HTMLImageElement — `<img>.decode()` output. Last-resort path for
 *                      jsdom and ancient browsers.
 *
 * Three.js Texture accepts all three directly (Three.js r150+ has
 * explicit VideoFrame support in WebGLTextures). Same architectural
 * seam in every tier — the next codec migration is a single-tier swap.
 */
export type DecodedScreencastFrame = HTMLImageElement | ImageBitmap | VideoFrame;

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
 * Tier 1 — WebCodecs `ImageDecoder`. Hardware-accelerated decode
 * (CoreVideo on Apple, libvpx/libjpeg-turbo via Chromium codec layer
 * on others). Output is `VideoFrame`, the unified WebCodecs frame
 * type — when the H.264 end-game lands (`VideoDecoder` over
 * WebSocket), this tier swaps its decoder and the rest of the
 * pipeline is identical.
 *
 * Tier 2 — `createImageBitmap(blob)`. The browser's native image
 * decoder, runs off-main-thread, produces `ImageBitmap`. Universal
 * across modern browsers including Firefox. `colorSpaceConversion:
 * "none"` preserves the JPEG's sRGB encoding so the slab's
 * `SRGBColorSpace` texture tag decodes it correctly (the alternative
 * — "default" — would convert to the display color space pre-upload,
 * double-correcting the gamma when Three.js applies sRGB decode).
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

  // Tier 1 — WebCodecs ImageDecoder.
  if (typeof g.ImageDecoder === "function" && typeof g.fetch === "function") {
    try {
      const supported =
        typeof g.ImageDecoder.isTypeSupported === "function"
          ? await g.ImageDecoder.isTypeSupported("image/jpeg")
          : true;
      if (supported) {
        const buffer = await g.fetch(dataUri).then((r) => r.arrayBuffer());
        const decoder = new g.ImageDecoder({ type: "image/jpeg", data: buffer });
        try {
          const result = await decoder.decode();
          return result.image;
        } finally {
          decoder.close();
        }
      }
    } catch {
      // Fall through to tier 2 — codec unavailable for this content.
    }
  }

  // Tier 2 — createImageBitmap from Blob.
  if (typeof g.createImageBitmap === "function" && typeof g.fetch === "function") {
    try {
      const blob = await g.fetch(dataUri).then((r) => r.blob());
      return await g.createImageBitmap(blob, {
        colorSpaceConversion: "none",
        premultiplyAlpha: "default",
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
  // front pane — pixels embedded in the glass volume, sharing depth
  // with the creature, clipped to the meniscus silhouette
  // (`liquescentia-as-substrate.md`).
  img.style.display = "none";
  img.style.opacity = "0";
  // Letterbox the screencast within the body wrapper. `aspectRatio`
  // (initially 16/10; updated to the cloud Chromium's actual
  // device ratio on first frame) drives the visible rect, and
  // `max-width: 100%` + `max-height: 100%` constrain it to the body
  // wrapper's flex-1 area. The img's bounding-rect equals the
  // visible screencast rect — input-capture's coord translation
  // (`getBoundingClientRect()` against this element) stays honest
  // without having to compute letterbox offsets. Whatever space the
  // letterbox leaves around the img reads as the slab's body glass
  // — calm-software register, not a black bar.
  img.style.maxWidth = "100%";
  img.style.maxHeight = "100%";
  img.style.aspectRatio = "16 / 10";
  img.style.background = "rgba(255, 255, 255, 0.04)";

  // Body wrapper — takes the remainder of the stage after the
  // chrome strip + address-bar slot, and centers the screencast
  // img within. `flex: 1 1 0` claims the remainder; `min-height: 0`
  // lets the wrapper actually shrink so its content can fit (the
  // default `min-height: auto` of flex items would force the
  // wrapper to its content's intrinsic size and overflow the
  // stage). `overflow: hidden` is a safety net against any
  // pixel-rounding edge case.
  const body = document.createElement("div");
  body.className = "slab-live-browser-body";
  body.style.flex = "1 1 0";
  body.style.minHeight = "0";
  body.style.display = "flex";
  body.style.alignItems = "center";
  body.style.justifyContent = "center";
  body.style.overflow = "hidden";
  body.appendChild(img);
  root.appendChild(body);

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
        if (frame.device_width > 0 && frame.device_height > 0) {
          img.style.aspectRatio = `${frame.device_width} / ${frame.device_height}`;
        }
        // Flip the img to `display: block` (kept at `opacity: 0`) so
        // `getBoundingClientRect()` returns real pixels for the
        // input-capture coordinate translation. Pair with the
        // `display: none` + `opacity: 0` initial state in the
        // constructor; the texture is the visible register, this
        // is just the input-capture geometry made measurable.
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
