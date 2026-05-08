/**
 * Co-browse Slice 2c — DOM input capture on the live screencast `<img>`.
 *
 * Captures discrete user events (click, keydown for control keys,
 * printable keys for typing, paste) on the screencast frame
 * element, translates them to the wire format the runtime expects,
 * and forwards via the supplied `forwardEvent` callback. Returns a
 * detacher that fully removes listeners and restores the element.
 *
 * Doctrine binding:
 *
 *   - **Surface determinism** (`docs/doctrine/surface-determinism.md`).
 *     Every captured event invokes a typed capability via
 *     `forwardEvent` — never an AI-loop prompt. The
 *     `check-affordance-routing` gate enforces this statically.
 *
 *   - **Discrete events only** (Slice 2c scope per
 *     `spec/computer-use-v1.md` §5.5). Wheel, drag, continuous
 *     pointermove are NOT captured here — POST-per-event can't
 *     sustain 50+ events/sec without batching, and the rest of the
 *     stack (audit shape, bounds checks, redaction) is calibrated
 *     against discrete events.
 *
 *   - **Coordinate translation**. `<img>` adopts the screencast's
 *     aspect ratio in `buildLiveBrowserElement` (via
 *     `style.aspectRatio`), so `getBoundingClientRect()` IS the
 *     rendered image rect — no object-fit / letterbox math needed.
 *     We translate to logical pixels using either the live
 *     `naturalWidth`/`naturalHeight` (the JPEG dimensions, which
 *     equal the cloud Chromium viewport) or the supplied fallback
 *     when no frame has arrived yet.
 *
 * Focus model: `<img>` doesn't receive keyboard events by default.
 * The capture module sets `tabindex="0"` on attach, gives it focus
 * on click, and listens for keydown/paste only while focused. On
 * detach, the original `tabindex` is restored so the element is
 * left in its pre-capture state.
 */

import type { UserInputEvent } from "@motebit/sdk";
import type { UserInputForwardResult } from "@motebit/runtime";

export interface AttachInputCaptureDeps {
  /**
   * The live screencast `<img>` element. Provided by
   * `LiveBrowserElementHandle.frameElement`. Capture attaches
   * listeners directly to this element so the visible frame surface
   * IS the input capture surface.
   */
  readonly img: HTMLImageElement;
  /**
   * Forwards a wire-format event into the runtime's
   * `forwardUserInput`. Capture is wire-only: it does NOT decide
   * gate state (the runtime does) and does NOT emit audit events
   * (the caller does, after reading the returned `audit`). Capture
   * IS the wire; runtime IS the policy.
   *
   * Returning a Promise lets future versions await transport before
   * coalescing the next event; for v1 (discrete events) we
   * fire-and-forget.
   */
  readonly forwardEvent: (event: UserInputEvent) => Promise<UserInputForwardResult>;
  /**
   * Fallback viewport dimensions for the frame when `img.naturalWidth`
   * / `img.naturalHeight` are 0 (no frame has arrived yet, or the
   * decode is still in flight). Pass the cloud session's display
   * width/height — they equal the screencast's natural dimensions
   * once a frame lands.
   */
  readonly fallbackWidth: number;
  readonly fallbackHeight: number;
  /**
   * Optional logger for transport / capture warnings. Keeps the
   * capture module surface-agnostic — apps/web wires its own logger.
   */
  readonly logger?: { warn(msg: string, ctx?: Record<string, unknown>): void };
}

/**
 * Attach DOM input capture to the live screencast img. Returns a
 * detach thunk that removes every listener and restores the
 * element's pre-capture state. Idempotent on the detach side.
 */
