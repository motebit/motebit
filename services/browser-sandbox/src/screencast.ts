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
 *     "device_width": 1280, "device_height": 800 }
 *
 * Quality + sample rate are tuned for the slab's perceptual
 * register, not for fidelity: 60% JPEG quality at every-2nd-frame
 * (~15fps from a 30fps page) is enough motion that the slab reads
 * as alive without saturating bandwidth. Operators that need
 * higher quality can tune `BrowserSandboxConfig` later — for v1.3
 * the constants are inline.
 *
 * One screencast per session. The pool stores the disposer so
 * `closeSession` tears down the screencast first; double-start is
 * idempotent (returns the existing disposer).
 */

import type { Page } from "playwright-core";
import type { ScreencastFrame } from "@motebit/protocol";

export type { ScreencastFrame } from "@motebit/protocol";

const SCREENCAST_FORMAT = "jpeg" as const;
const SCREENCAST_QUALITY = 60;
const SCREENCAST_MAX_WIDTH = 1280;
const SCREENCAST_MAX_HEIGHT = 800;
/**
 * `everyNthFrame: 2` — Chromium pages typically composite at 60fps
 * (or 30fps on battery); requesting every-2nd-frame caps screencast
 * at ~30fps from a 60fps page or ~15fps from 30fps. The slab's
 * perceptual register doesn't need 60fps; halving the rate halves
 * bandwidth + JPEG-encode CPU. Higher motion fidelity is a
 * post-v1.3 tuning concern.
 */
const SCREENCAST_EVERY_NTH = 2;

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
