import type { EventLogEntry, SyncCursor, ConflictEdge } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";

export { HttpEventStoreAdapter } from "./http-adapter.js";
export type { HttpAdapterConfig } from "./http-adapter.js";
export { WebSocketEventStoreAdapter } from "./ws-adapter.js";
export type {
  WebSocketAdapterConfig,
  EventReceivedCallback,
  CustomMessageCallback,
} from "./ws-adapter.js";
export { EncryptedEventStoreAdapter, decryptEventPayload } from "./encrypted-adapter.js";
export type { EncryptedAdapterConfig, KeyProvider } from "./encrypted-adapter.js";
export {
  EncryptedConversationSyncAdapter,
  decryptConversationMessage,
  decryptSyncConversation,
} from "./encrypted-conversation-adapter.js";
export type { EncryptedConversationAdapterConfig } from "./encrypted-conversation-adapter.js";
export { PairingClient } from "./pairing-client.js";
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
  HttpConversationSyncConfig,
} from "./conversation-sync.js";
export { PlanSyncEngine, HttpPlanSyncAdapter, InMemoryPlanSyncStore } from "./plan-sync.js";
export type {
  PlanSyncConfig,
  PlanSyncStatus,
  PlanSyncStoreAdapter,
  PlanSyncRemoteAdapter,
  HttpPlanSyncConfig,
} from "./plan-sync.js";
export { EncryptedPlanSyncAdapter } from "./encrypted-plan-adapter.js";
export type { EncryptedPlanAdapterConfig } from "./encrypted-plan-adapter.js";

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
}

export interface SyncStatusListener {
  (status: SyncStatus): void;
}

// === Sync Engine ===

export class SyncEngine {
  private config: SyncConfig;
  private localStore: EventStoreAdapter;
  private remoteStore: EventStoreAdapter | null = null;
  private cursor: SyncCursor;
  private status: SyncStatus = "idle";
  private statusListeners: Set<SyncStatusListener> = new Set();
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private conflicts: ConflictEdge[] = [];

  constructor(localStore: EventStoreAdapter, motebitId: string, config: Partial<SyncConfig> = {}) {
    this.config = { ...DEFAULT_SYNC_CONFIG, ...config };
    this.localStore = localStore;
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
   * Perform a single sync cycle: push local events, pull remote events.
   */
  async sync(): Promise<SyncResult> {
    if (this.remoteStore === null) {
      this.setStatus("offline");
      return { pushed: 0, pulled: 0, conflicts: [] };
    }

    this.setStatus("syncing");

    try {
      // Push: send local events the remote hasn't seen
      const pushed = await this.pushEvents();

      // Pull: get remote events we haven't seen
      const pulled = await this.pullEvents();

      // Detect conflicts
      const conflicts = this.detectConflicts(pushed.events, pulled.events);
      this.conflicts.push(...conflicts);

      // Update cursor
      const localClock = await this.localStore.getLatestClock(this.cursor.motebit_id);
      this.cursor.last_version_clock = localClock;

      this.setStatus("idle");

      return {
        pushed: pushed.count,
        pulled: pulled.count,
        conflicts,
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
   * Get the current sync cursor.
   */
  getCursor(): SyncCursor {
    return { ...this.cursor };
  }

  // === Internal ===

  private async pushEvents(): Promise<{ count: number; events: EventLogEntry[] }> {
    if (this.remoteStore === null) return { count: 0, events: [] };

    const localEvents = await this.localStore.query({
      motebit_id: this.cursor.motebit_id,
      after_version_clock: this.cursor.last_version_clock,
      limit: this.config.batch_size,
    });

    for (const event of localEvents) {
      await this.remoteStore.append(event);
    }

    return { count: localEvents.length, events: localEvents };
  }

  private async pullEvents(): Promise<{ count: number; events: EventLogEntry[] }> {
    if (this.remoteStore === null) return { count: 0, events: [] };

    const remoteEvents = await this.remoteStore.query({
      motebit_id: this.cursor.motebit_id,
      after_version_clock: this.cursor.last_version_clock,
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
