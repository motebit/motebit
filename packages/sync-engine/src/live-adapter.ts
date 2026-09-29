import type { EventStoreAdapter } from "@motebit/event-log";

/** An adapter that reports wire activity (the HTTP and socket adapters do). */
export interface ActivityReporting {
  onActivity(listener: () => void): () => void;
}

function reportsActivity(x: unknown): x is ActivityReporting {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Partial<ActivityReporting>).onActivity === "function"
  );
}

/**
 * An adapter that forwards to whichever adapter `current()` returns now — the
 * surfaces' socket indirection: a token refresh replaces the socket adapter,
 * and an append already in progress must land on the replacement (#816).
 *
 * It forwards `onActivity` too (#914 round 5), so the sync engine's stall
 * watchdog hears the socket's frames being sent and acked. A hand-built
 * wrapper silently dropped it, and a slow but live cycle was abandoned as a
 * stall. Subscriptions follow a swap: the next call through the wrapper
 * moves them from the retired adapter to the current one.
 */
export function liveAdapter(current: () => EventStoreAdapter): EventStoreAdapter &
  ActivityReporting & {
    abortInFlight(): void;
    hasLiveWork(): boolean;
    readonly relayStreamKey: string | undefined;
  } {
  const listeners = new Set<() => void>();
  let bound: EventStoreAdapter | null = null;
  let unbind: (() => void) | null = null;
  const fire = (): void => {
    for (const l of listeners) {
      try {
        l();
      } catch {
        // a listener never breaks the transport
      }
    }
  };
  const follow = (): EventStoreAdapter => {
    const now = current();
    if (now !== bound) {
      unbind?.();
      bound = now;
      unbind = reportsActivity(now) ? now.onActivity(fire) : null;
    }
    return now;
  };
  return {
    append: (e) => follow().append(e),
    query: (f) => follow().query(f),
    getLatestClock: (id) => follow().getLatestClock(id),
    tombstone: (id, m) => follow().tombstone(id, m),
    abortInFlight(): void {
      (follow() as { abortInFlight?: () => void }).abortInFlight?.();
    },
    hasLiveWork(): boolean {
      return (follow() as { hasLiveWork?: () => boolean }).hasLiveWork?.() === true;
    },
    get relayStreamKey(): string | undefined {
      return (follow() as { relayStreamKey?: string }).relayStreamKey;
    },
    onActivity(listener: () => void): () => void {
      listeners.add(listener);
      follow();
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
