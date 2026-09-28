/**
 * The event-sync transport cursor (#868): the relay's ingest sequence.
 *
 * A device used to pull `after_clock = <its own max version_clock>`. Clocks
 * are assigned by devices, independently, so a sibling device's event at a
 * clock EQUAL to (or below) this device's max was skipped forever. A clock
 * orders causality; it is not a transport cursor.
 *
 * The relay stamps every stored event with a strictly increasing `seq`
 * (services/relay/src/event-seq.ts) and serves `after_seq` pulls. A client
 * keeps, per (local store, relay stream), the largest seq it has DURABLY
 * applied, and advances it only after the page's events are appended
 * locally. Dedup is by `event_id` — every local store's `append` ignores a
 * held `event_id` — so a cursor that is behind (lost, never persisted,
 * reset) costs a re-download, never an event.
 *
 * Law: the transport cursor is the relay ingest sequence; clocks order
 * causality only. (spec/memory-delta-v1.md §3.6)
 */
import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";

/** One page of a pull, as the source hands it back. */
export type SeqPullResult =
  | {
      /** The relay served the seq cursor. */
      kind: "seq";
      events: EventLogEntry[];
      /** The cursor to ask from next (the page's largest seq, or the request's cursor when empty). */
      nextSeq: number;
      /** More events follow `nextSeq`. */
      hasMore: boolean;
      /** The largest seq the relay holds for the identity. */
      latestSeq: number;
    }
  | {
      /**
       * The relay did not serve a seq (an older relay ignores `after_seq`):
       * these are the events it returned for the fallback `after_clock`.
       */
      kind: "clock";
      events: EventLogEntry[];
    };

/** A remote that can pull by the relay ingest sequence. */
export interface SeqPullSource {
  /**
   * Names the relay stream this source reads — the relay origin and the
   * identity — so a cursor from one relay is never applied to another.
   */
  readonly seqCursorKey: string;
  /**
   * Pull the events after `afterSeq`. Sent together with `fallbackAfterClock`
   * in ONE request: a relay that serves seq answers by seq, an older relay
   * answers the clock query exactly as it always has.
   */
  pullAfterSeq(afterSeq: number, fallbackAfterClock: number): Promise<SeqPullResult>;
}

/** Where the per-stream seq cursor is kept. */
export interface SyncSeqCursorStore {
  /** The largest seq durably applied for `key`, or null when none is recorded. */
  getSyncSeqCursor(key: string): Promise<number | null>;
  /** Record `seq` for `key`. Called only after the events up to it were appended locally. */
  setSyncSeqCursor(key: string, seq: number): Promise<void>;
}

export function isSeqPullSource(x: unknown): x is SeqPullSource {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Partial<SeqPullSource>;
  return typeof s.pullAfterSeq === "function" && typeof s.seqCursorKey === "string";
}

export function isSyncSeqCursorStore(x: unknown): x is SyncSeqCursorStore {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Partial<SyncSeqCursorStore>;
  return typeof s.getSyncSeqCursor === "function" && typeof s.setSyncSeqCursor === "function";
}

/** A cursor store held in memory. */
export class InMemorySyncSeqCursorStore implements SyncSeqCursorStore {
  private cursors = new Map<string, number>();
  getSyncSeqCursor(key: string): Promise<number | null> {
    return Promise.resolve(this.cursors.get(key) ?? null);
  }
  setSyncSeqCursor(key: string, seq: number): Promise<void> {
    this.cursors.set(key, seq);
    return Promise.resolve();
  }
}

/**
 * Cursors for local stores that cannot persist one, kept for the life of the
 * process and keyed by the local store OBJECT: the cursor describes what that
 * store holds, so two stores never share one (two simulated devices in one
 * process), and an adapter replaced by a token refresh keeps its store's
 * cursor instead of re-downloading from 0.
 */
const processCursors = new WeakMap<object, InMemorySyncSeqCursorStore>();

/**
 * The cursor store for `localStore`: an explicit one, else the local store
 * itself when it persists cursors (beside the events it describes), else a
 * process-lifetime in-memory store for that local store.
 */
