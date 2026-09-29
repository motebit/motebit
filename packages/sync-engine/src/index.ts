import type { EventLogEntry, SyncCursor, ConflictEdge } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";
import {
  isSeqPullSource,
  pullBySeq,
  resolveSeqCursorStore,
  relayHolds,
  relayStreamOfKey,
  warnSkippedSyncEvent,
  type SkippedSyncEvent,
  type SyncSeqCursorStore,
} from "./seq-cursor.js";

export {
  InMemorySyncSeqCursorStore,
  isSeqPullSource,
  isSyncSeqCursorStore,
  pullBySeq,
  resolveSeqCursorStore,
  filterUnseen,
  MAX_SEQ_PAGES_PER_PULL,
  warnSkippedSyncEvent,
  SKIPPED_SYNC_EVENTS_KEPT,
} from "./seq-cursor.js";
export type {
  SeqPullResult,
  SeqPullSource,
  SeqPullOutcome,
  SyncSeqCursorStore,
  SeqPullEntry,
  SkippedSyncEvent,
  SkippedSyncEventReason,
  HeldEventIdLookup,
} from "./seq-cursor.js";

export {
  classifyEventPayload,
  isEncryptedPayload,
  assertPushable,
  PlaintextPushRefusedError,
} from "./event-payload.js";
export type { EventPayloadForm, RelayPayloadMode } from "./event-payload.js";

export { StaticCredentialSource } from "./credential-source.js";
export type { CredentialRequest, CredentialSource } from "./credential-source.js";

export { HttpEventStoreAdapter } from "./http-adapter.js";
export type { HttpAdapterConfig } from "./http-adapter.js";
export { WebSocketEventStoreAdapter } from "./ws-adapter.js";
export { liveAdapter } from "./live-adapter.js";
export type { ActivityReporting } from "./live-adapter.js";
export type {
  WebSocketAdapterConfig,
  EventReceivedCallback,
  CustomMessageCallback,
} from "./ws-adapter.js";
export { EncryptedEventStoreAdapter, decryptEventPayload } from "./encrypted-adapter.js";
export type { EncryptedAdapterConfig, EncryptedAdapterLogger } from "./encrypted-adapter.js";
export {
  EncryptedConversationSyncAdapter,
  decryptConversationMessage,
  decryptSyncConversation,
} from "./encrypted-conversation-adapter.js";
export type { EncryptedConversationAdapterConfig } from "./encrypted-conversation-adapter.js";
export { PairingClient } from "./pairing-client.js";
export { readSuccessionState, submitSuccessionToRelay } from "./succession-client.js";
export type {
  ReadSuccessionStateRequest,
  RelaySuccessionState,
  SubmitSuccessionRequest,
  SubmitSuccessionResult,
} from "./succession-client.js";
export type { PairingClientConfig, PairingSession, PairingStatus } from "./pairing-client.js";
export {
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
  InMemoryConversationSyncStore,
} from "./conversation-sync.js";
export type {
  ConversationSyncConfig,
  ConversationSyncStatus,
  ConversationSyncStoreAdapter,
  ConversationSyncRemoteAdapter,
  HttpConversationAdapterConfig,
} from "./conversation-sync.js";
export { PlanSyncEngine, HttpPlanSyncAdapter, InMemoryPlanSyncStore } from "./plan-sync.js";
export type {
  PlanSyncConfig,
  PlanSyncStatus,
  PlanSyncStoreAdapter,
  PlanSyncRemoteAdapter,
  HttpPlanAdapterConfig,
} from "./plan-sync.js";
export { EncryptedPlanSyncAdapter } from "./encrypted-plan-adapter.js";
export type { EncryptedPlanAdapterConfig } from "./encrypted-plan-adapter.js";
export {
  LastWriterWinsResolver,
  AppendOnlyMergeResolver,
  ConflictTracker,
} from "./conflict-resolver.js";
export type {
  ConflictStrategy,
  ConflictResult,
  Versioned,
  ConflictResolver,
  ConversationWithMessages,
  ConflictEvent,
  ConflictLogger,
} from "./conflict-resolver.js";

// === Sync Configuration ===