export function attachInputCapture(deps: AttachInputCaptureDeps): () => void {
  const { img, forwardEvent, fallbackWidth, fallbackHeight } = deps;
  const logger = deps.logger ?? {
    // eslint-disable-next-line no-console -- fail-soft default; real surfaces wire a logger
    warn: (msg, ctx) => console.warn(msg, ctx),
  };

  // Make the img focusable so it can receive keyboard events. Save
  // the prior value so detach restores faithfully (the slab item
  // owns the element; we're a transient guest).
  const priorTabIndex = img.tabIndex;
  const priorOutline = img.style.outline;
  img.tabIndex = 0;
  // Calm chrome: focus-ring on a screencast image looks like an
  // OS dialog. Suppress here; if accessibility needs a focus
  // indicator we add a high-contrast custom ring later.
  img.style.outline = "none";

  // Bookkeeping for fire-and-forget forwards. A failure on one
  // event must not block the next (a slow transport shouldn't queue
  // up the user's clicks).
  function dispatch(event: UserInputEvent): void {
    forwardEvent(event).catch((err: unknown) => {
      logger.warn("co-browse input forward threw", {
        kind: event.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ── Click capture ───────────────────────────────────────────────
  function onClick(e: MouseEvent): void {
    // Preserve focus-on-click for keyboard handling.
    img.focus();
    const coords = translateClick(img, e, fallbackWidth, fallbackHeight);
    if (!coords) return; // out-of-bounds (defensive — clicks on the img should always be in-bounds)
    // Slice 2e — local click-ripple feedback. Pure DOM animation;
    // no wire involvement. Confirms "my click registered there"
    // before the next screencast frame arrives (which can be up
    // to ~67ms later at 15fps).
    spawnClickRipple(img, e);
    dispatch({
      kind: "click",
      x: coords.x,
      y: coords.y,
      button: mouseButton(e.button),
    });
    // Don't preventDefault — the user's click on the screencast img
    // shouldn't have a default action anyway, and not preventing
    // keeps surrounding focus / event-bubbling normal.
  }

  // ── Keyboard capture ───────────────────────────────────────────
  function onKeydown(e: KeyboardEvent): void {
    // Only forward when the screencast is focused. Otherwise we'd
    // steal keystrokes from the chat input, settings panel, etc.
    if (document.activeElement !== img) return;
    // IME composition produces a synthesized "Process" key in many
    // browsers; let the actual character events through `compositionend`
    // → `input` events handle themselves and skip the synthesized key.
    if (e.isComposing || e.key === "Process" || e.key === "Dead") return;
    // Skip pure modifier-key presses — the modifier state flows
    // through the `modifiers` field on the next non-modifier press.
    if (PURE_MODIFIER_KEYS.has(e.key)) return;
    // Prevent browser default actions that would steal focus or
    // navigate (Tab moving focus, Backspace history-back on some
    // older configs, F1 opening help). The capture surface owns
    // the keystroke — it's heading to Chromium.
    e.preventDefault();
    dispatch({
      kind: "key",
      key: e.key,
      modifiers: {
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        shift: e.shiftKey,
      },
    });
  }

  // ── Wheel capture (Slice 2c-batching) ───────────────────────────
  //
  // Native WheelEvents fire at 30-100Hz (trackpads at the high end);
  // forwarding each one as a POST would saturate the wire. We
  // coalesce in a 16ms window: collect deltas + cursor position,
  // emit ONE wire event when the window flushes. Sustained scrolling
  // resolves to ~60 wire events/sec — bounded.
  //
  // Coalescing scope: dx + dy sum together within the window. The
  // anchor cursor position uses the LATEST native event in the
  // window (so a trackpad swipe that drifts while scrolling lands
  // its wheel at the user's actual cursor, not where they started).
  // event_count rides along so the audit can record interaction
  // density.
  //
  // Boundary: the wheel window is per-attach. Detach flushes any
  // in-flight window so a quick drag-disable doesn't strand
  // events.
  let wheelAccum: { x: number; y: number; dx: number; dy: number; count: number } | null = null;
  let wheelFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const WHEEL_COALESCE_MS = 16;

  function flushWheel(): void {
    if (wheelFlushTimer != null) {
      clearTimeout(wheelFlushTimer);
      wheelFlushTimer = null;
    }
    if (!wheelAccum) return;
    const accum = wheelAccum;
    wheelAccum = null;
    dispatch({
      kind: "wheel",
      x: accum.x,
      y: accum.y,
      dx: accum.dx,
      dy: accum.dy,
      event_count: accum.count,
    });
  }

  function onWheel(e: WheelEvent): void {
    // Only capture wheel when the slab is focused — otherwise we'd
    // steal scroll from the page itself.
    if (document.activeElement !== img) return;
    // Suppress browser-default page scroll on the slab img. The
    // wheel is heading to Chromium, not to scroll motebit.com.
    e.preventDefault();
    const coords = translateClick(img, e, fallbackWidth, fallbackHeight);
    if (!coords) return; // out-of-bounds — defensive
    if (wheelAccum) {
      wheelAccum.x = coords.x;
      wheelAccum.y = coords.y;
      wheelAccum.dx += e.deltaX;
      wheelAccum.dy += e.deltaY;
      wheelAccum.count += 1;
      return;
    }
    wheelAccum = {
      x: coords.x,
      y: coords.y,
      dx: e.deltaX,
      dy: e.deltaY,
      count: 1,
    };
    wheelFlushTimer = setTimeout(flushWheel, WHEEL_COALESCE_MS);
  }

  // ── Paste capture ──────────────────────────────────────────────
  function onPaste(e: ClipboardEvent): void {
    if (document.activeElement !== img) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text.length === 0) return;
    // Suppress browser default — the paste targets our img (no real
    // input element); browser-default would do nothing useful and
    // we want the wire-format paste to be the canonical channel.
    e.preventDefault();
    dispatch({ kind: "paste", text });
  }

  img.addEventListener("click", onClick);
  // Wheel attaches on the img with `passive: false` so preventDefault
  // can suppress the page-level scroll. Modern browsers default
  // wheel listeners to passive — we need active.
  img.addEventListener("wheel", onWheel, { passive: false });
  // Keydown attaches on document so we catch keys regardless of which
  // ancestor element the focus event reports — but we ALSO check
  // `document.activeElement === img` inside the handler, so the
  // keystrokes are still scoped to slab focus.
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("paste", onPaste, true);

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    // Flush any pending wheel window so a fast drag-disable doesn't
    // strand the user's last scroll delta.
    flushWheel();
    img.removeEventListener("click", onClick);
    img.removeEventListener("wheel", onWheel);
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("paste", onPaste, true);
    // Restore pre-attach state.
    img.tabIndex = priorTabIndex;
    img.style.outline = priorOutline;
  };
}

// ── Coordinate translation ──────────────────────────────────────────────

/**
 * Translate a `MouseEvent` against the screencast img into logical
 * Chromium viewport pixels. Returns `null` if the click is
 * out-of-bounds (defensive — clicks on the img should always be in
 * bounds, but a malformed dispatch should fail closed).
 *
 * The `<img>` adopts the screencast's aspect ratio in
 * `buildLiveBrowserElement` (via `style.aspectRatio`), so its
 * bounding rect IS the rendered image area — no object-fit /
 * letterbox compensation needed. `naturalWidth`/`naturalHeight`
 * equal the cloud Chromium viewport once frames arrive; before
 * that we fall back to the supplied display dimensions.
 *
 * Exported for unit testing; surface code calls `attachInputCapture`.
 */
export function translateClick(
  img: HTMLImageElement,
  e: { clientX: number; clientY: number },
  fallbackWidth: number,
  fallbackHeight: number,
): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const lx = e.clientX - rect.left;
  const ly = e.clientY - rect.top;
  const xn = lx / rect.width;
  const yn = ly / rect.height;
  // Bounds check — accept the closed [0, 1] interval since edge
  // clicks are valid (a click on the rightmost pixel column is xn=1).
  if (xn < 0 || xn > 1 || yn < 0 || yn > 1) return null;
  // Logical pixels — prefer the live JPEG natural dimensions (which
  // equal the cloud viewport once frames arrive); fall back to the
  // session's display dims when no frame has arrived yet.
  const targetWidth = img.naturalWidth > 0 ? img.naturalWidth : fallbackWidth;
  const targetHeight = img.naturalHeight > 0 ? img.naturalHeight : fallbackHeight;
  return {
    x: Math.round(xn * targetWidth),
    y: Math.round(yn * targetHeight),
  };
}

function mouseButton(button: number): "left" | "right" | "middle" {
  if (button === 2) return "right";
  if (button === 1) return "middle";
  return "left";
}

/**
 * Slice 2e — spawn a brief expanding+fading circle at the click
 * coordinate. Pure DOM animation; the ripple element auto-removes
 * after `RIPPLE_DURATION_MS`. No wire involvement — this is local
 * feedback so the user sees "my click registered there" without
 * waiting for the next screencast frame.
 *
 * Mounted to the img's parent so the ripple positions absolutely
 * against the same coordinate space the click came from. The
 * parent (live_browser root div) has `position: relative` set in
 * `buildLiveBrowserElement` for the placeholder, which is
 * convenient for our absolute positioning here.
 *
 * Defensive: if the img has no parent (test shim, mid-detach), the
 * ripple is silently skipped — feedback is best-effort UX, never
 * load-bearing for the click forwarding itself.
 */
function spawnClickRipple(img: HTMLImageElement, e: MouseEvent): void {
  const parent = img.parentElement;
  if (!parent) return;
  // Compute click position relative to the img's own bounding rect,
  // then offset by the img's offsetLeft/Top within the parent. This
  // keeps the ripple anchored even if the parent has padding/margin
  // around the img.
  const rect = img.getBoundingClientRect();
  const lx = e.clientX - rect.left;
  const ly = e.clientY - rect.top;
  const ripple = document.createElement("span");
  ripple.className = "cobrowse-click-ripple";
  // Position absolute relative to parent. img.offsetLeft/Top
  // accounts for parent-internal layout (padding, sibling-induced
  // offsets); rect-based lx/ly is then the click point INSIDE the
  // img. Sum gives the click point in parent-local coordinates.
  const cx = img.offsetLeft + lx;
  const cy = img.offsetTop + ly;
  ripple.style.position = "absolute";
  ripple.style.left = `${cx}px`;
  ripple.style.top = `${cy}px`;
  ripple.style.width = "0";
  ripple.style.height = "0";
  // Translate-50% centers the ripple on (cx, cy) regardless of
  // its size at any given animation frame.
  ripple.style.transform = "translate(-50%, -50%)";
  ripple.style.borderRadius = "50%";
  ripple.style.background = "rgba(80, 130, 200, 0.42)";
  ripple.style.pointerEvents = "none";
  ripple.style.opacity = "0.6";
  ripple.style.transition = `width ${RIPPLE_DURATION_MS}ms ease-out, height ${RIPPLE_DURATION_MS}ms ease-out, opacity ${RIPPLE_DURATION_MS}ms ease-out`;
  parent.appendChild(ripple);
  // Force a reflow so the transition starts from the initial 0/0.6
  // state rather than collapsing to the final 30/0 with no visible
  // animation.
  void ripple.offsetWidth;
  ripple.style.width = `${RIPPLE_SIZE_PX}px`;
  ripple.style.height = `${RIPPLE_SIZE_PX}px`;
  ripple.style.opacity = "0";
  setTimeout(() => {
    ripple.remove();
  }, RIPPLE_DURATION_MS + 16);
}

const RIPPLE_DURATION_MS = 400;
const RIPPLE_SIZE_PX = 30;

const PURE_MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
]);
