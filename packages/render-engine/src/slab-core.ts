/**
 * Slab Core — the state-machine half of the "Motebit Computer."
 *
 * Doctrine: `docs/doctrine/motebit-computer.md` §"Mode contract" + §"Three
 * end states." The slab's lifecycle (emerging → active/resting → dissolving
 * | pinching → detached → gone), the ambient count rule (slabHidden items
 * excluded), the user-held visibility override, and the detach-handoff
 * timing are Ring 1 — the same machinery on every surface that renders a
 * slab. Renderers (Three.js plane on desktop/web, held tablet on spatial)
 * are Ring 3 — they consume the core's per-frame snapshot and apply
 * surface-native visuals. One state machine, many bodies.
 *
 * What lives here:
 *   - Items map keyed by id. Per-item phase, phaseTime, slabHidden flag.
 *   - Phase transitions driven by elapsed time (EMERGE / DISSOLVE / PINCH
 *     durations + detached tail).
 *   - Detach handoff: when a pinching item crosses the surface-tension
 *     separation moment, the renderer's `detachHandler` is invoked and
 *     the resulting `ArtifactHandle` resolves the `detachItemAsArtifact`
 *     promise.
 *   - Ambient state: planeVisibility (eased toward target by active count
 *     OR userHeldVisible), activeWarmth (eased toward 1 when active).
 *
 * What does NOT live here:
 *   - Three.js meshes, materials, geometry.
 *   - DOM elements, CSS3DObject anchors, element.style mutations.
 *   - Sympathetic-breathing scale application (renderers apply the
 *     amplitude factor to their own surface).
 *
 * The renderer's `update(t, deltaTime)` calls `core.tick(deltaTime)` once
 * per frame, then applies the returned snapshot to its surface.
 */

import type {
  ArtifactSpec,
  ArtifactHandle,
  SlabBodyRegister,
  SlabItemKind,
  SlabItemHandle,
  SlabItemPhase,
} from "./spec.js";

// ── Lifecycle constants ──────────────────────────────────────────────
//
// Doctrine-locked durations; renderers inherit. Drift between desktop
// and spatial would mean the same item lives a different length on each
// surface — Ring 1 leak.

/** Emerging phase duration (seconds). Doctrine: motebit-computer.md §Lifecycle. */
export const SLAB_EMERGE_DURATION_S = 0.4;
/** Dissolving phase duration (seconds). */
export const SLAB_DISSOLVE_DURATION_S = 0.3;
/** Pinching phase total duration (seconds). */
export const SLAB_PINCH_DURATION_S = 0.8;
/** Detached tail before transitioning to gone (seconds). */
export const SLAB_DETACHED_TAIL_S = 0.05;

/**
 * Pinch handoff fires when normalized pinch progress (t ∈ [0,1]) crosses
 * this threshold during phase 2 (the tendril-snap moment, t ∈ [0.35,
 * 0.55]). At local progress ≥ 0.85 inside phase 2, the bead has
 * separated; the renderer's detach handler is invoked and the artifact
 * appears as the slab-mounted copy dissipates.
 */
export const SLAB_PINCH_PHASE2_START = 0.35;
export const SLAB_PINCH_PHASE2_END = 0.55;
export const SLAB_PINCH_HANDOFF_LOCAL = 0.85;

// ── Sympathetic breathing — both renderers inherit ───────────────────
//
// Doctrine: liquescentia-as-substrate.md §V.2 (quiescence). Frequency
// derived from the Rayleigh eigenmode equation in the creature's
// quiescent regime; amplitude factor sets slab as 30% of creature's
// breath. Renderers multiply by their own surface scale unit.

/** Sympathetic breathing frequency (Hz). Inherits from creature. */
export const SLAB_BREATHE_FREQUENCY_HZ = 0.3;
/** Slab amplitude factor relative to creature. 0.3 = same body, not mimic. */
export const SLAB_BREATHE_AMPLITUDE_FACTOR = 0.3;

