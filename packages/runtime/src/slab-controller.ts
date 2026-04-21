/**
 * Slab controller — the "Motebit Computer" event translation layer.
 *
 * See docs/doctrine/motebit-computer.md for the semantic contract. This
 * module is Layer 4 (runtime, BSL); it owns the bridge between the
 * runtime's internal event streams (LLM tokens, tool calls, plan steps,
 * shell output, fetches, embeddings) and the typed lifecycle events
 * renderers consume via `@motebit/render-engine`'s `SlabItem*` contract.
 *
 * Why it lives here and not in the renderer:
 *
 *   - The slab's semantic membership — what IS a slab item, when does
 *     it open, when does it pinch vs dissolve — is a judgment the
 *     runtime is uniquely positioned to make. Renderers know how to
 *     draw a plane and animate a meniscus; they don't know whether a
 *     tool call's output is durable enough to detach as an artifact.
 *
 *   - Keeping the decision layer in the runtime means all three
 *     surfaces (web, desktop, spatial) bind to the same slab events
 *     with zero per-surface reasoning. Ring-1 identical-everywhere
 *     capability — the slab's MEANING is identical across surfaces;
 *     only the rendering diverges.
 *
 * Shape:
 *
 *   - `createSlabController(deps)` factory returning an observable
 *     `SlabController` — mirrors `createGoalsEmitter` / the
 *     `PresenceController` / `SovereignController` pattern used
 *     elsewhere in the runtime.
 *
 *   - State: a map of active slab items + an ambient slab state
 *     (`idle | active | recessed`). Subscribers receive the full state
 *     on every transition, matching the `StateVectorEngine.subscribe`
 *     observer pattern surfaces already know.
 *
 *   - Imperative open/update/end API called at the runtime's existing
 *     event sites — not a push-based subscription on every internal
 *     emitter. The runtime knows when it's starting a stream; it
 *     tells the slab. No ambiguity, no fan-out bookkeeping.
 *
 *   - Detach-vs-dissolve policy is an injected dep so surfaces can
 *     override without forking the controller. Default policy is
 *     conservative (dissolve unless the caller explicitly requested
 *     artifact detachment); callers who know their output is durable
 *     say so at `endItem` time via `outcome.detachAs`.
 *
 * Not in this module:
 *
 *   - No runtime-path wiring. The controller is standalone; callers
 *     (MotebitRuntime's streaming / tool-call / plan-step paths) open
 *     and end items. This keeps the unit under test minimal and the
 *     side-effect surface narrow.
 *
 *   - No rendering. The contract with `@motebit/render-engine` is the
 *     `SlabItemKind` / `SlabItemPhase` types; this controller emits
 *     state containing those types and nothing more.
 */

import type { SlabItemKind, SlabItemPhase } from "@motebit/render-engine";

/**
 * Ambient state of the slab plane itself, independent of individual
 * items. Doctrine (motebit-computer.md §"Silent state"):
 *
 *   - idle      — meniscus + refraction only; zero content, zero glow.
 *                 The slab is present but holding no active items. The
 *                 motebit may be thinking without tool-calling; the
 *                 slab shows that honestly.
 *   - active    — soul-color-tinted internal warmth; at least one item
 *                 is on the slab.
 *   - recessed  — edge refraction only; plane is retained behind the
 *                 scene envelope after a prolonged idle. The next
 *                 emergent item pops against a recessed plane.
 */
export type SlabAmbient = "idle" | "active" | "recessed";

/**
 * A slab item's outcome when it ends. The controller consults
 * `detachPolicy` to decide whether the item transitions through
 * `pinching → detached` (producing an artifact) or `dissolving` (back
 * into the slab surface, no artifact). Callers with a known-durable
 * output can explicitly request `detachAs` to bypass the default
 * policy.
 */