export function resolveSeqCursorStore(
  localStore: EventStoreAdapter,
  explicit?: SyncSeqCursorStore,
): SyncSeqCursorStore {
  if (explicit) return explicit;
  if (isSyncSeqCursorStore(localStore)) return localStore;
  let store = processCursors.get(localStore);
  if (!store) {
    store = new InMemorySyncSeqCursorStore();
    processCursors.set(localStore, store);
  }
  return store;
}

/**
 * The events of `events` that `localStore` does not already hold, by
 * `event_id`. A local copy of a pulled event carries the same
 * `version_clock` (events are copied verbatim), so reading the local log from
 * the batch's smallest clock is enough.
 */
export async function filterUnseen(
  localStore: EventStoreAdapter,
  motebitId: string,
  events: EventLogEntry[],
): Promise<EventLogEntry[]> {
  if (events.length === 0) return [];
  let minClock = Infinity;
  for (const e of events) if (e.version_clock < minClock) minClock = e.version_clock;
  const held = await localStore.query({
    motebit_id: motebitId,
    after_version_clock: minClock - 1,
  });
  const seen = new Set(held.map((e) => e.event_id));
  const fresh: EventLogEntry[] = [];
  for (const e of events) {
    // Only this identity's events are ever applied (the relay binds the read
    // to the caller; this is the client's own fail-closed check).
    if (e.motebit_id !== motebitId) continue;
    if (seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    fresh.push(e);
  }
  return fresh;
}

/** Bounded so a single pull call cannot spin; the next sync continues from the saved cursor. */
export const MAX_SEQ_PAGES_PER_PULL = 100;

export interface SeqPullOutcome {
  /** Which cursor the relay served. */
  mode: "seq" | "clock";
  /** The events appended locally that were not held before, in pull order. */
  fresh: EventLogEntry[];
}

/**
 * Pull everything after the stored cursor from `source` into `localStore`,
 * page by page, advancing the cursor after each page is appended. The one
 * pull routine both the sync engine and the socket catch-up use.
 */
export async function pullBySeq(opts: {
  source: SeqPullSource;
  localStore: EventStoreAdapter;
  cursorStore: SyncSeqCursorStore;
  motebitId: string;
  /** The `after_clock` an older relay answers instead (the caller's pre-#868 clock cursor). */
  fallbackAfterClock: number;
  maxPages?: number;
}): Promise<SeqPullOutcome> {
  const { source, localStore, cursorStore, motebitId, fallbackAfterClock } = opts;
  const key = source.seqCursorKey;
  let cursor = (await cursorStore.getSyncSeqCursor(key)) ?? 0;
  const fresh: EventLogEntry[] = [];
  let resetOnce = false;
  const maxPages = opts.maxPages ?? MAX_SEQ_PAGES_PER_PULL;
  for (let page = 0; page < maxPages; page++) {
    const res = await source.pullAfterSeq(cursor, fallbackAfterClock);
    if (res.kind === "clock") {
      const unseen = await filterUnseen(localStore, motebitId, res.events);
      for (const e of unseen) await localStore.append(e);
      fresh.push(...unseen);
      return { mode: "clock", fresh };
    }
    if (res.latestSeq < cursor && !resetOnce) {
      // The relay's sequence is BELOW this cursor: its database went back
      // (a restore). Everything it holds may be unseen here — start over;
      // dedup by event_id makes that safe.
      resetOnce = true;
      cursor = 0;
      page--;
      continue;
    }
    const unseen = await filterUnseen(localStore, motebitId, res.events);
    for (const e of unseen) await localStore.append(e);
    fresh.push(...unseen);
    // Only now, with the page durably appended, may the cursor pass it.
    if (res.nextSeq > cursor) {
      cursor = res.nextSeq;
      await cursorStore.setSyncSeqCursor(key, cursor);
    } else if (resetOnce && res.nextSeq === 0) {
      await cursorStore.setSyncSeqCursor(key, 0);
    }
    if (!res.hasMore) break;
  }
  return { mode: "seq", fresh };
}