/**
 * Empty-held membrane opacity. The slab's "present-but-recessed"
 * register — the user invoked `/computer` (or Option+C); the slab
 * acknowledges the invocation by becoming visible-but-faint. Doctrine
 * (motebit-computer.md §"Visual properties"): the asymmetry between
 * "present" and "active" depends on this being well below the active
 * register so the two states don't conflate. 0.20 reads as glass-at-
 * rest; 0.85 (the legacy value) read as "still working" and made
 * every empty held slab fight the active register.
 */
export const MEMBRANE_OPACITY = 0.2;
/**
 * Drag-hover lift target. When the user drags content over the slab's
 * screen-space rect, the membrane lifts to this opacity so it signals
 * targetability without preempting the gesture. Sits between
 * `MEMBRANE_OPACITY` and the active register (1.0) so the slab reads
 * as "I can take this" but not as "I am working."
 */
const DRAG_HOVER_OPACITY = 0.65;

// ── Detach handler ───────────────────────────────────────────────────

/**
 * Function the core invokes when a pinching item reaches separation —
 * the renderer (or its host adapter) spawns the detached artifact in
 * the wider scene and returns the handle. Injected at construction so
 * `slab-core.ts` doesn't depend on `artifacts.ts`.
 */
export type DetachArtifactHandler = (spec: ArtifactSpec) => ArtifactHandle | undefined;

// ── Frame snapshot ───────────────────────────────────────────────────

/**
 * Per-item state the renderer needs to apply visuals. The renderer
 * keeps its own parallel map keyed by id (DOM element, mesh, etc.); on
 * each tick it iterates this list and applies surface-native rendering.
 *
 * Items that just transitioned to `gone` appear once with phase=gone
 * so the renderer can clean up its parallel state, then disappear on
 * the next tick.
 */
export interface SlabCoreItemSnapshot {
  readonly id: string;
  readonly kind: SlabItemKind;
  readonly slabHidden: boolean;
  readonly phase: SlabItemPhase;
  readonly phaseTime: number;
}

/**
 * Per-frame snapshot returned by `tick()`. The renderer uses this to
 * drive its surface-native visuals; nothing else in the snapshot leaks
 * rendering primitives.
 */
export interface SlabCoreFrame {
  readonly items: readonly SlabCoreItemSnapshot[];
  /**
   * Eased ambient surface presence, 0..1. On desktop drives
   * `planeMesh.visible` + `material.opacity`; on spatial drives the
   * held-tablet's emerge/recede. Same conceptual axis.
   */
  readonly planeVisibility: number;
  /**
   * Eased active-warmth coupling, 0..1. Renderers couple soul color
   * onto their slab material when warmth > 0.
   */
  readonly activeWarmth: number;
  /**
   * Body register — what occupies the body region right now (home
   * affordances, live screencast, or home overlaying a dim screencast).
   * Renderers derive screen-mesh visibility from this value; surfaces
   * read it to decide which content to mount in `bodySlot`. One source
   * of truth for the body's tri-state, lifted out of the prior
   * implicit coupling between {screenTexture, screencastSuppressed}.
   * Doctrine: `motebit-computer.md` §"Body register — the tri-state."
   */
  readonly bodyRegister: SlabBodyRegister;
}

export interface SlabCoreDeps {
  detachHandler?: DetachArtifactHandler | null;
}

// ── Internal state ───────────────────────────────────────────────────

interface ManagedSlabCoreItem {
  id: string;
  kind: SlabItemKind;
  slabHidden: boolean;
  phase: SlabItemPhase;
  phaseTime: number;
  phaseListeners: Set<(phase: SlabItemPhase) => void>;
  /** Artifact spec captured by `detachItemAsArtifact`; consumed at handoff. */
  detachTo?: ArtifactSpec;
  /** Resolves `dissolveItem`'s promise when the dissolve completes. */
  dissolveResolve?: () => void;
  /** Resolves `detachItemAsArtifact`'s promise after the detached tail. */
  detachResolve?: (handle: ArtifactHandle | undefined) => void;
  /** Stored handle from the renderer's detachHandler — what `detachResolve` returns. */
  detachArtifactHandle?: ArtifactHandle | undefined;
  /** True once the core has invoked `detachHandler` for this item. */
  detachHandoffFired: boolean;
}

// ── SlabCore ─────────────────────────────────────────────────────────