export interface SyncConfig {
  /** How often to attempt sync (ms) */
  sync_interval_ms: number;
  /** Max events per sync batch */
  batch_size: number;
  /** Retry attempts on failure */
  max_retries: number;
  /** Backoff base (ms) */
  retry_backoff_ms: number;
  /**
   * Where the relay-ingest-sequence pull cursor is kept (#868). Default: the
   * local store itself when it persists cursors, else process memory keyed
   * by the local store (a new process then re-pulls from seq 0, deduped by
   * event_id).
   */
  seqCursorStore?: SyncSeqCursorStore;
  /**
   * Told of every pulled event moved past without being applied (#868).
   * Default: a `console.warn` line naming the event and the reason.
   */
  onSkippedEvent?: (skipped: SkippedSyncEvent) => void;
  /**
   * The most a sync cycle may go without progress — an acknowledged or failed
   * push, a finished pull — before it is abandoned (#914 round 2): the status
   * turns `error`, the cycle's caller and every `sync()` that joined it get
   * an empty result, and the next `sync()` starts afresh. An abandoned cycle
   * still running can only write an acknowledged push cursor, so abandoning
   * never loses an event. Default 60 000 ms.
   */
  stall_timeout_ms?: number;
  /**
   * How long a sync waits for the answers to its pushes before it ends
   * (#914 round 7). A push still unanswered then is NOT failed: it stays in
   * flight, its acknowledgment moves the push cursor whenever it arrives —
   * in a later sync or between syncs — and no later sync sends it again
   * while it is in flight. The wait only frees the sync to push what is
   * appended meanwhile. Default: `sync_interval_ms`.
   */
  push_patience_ms?: number;
}

const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/**
 * The most push batches (`batch_size` events each) one `sync()` sends (#914).
 * A larger backlog continues on the next sync from the persisted push cursor.
 */
export const MAX_PUSH_BATCHES_PER_SYNC = 50;

/** How many pulled event_ids the engine remembers as held by the relay. */
const MAX_KNOWN_REMOTE = 10_000;

/**
 * The key the push cursor is kept under, in the same cursor store as the
 * pull cursor (#914). A remote that names its relay stream — a seq source,
 * or a socket adapter through its catch-up source (`relayStreamKey`, #914
 * round 8) — gets a cursor of its own, so a relay it has never pushed to is
 * pushed the whole log; a remote that names none shares the identity's
 * default push cursor. Prefixed `push:` — never equal to a pull cursor key.
 */
export function pushCursorKey(remote: EventStoreAdapter, motebitId: string): string {
  if (isSeqPullSource(remote)) return `push:${remote.seqCursorKey}`;
  const named = (remote as { relayStreamKey?: unknown }).relayStreamKey;
  return typeof named === "string" ? `push:relay:${named}` : `push:#${motebitId}`;
}

/** Every push-cursor key starts with this (`pushCursorKey`). */
const PUSH_CURSOR_PREFIX = "push:";

/**
 * The relay streams a `SyncEngine` in this process connected, per LOCAL
 * store object, with the cursor store each stream's push cursor is kept in
 * (#962). Read by `pushCompactionFloor`; a store's own persisted push
 * cursors cover the streams of an earlier process.
 */
const connectedPushStreams = new WeakMap<object, Map<string, SyncSeqCursorStore>>();

/**
 * The highest clock compaction may delete up to in `localStore` (#962): the
 * smaller of `requested` and every relay stream's ACKED push cursor — so an
 * event no relay has acknowledged is never compacted away before it is
 * pushed. The streams are those a `SyncEngine` connected over this store in
 * this process, plus every push cursor the store persists (a relay an
 * earlier process pushed to, before this one connects). The minimum across
 * streams: a relay that has acknowledged nothing holds everything.
 *
 * No stream at all (no relay ever configured over this store): `requested`,
 * compaction as before. A cursor that cannot be read: 0 — compact nothing
 * (fail closed).
 */
export async function pushCompactionFloor(
  localStore: EventStoreAdapter,
  requested: number,
): Promise<number> {
  try {
    const streams = new Map<string, SyncSeqCursorStore>(connectedPushStreams.get(localStore) ?? []);
    const own = resolveSeqCursorStore(localStore);
    if (own.listSyncSeqCursorKeys) {
      for (const key of await own.listSyncSeqCursorKeys(PUSH_CURSOR_PREFIX)) {
        if (!streams.has(key)) streams.set(key, own);
      }
    }
    let floor = requested;
    for (const [key, store] of streams) {
      floor = Math.min(floor, (await store.getSyncSeqCursor(key)) ?? 0);
    }
    return floor;
  } catch {
    return 0;
  }
}

