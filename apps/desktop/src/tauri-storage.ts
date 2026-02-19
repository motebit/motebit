import type { EventLogEntry, EventType, MemoryNode, MemoryEdge, MotebitIdentity, AuditRecord, SensitivityLevel, RelationType } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import type { MemoryStorageAdapter, MemoryQuery } from "@motebit/memory-graph";
import { computeDecayedConfidence } from "@motebit/memory-graph";
import type { IdentityStorage, DeviceRegistration } from "@motebit/core-identity";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import type { StateSnapshotAdapter, ConversationStoreAdapter } from "@motebit/runtime";

// === IPC Helpers ===

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

async function dbQuery<T>(invoke: InvokeFn, sql: string, params: unknown[] = []): Promise<T[]> {
  return invoke<T[]>("db_query", { sql, params });
}

async function dbExecute(invoke: InvokeFn, sql: string, params: unknown[] = []): Promise<number> {
  return invoke<number>("db_execute", { sql, params });
}

// === TauriEventStore ===

interface EventRow {
  event_id: string;
  motebit_id: string;
  device_id: string | null;
  event_type: string;
  payload: string;
  version_clock: number;
  timestamp: number;
  tombstoned: number;
}

function rowToEvent(row: EventRow): EventLogEntry {
  const entry: EventLogEntry = {
    event_id: row.event_id,
    motebit_id: row.motebit_id,
    event_type: row.event_type as EventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    version_clock: row.version_clock,
    timestamp: row.timestamp,
    tombstoned: row.tombstoned === 1,
  };
  if (row.device_id !== null) {
    entry.device_id = row.device_id;
  }
  return entry;
}

export class TauriEventStore implements EventStoreAdapter {
  constructor(private invoke: InvokeFn) {}

  async append(entry: EventLogEntry): Promise<void> {
    await dbExecute(
      this.invoke,
      `INSERT OR IGNORE INTO events (event_id, motebit_id, device_id, event_type, payload, version_clock, timestamp, tombstoned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.event_id,
        entry.motebit_id,
        entry.device_id ?? null,
        entry.event_type,
        JSON.stringify(entry.payload),
        entry.version_clock,
        entry.timestamp,
        entry.tombstoned ? 1 : 0,
      ],
    );
  }

  async query(filter: EventFilter): Promise<EventLogEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.motebit_id !== undefined) {
      conditions.push("motebit_id = ?");
      params.push(filter.motebit_id);
    }
    if (filter.event_types !== undefined && filter.event_types.length > 0) {
      const placeholders = filter.event_types.map(() => "?").join(", ");
      conditions.push(`event_type IN (${placeholders})`);
      params.push(...filter.event_types);
    }
    if (filter.after_timestamp !== undefined) {
      conditions.push("timestamp > ?");
      params.push(filter.after_timestamp);
    }
    if (filter.before_timestamp !== undefined) {
      conditions.push("timestamp < ?");
      params.push(filter.before_timestamp);
    }
    if (filter.after_version_clock !== undefined) {
      conditions.push("version_clock > ?");
      params.push(filter.after_version_clock);
    }

    let sql = "SELECT * FROM events";
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY version_clock ASC";
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }

    const rows = await dbQuery<EventRow>(this.invoke, sql, params);
    return rows.map(rowToEvent);
  }

  async getLatestClock(motebitId: string): Promise<number> {
    const rows = await dbQuery<{ max_clock: number | null }>(
      this.invoke,
      "SELECT MAX(version_clock) as max_clock FROM events WHERE motebit_id = ?",
      [motebitId],
    );
    return rows[0]?.max_clock ?? 0;
  }

  async tombstone(eventId: string, motebitId: string): Promise<void> {
    await dbExecute(
      this.invoke,
      "UPDATE events SET tombstoned = 1 WHERE event_id = ? AND motebit_id = ?",
      [eventId, motebitId],
    );
  }

  async compact(motebitId: string, beforeClock: number): Promise<number> {
    return dbExecute(
      this.invoke,
      "DELETE FROM events WHERE motebit_id = ? AND version_clock <= ?",
      [motebitId, beforeClock],
    );
  }

  async countEvents(motebitId: string): Promise<number> {
    const rows = await dbQuery<{ cnt: number }>(
      this.invoke,
      "SELECT COUNT(*) as cnt FROM events WHERE motebit_id = ?",
      [motebitId],
    );
    return rows[0]?.cnt ?? 0;
  }
}

// === TauriMemoryStorage ===

interface NodeRow {
  node_id: string;
  motebit_id: string;
  content: string;
  embedding: string;
  confidence: number;
  sensitivity: string;
  created_at: number;
  last_accessed: number;
  half_life: number;
  tombstoned: number;
}

function rowToNode(row: NodeRow): MemoryNode {
  return {
    node_id: row.node_id,
    motebit_id: row.motebit_id,
    content: row.content,
    embedding: JSON.parse(row.embedding) as number[],
    confidence: row.confidence,
    sensitivity: row.sensitivity as SensitivityLevel,
    created_at: row.created_at,
    last_accessed: row.last_accessed,
    half_life: row.half_life,
    tombstoned: row.tombstoned === 1,
  };
}

interface EdgeRow {
  edge_id: string;
  source_id: string;
  target_id: string;
  relation_type: string;
  weight: number;
  confidence: number;
}

function rowToEdge(row: EdgeRow): MemoryEdge {
  return {
    edge_id: row.edge_id,
    source_id: row.source_id,
    target_id: row.target_id,
    relation_type: row.relation_type as RelationType,
    weight: row.weight,
    confidence: row.confidence,
  };
}

export class TauriMemoryStorage implements MemoryStorageAdapter {
  constructor(private invoke: InvokeFn) {}

  async saveNode(node: MemoryNode): Promise<void> {
    await dbExecute(
      this.invoke,
      `INSERT OR REPLACE INTO memory_nodes
       (node_id, motebit_id, content, embedding, confidence, sensitivity, created_at, last_accessed, half_life, tombstoned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        node.node_id,
        node.motebit_id,
        node.content,
        JSON.stringify(node.embedding),
        node.confidence,
        node.sensitivity,
        node.created_at,
        node.last_accessed,
        node.half_life,
        node.tombstoned ? 1 : 0,
      ],
    );
  }

