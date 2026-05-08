/**
 * Slab plane two-finger-hold gesture — the user's stop button.
 *
 * Doctrine: `motebit-computer.md` §"The user's touch — supervised
 * agency". Three direct gestures supervise agency on the slab without
 * interrupting the AI loop:
 *
 *   - **Tap** an item → focus / inspect (handled in `slab-items.ts`).
 *   - **Long-press** an item → pin (handled in `slab-items.ts`).
 *   - **Swipe** an item → force-dissolve (handled in `slab-items.ts`).
 *   - **Two-finger hold** on the plane → halt the session (here).
 *
 * The first three are item-scoped acts on a particular receipt. The
 * fourth is plane-scoped — it preempts dispatch for the whole session.
 * It composes with the runtime's `ComputerSessionManager.halt()`
 * primitive (v1.2): same `user_preempted` boundary, three triggers
 * (slash command, this gesture, AI's own future "stop" tool), one
 * fail-closed contract per `computer-use-v1.md §3.3`.
 *
 * Why a pure state machine? Test environments have no `PointerEvent`
 * and no `requestAnimationFrame`. Splitting the gesture logic from the
 * DOM wiring lets the detector run honestly under vitest, and keeps
 * the wiring layer thin enough to inspect at a glance. Sibling pattern
 * to `SlabCore` / `SlabManager` (Ring 1 state machine + Ring 3
 * renderer).
 *
 * The hold threshold (700ms) is calibrated from the canonical
 * accidental-touch literature: < 300ms is plausibly a tap on stacked
 * cards, > 1s is a learnable user-action pause. 700ms sits comfortably
 * in the "deliberate" band, matching Material's long-press default
 * and iOS's contextual-menu hold.
 *
 * The movement tolerance (12px CSS) is enough to absorb finger
 * micro-jitter on touch surfaces but tight enough that an actual scroll
 * or pan cancels the hold — the user's intent must be still.
 */

const DEFAULT_HOLD_MS = 700;
const DEFAULT_MOVE_TOLERANCE_PX = 12;

export interface PlaneGestureCallbacks {
  /**
   * Hold completed — fire the user's halt trigger.
   *
   * Called exactly once per arm-and-complete cycle. After firing, the
   * detector enters a fired state until `reset()` is called (typically
   * when the user resumes via slash command or the app explicitly
   * clears halt state).
   */
  onHaltTriggered: () => void;
  /**
   * Hold progress (0..1) — for visual feedback during the hold. Called
   * on each `tick()` whenever the value changes, including transitions
   * to/from 0 (arm/disarm).
   */
  onProgress?: (fraction: number) => void;
  /**
   * Hold cancelled before completion — pointer lifted or moved past
   * tolerance. Called once per disarm, never paired with a successful
   * `onHaltTriggered`.
   */
  onCancel?: () => void;
}

export interface PlaneGestureOptions {
  /** Hold duration in milliseconds before halt fires. Default 700ms. */
  holdMs?: number;
  /** Movement tolerance in CSS pixels — exceeding this cancels. Default 12px. */
  moveTolerancePx?: number;
}

interface PointerSnapshot {
  startX: number;
  startY: number;
}

export interface PlaneGestureDetector {
  /** Number of currently-tracked pointers. Test surface only. */
  pointerCount(): number;
  /** True between arm (two pointers down) and either fire or disarm. */
  isArmed(): boolean;
  /** True after `onHaltTriggered` fired; cleared by `reset()`. */
  hasFired(): boolean;
  /** Register a pointer-down. */
  onPointerDown(pointerId: number, x: number, y: number, now: number): void;
  /** Update a pointer position; cancels the hold if it moves past tolerance. */
  onPointerMove(pointerId: number, x: number, y: number): void;
  /** Drop a pointer — pointer-up or pointer-cancel. */
  onPointerUp(pointerId: number): void;
  /** Drive progress + completion. Should be called from a frame tick. */
  tick(now: number): void;
  /**
   * Clear all state. Use after the consumer has acted on the halt
   * (e.g. after the user resumes the session) so the detector is
   * ready to fire again.
   */
  reset(): void;
}