/**
 * The adapter instance a push goes out through (#914 round 9): what a
 * remote names as its `pushTransport` (a socket adapter, followed through
 * the encrypted and live wrappers), else the remote itself.
 */
interface PushTransport {
  /** Is this event still on the wire through this instance — a promise it will settle? */
  holdsPush?(eventId: string): boolean;
}
function transportOf(remote: EventStoreAdapter): object {
  const named = (remote as { pushTransport?: unknown }).pushTransport;
  return typeof named === "object" && named !== null ? named : remote;
}

/**
 * The relay stream a remote pushes to, for asking what that relay has been
 * seen to hold (#914 round 8): a seq source's stream, or the one a socket
 * adapter names; null when the remote names none (then nothing counts as
 * held, and everything is pushed — harmless, the relay dedups).
 */
function relayStreamOf(remote: EventStoreAdapter): string | null {
  if (isSeqPullSource(remote)) return relayStreamOfKey(remote.seqCursorKey);
  const named = (remote as { relayStreamKey?: unknown }).relayStreamKey;
  return typeof named === "string" ? named : null;
}

/** Local events in push order: by clock, then event_id (a stable order for equal clocks). */
function byClockThenId(a: EventLogEntry, b: EventLogEntry): number {
  if (a.version_clock !== b.version_clock) return a.version_clock - b.version_clock;
  return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
}

/**
 * The largest clock the push cursor may move to (#914): the clock of the
 * last whole clock group, in push order, whose every event is in `done`
 * (acknowledged by the relay, or known to be held there). `events` must be
 * EVERY local event above `cursor`, sorted by clock, so no event at or below
 * the result is left unacknowledged — a group split across batches, or with
 * one failed member, holds the cursor below it.
 *
 * Precondition: every local append takes a clock above every event already
 * stored (an ATOMIC `appendWithClock`). A store whose clock assignment is a
 * non-atomic read-max-then-insert (TauriEventStore, ExpoSqliteEventStore
 * today) can land a concurrent append at or below a clock this cursor has
 * passed, and that event is never pushed — as on main. Tracked in #964.
 */
export function ackedPushCursor(
  cursor: number,
  events: readonly EventLogEntry[],
  done: ReadonlySet<string>,
): number {
  let safe = cursor;
  let i = 0;
  while (i < events.length) {
    const clock = events[i]!.version_clock;
    let whole = true;
    let j = i;
    while (j < events.length && events[j]!.version_clock === clock) {
      if (!done.has(events[j]!.event_id)) whole = false;
      j++;
    }
    if (!whole) break;
    safe = clock;
    i = j;
  }
  return safe;
}

const DEFAULT_SYNC_CONFIG: SyncConfig = {
  sync_interval_ms: 30_000,
  batch_size: 100,
  max_retries: 3,
  retry_backoff_ms: 1_000,
};

/** What one pull brought. */
interface PullOutcome {
  count: number;
  events: EventLogEntry[];
  skipped?: SkippedSyncEvent[];
  encryptedOnRawPath?: number;
}

// === Sync Status ===

export type SyncStatus = "idle" | "syncing" | "error" | "offline";

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: ConflictEdge[];
  /**
   * Pulled events moved past WITHOUT being applied this cycle because this
   * device cannot decrypt them (#868). Each is recorded where the cursor
   * lives (bounded) and reported through `SyncConfig.onSkippedEvent`.
   * Absent when none.
   */
  skipped?: SkippedSyncEvent[];
  /**
   * E2E-encrypted events this RAW pull passed without applying (the E2E
   * path over the same store applies them). Expected, not an error; counted,
   * never recorded per event. Absent when none.
   */
  encryptedOnRawPath?: number;
}

export interface SyncStatusListener {
  (status: SyncStatus): void;
}

// === Sync Engine ===

