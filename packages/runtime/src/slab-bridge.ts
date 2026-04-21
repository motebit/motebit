/**
 * Slab bridge — wires a `SlabController` (runtime layer) to any
 * render-side target that implements the slab surface of
 * `RenderAdapter` (render-engine layer). Surface-neutral — the
 * caller supplies a per-item render function, so the web, desktop,
 * spatial, and any future surface can reuse the same diffing and
 * subscription plumbing while drawing items in whatever medium is
 * native to them (HTML card, WebXR panel, React Native view, …).
 *
 * Why this module exists:
 *
 *   - Without a bridge, `runtime.slab` emits typed lifecycle events
 *     into the void. Surfaces would each reimplement the diff:
 *     detect new items → openItem, detect phase transitions →
 *     dissolve / detach, detect payload changes → update. That's
 *     classic panel-pattern drift bait. The bridge is the one copy,
 *     surfaces just supply the element-producing functions.
 *
 *   - Keeps render-engine free of any runtime dependency and keeps
 *     the SlabController free of any rendering dependency. The
 *     bridge is the single place that knows both shapes, and it
 *     lives in the runtime package because the runtime owns the
 *     semantics; renderers just obey.
 *
 * Shape:
 *
 *   - `bindSlabControllerToRenderer(deps) → unsubscribe`. Subscribes
 *     once. Returns an unsubscribe thunk. No shared mutable state
 *     between instances — each call produces an isolated binding.
 *
 *   - Element lifecycle: the caller's `renderItem` is called once
 *     per new slab item. The element is mounted on the renderer via
 *     `addSlabItem`. Subsequent `updateItem` calls (invoked when the
 *     controller's payload changes) mutate the same element in
 *     place. The renderer owns removal — the bridge drops its
 *     reference when the item leaves state.
 */

import type {
  SlabController,
  SlabItem,
  SlabState,
  ArtifactKindForDetach,
} from "./slab-controller.js";

/**
 * Typed action set scoped to one slab item. The bridge constructs
 * one of these per mounted item and passes it to `renderItem` so
 * the surface-native renderer can wire pointer/touch handlers to
 * user-touch capabilities without reaching back into the controller.
 *
 * Doctrine (motebit-computer.md §"The user's touch"): gestures route
 * through typed capabilities, not constructed prompts. Closing over
 * the item id at mount time keeps the renderer stateless about
 * controller plumbing.
 */
export interface SlabItemActions {
  /**
   * User-initiated force-dissolve. The swipe gesture. Bypasses the
   * detach policy — a swipe means "no, I don't want this," not
   * "graduate this to an artifact." No-op on already-terminal items.
   */
  dismiss(): void;
}

/**
 * The subset of `RenderAdapter` the bridge needs. Declared inline
 * here so this module doesn't depend on `@motebit/render-engine`
 * directly (avoids a circular-dep risk and keeps the coupling
 * nominal).
 */
export interface SlabRendererTarget {
  addSlabItem?(spec: { id: string; kind: SlabItem["kind"]; element: HTMLElement }): unknown;
  dissolveSlabItem?(id: string): Promise<void>;
  detachSlabItemAsArtifact?(
    id: string,
    artifact: { id: string; kind: ArtifactKindForDetach; element: HTMLElement },
  ): Promise<unknown>;
  clearSlabItems?(): void;
}

export interface SlabBridgeDeps {
  controller: SlabController;
  renderer: SlabRendererTarget;

  /**
   * Called once per new slab item. Produces the HTMLElement the
   * renderer will mount on the slab surface. The element may be
   * styled / populated to reflect the initial `item.payload`; later
   * payload updates route through `updateItem`.
   *
   * The second argument is a typed action set scoped to this item —
   * the bridge passes closures that invoke the controller's user-
   * touch capabilities (`dismiss`, future `pin` / `feed`). Renderers
   * wire pointer/touch event handlers to these actions per the
   * surface-determinism doctrine: each gesture routes through a typed
   * capability, never a constructed prompt. See
   * docs/doctrine/motebit-computer.md §"The user's touch — supervised
   * agency" for the canonical gesture set.
   */
  renderItem: (item: SlabItem, actions: SlabItemActions) => HTMLElement;

  /**
   * Optional. Called when the controller emits a new state whose
   * item differs from the previous state by payload only (phase
   * unchanged, `lastUpdatedAt` advanced). The bridge passes the
   * original element so the caller can mutate in place rather than
   * remount. When omitted, payload updates are silently no-op at the
   * render layer — fine for simple items that only need their
   * initial render.
   */
  updateItem?: (item: SlabItem, element: HTMLElement) => void;

  /**
   * Optional. Called when a `pinching` item arrives with a
   * `__slabDetach` payload marker — produces the artifact spec the
   * detached bead will settle into. If omitted OR the payload lacks
   * the marker, detachment degrades to dissolution at the render
   * layer (the renderer still runs its pinch animation; no artifact
   * spawns in the scene).
   *
   * The artifact's `element` is typically distinct from the slab
   * item's element — the slab item dissolves during the pinch, and
   * the detached artifact renders separately (may be a richer
   * presentation than the ephemeral slab preview).
   */
  renderDetachArtifact?: (
    item: SlabItem,
    artifactKind: ArtifactKindForDetach,
  ) => { id: string; kind: ArtifactKindForDetach; element: HTMLElement };

