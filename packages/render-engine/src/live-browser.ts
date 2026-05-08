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
   * Stop the subscription and clear the rendered frame. Idempotent —
   * a second call is a no-op. The element itself is left in the DOM
   * for the slab's dissolve animation to take it the rest of the way.
   */
  dispose(): void;
}

export function buildLiveBrowserElement(source: ScreencastFrameSource): LiveBrowserElementHandle {
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
  // Block-level layout + intrinsic aspect ratio from the first
  // frame's dimensions; until then a 16:10 placeholder so the slot
  // doesn't collapse to zero height.
  img.style.display = "block";
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

  function pushFrame(frame: ScreencastFrame): void {
    if (disposed) return;
    // Drop out-of-order frames. CDP frames generally arrive in order
    // but jitter under load can re-order; latest-wins keeps the
    // render-thread paint queue honest.
    if (frame.timestamp < lastTimestamp) return;
    lastTimestamp = frame.timestamp;
    img.src = `data:image/jpeg;base64,${frame.jpeg_base64}`;
    // Lock the element's aspect ratio to the captured viewport on
    // first frame so it stops billboarding as the placeholder ratio.
    if (!firstFrameSeen) {
      firstFrameSeen = true;
      if (frame.device_width > 0 && frame.device_height > 0) {
        img.style.aspectRatio = `${frame.device_width} / ${frame.device_height}`;
      }
      placeholder.remove();
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
