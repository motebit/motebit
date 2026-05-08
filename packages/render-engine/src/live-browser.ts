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
   * Stop the subscription and clear the rendered frame. Idempotent —
   * a second call is a no-op. The element itself is left in the DOM
   * for the slab's dissolve animation to take it the rest of the way.
   */
  dispose(): void;
}

export function buildLiveBrowserElement(source: ScreencastFrameSource): LiveBrowserElementHandle {
  const root = document.createElement("div");
  root.className = "slab-live-browser";

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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