export class SlabCore {
  private readonly items = new Map<string, ManagedSlabCoreItem>();
  private readonly detachHandler: DetachArtifactHandler | null;

  /** Eased plane visibility, 0..1. */
  private planeVisibility = 0;
  /** Eased active warmth, 0..1. */
  private activeWarmth = 0;
  /**
   * Legacy "force-show empty plane" override. Pre-shell-mounted-on-boot,
   * Option+C / `/computer` would set this so the empty plane appeared at
   * `MEMBRANE_OPACITY` (the recessed "present, ready" register). Surfaces
   * that don't mount a `live_browser` shell still rely on it.
   */
  private userHeldVisible = false;
  /**
   * Force-hide override. Set when the user dismisses the slab via
   * Option+C / `/computer` — takes precedence over active items and
   * drag-hover so the user can hide the plane even when the live_browser
   * shell is mounted (the intent-gated-slab affirmative shape that
   * makes the legacy "force-show empty plane" semantic redundant on
   * shell-equipped surfaces). Doctrine: motebit-computer.md §"Ambient
   * states — User-held visibility (orthogonal)."
   */
  private userHeldHidden = false;
  /**
   * Drag-hover override (slab-honesty membrane work). When the user is
   * dragging content over the slab's surface, the membrane lifts from
   * the recessed `MEMBRANE_OPACITY` (0.20) up to `DRAG_HOVER_OPACITY`
   * (0.65) so the slab signals targetability without preempting the
   * gesture. Cleared on drop or dragleave. Doctrine: motebit-
   * computer.md §"The user's touch — supervised agency" + the
   * calm-software pattern (drop targets answer, don't shout).
   */
  private dragHover = false;
  /**
   * Body register — what's in the body region right now. Surfaces
   * write via `setBodyRegister`; renderers read via `getBodyRegister`
   * or the per-frame snapshot. Default `home`: empty-but-ready is the
   * floor (the intent-gated-slab principle). The register lifts the
   * prior implicit coupling between {screenTexture present, suppressed
   * flag} into one named state — three values, one source of truth.
   * Doctrine: `motebit-computer.md` §"Body register — the tri-state."
   */
  private bodyRegister: SlabBodyRegister = "home";

  constructor(deps: SlabCoreDeps = {}) {
    this.detachHandler = deps.detachHandler ?? null;
  }

  // ── Public mutators ───────────────────────────────────────────────

  /**
   * Register an item in the state machine. Returns a handle whose
   * `getPhase` reads live state and whose `onPhaseChange` subscribes
   * to transitions. The renderer is responsible for whatever per-item
   * rendering state it owns (DOM element, mesh, etc.) — the core
   * tracks only id/kind/slabHidden + lifecycle.
   */
  addItem(args: { id: string; kind: SlabItemKind; slabHidden?: boolean }): SlabItemHandle {
    const item: ManagedSlabCoreItem = {
      id: args.id,
      kind: args.kind,
      slabHidden: args.slabHidden ?? false,
      phase: "emerging",
      phaseTime: 0,
      phaseListeners: new Set(),
      detachHandoffFired: false,
    };
    this.items.set(args.id, item);

    return {
      id: args.id,
      getPhase: () => item.phase,
      onPhaseChange: (listener) => {
        item.phaseListeners.add(listener);
        return () => item.phaseListeners.delete(listener);
      },
    };
  }