  async getNode(nodeId: string): Promise<MemoryNode | null> {
    const rows = await dbQuery<NodeRow>(
      this.invoke,
      "SELECT * FROM memory_nodes WHERE node_id = ?",
      [nodeId],
    );
    if (rows.length === 0) return null;
    return rowToNode(rows[0]!);
  }

  async queryNodes(query: MemoryQuery): Promise<MemoryNode[]> {
    const rows = await dbQuery<NodeRow>(
      this.invoke,
      "SELECT * FROM memory_nodes WHERE motebit_id = ?",
      [query.motebit_id],
    );
    let results = rows.map(rowToNode);

    if (query.include_tombstoned !== true) {
      results = results.filter((n) => !n.tombstoned);
    }

    if (query.min_confidence !== undefined) {
      const now = Date.now();
      const minConf = query.min_confidence;
      results = results.filter((n) => {
        const decayed = computeDecayedConfidence(
          n.confidence,
          n.half_life,
          now - n.created_at,
        );
        return decayed >= minConf;
      });
    }

    if (query.sensitivity_filter !== undefined) {
      const allowed = query.sensitivity_filter;
      results = results.filter((n) => allowed.includes(n.sensitivity));
    }

    if (query.limit !== undefined) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async saveEdge(edge: MemoryEdge): Promise<void> {
    await dbExecute(
      this.invoke,
      `INSERT OR REPLACE INTO memory_edges
       (edge_id, source_id, target_id, relation_type, weight, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        edge.edge_id,
        edge.source_id,
        edge.target_id,
        edge.relation_type,
        edge.weight,
        edge.confidence,
      ],
    );
  }

  async getEdges(nodeId: string): Promise<MemoryEdge[]> {
    const rows = await dbQuery<EdgeRow>(
      this.invoke,
      "SELECT * FROM memory_edges WHERE source_id = ? OR target_id = ?",
      [nodeId, nodeId],
    );
    return rows.map(rowToEdge);
  }

  async tombstoneNode(nodeId: string): Promise<void> {
    await dbExecute(
      this.invoke,
      "UPDATE memory_nodes SET tombstoned = 1 WHERE node_id = ?",
      [nodeId],
    );
  }

  async getAllNodes(motebitId: string): Promise<MemoryNode[]> {
    const rows = await dbQuery<NodeRow>(
      this.invoke,
      "SELECT * FROM memory_nodes WHERE motebit_id = ?",
      [motebitId],
    );
    return rows.map(rowToNode);
  }

  async getAllEdges(motebitId: string): Promise<MemoryEdge[]> {
    const rows = await dbQuery<EdgeRow>(
      this.invoke,
      `SELECT DISTINCT e.* FROM memory_edges e
       INNER JOIN memory_nodes n ON (e.source_id = n.node_id OR e.target_id = n.node_id)
       WHERE n.motebit_id = ?`,
      [motebitId],
    );
    return rows.map(rowToEdge);
  }
}

// === TauriIdentityStorage ===

interface IdentityRow {
  motebit_id: string;
  created_at: number;
  owner_id: string;
  version_clock: number;
}

interface DeviceRow {
  device_id: string;
  motebit_id: string;
  device_token: string;
  public_key: string;
  registered_at: number;
  device_name: string | null;
}

export class TauriIdentityStorage implements IdentityStorage {
  constructor(private invoke: InvokeFn) {}

  async save(identity: MotebitIdentity): Promise<void> {
    await dbExecute(
      this.invoke,
      `INSERT OR REPLACE INTO identities (motebit_id, created_at, owner_id, version_clock)
       VALUES (?, ?, ?, ?)`,
      [identity.motebit_id, identity.created_at, identity.owner_id, identity.version_clock],
    );
  }

  async load(motebitId: string): Promise<MotebitIdentity | null> {
    const rows = await dbQuery<IdentityRow>(
      this.invoke,
      "SELECT * FROM identities WHERE motebit_id = ?",
      [motebitId],
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return { motebit_id: r.motebit_id, created_at: r.created_at, owner_id: r.owner_id, version_clock: r.version_clock };
  }

  async loadByOwner(ownerId: string): Promise<MotebitIdentity | null> {
    const rows = await dbQuery<IdentityRow>(
      this.invoke,
      "SELECT * FROM identities WHERE owner_id = ? LIMIT 1",
      [ownerId],
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return { motebit_id: r.motebit_id, created_at: r.created_at, owner_id: r.owner_id, version_clock: r.version_clock };
  }

  async saveDevice(device: DeviceRegistration): Promise<void> {
    await dbExecute(
      this.invoke,
      `INSERT OR REPLACE INTO devices (device_id, motebit_id, device_token, public_key, registered_at, device_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [device.device_id, device.motebit_id, device.device_token, device.public_key, device.registered_at, device.device_name ?? null],
    );
  }

  async loadDevice(deviceId: string): Promise<DeviceRegistration | null> {
    const rows = await dbQuery<DeviceRow>(
      this.invoke,
      "SELECT * FROM devices WHERE device_id = ?",
      [deviceId],
    );
    if (rows.length === 0) return null;
    return rowToDeviceReg(rows[0]!);
  }

  async loadDeviceByToken(token: string): Promise<DeviceRegistration | null> {
    const rows = await dbQuery<DeviceRow>(
      this.invoke,
      "SELECT * FROM devices WHERE device_token = ?",
      [token],
    );
    if (rows.length === 0) return null;
    return rowToDeviceReg(rows[0]!);
  }

  async listDevices(motebitId: string): Promise<DeviceRegistration[]> {
    const rows = await dbQuery<DeviceRow>(
      this.invoke,
      "SELECT * FROM devices WHERE motebit_id = ?",
      [motebitId],
    );
    return rows.map(rowToDeviceReg);
  }
}

function rowToDeviceReg(row: DeviceRow): DeviceRegistration {
  const device: DeviceRegistration = {
    device_id: row.device_id,
    motebit_id: row.motebit_id,
    device_token: row.device_token,
    public_key: row.public_key,
    registered_at: row.registered_at,
  };
  if (row.device_name !== null) {
    device.device_name = row.device_name;
  }
  return device;
}

// === TauriAuditLog ===

interface AuditRow {
  audit_id: string;
  motebit_id: string;
  timestamp: number;
  action: string;
  target_type: string;
  target_id: string;
  details: string;
}

function rowToAudit(row: AuditRow): AuditRecord {
  return {
    audit_id: row.audit_id,
    motebit_id: row.motebit_id,
    timestamp: row.timestamp,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    details: JSON.parse(row.details) as Record<string, unknown>,
  };
}

export class TauriAuditLog implements AuditLogAdapter {
  constructor(private invoke: InvokeFn) {}

  async record(entry: AuditRecord): Promise<void> {
    await dbExecute(
      this.invoke,
      `INSERT OR REPLACE INTO audit_log (audit_id, motebit_id, timestamp, action, target_type, target_id, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.audit_id,
        entry.motebit_id,
        entry.timestamp,
        entry.action,
        entry.target_type,
        entry.target_id,
        JSON.stringify(entry.details),
      ],
    );
  }

  async query(
    motebitId: string,
    options: { limit?: number; after?: number } = {},
  ): Promise<AuditRecord[]> {
    const conditions: string[] = ["motebit_id = ?"];
    const params: unknown[] = [motebitId];

    if (options.after !== undefined) {
      conditions.push("timestamp > ?");
      params.push(options.after);
    }

    const sql = `SELECT * FROM audit_log WHERE ${conditions.join(" AND ")} ORDER BY timestamp ASC`;
    const rows = await dbQuery<AuditRow>(this.invoke, sql, params);
    let results = rows.map(rowToAudit);

    if (options.limit !== undefined) {
      results = results.slice(-options.limit);
    }

    return results;
  }
}

// === TauriStateSnapshotStorage ===

export class TauriStateSnapshotStorage implements StateSnapshotAdapter {
  constructor(private invoke: InvokeFn) {}

  saveState(motebitId: string, stateJson: string, versionClock?: number): void {
    // Fire-and-forget — state snapshot writes are best-effort (matches sync interface)
    void dbExecute(
      this.invoke,
      `INSERT OR REPLACE INTO state_snapshots (motebit_id, state_json, updated_at, version_clock)
       VALUES (?, ?, ?, ?)`,
      [motebitId, stateJson, Date.now(), versionClock ?? 0],
    );
  }

  loadState(motebitId: string): string | null {
    // StateSnapshotAdapter is sync — we can't await here.
    // The runtime calls loadState() during constructor, before any async work.
    // We use a sync-ish approach: pre-load in an init step (see TauriStateSnapshotStorage.preload).
    return this._cache.get(motebitId) ?? null;
  }

  getSnapshotClock(motebitId: string): number {
    return this._clockCache.get(motebitId) ?? 0;
  }

  // Internal cache populated by preload()
  private _cache = new Map<string, string>();
  private _clockCache = new Map<string, number>();

  /**
   * Pre-load state from SQLite before constructing MotebitRuntime.
   * Must be called and awaited before the runtime reads loadState().
   */
  async preload(motebitId: string): Promise<void> {
    const rows = await dbQuery<{ state_json: string; version_clock: number }>(
      this.invoke,
      "SELECT state_json, version_clock FROM state_snapshots WHERE motebit_id = ?",
      [motebitId],
    );
    if (rows.length > 0) {
      this._cache.set(motebitId, rows[0]!.state_json);
      this._clockCache.set(motebitId, rows[0]!.version_clock);
    }
  }
}

// === TauriConversationStore ===

interface ConversationRow {
  conversation_id: string;
  motebit_id: string;
  started_at: number;
  last_active_at: number;
  title: string | null;
  summary: string | null;
  message_count: number;
}

interface ConversationMessageRow {
  message_id: string;
  conversation_id: string;
  motebit_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: number;
  token_estimate: number;
}

/** 4-hour window for session continuity. */
const ACTIVE_CONVERSATION_WINDOW_MS = 4 * 60 * 60 * 1000;

export class TauriConversationStore implements ConversationStoreAdapter {
  // ConversationStoreAdapter is sync, but Tauri IPC is async.
  // We use the same preload/cache strategy as TauriStateSnapshotStorage.
  private _activeCache = new Map<string, {
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    summary: string | null;
  } | null>();
  private _messagesCache = new Map<string, Array<{
    messageId: string;
    conversationId: string;
    motebitId: string;
    role: string;
    content: string;
    toolCalls: string | null;
    toolCallId: string | null;
    createdAt: number;
    tokenEstimate: number;
  }>>();

  constructor(private invoke: InvokeFn) {}

  /** Pre-load active conversation and its messages before runtime construction. */
  async preload(motebitId: string): Promise<void> {
    const cutoff = Date.now() - ACTIVE_CONVERSATION_WINDOW_MS;
    const convRows = await dbQuery<ConversationRow>(
      this.invoke,
      "SELECT * FROM conversations WHERE motebit_id = ? AND last_active_at > ? ORDER BY last_active_at DESC LIMIT 1",
      [motebitId, cutoff],
    );
    if (convRows.length > 0) {
      const row = convRows[0]!;
      this._activeCache.set(motebitId, {
        conversationId: row.conversation_id,
        startedAt: row.started_at,
        lastActiveAt: row.last_active_at,
        summary: row.summary,
      });
      const msgRows = await dbQuery<ConversationMessageRow>(
        this.invoke,
        "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC",
        [row.conversation_id],
      );
      this._messagesCache.set(row.conversation_id, msgRows.map(r => ({
        messageId: r.message_id,
        conversationId: r.conversation_id,
        motebitId: r.motebit_id,
        role: r.role,
        content: r.content,
        toolCalls: r.tool_calls,
        toolCallId: r.tool_call_id,
        createdAt: r.created_at,
        tokenEstimate: r.token_estimate,
      })));
    } else {
      this._activeCache.set(motebitId, null);
    }
  }

  createConversation(motebitId: string): string {
    const conversationId = crypto.randomUUID();
    const now = Date.now();
    void dbExecute(
      this.invoke,
      `INSERT INTO conversations (conversation_id, motebit_id, started_at, last_active_at, title, summary, message_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [conversationId, motebitId, now, now, null, null],
    );
    return conversationId;
  }

  appendMessage(conversationId: string, motebitId: string, msg: {
    role: string;
    content: string;
    toolCalls?: string;
    toolCallId?: string;
  }): void {
    const messageId = crypto.randomUUID();
    const now = Date.now();
    const tokenEstimate = Math.ceil(msg.content.length / 4);
    void dbExecute(
      this.invoke,
      `INSERT INTO conversation_messages (message_id, conversation_id, motebit_id, role, content, tool_calls, tool_call_id, created_at, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [messageId, conversationId, motebitId, msg.role, msg.content, msg.toolCalls ?? null, msg.toolCallId ?? null, now, tokenEstimate],
    );
    void dbExecute(
      this.invoke,
      "UPDATE conversations SET last_active_at = ?, message_count = message_count + 1 WHERE conversation_id = ?",
      [now, conversationId],
    );
  }

  loadMessages(conversationId: string, _limit?: number): Array<{
    messageId: string;
    conversationId: string;
    motebitId: string;
    role: string;
    content: string;
    toolCalls: string | null;
    toolCallId: string | null;
    createdAt: number;
    tokenEstimate: number;
  }> {
    // Return from preloaded cache (sync interface requirement)
    return this._messagesCache.get(conversationId) ?? [];
  }

  getActiveConversation(motebitId: string): {
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    summary: string | null;
  } | null {
    return this._activeCache.get(motebitId) ?? null;
  }

  updateSummary(conversationId: string, summary: string): void {
    void dbExecute(
      this.invoke,
      "UPDATE conversations SET summary = ? WHERE conversation_id = ?",
      [summary, conversationId],
    );
  }

  listConversations(_motebitId: string, _limit = 20): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> {
    // Sync interface returns from cache (populated by preload / listConversationsAsync)
    return this._conversationsListCache;
  }

  /** Async list of conversations — populates the sync cache and returns results. */
  async listConversationsAsync(motebitId: string, limit = 20): Promise<Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    summary: string | null;
    messageCount: number;
  }>> {
    const rows = await dbQuery<ConversationRow>(
      this.invoke,
      "SELECT * FROM conversations WHERE motebit_id = ? ORDER BY last_active_at DESC LIMIT ?",
      [motebitId, limit],
    );
    const results = rows.map(r => ({
      conversationId: r.conversation_id,
      startedAt: r.started_at,
      lastActiveAt: r.last_active_at,
      title: r.title,
      summary: r.summary,
      messageCount: r.message_count,
    }));
    // Update sync cache
    this._conversationsListCache = results;
    return results;
  }

  /** Async load messages for a specific conversation (for switching). */
  async loadMessagesAsync(conversationId: string): Promise<Array<{
    messageId: string;
    conversationId: string;
    motebitId: string;
    role: string;
    content: string;
    toolCalls: string | null;
    toolCallId: string | null;
    createdAt: number;
    tokenEstimate: number;
  }>> {
    const rows = await dbQuery<ConversationMessageRow>(
      this.invoke,
      "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC",
      [conversationId],
    );
    const messages = rows.map(r => ({
      messageId: r.message_id,
      conversationId: r.conversation_id,
      motebitId: r.motebit_id,
      role: r.role,
      content: r.content,
      toolCalls: r.tool_calls,
      toolCallId: r.tool_call_id,
      createdAt: r.created_at,
      tokenEstimate: r.token_estimate,
    }));
    // Update message cache for sync loadMessages()
    this._messagesCache.set(conversationId, messages);
    return messages;
  }

  /** Update the title of a conversation. */
  updateTitle(conversationId: string, title: string): void {
    void dbExecute(
      this.invoke,
      "UPDATE conversations SET title = ? WHERE conversation_id = ?",
      [title, conversationId],
    );
  }

  /** Get total message count for the active conversation (from DB, async). */
  async getMessageCount(conversationId: string): Promise<number> {
    const rows = await dbQuery<{ message_count: number }>(
      this.invoke,
      "SELECT message_count FROM conversations WHERE conversation_id = ?",
      [conversationId],
    );
    return rows[0]?.message_count ?? 0;
  }

  /** Async methods for conversation sync (getConversationsSince, getMessagesSince, upsertConversation, upsertMessage). */
  async getConversationsSince(motebitId: string, since: number): Promise<Array<{
    conversation_id: string;
    motebit_id: string;
    started_at: number;
    last_active_at: number;
    title: string | null;
    summary: string | null;
    message_count: number;
  }>> {
    const rows = await dbQuery<ConversationRow>(
      this.invoke,
      "SELECT * FROM conversations WHERE motebit_id = ? AND last_active_at > ? ORDER BY last_active_at ASC",
      [motebitId, since],
    );
    return rows.map(r => ({
      conversation_id: r.conversation_id,
      motebit_id: r.motebit_id,
      started_at: r.started_at,
      last_active_at: r.last_active_at,
      title: r.title,
      summary: r.summary,
      message_count: r.message_count,
    }));
  }

  async getMessagesSince(conversationId: string, since: number): Promise<Array<{
    message_id: string;
    conversation_id: string;
    motebit_id: string;
    role: string;
    content: string;
    tool_calls: string | null;
    tool_call_id: string | null;
    created_at: number;
    token_estimate: number;
  }>> {
    const rows = await dbQuery<ConversationMessageRow>(
      this.invoke,
      "SELECT * FROM conversation_messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at ASC",
      [conversationId, since],
    );
    return rows.map(r => ({
      message_id: r.message_id,
      conversation_id: r.conversation_id,
      motebit_id: r.motebit_id,
      role: r.role,
      content: r.content,
      tool_calls: r.tool_calls,
      tool_call_id: r.tool_call_id,
      created_at: r.created_at,
      token_estimate: r.token_estimate,
    }));
  }

  async upsertConversation(conv: {
    conversation_id: string;
    motebit_id: string;
    started_at: number;
    last_active_at: number;
    title: string | null;
    summary: string | null;
    message_count: number;
  }): Promise<void> {
    await dbExecute(
      this.invoke,
      `INSERT OR REPLACE INTO conversations (conversation_id, motebit_id, started_at, last_active_at, title, summary, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [conv.conversation_id, conv.motebit_id, conv.started_at, conv.last_active_at, conv.title, conv.summary, conv.message_count],
    );
  }

  async upsertMessage(msg: {
    message_id: string;
    conversation_id: string;
    motebit_id: string;
    role: string;
    content: string;
    tool_calls: string | null;
    tool_call_id: string | null;
    created_at: number;
    token_estimate: number;
  }): Promise<void> {
    await dbExecute(
      this.invoke,
      `INSERT OR IGNORE INTO conversation_messages (message_id, conversation_id, motebit_id, role, content, tool_calls, tool_call_id, created_at, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [msg.message_id, msg.conversation_id, msg.motebit_id, msg.role, msg.content, msg.tool_calls, msg.tool_call_id, msg.created_at, msg.token_estimate],
    );
  }

  // Internal cache for sync listConversations() calls
  private _conversationsListCache: Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> = [];
}
