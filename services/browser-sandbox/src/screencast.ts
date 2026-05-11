/**
 * CDP-driven screencast for the browser-sandbox (v1.3).
 *
 * Per-action screenshots produced "moments" — the slab read as a
 * slideshow of stills, not a window into a browser. v1.3 swaps that
 * for `Page.startScreencast` over Chrome DevTools Protocol: a
 * continuous JPEG frame stream the slab renders into a live
 * surface. The AI loop still drives via Playwright actions; the
 * user just sees motion between them.
 *
 * Why CDP screencast instead of WebSocket binary frames or
 * MediaRecorder. CDP screencast is the canonical Chromium-side
 * primitive — Playwright wraps it via `context.newCDPSession(page)`
 * and emits `Page.screencastFrame` events. The format (JPEG +
 * metadata) is documented and stable. MediaRecorder would require
 * a `<video>` element rendering inside the headless context which
 * the headless executor doesn't have. WebSocket pixel streaming
 * would re-implement what CDP already gives us.
 *
 * Wire format (one frame per NDJSON line):
 *
 *   { "jpeg_base64": "<...>", "timestamp": 1700000000123,
 *     "device_width": 1920, "device_height": 1200 }
 *
 * Quality tier — hero-surface, not bandwidth-budget. The slab is
 * the most-looked-at object in the product after the creature;
 * it gets visionOS-window-grade fidelity. JPEG quality 90 at
 * 1920×1200 every frame produces a stream whose visible artifacts
 * are below the noise floor of the slab's transmission shader.
 *
 * The earlier v1.3 register (quality 60, every-2nd-frame, 1280×800)
 * was tuned for "reads as alive" — it succeeded perceptually but
 * left text antialiasing soft and produced visible chroma blocks
 * on flat backgrounds. The hero-surface tier costs ~3× bandwidth
 * (~1.5 MB/s peak) for a hero surface the user looks at
 * continuously — the right trade. End-game replaces the JPEG path
 * entirely with WebCodecs H.264 (`motebit-computer.md`
 * §"Capture-pipeline end-game"); this tier is the substrate the
 * end-game inherits, not a parallel codepath.
 *
 * One screencast per session. The pool stores the disposer so
 * `closeSession` tears down the screencast first; double-start is
 * idempotent (returns the existing disposer).
 */

import type { Page } from "playwright-core";
import type { ScreencastFrame } from "@motebit/protocol";

export type { ScreencastFrame } from "@motebit/protocol";

const SCREENCAST_FORMAT = "jpeg" as const;
/**
 * JPEG quality 90 — the threshold above which compression artifacts
 * are below normal viewing distance perception on a hero surface.
 * 85 is "looks identical to original on a thumbnail"; 90 is "looks
 * identical to original at full-size on a textured surface in 3D
 * being looked at directly." The slab gets the latter.
 */
const SCREENCAST_QUALITY = 90;
/**
 * 1920×1200 source — enough resolution that the slab is texel-
 * supersampled at any reasonable display size up to ~4K. The
 * screen mesh is ~0.46 m wide in world space; at typical viewing
 * distance and DPR 2 that's ~960–1200 screen pixels — a 1920px
 * source gives ≥1.5× oversampling, which trilinear + max-aniso
 * filtering converts to sharpness rather than aliasing.
 */
const SCREENCAST_MAX_WIDTH = 1920;
const SCREENCAST_MAX_HEIGHT = 1200;
/**
 * `everyNthFrame: 1` — every composited frame. The slab's
 * sympathetic breathing at 0.3 Hz reads as alive only when
 * sub-frame motion (scroll, hover, cursor) is smooth; every-other-
 * frame at 15 fps produced visible step. CDP screencast caps at
 * Chromium's composite rate (typically 30–60 fps depending on
 * power state), which is the right tier — the slab is not a 120fps
 * surface, but it should not stutter.
 */
const SCREENCAST_EVERY_NTH = 1;

/**
 * Stop the screencast cleanly. Idempotent — calling twice is a no-op.
 */
export type StopScreencast = () => Promise<void>;

/**
 * Begin streaming JPEG frames from the page's underlying CDP session.
 * Each frame fires `onFrame`; the returned disposer stops the
 * screencast and detaches the CDP session. Errors during teardown
 * are swallowed (the session may already be torn down by the time
 * the disposer runs — that's fine, the goal is "no leaks").
 *
 * The `Page.screencastFrameAck` send is required: CDP pauses the
 * stream until the client acks the previous frame. Skipping it
 * stalls the screencast after one frame. Acks fire-and-forget —
 * a thrown ack (e.g. CDP detached mid-frame) must not break the
 * frame delivery to the consumer.
 */
export async function startScreencast(
  page: Page,
  onFrame: (frame: ScreencastFrame) => void,
): Promise<StopScreencast> {
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", (event) => {
    try {
      onFrame({
        jpeg_base64: event.data,
        timestamp:
          typeof event.metadata?.timestamp === "number"
            ? event.metadata.timestamp * 1000 // CDP metadata is seconds; normalize to ms
            : Date.now(),
        device_width: event.metadata?.deviceWidth ?? SCREENCAST_MAX_WIDTH,
        device_height: event.metadata?.deviceHeight ?? SCREENCAST_MAX_HEIGHT,
      });
    } catch {
      // Consumer fault must not break the screencast.
    }
    // Ack — fire and forget. CDP needs this to send the next frame.
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
  });

  await cdp.send("Page.startScreencast", {
    format: SCREENCAST_FORMAT,
    quality: SCREENCAST_QUALITY,
    maxWidth: SCREENCAST_MAX_WIDTH,
    maxHeight: SCREENCAST_MAX_HEIGHT,
    everyNthFrame: SCREENCAST_EVERY_NTH,
  });

  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    try {
      await cdp.send("Page.stopScreencast");
    } catch {
      // CDP may already be detached on the page side.
    }
    try {
      await cdp.detach();
    } catch {
      // Same — best-effort cleanup.
    }
  };
}
