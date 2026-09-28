import type { EventLogEntry, SyncCursor, ConflictEdge } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";
import {
  isSeqPullSource,
  pullBySeq,
  resolveSeqCursorStore,
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
}

/**
 * The most push batches (`batch_size` events each) one `sync()` sends (#914).
 * A larger backlog continues on the next sync from the persisted push cursor.
 */
export const MAX_PUSH_BATCHES_PER_SYNC = 50;

/** How many pulled event_ids the engine remembers as held by the relay. */
const MAX_KNOWN_REMOTE = 10_000;

/**
 * The key the push cursor is kept under, in the same cursor store as the
 * pull cursor (#914). A remote that names its relay stream (a seq source)
 * gets a cursor of its own, so a relay it has never pushed to is pushed the
 * whole log; any other remote shares the identity's default push cursor.
 * Prefixed `push:` — never equal to a pull cursor key.
 */
export function pushCursorKey(remote: EventStoreAdapter, motebitId: string): string {
  return isSeqPullSource(remote) ? `push:${remote.seqCursorKey}` : `push:#${motebitId}`;
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
  /** The sync in progress: a second call joins it rather than racing it. */
  private running: Promise<SyncResult> | null = null;
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
    // What one relay served says nothing about what another holds.
    this.knownRemote.clear();
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
    const run = this.runSync().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async runSync(): Promise<SyncResult> {
    const remote = this.remoteStore;
    if (remote === null) {
      this.setStatus("offline");
      return { pushed: 0, pulled: 0, conflicts: [] };
    }

    this.setStatus("syncing");

    try {
      // Push: every local event the relay has not acknowledged (#914)
      const pushed = await this.pushEvents(remote);

      // Pull: get remote events we haven't seen
      const pulled = await this.pullEvents();
      // The relay served these, so it holds them: never pushed back.
      // Bounded: forgetting one only costs a harmless re-push.
      if (this.knownRemote.size > MAX_KNOWN_REMOTE) this.knownRemote.clear();
      for (const e of pulled.events) this.knownRemote.set(e.event_id, e.version_clock);

      // Detect conflicts
      const conflicts = this.detectConflicts(pushed.events, pulled.events);
      this.conflicts.push(...conflicts);

      // The pull-side clock, as before #914. The PUSH cursor is never set
      // here: it moved, in pushEvents, only as far as the relay acknowledged.
      this.pullAfterClock = await this.localStore.getLatestClock(this.cursor.motebit_id);

      this.setStatus("idle");

      return {
        pushed: pushed.count,
        pulled: pulled.count,
        conflicts,
        ...(pulled.skipped && pulled.skipped.length > 0 ? { skipped: pulled.skipped } : {}),
        ...(pulled.encryptedOnRawPath ? { encryptedOnRawPath: pulled.encryptedOnRawPath } : {}),
      };
    } catch {
      this.setStatus("error");
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
   * Push every local event above the push cursor, `batch_size` at a time, at
   * most MAX_PUSH_BATCHES_PER_SYNC batches (#914). After each batch the
   * cursor moves to `ackedPushCursor` — only as far as the relay
   * ACKNOWLEDGED (an `append` that resolved) — and is persisted. A failed
   * append ends the push once the cursor is saved, and is thrown. The relay
   * dedups by event_id, so a re-push is harmless.
   *
   * The local read has no `limit`: a store's `limit` is not clock-ordered in
   * every store (IndexedDB returns by timestamp, the in-memory store by
   * insertion order), and a clock cursor may pass an event only when EVERY
   * event at or below it was read. An event appended after the read carries
   * a clock above everything read (the store's max + 1), so a later push
   * takes it.
   */
  private async pushEvents(
    remote: EventStoreAdapter,
  ): Promise<{ count: number; events: EventLogEntry[] }> {
    const motebitId = this.cursor.motebit_id;
    const key = pushCursorKey(remote, motebitId);
    let cursor = (await this.seqCursorStore.getSyncSeqCursor(key)) ?? 0;
    this.cursor.last_version_clock = cursor;

    const pending = (
      await this.localStore.query({ motebit_id: motebitId, after_version_clock: cursor })
    )
      .filter((e) => e.motebit_id === motebitId && e.version_clock > cursor)
      .sort(byClockThenId);

    const done = new Set<string>();
    const pushed: EventLogEntry[] = [];
    let failure: Error | null = null;
    for (
      let batch = 0, at = 0;
      batch < MAX_PUSH_BATCHES_PER_SYNC && at < pending.length && failure === null;
      batch++, at += this.config.batch_size
    ) {
      const send: EventLogEntry[] = [];
      for (const e of pending.slice(at, at + this.config.batch_size)) {
        if (this.knownRemote.has(e.event_id)) done.add(e.event_id);
        else send.push(e);
      }
      // One append per event, all started together: the adapter decides how
      // many go on the wire at once (the socket coalesces them into a frame;
      // HTTP bounds its concurrent requests).
      const settled = await Promise.allSettled(send.map((e) => remote.append(e)));
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i]!;
        const e = send[i]!;
        if (r.status === "fulfilled") {
          done.add(e.event_id);
          pushed.push(e);
        } else if (failure === null) {
          const reason: unknown = r.reason;
          failure =
            reason instanceof Error ? reason : new Error("sync push failed", { cause: reason });
        }
      }
      const next = ackedPushCursor(cursor, pending, done);
      if (next > cursor) {
        await this.seqCursorStore.setSyncSeqCursor(key, next);
        cursor = next;
        this.cursor.last_version_clock = cursor;
      }
    }
    for (const [id, clock] of this.knownRemote) {
      if (clock <= cursor) this.knownRemote.delete(id);
    }
    if (failure !== null) throw failure;
    return { count: pushed.length, events: pushed };
  }

  private async pullEvents(): Promise<{
    count: number;
    events: EventLogEntry[];
    skipped?: SkippedSyncEvent[];
    encryptedOnRawPath?: number;
  }> {
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

  private setStatus(status: SyncStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}
