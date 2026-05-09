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
   * Why above the img and not as separate slab chrome (parallel to
   * `setSlabControlBand`): the address bar is part of the
   * "browser-inside-the-slab," not chrome of the slab itself. Same
   * way Chrome's address bar is part of Chrome's window, not
   * separate from it. Visually + semantically belongs with the
   * live_browser item.
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
   * Slice 2g — expose the "waiting for first frame" placeholder so
   * surfaces can recess it during state transitions where the
   * doorbell band is the load-bearing UI. When state is
   * `handoff_pending` and no first frame has arrived, three pieces
   * of UI compete for the same volume: the broken-img glyph
   * (suppressed by Slice 2g's display:none-until-first-frame), the
   * "live browser · waiting for first frame…" placeholder, and the
   * Grant/Deny band. The band is the message; the placeholder is
   * noise. Surface code hides the placeholder
   * (`placeholderEl.style.display = "none"`) when state is
   * handoff_pending and reveals it otherwise.
   *
   * Auto-removal on first frame is unchanged — `pushFrame` calls
   * `placeholder.remove()` regardless of whether the surface had
   * temporarily hidden it. The display-toggle is purely
   * presentational; lifecycle stays render-engine-owned.
   */
  readonly placeholderEl: HTMLElement;
  /**
   * Stop the subscription and clear the rendered frame. Idempotent —
   * a second call is a no-op. The element itself is left in the DOM
   * for the slab's dissolve animation to take it the rest of the way.
   */
  dispose(): void;
}

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
 * it the decoded `HTMLImageElement` after `Image.decode()` resolves.
 */
export interface BuildLiveBrowserDeps {
  readonly onFrameDecoded?: (image: HTMLImageElement, frame: ScreencastFrame) => void;
}

export function buildLiveBrowserElement(
  source: ScreencastFrameSource,
  deps: BuildLiveBrowserDeps = {},
): LiveBrowserElementHandle {
  const root = document.createElement("div");
  root.className = "slab-live-browser";

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
  // Slice 2g — start hidden so an `<img>` with no `src` doesn't
  // render the browser's default broken-image glyph + alt text.
  // The placeholder div below carries the loading UX until the
  // first frame arrives; `pushFrame` flips this to "block" on
  // first frame and the placeholder removes itself in the same
  // tick.
  //
  // 2026-05-09 — the parallel WebGL screen-mesh path
  // (`onFrameDecoded` → `renderer.setSlabScreencastImage`) lives
  // behind the CSS3D layer. When the texture path renders, you see
  // the texture; when it doesn't, you see this img. Keeping img
  // visible at opacity:1 means screencast content is always shown
  // even if the WebGL transmission path mis-composites under
  // multi-transmissive-object stacks (slab front + back + sideWall
  // all share `planeMaterial` with `transmission`, and the
  // transmission render-target interaction with a non-transmissive
  // child mesh inside the same group doesn't reliably surface the
  // texture in current three.js). The depth/silhouette seam Daniel
  // surfaced will be closed when the transmission interaction is
  // diagnosed; for now visible-img is the calm-software default —
  // never lose the user's ability to see the page.
  img.style.display = "none";
  img.style.width = "100%";
  img.style.aspectRatio = "16 / 10";
  img.style.background = "rgba(255, 255, 255, 0.04)";
  root.appendChild(img);

  // Pre-frame placeholder text — replaces with the first frame the
  // moment one arrives. Calm-software: never confirm "loading" once
  // content is visible.
  const placeholder = document.createElement("div");
  placeholder.className = "slab-live-browser-placeholder";
  placeholder.textContent = "live browser · waiting for first frame…";
  placeholder.style.position = "absolute";
  placeholder.style.inset = "0";
  placeholder.style.display = "flex";
  placeholder.style.alignItems = "center";
  placeholder.style.justifyContent = "center";
  placeholder.style.opacity = "0.55";
  root.style.position = "relative";
  root.appendChild(placeholder);

  let firstFrameSeen = false;
  let lastTimestamp = 0;
  let disposed = false;

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

    const paint = (decoded?: HTMLImageElement): void => {
      if (disposed) return;
      // Drop if a newer frame already painted while we were decoding.
      // Prevents back-and-forth churn when frames arrive in bursts.
      if (myGen <= lastPaintedGeneration) return;
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
        // Slice 2g — flip the img visible only after the first decode-
        // ready src has been assigned. Pair with the `display: none`
        // initial state in the constructor; together they suppress the
        // broken-image fallback glyph during the loading window.
        img.style.display = "block";
        placeholder.remove();
      }
      // Hand the decoded image to consumers (apps/web routes it to the
      // slab's WebGL screen-mesh texture). When `decoded` is absent
      // (jsdom path with no `Image.decode`), fall back to the visible
      // img — by this point its `src` is set, so consumers can read it.
      if (deps.onFrameDecoded != null) {
        deps.onFrameDecoded(decoded ?? img, frame);
      }
    };

    // Pre-decode on a hidden Image when supported; the browser caches
    // by data URI, so swapping `img.src` to the same URI after decode
    // resolves serves from cache — effectively atomic, no decode-flash
    // on the visible img. jsdom and other test environments don't
    // implement `decode()`; fall back to direct paint there.
    if (typeof Image.prototype.decode === "function") {
      const preload = new Image();
      preload.decoding = "async";
      preload.src = dataUri;
      preload.decode().then(
        () => paint(preload),
        () => paint(),
      );
    } else {
      paint();
    }
  }

  const unsubscribe = source.subscribe(pushFrame);

  return {
    element: root,
    frameElement: img,
    addressBarSlot,
    controlBandSlot,
    placeholderEl: placeholder,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