export type SlabItemOutcome =
  | {
      kind: "completed";
      /** Free-form result, consumed by the detachPolicy + renderer. */
      result?: unknown;
      /**
       * If set, the controller immediately detaches as the named
       * artifact kind, bypassing the default policy. Used when the
       * caller knows the output is durable (completed code file,
       * signed receipt, finalized plan).
       */
      detachAs?: ArtifactKindForDetach;
    }
  | { kind: "interrupted" }
  | { kind: "failed"; error: string };

/**
 * Kinds of artifacts a slab item can detach as. Structural subset of
 * `@motebit/render-engine`'s `ArtifactKind` (duplicated here rather
 * than imported to keep the type surface minimal; the intersection is
 * enforced by the renderer at the pinch boundary).
 */
export type ArtifactKindForDetach = "text" | "code" | "plan" | "memory" | "receipt";

/** The policy decision returned by `detachPolicy`. */
export type DetachDecision =
  | { action: "detach"; artifactKind: ArtifactKindForDetach }
  | { action: "dissolve" };

export type DetachPolicy = (item: SlabItem, outcome: SlabItemOutcome) => DetachDecision;

/**
 * Default detach policy. Errs on dissolution — an item that doesn't
 * explicitly declare itself artifact-worthy at end-time dissolves back
 * into the slab rather than spawning a graduated scene object. This
 * matches the "calm software" rule: a tool-call log that the turn used
 * and moved on from should not leave an artifact behind.
 *
 * Callers that know their output is durable pass `detachAs` in the
 * outcome; those take precedence over this policy. Surfaces that want
 * different default behavior inject their own policy via deps.
 */
export const defaultDetachPolicy: DetachPolicy = (_item, outcome) => {
  if (outcome.kind === "completed" && outcome.detachAs) {
    return { action: "detach", artifactKind: outcome.detachAs };
  }
  return { action: "dissolve" };
};

export interface SlabItem {
  readonly id: string;
  readonly kind: SlabItemKind;
  readonly phase: SlabItemPhase;
  readonly openedAt: number;
  readonly lastUpdatedAt: number;
  /**
   * Free-form payload — streamed tokens, tool input/output, plan step
   * status, fetch URL, etc. Renderers narrow by item kind. Typed as
   * `unknown` here because the controller is shape-agnostic.
   */
  readonly payload: unknown;
}

export interface SlabState {
  readonly ambient: SlabAmbient;
  /**
   * Items currently on the slab, keyed by ID. Excludes items in the
   * `gone` phase — those are removed from state after a brief tail
   * for renderer animation coordination, then dropped.
   */
  readonly items: ReadonlyMap<string, SlabItem>;
}

export type SlabSubscriber = (state: SlabState) => void;

export interface SlabControllerDeps {
  /** Policy injection. Defaults to `defaultDetachPolicy`. */
  detachPolicy?: DetachPolicy;
  /**
   * After the last item transitions to `gone`, how long to wait before
   * the ambient state transitions from `idle` to `recessed`. Doctrine:
   * recession is a prolonged-idle signal, not an immediate one. Default
   * 10s — short enough that quiet pauses settle visibly, long enough
   * that a next-turn pop doesn't feel emerged-from-scratch.
   */
  recessionDelayMs?: number;
  /** Inject for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Inject for tests. Defaults to `setTimeout` / `clearTimeout`. */
  scheduleTimeout?: (callback: () => void, delayMs: number) => TimeoutHandle;
  /** Defaults to `console.warn`. */
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/**
 * Opaque handle returned by `scheduleTimeout`. Named so we don't leak
 * `NodeJS.Timeout` vs browser `number` distinctions through the dep
 * interface — tests pass a synthetic timer, production passes real
 * `setTimeout`.
 */
export interface TimeoutHandle {
  cancel(): void;
}

export interface SlabController {
  /** Current state. Snapshots; never a mutable reference. */
  getState(): SlabState;

