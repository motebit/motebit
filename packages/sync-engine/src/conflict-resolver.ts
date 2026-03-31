import type { SyncConversation, SyncConversationMessage } from "@motebit/sdk";

// === Conflict Resolution Interfaces ===

/** Strategy used to resolve a conflict. */
export type ConflictStrategy = "local_wins" | "remote_wins" | "merge";

/** Result of resolving a conflict between local and remote versions. */
export interface ConflictResult<T> {
  /** The resolved value to store locally. */
  resolved: T;
  /** Which strategy was applied. */
  strategy: ConflictStrategy;
  /** True when local and remote versions diverged (for UI notification). */
  conflicted: boolean;
}

/** Metadata attached to a versioned value for conflict comparison. */
export interface Versioned {
  /** Monotonic version clock (higher = newer). */
  version: number;
  /** Wall-clock timestamp in ms. */
  timestamp: number;
  /** Originating device ID (deterministic tiebreak). */
  device_id: string;
}

/**
 * Pluggable conflict resolver. Different data types can use different strategies:
 * - Conversations metadata: LastWriterWinsResolver
 * - Conversation messages: AppendOnlyMergeResolver
 * - Plans/goals: LastWriterWinsResolver
 */
export interface ConflictResolver<T> {
  resolve(local: T & Versioned, remote: T & Versioned): ConflictResult<T>;
}

/** Conflict event for structured logging and UI display. */
export interface ConflictEvent {
  /** Unique ID for this conflict occurrence. */
  conflict_id: string;
  /** What kind of data conflicted. */
  data_type: string;
  /** Which strategy resolved it. */
  strategy: ConflictStrategy;
  /** Whether versions actually diverged. */
  conflicted: boolean;
  /** When the conflict was resolved. */
  resolved_at: number;
  /** Local version clock. */
  local_version: number;
  /** Remote version clock. */
  remote_version: number;
  /** Local device ID. */
  local_device_id: string;
  /** Remote device ID. */
  remote_device_id: string;
}

// === Last-Writer-Wins Resolver ===

/**
 * Default conflict resolution strategy:
 * 1. Higher version clock wins
 * 2. If equal versions, later timestamp wins
 * 3. If equal timestamps, lexicographically greater device_id wins (deterministic)
 *
 * Marks conflicted=true when versions diverge (local.version !== remote.version
 * and neither is strictly greater), so the UI can show a notification.
 */
export class LastWriterWinsResolver<T> implements ConflictResolver<T> {
  resolve(local: T & Versioned, remote: T & Versioned): ConflictResult<T> {
    // No conflict: versions are identical
    if (
      local.version === remote.version &&
      local.timestamp === remote.timestamp &&
      local.device_id === remote.device_id
    ) {
      return { resolved: local, strategy: "local_wins", conflicted: false };
    }

    // Determine winner
    const conflicted = local.version !== remote.version;
    const winner = this.pickWinner(local, remote);
    const strategy: ConflictStrategy = winner === local ? "local_wins" : "remote_wins";

    // Strip Versioned metadata from the result — return clean T
    const { version: _v, timestamp: _t, device_id: _d, ...rest } = winner;
    return { resolved: rest as T, strategy, conflicted };
  }

  private pickWinner(local: Versioned, remote: Versioned): typeof local {
    if (local.version !== remote.version) {
      return local.version > remote.version ? local : remote;
    }
    if (local.timestamp !== remote.timestamp) {
      return local.timestamp > remote.timestamp ? local : remote;
    }
    // Deterministic tiebreak: lexicographically greater device_id wins
    return local.device_id >= remote.device_id ? local : remote;
  }
}

// === Append-Only Merge Resolver for Conversation Messages ===

/** Input shape for append-only merge: a conversation with its messages. */
export interface ConversationWithMessages {
  conversation: SyncConversation;
  messages: SyncConversationMessage[];
}

/**
 * Merge resolver for conversations and their messages.
 * Conversations are append-only: messages are never edited.
 * Merge = union of messages, deduplicated by message_id, sorted by timestamp.
 * This is a natural CRDT (grow-only set).
 *
 * For conversation metadata, delegates to LastWriterWinsResolver.
 */