  /** Defaults to `console.warn`. */
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

interface SlabDetachMarker {
  artifactKind: ArtifactKindForDetach;
}

function readDetachMarker(payload: unknown): SlabDetachMarker | null {
  if (payload == null || typeof payload !== "object") return null;
  const marker = (payload as Record<string, unknown>).__slabDetach;
  if (marker == null || typeof marker !== "object") return null;
  const artifactKind = (marker as Record<string, unknown>).artifactKind;
  if (typeof artifactKind !== "string") return null;
  return { artifactKind: artifactKind as ArtifactKindForDetach };
}

/**
 * Subscribe the bridge. Returns an unsubscribe thunk — calling it
 * detaches the bridge and lets further controller events flow
 * without side effects. Callers typically pair this with runtime /
 * surface lifecycle: subscribe on bootstrap, unsubscribe on
 * teardown. Idempotent on unsubscribe.
 */
export function bindSlabControllerToRenderer(deps: SlabBridgeDeps): () => void {
  const { controller, renderer, renderItem, updateItem, renderDetachArtifact } = deps;
  const warn = deps.logger?.warn.bind(deps.logger) ?? ((msg, ctx) => console.warn(msg, ctx));

  // Element the renderer currently holds for each live slab item —
  // the bridge keeps a reference so `updateItem` can mutate in place
  // without looking the DOM back up from scratch.
  const mountedElements = new Map<string, HTMLElement>();
  // Items that have already been forwarded to the renderer's addSlabItem.
  // Guards against double-mount when the controller's initial state
  // fires alongside a synchronous first update.
  const mounted = new Set<string>();
  // Items that have already been handed off to `dissolveSlabItem` or
  // `detachSlabItemAsArtifact`. Prevents double-emission of terminal
  // transitions if the renderer's promise doesn't resolve instantly.
  const ended = new Set<string>();

  let previous: SlabState | null = null;

  const onState = (state: SlabState): void => {
    const prev = previous;

    // New or updated items.
    for (const [id, item] of state.items) {
      const prevItem = prev?.items.get(id) ?? null;

      // First time we see this id — mount it. We mount on the very
      // first observation regardless of phase because the emerging
      // notify IS the first observation in the normal case; if a
      // surface subscribes mid-stream and sees an already-active
      // item, mounting it there is still the right move.
      //
      // `mounted` marks every attempt (success + failure) so a
      // renderItem exception doesn't cause the bridge to retry on
      // every subsequent state emit. The item is effectively
      // abandoned for the remainder of its lifetime.
      if (!mounted.has(id)) {
        mounted.add(id);
        try {
          const actions: SlabItemActions = {
            dismiss: () => controller.dismissItem(id),
          };
          const element = renderItem(item, actions);
          mountedElements.set(id, element);
          renderer.addSlabItem?.({ id, kind: item.kind, element });
        } catch (err: unknown) {
          warn("slab bridge renderItem threw — item abandoned", {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Phase transitions that cross into terminal territory — wire
      // the matching renderer method once per item.
      if (!ended.has(id)) {
        if (item.phase === "pinching") {
          ended.add(id);
          const marker = readDetachMarker(item.payload);
          if (marker && renderDetachArtifact) {
            try {
              const artifact = renderDetachArtifact(item, marker.artifactKind);
              void renderer.detachSlabItemAsArtifact?.(id, artifact);
            } catch (err: unknown) {
              warn("slab bridge renderDetachArtifact threw — falling back to dissolve", {
                id,
                error: err instanceof Error ? err.message : String(err),
              });
              void renderer.dissolveSlabItem?.(id);
            }
          } else {
            // Pinching with no marker or no renderer — behaviorally
            // equivalent to dissolving from the renderer's POV.
            void renderer.dissolveSlabItem?.(id);
          }
        } else if (item.phase === "dissolving") {
          ended.add(id);
          void renderer.dissolveSlabItem?.(id);
        }
      }

      // Payload change without phase change — update in place.
      if (prevItem != null && prevItem.phase === item.phase) {
        if (prevItem.lastUpdatedAt !== item.lastUpdatedAt && updateItem) {
          const element = mountedElements.get(id);
          if (element) {
            try {
              updateItem(item, element);
            } catch (err: unknown) {
              warn("slab bridge updateItem threw", {
                id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }
    }

    // Items that left state — drop local bookkeeping. The renderer's
    // `gone` phase handling (dissolve / detach tail) already removed
    // them from the scene; we just clear the map entry so the id can
    // be reused later.
    if (prev != null) {
      for (const [id] of prev.items) {
        if (!state.items.has(id)) {
          mountedElements.delete(id);
          mounted.delete(id);
          ended.delete(id);
        }
      }
    }

    previous = state;
  };

  const unsubscribe = controller.subscribe(onState);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    mountedElements.clear();
    mounted.clear();
    ended.clear();
  };
}
