/**
 * The event-sync transport cursor (#868): the relay's ingest sequence.
 *
 * A device used to pull `after_clock = <its own max version_clock>`. Clocks
 * are assigned by devices, independently, so a sibling device's event at a
 * clock EQUAL to (or below) this device's max was skipped forever. A clock
 * orders causality; it is not a transport cursor.
 *
 * The relay stamps every stored event with a per-identity, strictly
 * increasing `seq` (services/relay/src/event-seq.ts) and serves `after_seq`
 * pulls. A client keeps, per (local store, relay stream, MODE), the largest
 * seq it has DURABLY processed, and advances it only after the page is
 * processed. Dedup is by `event_id`, so a cursor that is behind (lost, never
 * persisted, reset) costs a re-download, never an event.
 *
 * Processing one page, in this order (spec/memory-delta-v1.md §3.6):
 *   1. DEDUP by `event_id` against the local store — on the TRANSPORT form,
 *      before any decryption, so an event already held is never decrypted
 *      again (the whole pre-rotation history, after a key rotation).
 *   2. DECODE each remaining event on its own (an E2E source decrypts it). One
 *      event that cannot be decoded never stops the stream: it is RECORDED
 *      (event_id, seq, reason) where the cursor lives — the most recent
 *      SKIPPED_SYNC_EVENTS_KEPT per key, plus a running total — reported, NOT applied,
 *      and the cursor moves past it.
 *   3. A RAW source (no decoding) never applies an E2E-encrypted payload: the
 *      ciphertext is useless here, and — held under its event_id — it would
 *      make the E2E path over the same store drop the real event as a
 *      duplicate. It is COUNTED (expected there, not an error; no row per
 *      event) and passed. Raw and E2E pulls also
 *      keep separate cursors (the mode is in the key), so neither advances
 *      the other past an event it never applied.
 *   4. APPEND the rest; only then advance the cursor.
 *
 * Law: the transport cursor is the relay ingest sequence; clocks order
 * causality only.
 */
import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";
import { classifyEventPayload } from "./event-payload.js";

/** One event of a seq page: the entry in its TRANSPORT form, and its relay seq. */
export interface SeqPullEntry {
  seq: number;
  event: EventLogEntry;
}

/** One page of a pull, as the source hands it back (transport form — not yet decoded). */
export type SeqPullResult =
  | {
      /** The relay served the seq cursor. */
      kind: "seq";
      entries: SeqPullEntry[];
      /** The cursor to ask from next (the page's largest seq, or the request's cursor when empty). */
      nextSeq: number;
      /** More events follow `nextSeq`. */
      hasMore: boolean;
      /** The largest seq the relay has assigned the identity. */
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
   * Names the relay stream this source reads AND the mode it reads it in —
   * relay origin, identity, raw or E2E — so a cursor never applies to another
   * relay, and the raw and E2E paths never advance each other's cursor.
   */
  readonly seqCursorKey: string;
  /**
   * Pull the events after `afterSeq`, in their TRANSPORT form (an E2E payload
   * still encrypted). Sent together with `fallbackAfterClock` in ONE request:
   * a relay that serves seq answers by seq, an older relay answers the clock
   * query exactly as it always has.
   */
  pullAfterSeq(afterSeq: number, fallbackAfterClock: number): Promise<SeqPullResult>;
  /**
   * Turn one transport entry into the entry the local store holds (an E2E
   * source decrypts it). Throws when it cannot. Absent ⇒ a RAW source.
   */
  decodeEvent?(event: EventLogEntry): Promise<EventLogEntry>;
}

/** Why a pulled event was not applied. */
export type SkippedSyncEventReason =
  /** An E2E source could not decrypt it (key rotated away, unknown key version, corrupt ciphertext). */
  "undecryptable";

/** A pulled event the client moved past without applying — recorded, never silent. */
export interface SkippedSyncEvent {
  event_id: string;
  /** Its relay seq; null when an older relay served the clock fallback. */
  seq: number | null;
  reason: SkippedSyncEventReason;
  /** The error message, for `undecryptable`. */
  detail?: string;
}