export class AppendOnlyMergeResolver {
  private metadataResolver = new LastWriterWinsResolver<SyncConversation>();

  /**
   * Merge two versions of the same conversation.
   * - Metadata: last-writer-wins by version/timestamp/device_id
   * - Messages: union deduplicated by message_id, sorted by created_at
   */
  resolve(
    local: ConversationWithMessages & Versioned,
    remote: ConversationWithMessages & Versioned,
  ): ConflictResult<ConversationWithMessages> {
    // Resolve metadata with LWW
    const metadataResult = this.metadataResolver.resolve(
      {
        ...local.conversation,
        version: local.version,
        timestamp: local.timestamp,
        device_id: local.device_id,
      },
      {
        ...remote.conversation,
        version: remote.version,
        timestamp: remote.timestamp,
        device_id: remote.device_id,
      },
    );

    // Merge messages: union by message_id
    const messageMap = new Map<string, SyncConversationMessage>();
    for (const msg of local.messages) {
      messageMap.set(msg.message_id, msg);
    }
    for (const msg of remote.messages) {
      // Only add if not already present (first-seen wins for identical IDs)
      if (!messageMap.has(msg.message_id)) {
        messageMap.set(msg.message_id, msg);
      }
    }

    // Sort by created_at, then by message_id for deterministic order
    const mergedMessages = Array.from(messageMap.values()).sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at - b.created_at;
      return a.message_id.localeCompare(b.message_id);
    });

    const mergedConversation = {
      ...metadataResult.resolved,
      message_count: mergedMessages.length,
    };

    // It's a merge if both sides contributed messages the other didn't have
    const localIds = new Set(local.messages.map((m) => m.message_id));
    const remoteIds = new Set(remote.messages.map((m) => m.message_id));
    const localOnly = local.messages.some((m) => !remoteIds.has(m.message_id));
    const remoteOnly = remote.messages.some((m) => !localIds.has(m.message_id));
    const isMerge = localOnly && remoteOnly;

    return {
      resolved: { conversation: mergedConversation, messages: mergedMessages },
      strategy: isMerge ? "merge" : metadataResult.strategy,
      conflicted: isMerge || metadataResult.conflicted,
    };
  }
}

// === Conflict Logger ===

/** Logger interface matching the runtime pluggable logger convention. */
export interface ConflictLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

const defaultLogger: ConflictLogger = {
  warn: (message: string, data?: Record<string, unknown>) => {
    console.warn(message, data);
  },
};

/**
 * Tracks conflict events for structured logging and UI display.
 * Stores the last N conflicts and logs each one.
 */
export class ConflictTracker {
  private events: ConflictEvent[] = [];
  private maxEvents: number;
  private logger: ConflictLogger;

  constructor(opts: { maxEvents?: number; logger?: ConflictLogger } = {}) {
    this.maxEvents = opts.maxEvents ?? 100;
    this.logger = opts.logger ?? defaultLogger;
  }

  /** Record a conflict event. */
  record(event: Omit<ConflictEvent, "conflict_id" | "resolved_at">): ConflictEvent {
    const full: ConflictEvent = {
      ...event,
      conflict_id: crypto.randomUUID(),
      resolved_at: Date.now(),
    };

    this.events.push(full);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    if (full.conflicted) {
      this.logger.warn("sync conflict resolved", {
        conflict_id: full.conflict_id,
        data_type: full.data_type,
        strategy: full.strategy,
        local_version: full.local_version,
        remote_version: full.remote_version,
        local_device_id: full.local_device_id,
        remote_device_id: full.remote_device_id,
      });
    }

    return full;
  }

  /** Get all recorded conflict events. */
  getEvents(): readonly ConflictEvent[] {
    return this.events;
  }

  /** Get the most recent conflict event, or null. */
  getLastConflict(): ConflictEvent | null {
    return this.events.length > 0 ? this.events[this.events.length - 1]! : null;
  }

  /** Clear all recorded events. */
  clear(): void {
    this.events = [];
  }
}