  dissolveItem(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) return Promise.resolve();
    if (item.phase === "dissolving" || item.phase === "gone") {
      return new Promise<void>((r) => {
        item.dissolveResolve = r;
      });
    }
    this.setPhase(item, "dissolving");
    item.phaseTime = 0;
    return new Promise<void>((r) => {
      item.dissolveResolve = r;
    });
  }

  detachItemAsArtifact(id: string, artifact: ArtifactSpec): Promise<ArtifactHandle | undefined> {
    const item = this.items.get(id);
    if (!item) return Promise.resolve(undefined);
    if (item.phase === "pinching" || item.phase === "detached" || item.phase === "gone") {
      return new Promise<ArtifactHandle | undefined>((r) => {
        item.detachResolve = r;
      });
    }
    item.detachTo = artifact;
    this.setPhase(item, "pinching");
    item.phaseTime = 0;
    return new Promise<ArtifactHandle | undefined>((r) => {
      item.detachResolve = r;
    });
  }

  clearItems(): void {
    // Drop every tracked id without firing transitions — same shape
    // as `removeImmediate` from the original SlabManager. Pending
    // dissolve/detach promises are abandoned (matching prior
    // behavior); callers that need clean teardown should dissolve
    // first.
    for (const item of this.items.values()) {
      item.phaseListeners.clear();
    }
    this.items.clear();
  }

  setUserVisible(visible: boolean): void {
    // Two state bits move in lockstep:
    //   userHeldHidden — force-hide override (precedence over items
    //     + drag-hover); the new lever for shell-mounted surfaces.
    //   userHeldVisible — legacy "force-show empty plane" (only
    //     matters when no items are mounted; preserved for surfaces
    //     that don't mount a live_browser shell).
    this.userHeldHidden = !visible;
    this.userHeldVisible = visible;
    // Symmetric snap. The slab is rendered via TWO compositors —
    // WebGL (plane material.opacity) and CSS3D (stage element with
    // backdrop-filter chrome). They only stay in visual lockstep
    // through a transition when that transition is instant. Any
    // easing in `tick()` creates the "URL bar persists past slab
    // body" desync because the chrome's white-panel mass starts at
    // ~97% perceived opacity while the glass plane starts at 20%.
    // Same proportional decay, very different perceived presence.
    // Snap on both edges: pre-warm up to the empty-held target on
    // reveal, pre-warm down to 0 on hide. Both registers cross the
    // visibility threshold in the same frame and the slab moves as
    // one piece. Reveal-intact == hide-intact.
    if (visible && this.planeVisibility < MEMBRANE_OPACITY) {
      this.planeVisibility = MEMBRANE_OPACITY;
    } else if (!visible) {
      this.planeVisibility = 0;
    }
  }

  /**
   * Whether the slab is currently shown to the user. True iff the
   * user hasn't force-hidden AND (items are present OR the user-
   * held register is active). The truth condition for the slash-
   * command presence gate — `/computer` reads this to decide
   * whether to dismiss (true) or invoke + show (false).
   *
   * Note: under intent-gated mount, an item can appear in the data
   * model microseconds before the user has seen the slab visually;
   * `isUserVisible()` returns true at that moment, so callers that
   * just mounted an item should not query this in the same frame
   * unless they want "is the slab plumbed" rather than "has the
   * user seen the slab." For the slash-command gate, querying
   * BEFORE invokeComputer is correct: it reflects the pre-press
   * state.
   */
  isUserVisible(): boolean {
    return !this.userHeldHidden && (this.hasVisibleItem() || this.userHeldVisible);
  }

  /**
   * Flip the user's visibility intent and return the new visible
   * state. The toggle inspects whether the slab is currently shown
   * to the user — items present (and not force-hidden), or the
   * legacy "user-held visible" register active — and inverts.
   *
   *   - Shell-mounted surface, default state: items always present
   *     → first toggle hides (returns `false`), second shows.
   *   - Shell-less surface, default state: no items, no hold →
   *     first toggle reveals at MEMBRANE_OPACITY (returns `true`),
   *     second dismisses.
   *
   * Surfaces that display a toast / indicator can mirror the return
   * value directly without re-querying state.
   */
  toggleUserVisible(): boolean {
    const currentlyShown = !this.userHeldHidden && (this.hasVisibleItem() || this.userHeldVisible);
    this.setUserVisible(!currentlyShown);
    return !this.userHeldHidden;
  }

  /**
   * Whether at least one non-hidden, non-terminal item is on the
   * slab. Mirrors the active-count loop in `tick()` — kept private
   * because this signal is meaningful only for the toggle's
   * "currently shown" check.
   */
  private hasVisibleItem(): boolean {
    for (const item of this.items.values()) {
      if (item.slabHidden) continue;
      if (item.phase === "dissolving" || item.phase === "detached" || item.phase === "gone") {
        continue;
      }
      return true;
    }
    return false;
  }

  /**
   * Drag-hover signal — set true when the user starts dragging
   * content (file, URL, text) over the slab's screen-space rect, false
   * on drop / dragleave. The empty membrane lifts from
   * `MEMBRANE_OPACITY` to `DRAG_HOVER_OPACITY` so the slab signals
   * "I can take this" without preempting the gesture. Has no effect
   * when items are present (the active register already owns the
   * plane). Idempotent.
   */
  setDragHover(hovering: boolean): void {
    this.dragHover = hovering;
  }

  /**
   * Set the body register. Idempotent; calling with the current value
   * is a no-op (the renderer reads from snapshot each tick, so the
   * caller doesn't need to track prior state). Doctrine:
   * `motebit-computer.md` §"Body register — the tri-state."
   */
  setBodyRegister(register: SlabBodyRegister): void {
    this.bodyRegister = register;
  }

  /** Current body register. Read by renderers to derive mesh visibility. */
  getBodyRegister(): SlabBodyRegister {
    return this.bodyRegister;
  }

  /** Read-only check used by renderers to gate per-id parallel state. */
  hasItem(id: string): boolean {
    return this.items.has(id);
  }

  // ── Per-frame tick ────────────────────────────────────────────────

  /**
   * Drive the state machine forward by `deltaTime` and return the
   * frame snapshot. Resolves dissolve/detach promises and fires phase
   * listeners as transitions happen. Items that transition into
   * `gone` appear in the returned `items` once (so renderers can
   * clean up parallel state) and are removed from internal state at
   * the end of tick — they will not appear on the next call.
   */
  tick(deltaTime: number): SlabCoreFrame {
    // Advance per-item state. Collect ids that became `gone` this
    // tick so we can remove them after building the snapshot.
    const goneThisTick: string[] = [];
    for (const item of this.items.values()) {
      item.phaseTime += deltaTime;
      this.advanceItem(item);
      if (item.phase === "gone") goneThisTick.push(item.id);
    }

    // Ambient: count non-terminal *visible* items. Hidden mind-mode
    // items must not raise the surface — doctrine
    // motebit-computer.md §"Ambient states" + the bug fix in commit
    // 89467720.
    let activeCount = 0;
    for (const item of this.items.values()) {
      if (item.slabHidden) continue;
      if (item.phase === "dissolving" || item.phase === "detached" || item.phase === "gone") {
        continue;
      }
      activeCount++;
    }

    // Plane visibility easing — one force-hide override + three
    // present-states.
    //
    //   0. User-toggled hidden → ease to 0. Takes precedence over
    //      everything else so Option+C / `/computer` can dismiss
    //      the always-mounted shell. This is the lever the
    //      shell-mounted-on-boot architecture needs (item count is
    //      always > 0 once the live_browser shell is up).
    //   1. Items present       → snap toward 1.0 fast (rate 3).
    //      Active register; warmth rises with it.
    //   2. Drag-hover          → ease to DRAG_HOVER_OPACITY. The
    //      user is asking the surface to receive a gesture; the
    //      slab lifts to signal "I can take this," whether or not
    //      it was held open before the drag started.
    //   3. User-held visible   → ease to MEMBRANE_OPACITY (faint
    //      "present" register; legacy lever for shell-less
    //      surfaces).
    //   4. Otherwise           → ease to 0 (full dissolve).
    //
    // Drag-hover overrides user-held-visible (active gesture beats
    // passive hold). userHeldHidden overrides everything (explicit
    // dismiss beats every other signal).
    let warmthTarget = 0;
    if (this.userHeldHidden) {
      this.planeVisibility = smoothToward(this.planeVisibility, 0, deltaTime, 4);
    } else if (activeCount > 0) {
      this.planeVisibility = Math.min(1, this.planeVisibility + deltaTime * 3);
      warmthTarget = 1;
    } else if (this.dragHover) {
      // Faster ease (rate 6) so the slab answers the gesture
      // promptly — slow ease here would feel like the slab is
      // hesitating to take the drop.
      this.planeVisibility = smoothToward(this.planeVisibility, DRAG_HOVER_OPACITY, deltaTime, 6);
    } else if (this.userHeldVisible) {
      this.planeVisibility = smoothToward(this.planeVisibility, MEMBRANE_OPACITY, deltaTime, 4);
    } else {
      this.planeVisibility = smoothToward(this.planeVisibility, 0, deltaTime, 4);
    }
    this.activeWarmth = smoothToward(this.activeWarmth, warmthTarget, deltaTime, 2.5);

    // Build snapshot — includes any items that just hit `gone` so
    // renderers can run final cleanup.
    const snapshot: SlabCoreItemSnapshot[] = [];
    for (const item of this.items.values()) {
      snapshot.push({
        id: item.id,
        kind: item.kind,
        slabHidden: item.slabHidden,
        phase: item.phase,
        phaseTime: item.phaseTime,
      });
    }

    // Now drop the gone items so they don't reappear next tick.
    for (const id of goneThisTick) {
      const item = this.items.get(id);
      if (item) item.phaseListeners.clear();
      this.items.delete(id);
    }

    return {
      items: snapshot,
      planeVisibility: this.planeVisibility,
      activeWarmth: this.activeWarmth,
      bodyRegister: this.bodyRegister,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────

  private setPhase(item: ManagedSlabCoreItem, phase: SlabItemPhase): void {
    item.phase = phase;
    for (const listener of item.phaseListeners) {
      try {
        listener(phase);
      } catch {
        // Listener exceptions are isolated — core state must not be
        // affected by a caller's subscription error.
      }
    }
  }

  private advanceItem(item: ManagedSlabCoreItem): void {
    switch (item.phase) {
      case "emerging": {
        if (item.phaseTime >= SLAB_EMERGE_DURATION_S) {
          this.setPhase(item, "active");
          item.phaseTime = 0;
        }
        break;
      }
      case "active":
      case "resting":
        // Steady states — no time-driven transition. Caller drives
        // the active → resting move via a future explicit API; the
        // current contract leaves the renderer / runtime in charge
        // of when work is "done."
        break;
      case "dissolving": {
        if (item.phaseTime >= SLAB_DISSOLVE_DURATION_S) {
          this.setPhase(item, "gone");
          item.dissolveResolve?.();
        }
        break;
      }
      case "pinching": {
        const t = Math.min(1, item.phaseTime / SLAB_PINCH_DURATION_S);
        // Detach handoff: phase 2 (tendril snap) at local progress
        // >= 0.85 of the [0.35, 0.55] window. Renderer is invoked
        // exactly once per item via `detachHandoffFired`. Defensive
        // dissipation-phase handoff: if a slow frame skipped the
        // window, fire here so the caller still gets the artifact.
        if (item.detachTo && !item.detachHandoffFired) {
          if (t >= SLAB_PINCH_PHASE2_START && t < SLAB_PINCH_PHASE2_END) {
            const local =
              (t - SLAB_PINCH_PHASE2_START) / (SLAB_PINCH_PHASE2_END - SLAB_PINCH_PHASE2_START);
            if (local >= SLAB_PINCH_HANDOFF_LOCAL) {
              this.fireDetachHandoff(item);
            }
          } else if (t >= SLAB_PINCH_PHASE2_END) {
            this.fireDetachHandoff(item);
          }
        }
        if (item.phaseTime >= SLAB_PINCH_DURATION_S) {
          this.setPhase(item, "detached");
          item.phaseTime = 0;
        }
        break;
      }
      case "detached": {
        if (item.phaseTime >= SLAB_DETACHED_TAIL_S) {
          this.setPhase(item, "gone");
          item.detachResolve?.(item.detachArtifactHandle);
        }
        break;
      }
      case "gone":
        // Already terminal — tick will drop it after building the
        // snapshot. Defensive no-op.
        break;
    }
  }

  private fireDetachHandoff(item: ManagedSlabCoreItem): void {
    item.detachHandoffFired = true;
    if (item.detachTo && this.detachHandler) {
      try {
        item.detachArtifactHandle = this.detachHandler(item.detachTo);
      } catch {
        // Handler exceptions abandon the artifact — the detach
        // promise resolves with `undefined`, mirroring the headless
        // no-handler path.
        item.detachArtifactHandle = undefined;
      }
    }
  }
}

function smoothToward(current: number, target: number, deltaTime: number, rate: number): number {
  const factor = 1 - Math.exp(-rate * deltaTime);
  return current + (target - current) * factor;
}