/** Where the per-stream seq cursor — and the record of skipped events — is kept. */
export interface SyncSeqCursorStore {
  /** The largest seq durably processed for `key`, or null when none is recorded. */
  getSyncSeqCursor(key: string): Promise<number | null>;
  /** Record `seq` for `key`. Called only after the events up to it were processed. */
  setSyncSeqCursor(key: string, seq: number): Promise<void>;
  /**
   * Durably record an event the stream moved past because it could not be
   * decrypted. A store keeps at most `SKIPPED_SYNC_EVENTS_KEPT` rows per key
   * (the most recent), pruning in the same write, plus a running total.
   * Optional; `pullBySeq` also reports every skip through `onSkipped`.
   */
  recordSkippedSyncEvent?(key: string, skipped: SkippedSyncEvent): Promise<void>;
  /** Every undecryptable skip ever recorded for `key`, including rows since pruned. */
  countSkippedSyncEvents?(key: string): Promise<number>;
}

/**
 * A local store that can answer "which of these event_ids do you hold?" by
 * key — one indexed lookup per id, never a scan of the log.
 */
export interface HeldEventIdLookup {
  getHeldEventIds(eventIds: readonly string[]): Promise<Set<string>>;
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

function hasHeldEventIdLookup(x: unknown): x is HeldEventIdLookup {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Partial<HeldEventIdLookup>).getHeldEventIds === "function"
  );
}

/** The default report of a skipped event: one warning line, never the payload. */
export function warnSkippedSyncEvent(s: SkippedSyncEvent): void {
  // eslint-disable-next-line no-console -- the runtime's pluggable-logger default (CLAUDE.md conventions); callers pass onSkippedEvent to route it
  console.warn(
    `sync: moved past event ${s.event_id} (seq ${s.seq ?? "n/a"}) without applying it: ${s.reason}${
      s.detail ? ` — ${s.detail}` : ""
    }`,
  );
}