  /** Observe state transitions. Returns an unsubscribe thunk. */
  subscribe(subscriber: SlabSubscriber): () => void;

  /**
   * Open a new slab item. Emits `emerging` immediately, transitions to
   * `active` on the next tick so renderers can run the emergence
   * animation to completion before any update events arrive.
   *
   * Idempotent on `id` collisions: a second call with the same id is
   * dropped with a logger warning. Callers that legitimately reopen
   * (e.g., a tool call retried) should use a fresh id.
   */
  openItem(spec: { id: string; kind: SlabItemKind; payload?: unknown }): void;

  /**
   * Replace or extend a live item's payload. No phase change. The
   * renderer receives the new state and updates the item in-place.
   * No-op against an unknown id (logged).
   */
  updateItem(id: string, payload: unknown): void;

  /**
   * End an item. Consults `detachPolicy` to decide whether the item
   * transitions through `pinching → detached` or `dissolving`. The
   * item remains in state through those phases and is removed on
   * reaching `gone`.
   */
  endItem(id: string, outcome: SlabItemOutcome): void;

  /**
   * Clear every active item without running end-phase animations.
   * Used for runtime teardown / disposal; prefer `endItem` in normal
   * operation so the slab's physics remain honest.
   */
  clearAll(): void;

  dispose(): void;
}

// ── Internal constants ────────────────────────────────────────────────

const DEFAULT_RECESSION_DELAY_MS = 10_000;

/**
 * Delays for the brief phase tail after `dissolving` / `detached` so
 * renderers have time to run their animations before the item is
 * removed from state. Values match the doctrine's transition budgets
 * (motebit-computer.md §Lifecycle). Kept small so a rapid succession
 * of items doesn't backlog state.
 */
const DISSOLVING_TAIL_MS = 300;
const DETACHED_TAIL_MS = 800;

/**
 * The `detached → gone` tail is zero — once the item has detached, it's
 * released from the slab's state immediately on the next notify. The
 * artifact lives on as its own scene object; the slab holds no reference.
 */
const POST_DETACHED_TAIL_MS = 0;

// ── Implementation ───────────────────────────────────────────────────

export function createSlabController(deps: SlabControllerDeps = {}): SlabController {
  const detachPolicy = deps.detachPolicy ?? defaultDetachPolicy;
  const recessionDelayMs = deps.recessionDelayMs ?? DEFAULT_RECESSION_DELAY_MS;
  const now = deps.now ?? (() => Date.now());
  const scheduleTimeout =
    deps.scheduleTimeout ??
    ((cb, ms) => {
      const handle = setTimeout(cb, ms);
      return {
        cancel: () => clearTimeout(handle),
      };
    });
  const warn = deps.logger?.warn.bind(deps.logger) ?? ((msg, ctx) => console.warn(msg, ctx));

  const items = new Map<string, SlabItem>();
  const subscribers = new Set<SlabSubscriber>();
  const pendingTimers = new Map<string, TimeoutHandle>();
  let ambient: SlabAmbient = "idle";
  let recessionTimer: TimeoutHandle | null = null;
  let disposed = false;

  // ── State projection ──────────────────────────────────────────────

  const snapshot = (): SlabState => ({
    ambient,
    // Freeze the map view so subscribers can't mutate. A fresh Map copy
    // each transition is deliberate — small items, React-style
    // reference-identity-based change detection stays correct.
    items: new Map(items),
  });

  const notify = (): void => {
    if (disposed) return;
    const state = snapshot();
    for (const subscriber of subscribers) {
      try {
        subscriber(state);
      } catch (err: unknown) {
        warn("slab subscriber threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  // ── Ambient state management ──────────────────────────────────────

  const recomputeAmbient = (): void => {
    const hasActive = [...items.values()].some(
      (item) => item.phase !== "gone" && item.phase !== "detached",
    );
    if (hasActive) {
      if (recessionTimer) {
        recessionTimer.cancel();
        recessionTimer = null;
      }
      if (ambient !== "active") {
        ambient = "active";
      }
      return;
    }
    // No active items. Drop to idle immediately; schedule the
    // idle→recessed transition after the configured delay.
    if (ambient !== "idle" && ambient !== "recessed") {
      ambient = "idle";
    }
    if (recessionTimer) recessionTimer.cancel();
    recessionTimer = scheduleTimeout(() => {
      if (disposed) return;
      // Re-check: a new item may have opened in the interim.
      const stillIdle = [...items.values()].every(
        (item) => item.phase === "gone" || item.phase === "detached",
      );
      if (stillIdle && ambient === "idle") {
        ambient = "recessed";
        notify();
      }
      recessionTimer = null;
    }, recessionDelayMs);
  };

  // ── Phase transition helpers ──────────────────────────────────────

  const updatePhase = (id: string, phase: SlabItemPhase, payload?: unknown): boolean => {
    const current = items.get(id);
    if (!current) return false;
    const next: SlabItem = {
      ...current,
      phase,
      lastUpdatedAt: now(),
      payload: payload !== undefined ? payload : current.payload,
    };
    items.set(id, next);
    return true;
  };

  const cancelPendingTimer = (id: string): void => {
    const pending = pendingTimers.get(id);
    if (pending) {
      pending.cancel();
      pendingTimers.delete(id);
    }
  };

  const scheduleTail = (id: string, phase: SlabItemPhase, delayMs: number): void => {
    cancelPendingTimer(id);
    const handle = scheduleTimeout(() => {
      pendingTimers.delete(id);
      if (disposed) return;
      if (phase === "gone") {
        items.delete(id);
      } else {
        updatePhase(id, phase);
      }
      recomputeAmbient();
      notify();
    }, delayMs);
    pendingTimers.set(id, handle);
  };

  /**
   * Detach tail — two chained phases (`pinching → detached → gone`)
   * with both delays tracked through the injected scheduler so tests
   * can drive them deterministically. `pinching` is the current phase
   * set by endItem; this function schedules the transitions onwards.
   */
  const scheduleDetachTail = (id: string): void => {
    cancelPendingTimer(id);
    const toDetached = scheduleTimeout(() => {
      pendingTimers.delete(id);
      if (disposed) return;
      updatePhase(id, "detached");
      recomputeAmbient();
      notify();
      // Chain the next phase immediately — the scheduler's next `advance`
      // picks it up because it's a fresh entry in the queue.
      const toGone = scheduleTimeout(() => {
        pendingTimers.delete(id);
        if (disposed) return;
        items.delete(id);
        recomputeAmbient();
        notify();
      }, POST_DETACHED_TAIL_MS);
      pendingTimers.set(id, toGone);
    }, DETACHED_TAIL_MS);
    pendingTimers.set(id, toDetached);
  };

  /**
   * Promote `emerging → active` synchronously if the item is still in
   * the emerging phase when an update / end arrives. The emerging
   * phase is the "item is being born" state — renderers observe it on
   * the first notify and animate the arrival. Once a real event
   * follows (update with new payload, or end), the item is by
   * definition active, so we flip the phase before the caller's
   * change applies.
   */
  const promoteFromEmerging = (id: string): void => {
    const current = items.get(id);
    if (!current || current.phase !== "emerging") return;
    updatePhase(id, "active");
  };

  // ── Public API ────────────────────────────────────────────────────

  return {
    getState(): SlabState {
      return snapshot();
    },

    subscribe(subscriber: SlabSubscriber): () => void {
      subscribers.add(subscriber);
      // Fire initial state so new subscribers don't have to wait for the
      // next transition to learn the current shape.
      try {
        subscriber(snapshot());
      } catch (err: unknown) {
        warn("slab subscriber threw during initial notify", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return () => {
        subscribers.delete(subscriber);
      };
    },

    openItem({ id, kind, payload }): void {
      if (disposed) return;
      if (items.has(id)) {
        warn("slab openItem ignored — item id already present", { id, kind });
        return;
      }
      const ts = now();
      items.set(id, {
        id,
        kind,
        phase: "emerging",
        openedAt: ts,
        lastUpdatedAt: ts,
        payload,
      });
      recomputeAmbient();
      notify();
      // No timer-based `emerging → active` transition. The phase
      // promotes synchronously on the first update or end call via
      // `promoteFromEmerging`. Callers that open and never update
      // (e.g., an instantaneous tool call that completes before any
      // progress emits) still see the correct sequence via the end
      // path's promotion.
    },

    updateItem(id: string, payload: unknown): void {
      if (disposed) return;
      const current = items.get(id);
      if (!current) {
        warn("slab updateItem ignored — unknown id", { id });
        return;
      }
      // Don't update terminal-phase items — they're on their way out.
      if (
        current.phase === "pinching" ||
        current.phase === "dissolving" ||
        current.phase === "detached" ||
        current.phase === "gone"
      ) {
        warn("slab updateItem ignored — item already in terminal phase", {
          id,
          phase: current.phase,
        });
        return;
      }
      promoteFromEmerging(id);
      const promoted = items.get(id)!;
      updatePhase(id, promoted.phase, payload);
      notify();
    },

    endItem(id: string, outcome: SlabItemOutcome): void {
      if (disposed) return;
      const current = items.get(id);
      if (!current) {
        warn("slab endItem ignored — unknown id", { id });
        return;
      }
      if (
        current.phase === "pinching" ||
        current.phase === "dissolving" ||
        current.phase === "detached" ||
        current.phase === "gone"
      ) {
        warn("slab endItem ignored — item already in terminal phase", {
          id,
          phase: current.phase,
        });
        return;
      }

      // Promote an emerging item to active with its own notify before
      // transitioning onwards. Renderers rely on the full phase
      // sequence (emerging → active → end) so arrival and departure
      // animations chain cleanly even when the item lives briefly.
      if (current.phase === "emerging") {
        promoteFromEmerging(id);
        notify();
      }
      const currentAfterPromote = items.get(id)!;

      const decision = detachPolicy(currentAfterPromote, outcome);
      if (decision.action === "detach") {
        // pinching → detached → gone. The item carries the artifact kind
        // in its payload so the renderer's detach callback can spawn
        // the right artifact-scene-object when the bead separates.
        updatePhase(id, "pinching", {
          ...(currentAfterPromote.payload as Record<string, unknown> | undefined),
          __slabDetach: { artifactKind: decision.artifactKind, outcome },
        });
        recomputeAmbient();
        notify();
        // Renderer observes `pinching` and runs the pinch physics;
        // advance to `detached` on the detachment-tail timer so the
        // state machine and the render animation stay aligned. Once
        // detached, drop from state on the next tick — the artifact
        // lives on as its own scene object, the slab releases.
        scheduleDetachTail(id);
        return;
      }

      // dissolve path — outcome is ephemeral (or interrupted / failed).
      updatePhase(id, "dissolving", currentAfterPromote.payload);
      recomputeAmbient();
      notify();
      scheduleTail(id, "gone", DISSOLVING_TAIL_MS);
    },

    clearAll(): void {
      if (disposed) return;
      for (const timer of pendingTimers.values()) timer.cancel();
      pendingTimers.clear();
      items.clear();
      if (recessionTimer) {
        recessionTimer.cancel();
        recessionTimer = null;
      }
      ambient = "idle";
      notify();
    },

    dispose(): void {
      disposed = true;
      for (const timer of pendingTimers.values()) timer.cancel();
      pendingTimers.clear();
      if (recessionTimer) {
        recessionTimer.cancel();
        recessionTimer = null;
      }
      subscribers.clear();
      items.clear();
    },
  };
}