export function createPlaneGestureDetector(
  callbacks: PlaneGestureCallbacks,
  options: PlaneGestureOptions = {},
): PlaneGestureDetector {
  const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  const tolerancePx = options.moveTolerancePx ?? DEFAULT_MOVE_TOLERANCE_PX;
  const toleranceSq = tolerancePx * tolerancePx;

  const pointers = new Map<number, PointerSnapshot>();
  let armedAt: number | null = null;
  let fired = false;
  // -1 sentinel = "no progress yet emitted." Lets the first arm
  // (progress 0) fire onProgress, while a same-frame second tick
  // at progress 0 stays deduped.
  let lastProgress = -1;

  function emitProgress(value: number): void {
    if (value !== lastProgress) {
      lastProgress = value;
      callbacks.onProgress?.(value);
    }
  }

  function arm(now: number): void {
    if (armedAt !== null || fired) return;
    armedAt = now;
    emitProgress(0);
  }

  function disarm(): void {
    if (armedAt === null) return;
    armedAt = null;
    // Reset lastProgress to the sentinel so the next arm re-emits 0.
    lastProgress = -1;
    callbacks.onProgress?.(0);
    callbacks.onCancel?.();
  }

  function rearmCheck(now: number): void {
    // If we still have ≥ 2 pointers and aren't armed (e.g. one moved
    // out and was deleted, then a new one came in), arm again.
    // If we dropped below 2 while armed, disarm.
    if (fired) return;
    if (pointers.size >= 2 && armedAt === null) {
      arm(now);
    } else if (pointers.size < 2 && armedAt !== null) {
      disarm();
    }
  }

  function onPointerDown(pointerId: number, x: number, y: number, now: number): void {
    if (fired) return;
    pointers.set(pointerId, { startX: x, startY: y });
    rearmCheck(now);
  }

  function onPointerMove(pointerId: number, x: number, y: number): void {
    if (fired) return;
    const snap = pointers.get(pointerId);
    if (!snap) return;
    const dx = x - snap.startX;
    const dy = y - snap.startY;
    if (dx * dx + dy * dy > toleranceSq) {
      // Treat the move as a release — the user is panning, not holding.
      // The pointer stays "active" in the OS but is no longer counted
      // for the hold; if it returns to near-still we don't re-track it
      // unless a fresh pointerdown occurs.
      pointers.delete(pointerId);
      rearmCheck(performance.now());
    }
  }

  function onPointerUp(pointerId: number): void {
    if (!pointers.delete(pointerId)) return;
    rearmCheck(performance.now());
  }

  function tick(now: number): void {
    if (fired || armedAt === null) return;
    const elapsed = now - armedAt;
    const progress = Math.min(1, Math.max(0, elapsed / holdMs));
    emitProgress(progress);
    if (progress >= 1) {
      fired = true;
      armedAt = null;
      callbacks.onHaltTriggered();
    }
  }

  function reset(): void {
    const wasNonZero = lastProgress > 0;
    pointers.clear();
    armedAt = null;
    fired = false;
    lastProgress = -1;
    if (wasNonZero) {
      callbacks.onProgress?.(0);
    }
  }

  return {
    pointerCount: () => pointers.size,
    isArmed: () => armedAt !== null,
    hasFired: () => fired,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    tick,
    reset,
  };
}

/**
 * Wire a plane-gesture detector to a DOM `EventTarget` (typically the
 * slab's CSS3D-renderer container). Returns a disposer.
 *
 * Filters to `pointerType === "touch"` so trackpad two-finger gestures
 * (which manifest as wheel events on macOS Chromium, not pointers) and
 * mouse-and-keyboard combos don't accidentally arm the gesture. The
 * desktop trigger is the slash command, not a synthetic touch
 * simulation.
 *
 * The bounding-rect check guards against bubbled pointer events from
 * outside the slab — if the user is touching the chat list with two
 * fingers, that's a scroll, not a halt request.
 *
 * The caller drives `detector.tick()` from the same animation loop the
 * SlabManager uses, so progress visuals stay in lockstep with the
 * sympathetic-breathing pulse and there's no parallel rAF loop. The
 * disposer just removes the four event listeners; tick lifecycle
 * belongs to whatever owns the animation loop.
 */
export function attachPlaneGestureToTarget(
  target: EventTarget,
  detector: PlaneGestureDetector,
  getBoundsRect?: () => { left: number; top: number; right: number; bottom: number } | null,
): () => void {
  function withinBounds(x: number, y: number): boolean {
    if (!getBoundsRect) return true;
    const r = getBoundsRect();
    if (!r) return false;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function isTouchPointer(e: Event): e is PointerEvent {
    return (
      typeof PointerEvent !== "undefined" && e instanceof PointerEvent && e.pointerType === "touch"
    );
  }

  const onDown = (e: Event): void => {
    if (!isTouchPointer(e)) return;
    if (!withinBounds(e.clientX, e.clientY)) return;
    detector.onPointerDown(e.pointerId, e.clientX, e.clientY, performance.now());
  };
  const onMove = (e: Event): void => {
    if (!isTouchPointer(e)) return;
    detector.onPointerMove(e.pointerId, e.clientX, e.clientY);
  };
  const onUp = (e: Event): void => {
    if (!isTouchPointer(e)) return;
    detector.onPointerUp(e.pointerId);
  };

  target.addEventListener("pointerdown", onDown);
  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerup", onUp);
  target.addEventListener("pointercancel", onUp);

  return () => {
    target.removeEventListener("pointerdown", onDown);
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerup", onUp);
    target.removeEventListener("pointercancel", onUp);
  };
}