export class SyncEngine {
  private config: SyncConfig;
  private localStore: EventStoreAdapter;
  private remoteStore: EventStoreAdapter | null = null;
  /**
   * `last_version_clock` is the PUSH cursor (#914): the largest clock such
   * that the relay ACKNOWLEDGED every local event at or below it. It moves
   * only after an acknowledgment — never to a local max read at another
   * moment — and is persisted in the cursor store under `pushCursorKey`, so
   * a crash between an acknowledgment and the write re-pushes, never loses.
   * Never a pull cursor.
   */
  private cursor: SyncCursor;
  /**
   * The `after_clock` a remote that cannot pull by seq is asked, and the
   * fallback an older relay answers: the local max clock after the last
   * sync, exactly as before #914. Pull side only.
   */
  private pullAfterClock = 0;
  /**
   * Events this engine pulled FROM the relay — so the relay holds them. A
   * push counts them acknowledged without sending them back. event_id →
   * clock; pruned as the push cursor passes them; cleared with the remote.
   */
  private knownRemote = new Map<string, number>();
  /**
   * Pushes whose answer has not arrived, per push-cursor key, across syncs
   * (#914 round 7): a later sync joins one rather than sending it again.
   */
  private outstanding = new Map<string, Map<string, { promise: Promise<void>; via: object }>>();
  /** Acknowledged events above the push cursor, per push-cursor key, not yet folded into it. */
  private ackedAbove = new Map<string, Set<string>>();
  /**
   * EVERY local event above the push cursor when last read, in push order,
   * per key — what an acknowledgment arriving between syncs folds against.
   * An event appended after the read carries a higher clock (the atomic
   * clock precondition), so the cursor can never pass it from this list.
   */
  private aboveCursor = new Map<string, EventLogEntry[]>();
  /** The relay stream each push-cursor key pushes to (`relayStreamOf`). */
  private streamOfKey = new Map<string, string | null>();
  /** Push-cursor writes, one at a time, in order. */
  private cursorChain: Promise<void> = Promise.resolve();
  private advanceQueued = new Set<string>();
  /** The sync in progress: a second call joins it rather than racing it. */
  private running: Promise<SyncResult> | null = null;
  /** The current cycle; bumped when one is abandoned, so its late status writes are ignored. */
  private cycle = 0;
  /** When the current cycle last made progress (the stall watchdog reads it). */
  private lastProgressAt = 0;
  /** The relay-ingest-sequence pull cursor, per relay stream (#868). */
  private seqCursorStore: SyncSeqCursorStore;
  private status: SyncStatus = "idle";
  private statusListeners: Set<SyncStatusListener> = new Set();
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private conflicts: ConflictEdge[] = [];

  constructor(localStore: EventStoreAdapter, motebitId: string, config: Partial<SyncConfig> = {}) {
    this.config = { ...DEFAULT_SYNC_CONFIG, ...config };
    this.localStore = localStore;
    this.seqCursorStore = resolveSeqCursorStore(localStore, config.seqCursorStore);
    this.cursor = {
      motebit_id: motebitId,
      last_event_id: "",
      last_version_clock: 0,
    };
  }

  /**
   * Connect to a remote event store for sync.
   */
  connectRemote(remoteStore: EventStoreAdapter): void {
    this.remoteStore = remoteStore;
    // #962: from now on compaction over this store stops at this stream's
    // acked push cursor — in this process at once, and in a later one
    // through the cursor persisted here (0 until the relay acknowledges).
    const key = pushCursorKey(remoteStore, this.cursor.motebit_id);
    let streams = connectedPushStreams.get(this.localStore);
    if (!streams) {
      streams = new Map<string, SyncSeqCursorStore>();
      connectedPushStreams.set(this.localStore, streams);
    }
    streams.set(key, this.seqCursorStore);
    const cursors = this.seqCursorStore;
    this.cursorChain = this.cursorChain
      .then(async () => {
        if ((await cursors.getSyncSeqCursor(key)) === null) await cursors.setSyncSeqCursor(key, 0);
      })
      .catch(() => {
        // Unpersisted enrollment: this process still holds the floor; the
        // cursor's first acknowledged write persists it.
      });
    // What one relay served says nothing about what another holds.
    this.knownRemote.clear();
    // Wire activity (a request attempt, its headers, each body chunk) is
    // progress to the stall watchdog: a slow but live cycle is never abandoned.
    this.unsubscribeActivity?.();
    const reporting = remoteStore as EventStoreAdapter & {
      onActivity?: (l: () => void) => () => void;
    };
    this.unsubscribeActivity =
      typeof reporting.onActivity === "function"
        ? reporting.onActivity(() => this.progress())
        : null;
  }

  private unsubscribeActivity: (() => void) | null = null;

  /** The relay holds these (it served them): a push counts them acknowledged. */
  private noteHeldByRelay(events: readonly EventLogEntry[]): void {
    // Bounded: forgetting one only costs a harmless re-push.
    if (this.knownRemote.size > MAX_KNOWN_REMOTE) this.knownRemote.clear();
    for (const e of events) this.knownRemote.set(e.event_id, e.version_clock);
  }