/** A cursor store held in memory (skipped events kept in a list). */
export class InMemorySyncSeqCursorStore implements SyncSeqCursorStore {
  private cursors = new Map<string, number>();
  readonly skipped: Array<SkippedSyncEvent & { key: string }> = [];
  getSyncSeqCursor(key: string): Promise<number | null> {
    return Promise.resolve(this.cursors.get(key) ?? null);
  }
  setSyncSeqCursor(key: string, seq: number): Promise<void> {
    this.cursors.set(key, seq);
    return Promise.resolve();
  }
  private totals = new Map<string, number>();
  recordSkippedSyncEvent(key: string, skipped: SkippedSyncEvent): Promise<void> {
    if (this.skipped.some((s) => s.key === key && s.event_id === skipped.event_id)) {
      return Promise.resolve();
    }
    this.skipped.push({ key, ...skipped });
    this.totals.set(key, (this.totals.get(key) ?? 0) + 1);
    const mine = this.skipped.filter((s) => s.key === key);
    for (const old of mine.slice(0, Math.max(0, mine.length - SKIPPED_SYNC_EVENTS_KEPT))) {
      this.skipped.splice(this.skipped.indexOf(old), 1);
    }
    return Promise.resolve();
  }
  /** Every skip ever recorded for `key`, including the pruned ones. */
  countSkippedSyncEvents(key: string): Promise<number> {
    return Promise.resolve(this.totals.get(key) ?? 0);
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
 * `event_id`, keeping only this identity's. A store with `getHeldEventIds`
 * answers by key lookup; otherwise the local log is read once from the
 * batch's smallest clock (a local copy of a pulled event carries the same
 * `version_clock` — events are copied verbatim).
 */
export async function filterUnseen(
  localStore: EventStoreAdapter,
  motebitId: string,
  events: EventLogEntry[],
): Promise<EventLogEntry[]> {
  const mine = events.filter((e) => e.motebit_id === motebitId);
  if (mine.length === 0) return [];
  let held: Set<string>;
  if (hasHeldEventIdLookup(localStore)) {
    held = await localStore.getHeldEventIds(mine.map((e) => e.event_id));
  } else {
    let minClock = Infinity;
    for (const e of mine) if (e.version_clock < minClock) minClock = e.version_clock;
    const local = await localStore.query({
      motebit_id: motebitId,
      after_version_clock: minClock - 1,
    });
    held = new Set(local.map((e) => e.event_id));
  }
  const fresh: EventLogEntry[] = [];
  for (const e of mine) {
    if (held.has(e.event_id)) continue;
    held.add(e.event_id);
    fresh.push(e);
  }
  return fresh;
}

/**
 * The relay's own record as an acknowledgment (#914 round 7). Every event a
 * pull shows the relay HOLDS — the device's own events included — is noted
 * against the local store the pull writes into, and a push counts it
 * acknowledged. A push whose ack is lost (a socket rebuilt before a slow ack
 * arrives, a response that never comes back) is still known delivered once
 * the relay's stream shows it, so the push cursor passes it instead of
 * re-sending it forever. Keyed by the local store object (one device's
 * record), bounded; forgetting one only costs a re-push.
 */
const relayHeld = new WeakMap<object, Map<string, Map<string, number>>>();
const RELAY_HELD_KEPT = 50_000;

/**
 * The relay a cursor key reads, whatever the payload mode: `raw:` and
 * `e2e:` keys over the same relay origin + identity are one relay's record
 * (#914 round 8).
 */
export function relayStreamOfKey(seqCursorKey: string): string {
  return seqCursorKey.replace(/^(?:e2e:|raw:)+/, "");
}

/**
 * Note that the relay stream `relayStream` (see `relayStreamOfKey`) holds
 * these events. Keyed by the local store AND the relay: what relay A served
 * says nothing about what relay B holds (#914 round 8 — a device pointed at
 * a new relay must push it the whole log, its own events included).
 */
export function noteRelayHolds(
  localStore: object,
  relayStream: string,
  events: readonly EventLogEntry[],
): void {
  let perRelay = relayHeld.get(localStore);
  if (!perRelay) {
    perRelay = new Map();
    relayHeld.set(localStore, perRelay);
  }
  let held = perRelay.get(relayStream);
  if (!held) {
    held = new Map();
    perRelay.set(relayStream, held);
  }
  for (const e of events) {
    held.delete(e.event_id);
    held.set(e.event_id, e.version_clock);
  }
  while (held.size > RELAY_HELD_KEPT) held.delete(held.keys().next().value!);
}

/** Has a pull from `relayStream` into `localStore` shown that relay holding `eventId`? */
export function relayHolds(localStore: object, relayStream: string, eventId: string): boolean {
  return relayHeld.get(localStore)?.get(relayStream)?.has(eventId) ?? false;
}

/** Bounded so a single pull call cannot spin; the next sync continues from the saved cursor. */
export const MAX_SEQ_PAGES_PER_PULL = 100;

export interface SeqPullOutcome {
  /** Which cursor the relay served. */
  mode: "seq" | "clock";
  /** The events appended locally that were not held before, decoded, in pull order. */
  fresh: EventLogEntry[];
  /** The events moved past without being applied because they could not be decrypted (also recorded and reported). */
  skipped: SkippedSyncEvent[];
  /**
   * E2E-encrypted events a RAW path passed (the E2E path over the same store
   * applies them). Expected, not an error: counted, never recorded per event.
   */
  encryptedOnRawPath: number;
}

/**
 * How many undecryptable-event rows a store keeps per cursor key; the oldest
 * past this are pruned in the same write, beside a running total of every
 * skip recorded (spec/memory-delta-v1.md §3.6). Each surface's store inlines
 * this number.
 */
export const SKIPPED_SYNC_EVENTS_KEPT = 1000;

/**
 * Pull everything after the stored cursor from `source` into `localStore`,
 * page by page: dedup (transport form) → decode per event → append →
 * advance. The one pull routine both the sync engine and the socket
 * catch-up use.
 */
export async function pullBySeq(opts: {
  source: SeqPullSource;
  localStore: EventStoreAdapter;
  cursorStore: SyncSeqCursorStore;
  motebitId: string;
  /** The `after_clock` an older relay answers instead (the caller's pre-#868 clock cursor). */
  fallbackAfterClock: number;
  maxPages?: number;
  /** Told of every event moved past without being applied. */
  onSkipped?: (skipped: SkippedSyncEvent) => void;
  /**
   * Told after each page is applied, with the events it appended (#914 round
   * 3): a caller can count the page as progress, and learn which events the
   * relay holds before the pull as a whole returns.
   */
  onPage?: (fresh: readonly EventLogEntry[]) => void;
}): Promise<SeqPullOutcome> {
  const { source, localStore, cursorStore, motebitId, fallbackAfterClock } = opts;
  const key = source.seqCursorKey;
  let cursor = (await cursorStore.getSyncSeqCursor(key)) ?? 0;
  const fresh: EventLogEntry[] = [];
  const skipped: SkippedSyncEvent[] = [];
  let encryptedOnRawPath = 0;
  let resetOnce = false;
  const maxPages = opts.maxPages ?? MAX_SEQ_PAGES_PER_PULL;

  const skip = async (s: SkippedSyncEvent): Promise<void> => {
    skipped.push(s);
    await cursorStore.recordSkippedSyncEvent?.(key, s);
    opts.onSkipped?.(s);
  };

  /** Steps 2–4 for events already deduped, in order. */
  const apply = async (unseen: EventLogEntry[], seqOf: (id: string) => number | null) => {
    for (const transport of unseen) {
      let entry: EventLogEntry;
      if (source.decodeEvent) {
        try {
          entry = await source.decodeEvent(transport);
        } catch (err: unknown) {
          await skip({
            event_id: transport.event_id,
            seq: seqOf(transport.event_id),
            reason: "undecryptable",
            detail: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      } else if (classifyEventPayload(transport.payload) !== "plaintext") {
        // Expected on a raw path, not an error: counted, never recorded per
        // event (a raw daemon beside an E2E device would otherwise write a
        // row for every event that device ever wrote). A payload carrying
        // the E2E marker in any form — the envelope or a malformed one — is
        // never applied as plaintext (#928: one predicate for every reader).
        encryptedOnRawPath++;
        continue;
      } else {
        entry = transport;
      }
      await localStore.append(entry);
      fresh.push(entry);
    }
  };

  for (let page = 0; page < maxPages; page++) {
    const res = await source.pullAfterSeq(cursor, fallbackAfterClock);
    noteRelayHolds(
      localStore,
      relayStreamOfKey(source.seqCursorKey),
      (res.kind === "clock" ? res.events : res.entries.map((x) => x.event)).filter(
        (e) => e.motebit_id === motebitId,
      ),
    );
    if (res.kind === "clock") {
      const unseen = await filterUnseen(localStore, motebitId, res.events);
      await apply(unseen, () => null);
      opts.onPage?.(fresh);
      return { mode: "clock", fresh, skipped, encryptedOnRawPath };
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
    const seqs = new Map(res.entries.map((x) => [x.event.event_id, x.seq]));
    const unseen = await filterUnseen(
      localStore,
      motebitId,
      res.entries.map((x) => x.event),
    );
    const before = fresh.length;
    await apply(unseen, (id) => seqs.get(id) ?? null);
    opts.onPage?.(fresh.slice(before));
    // Only now, with the page processed (applied or recorded), may the cursor pass it.
    if (res.nextSeq > cursor) {
      cursor = res.nextSeq;
      await cursorStore.setSyncSeqCursor(key, cursor);
    } else if (resetOnce && res.nextSeq === 0) {
      await cursorStore.setSyncSeqCursor(key, 0);
    }
    if (!res.hasMore) break;
  }
  return { mode: "seq", fresh, skipped, encryptedOnRawPath };
}
