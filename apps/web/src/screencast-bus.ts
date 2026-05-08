/**
 * `ScreencastFrameBus` — minimal subscribe/publish bus for live
 * screencast frames (v1.3 slice 2).
 *
 * The cloud-browser dispatcher's `openScreencast({onFrame})` produces
 * frames; the slab's `live_browser` element consumes them through the
 * `ScreencastFrameSource` shape declared in `@motebit/sdk`. The bus
 * sits in between: a producer-agnostic, consumer-agnostic relay so
 * the dispatcher and the slab item can be wired independently of
 * each other.
 *
 * Why a bus rather than wiring `dispatcher.openScreencast` directly
 * to a slab-item element. The slab item is built lazily by the slab
 * bridge when the controller fires `openItem`; the dispatcher stream
 * starts at `queryDisplay` time. Without a bus, the apps would need
 * to delay starting the screencast until after the slab item exists
 * — buffering the connection behind a UI lifecycle the runtime
 * doesn't need to know about. The bus inverts the dependency: the
 * dispatcher publishes, the slab item subscribes when it mounts.
 *
 * Sibling of how the slab bridge already separates lifecycle owner
 * (the runtime controller) from rendering owner (the surface
 * renderer) — same shape applied to the frame stream.
 *
 * v1 = one cloud session at a time, so one bus per `WebApp`. If
 * concurrent cloud sessions become a real consumer need, extend to
 * a `Map<sessionId, ScreencastFrameBus>` — the per-bus shape stays.
 */

import type { ScreencastFrame, ScreencastFrameSource } from "@motebit/sdk";

export class ScreencastFrameBus implements ScreencastFrameSource {
  private readonly subscribers = new Set<(frame: ScreencastFrame) => void>();
  private latestFrame: ScreencastFrame | null = null;

  /**
   * Subscribe to frames. Returns an unsubscribe thunk. New
   * subscribers receive the most recent frame immediately (when
   * available) so a slab item that mounts mid-stream paints with
   * the current state instead of the placeholder.
   */
  subscribe(callback: (frame: ScreencastFrame) => void): () => void {
    this.subscribers.add(callback);
    if (this.latestFrame !== null) {
      try {
        callback(this.latestFrame);
      } catch {
        // Subscriber faults must not break the subscribe path.
      }
    }
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Publish a frame to every subscriber. Producer-side; the dispatcher
   * wires its `onFrame` callback to this method. A subscriber that
   * throws is isolated — other subscribers still receive the frame.
   */
  publish(frame: ScreencastFrame): void {
    this.latestFrame = frame;
    for (const subscriber of this.subscribers) {
      try {
        subscriber(frame);
      } catch {
        // One subscriber's fault doesn't break the broadcast.
      }
    }
  }

  /**
   * Drop every subscriber and forget the latest frame. Called at
   * session close so a subsequent open starts from a clean slate.
   */
  reset(): void {
    this.subscribers.clear();
    this.latestFrame = null;
  }
}