  /**
   * Start background sync loop.
   */
  start(): void {
    if (this.syncInterval !== null) return;
    this.syncInterval = setInterval(() => {
      void this.sync();
    }, this.config.sync_interval_ms);
  }

  /**
   * Stop background sync.
   */
  stop(): void {
    if (this.syncInterval !== null) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  /**
   * Perform a single sync cycle: push local events, pull remote events. A
   * call made while a cycle is running joins that cycle.
   */
  sync(): Promise<SyncResult> {
    if (this.running) return this.running;
    const cycle = ++this.cycle;
    const remote = this.remoteStore;
    const run = this.watchStall(this.runSync(cycle), cycle, remote).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  /**
   * `run`'s result, or — once the cycle has made no progress for
   * `stall_timeout_ms` — an empty result with the cycle abandoned. Bounds the
   * cycle's caller and every caller that joined it, whatever the remote does.
   */
  private watchStall(
    run: Promise<SyncResult>,
    cycle: number,
    remote: EventStoreAdapter | null,
  ): Promise<SyncResult> {
    const stallMs = this.config.stall_timeout_ms ?? DEFAULT_STALL_TIMEOUT_MS;
    this.lastProgressAt = Date.now();
    return new Promise<SyncResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const check = (): void => {
        const idle = Date.now() - this.lastProgressAt;
        if (idle < stallMs) {
          timer = setTimeout(check, stallMs - idle);
          return;
        }
        // Work still on the wire, within its own deadline, is alive — not a
        // stall — however long it takes (#914 round 7). Only the transport
        // can say: ask it.
        if ((remote as { hasLiveWork?: () => boolean } | null)?.hasLiveWork?.() === true) {
          this.lastProgressAt = Date.now();
          timer = setTimeout(check, stallMs);
          return;
        }
        resolve({ pushed: 0, pulled: 0, conflicts: [] });
        if (this.cycle === cycle) {
          this.cycle++; // the abandoned cycle's late status writes are ignored
          // …and its requests end with it: a request left on the wire would
          // hold the push slot against the next cycle (#914 round 6).
          (remote as { abortInFlight?: () => void } | null)?.abortInFlight?.();
          this.setStatus("error");
        }
      };
      timer = setTimeout(check, stallMs);
      run.then(
        (result) => {
          if (timer) clearTimeout(timer);
          resolve(result);
        },
        () => {
          // runSync reports its own failures; this is a last line, never an
          // unhandled rejection and never a wedged `running`.
          if (timer) clearTimeout(timer);
          resolve({ pushed: 0, pulled: 0, conflicts: [] });
          if (this.cycle === cycle) this.setStatus("error");
        },
      );
    });
  }

  /** The cycle made progress: the stall watchdog restarts its count. */
  private progress(): void {
    this.lastProgressAt = Date.now();
  }

  /** Set the status, unless `cycle` was abandoned. */
  private setCycleStatus(cycle: number, status: SyncStatus): void {
    if (cycle === this.cycle) this.setStatus(status);
  }

  private async runSync(cycle: number): Promise<SyncResult> {
    const remote = this.remoteStore;
    if (remote === null) {
      this.setCycleStatus(cycle, "offline");
      return { pushed: 0, pulled: 0, conflicts: [] };
    }

    this.setCycleStatus(cycle, "syncing");

    try {
      // Push: every local event the relay has not acknowledged (#914)
      const pushed = await this.pushEvents(remote);

      // Pull: get remote events we haven't seen
      // Each page's events are noted as held by the relay as the page is
      // applied (never pushed back, even by a concurrent cycle), and each
      // page is progress to the watchdog.
      const pulledNow = await this.awaitPull(remote);
      this.progress();
      if (pulledNow === null) {
        // The pull is still arriving (a slow relay): it continues, its pages
        // land as they come, and a later sync reports it (#914 round 7).
        this.setCycleStatus(cycle, "idle");
        return { pushed: pushed.count, pulled: 0, conflicts: [] };
      }
      const pulled = pulledNow;

      // Detect conflicts
      const conflicts = this.detectConflicts(pushed.events, pulled.events);
      this.conflicts.push(...conflicts);

      // The pull-side clock, as before #914. The PUSH cursor is never set
      // here: it moved, in pushEvents, only as far as the relay acknowledged.
      this.pullAfterClock = await this.localStore.getLatestClock(this.cursor.motebit_id);

      this.setCycleStatus(cycle, "idle");

      return {
        pushed: pushed.count,
        pulled: pulled.count,
        conflicts,
        ...(pulled.skipped && pulled.skipped.length > 0 ? { skipped: pulled.skipped } : {}),
        ...(pulled.encryptedOnRawPath ? { encryptedOnRawPath: pulled.encryptedOnRawPath } : {}),
      };
    } catch {
      this.setCycleStatus(cycle, "error");
      return { pushed: 0, pulled: 0, conflicts: [] };
    }
  }

  /**
   * Subscribe to sync status changes.
   */
  onStatusChange(listener: SyncStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Get current sync status.
   */
  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Get all unresolved conflicts.
   */
  getConflicts(): ConflictEdge[] {
    return [...this.conflicts];
  }

  /**
   * Get the current sync cursor. `last_version_clock` is the PUSH cursor:
   * the relay acknowledged every local event at or below it (#914).
   */
  getCursor(): SyncCursor {
    return { ...this.cursor };
  }

  // === Internal ===

  /**
   * Push every local event above the push cursor, at most
   * MAX_PUSH_BATCHES_PER_SYNC × `batch_size` of them, handed to the adapter
   * together (#914 round 7). Each acknowledgment (an `append` that resolved)
   * moves the cursor through `advance` — only past whole clock groups the
   * relay ACKNOWLEDGED, persisted — whenever it arrives, in this sync or
   * after it. A push still in flight from an earlier sync is joined, never
   * sent again. The sync waits for the answers only as long as `patient`
   * allows; a failure that arrived by then is thrown. The relay dedups by
   * event_id, so a re-push is harmless.
   *
   * The local read has no `limit`: a store's `limit` is not clock-ordered in
   * every store (IndexedDB returns by timestamp, the in-memory store by
   * insertion order), and a clock cursor may pass an event only when EVERY
   * event at or below it was read. An event appended after the read carries
   * a clock above everything read (the store's max + 1), so a later push
   * takes it — PROVIDED the store assigns clocks atomically
   * (`appendWithClock`). The Tauri and Expo stores do not yet: a concurrent
   * append there can land at or below the cursor and is never pushed, a loss
   * main shares. Tracked in #964; see `ackedPushCursor`.
   */
  private async pushEvents(
    remote: EventStoreAdapter,
  ): Promise<{ count: number; events: EventLogEntry[] }> {
    const motebitId = this.cursor.motebit_id;
    const key = pushCursorKey(remote, motebitId);
    const stream = relayStreamOf(remote);
    this.streamOfKey.set(key, stream);
    await this.cursorChain; // an acknowledgment being folded in lands first
    const cursor = (await this.seqCursorStore.getSyncSeqCursor(key)) ?? 0;
    this.cursor.last_version_clock = cursor;

    const pending = (
      await this.localStore.query({ motebit_id: motebitId, after_version_clock: cursor })
    )
      .filter((e) => e.motebit_id === motebitId && e.version_clock > cursor)
      .sort(byClockThenId);
    this.aboveCursor.set(key, pending);

    const transport = transportOf(remote);
    let inFlight = this.outstanding.get(key);
    if (!inFlight) {
      inFlight = new Map<string, { promise: Promise<void>; via: object }>();
      this.outstanding.set(key, inFlight);
    }
    // A push held by ANOTHER transport instance — an adapter a token refresh
    // or rebuild replaced — is joined only while that adapter still holds it
    // on the wire (`holdsPush`: a frame draining on its retired socket, which
    // its own rules settle). One it no longer holds may never settle: it is
    // sent again through this transport (#914 round 9; the relay stores each
    // event_id once). Never a re-send of work still in flight; never a join
    // of a promise nothing will settle.
    for (const [id, held] of inFlight) {
      if (held.via === transport) continue;
      if ((held.via as PushTransport).holdsPush?.(id) === true) continue;
      inFlight.delete(id);
    }
    let acked = this.ackedAbove.get(key);
    if (!acked) this.ackedAbove.set(key, (acked = new Set<string>()));
    // A push left in flight by an earlier sync is joined, never sent again —
    // when the transport reports its live work (`hasLiveWork`): such a
    // transport settles every push it holds (an answer, a close, a dead
    // socket, a silent request's cap). A transport that cannot say may hold
    // one forever; its pushes are sent again — harmless, the relay dedups.
    if (
      inFlight.size > 0 &&
      typeof (remote as { hasLiveWork?: () => boolean }).hasLiveWork !== "function"
    ) {
      inFlight.clear();
    }

    // Every batch of this sync is handed to the adapter AT ONCE (#914 round
    // 7): the adapter decides how much goes on the wire together (the socket
    // pipelines frames, HTTP overlaps a slow relay's answers), so a batch
    // never waits on the previous batch's answer.
    const mine: Array<{ e: EventLogEntry; acked: Promise<void> }> = [];
    const window = pending.slice(0, MAX_PUSH_BATCHES_PER_SYNC * this.config.batch_size);
    for (const e of window) {
      if (
        acked.has(e.event_id) ||
        this.knownRemote.has(e.event_id) ||
        (stream !== null && relayHolds(this.localStore, stream, e.event_id))
      ) {
        acked.add(e.event_id);
        continue;
      }
      let p = inFlight.get(e.event_id)?.promise;
      if (!p) {
        const sent = remote.append(e);
        p = sent;
        inFlight.set(e.event_id, { promise: sent, via: transport });
        const ackedSet = acked;
        const flying = inFlight;
        sent.then(
          () => {
            ackedSet.add(e.event_id);
            this.progress();
            this.queueAdvance(key);
          },
          () => {
            this.progress();
          },
        );
        void sent
          .finally(() => {
            if (flying.get(e.event_id)?.promise === sent) flying.delete(e.event_id);
          })
          .catch(() => {});
      }
      mine.push({ e, acked: p });
    }

    // Wait for the answers — but not past the patience: an answer still
    // coming then is not a failure, and it moves the cursor when it arrives.
    // Past the patience, only a transport that reports live work lets the
    // sync end early; one that cannot say is waited on (the stall watchdog
    // governs it).
    const waited = await this.patient(Promise.allSettled(mine.map((m) => m.acked)), remote);
    const results = waited === null ? null : waited.value;

    await this.advance(key); // a cursor write that fails fails this sync

    const pushed: EventLogEntry[] = [];
    let failure: Error | null = null;
    if (results) {
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === "fulfilled") pushed.push(mine[i]!.e);
        else if (failure === null) {
          const reason: unknown = r.reason;
          failure =
            reason instanceof Error ? reason : new Error("sync push failed", { cause: reason });
        }
      }
    } else {
      for (const m of mine) if (acked.has(m.e.event_id)) pushed.push(m.e);
    }
    if (failure !== null) throw failure;
    return { count: pushed.length, events: pushed };
  }

  /**
   * `p`'s outcome — or null once the patience has passed while the
   * transport reports live work (#914 round 7). A transport that cannot say
   * is waited on; the stall watchdog governs it.
   */
  private patient<T>(p: Promise<T>, remote: EventStoreAdapter): Promise<{ value: T } | null> {
    const patience = this.config.push_patience_ms ?? this.config.sync_interval_ms;
    let timer: ReturnType<typeof setTimeout> | null = null;
    return Promise.race([
      p.then((value) => ({ value })),
      new Promise<null>((resolve) => {
        const look = (): void => {
          if ((remote as { hasLiveWork?: () => boolean }).hasLiveWork?.() === true) resolve(null);
          else timer = setTimeout(look, patience);
        };
        timer = setTimeout(look, patience);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * The pull still running from an earlier sync: joined, never doubled. A
   * sync waits for it only as long as `patient` allows.
   */
  private pendingPull: { remote: EventStoreAdapter; promise: Promise<PullOutcome> } | null = null;

  private async awaitPull(remote: EventStoreAdapter): Promise<PullOutcome | null> {
    let p = this.pendingPull;
    if (!p || p.remote !== remote) {
      const promise = this.pullEvents();
      promise.catch(() => {}); // consumed below, or by a later sync
      p = this.pendingPull = { remote, promise };
    }
    const mine = p;
    const settled = mine.promise.catch((err: unknown) => {
      if (this.pendingPull === mine) this.pendingPull = null;
      throw err;
    });
    const r = await this.patient(settled, remote);
    if (r === null) return null;
    if (this.pendingPull === mine) this.pendingPull = null;
    return r.value;
  }

  /** Fold acknowledgments into the push cursor soon — one pending fold per key. */
  private queueAdvance(key: string): void {
    if (this.advanceQueued.has(key)) return;
    this.advanceQueued.add(key);
    void Promise.resolve()
      .then(() => {
        this.advanceQueued.delete(key);
        return this.advance(key);
      })
      .catch(() => {
        // A failed cursor write loses nothing: the next sync re-pushes.
      });
  }

  /**
   * Move the push cursor for `key` past every whole clock group, in push
   * order, whose every event is acknowledged or held by the relay
   * (`ackedPushCursor`), and persist it. Serialized: writes never interleave.
   */
  private advance(key: string): Promise<void> {
    const run = this.cursorChain.then(async () => {
      const stream = this.streamOfKey.get(key) ?? null;
      const list = this.aboveCursor.get(key);
      const acked = this.ackedAbove.get(key);
      if (!list || !acked) return;
      const cursor = (await this.seqCursorStore.getSyncSeqCursor(key)) ?? 0;
      let from = 0;
      while (from < list.length && list[from]!.version_clock <= cursor) from++;
      const above = from > 0 ? list.slice(from) : list;
      const done = new Set<string>();
      for (const e of above) {
        if (
          acked.has(e.event_id) ||
          this.knownRemote.has(e.event_id) ||
          (stream !== null && relayHolds(this.localStore, stream, e.event_id))
        ) {
          done.add(e.event_id);
        } else break; // the cursor stops at the first gap
      }
      const next = ackedPushCursor(cursor, above, done);
      if (next > cursor) {
        // Persisted FIRST: a write that fails forgets nothing, so the next
        // fold (or this sync's own) tries again.
        await this.seqCursorStore.setSyncSeqCursor(key, next);
        let passed = 0;
        while (passed < above.length && above[passed]!.version_clock <= next) {
          acked.delete(above[passed]!.event_id);
          passed++;
        }
        this.aboveCursor.set(key, above.slice(passed));
        if (this.remoteStore && pushCursorKey(this.remoteStore, this.cursor.motebit_id) === key) {
          this.cursor.last_version_clock = next;
        }
        for (const [id, clock] of this.knownRemote) {
          if (clock <= next) this.knownRemote.delete(id);
        }
      }
    });
    this.cursorChain = run.catch(() => {});
    return run;
  }

  private async pullEvents(): Promise<PullOutcome> {
    if (this.remoteStore === null) return { count: 0, events: [] };

    // #868: a remote that pulls by the relay ingest sequence is read by seq —
    // the transport cursor — never by this device's clock. The clock below
    // is sent only as the fallback an older relay answers.
    if (isSeqPullSource(this.remoteStore)) {
      const { fresh, skipped, encryptedOnRawPath } = await pullBySeq({
        source: this.remoteStore,
        localStore: this.localStore,
        cursorStore: this.seqCursorStore,
        motebitId: this.cursor.motebit_id,
        fallbackAfterClock: this.pullAfterClock,
        onSkipped: this.config.onSkippedEvent ?? warnSkippedSyncEvent,
        onPage: (page) => {
          this.noteHeldByRelay(page);
          this.progress();
        },
      });
      return { count: fresh.length, events: fresh, skipped, encryptedOnRawPath };
    }

    const remoteEvents = await this.remoteStore.query({
      motebit_id: this.cursor.motebit_id,
      after_version_clock: this.pullAfterClock,
      limit: this.config.batch_size,
    });

    // Only append events we don't already have
    const localClock = await this.localStore.getLatestClock(this.cursor.motebit_id);
    const newEvents = remoteEvents.filter((e) => e.version_clock > localClock);

    for (const event of newEvents) {
      await this.localStore.append(event);
    }
    this.noteHeldByRelay(newEvents);

    return { count: newEvents.length, events: newEvents };
  }

  private detectConflicts(pushed: EventLogEntry[], pulled: EventLogEntry[]): ConflictEdge[] {
    const conflicts: ConflictEdge[] = [];

    // Simple conflict detection: same version_clock from different sources
    for (const local of pushed) {
      for (const remote of pulled) {
        if (local.version_clock === remote.version_clock && local.event_id !== remote.event_id) {
          conflicts.push({
            local_event: local,
            remote_event: remote,
            resolution: "unresolved",
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Set the status and tell the listeners. A listener that throws is
   * reported and passed over: it never breaks a sync cycle, the watchdog, or
   * the next sync (#914 round 3).
   */
  private setStatus(status: SyncStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (err: unknown) {
        // eslint-disable-next-line no-console -- the runtime's pluggable-logger default (CLAUDE.md conventions)
        console.warn(
          `sync: a status listener threw on "${status}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
