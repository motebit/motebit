import type {
  MemoryNode,
  AuditRecord,
  ExportManifest,
  MotebitIdentity,
  SensitivityLevel,
} from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";
import type { MemoryGraph, MemoryStorageAdapter } from "@motebit/memory-graph";
import type { DeletionCertificate } from "@motebit/crypto";
import { createDeletionCertificate } from "@motebit/crypto";

// === Audit Log ===

export interface AuditLogAdapter {
  record(entry: AuditRecord): Promise<void>;
  query(motebitId: string, options?: { limit?: number; after?: number }): Promise<AuditRecord[]>;
}

export class InMemoryAuditLog implements AuditLogAdapter {
  private records: AuditRecord[] = [];

  async record(entry: AuditRecord): Promise<void> {
    this.records.push({ ...entry });
  }

  async query(
    motebitId: string,
    options: { limit?: number; after?: number } = {},
  ): Promise<AuditRecord[]> {
    let results = this.records.filter((r) => r.motebit_id === motebitId);
    if (options.after !== undefined) {
      results = results.filter((r) => r.timestamp > options.after!);
    }
    if (options.limit !== undefined) {
      results = results.slice(-options.limit);
    }
    return results;
  }
}

// === Memory Inspector ===

export class MemoryInspector {
  constructor(
    private storage: MemoryStorageAdapter,
    private auditLog: AuditLogAdapter,
    private motebitId: string,
  ) {}

  /**
   * Browse all memory nodes (UI-facing API).
   */
  async listMemories(options: {
    include_tombstoned?: boolean;
    sensitivity?: SensitivityLevel[];
    limit?: number;
  } = {}): Promise<MemoryNode[]> {
    await this.audit("list_memories", "memory", "*", { options });

    return this.storage.queryNodes({
      motebit_id: this.motebitId,
      include_tombstoned: options.include_tombstoned,
      sensitivity_filter: options.sensitivity,
      limit: options.limit,
    });
  }

  /**
   * Get a single memory with audit trail.
   */
  async inspectMemory(nodeId: string): Promise<MemoryNode | null> {
    await this.audit("inspect_memory", "memory", nodeId, {});
    return this.storage.getNode(nodeId);
  }

  private async audit(
    action: string,
    targetType: string,
    targetId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.auditLog.record({
      audit_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      timestamp: Date.now(),
      action,
      target_type: targetType,
      target_id: targetId,
      details,
    });
  }
}

// === Sensitivity Manager ===

export class SensitivityManager {
  constructor(
    private storage: MemoryStorageAdapter,
    private auditLog: AuditLogAdapter,
    private motebitId: string,
  ) {}

  /**
   * Set the sensitivity level for a memory node.
   */
  async setSensitivity(
    nodeId: string,
    level: SensitivityLevel,
  ): Promise<void> {
    const node = await this.storage.getNode(nodeId);
    if (node === null) {
      throw new Error(`Memory node not found: ${nodeId}`);
    }

    const oldLevel = node.sensitivity;
    node.sensitivity = level;
    await this.storage.saveNode(node);

    await this.auditLog.record({
      audit_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      timestamp: Date.now(),
      action: "set_sensitivity",
      target_type: "memory",
      target_id: nodeId,
      details: { old_level: oldLevel, new_level: level },
    });
  }

  /**
   * Get retention rules for a sensitivity level.
   */
  getRetentionRules(level: SensitivityLevel): { max_retention_days: number; display_allowed: boolean } {
    switch (level) {
      case "none":
        return { max_retention_days: Infinity, display_allowed: true };
      case "personal":
        return { max_retention_days: 365, display_allowed: true };
      case "medical":
        return { max_retention_days: 90, display_allowed: false };
      case "financial":
        return { max_retention_days: 90, display_allowed: false };
      case "secret":
        return { max_retention_days: 30, display_allowed: false };
      default:
        return { max_retention_days: 0, display_allowed: false };
    }
  }
}

// === Delete Manager ===

export class DeleteManager {
  constructor(
    private memoryGraph: MemoryGraph,
    _eventStore: EventStore,
    private auditLog: AuditLogAdapter,
    private motebitId: string,
  ) {}

  /**
   * Delete a memory with full audit trail and deletion certificate.
   */
  async deleteMemory(
    nodeId: string,
    deletedBy: string,
  ): Promise<DeletionCertificate> {
    // Create deletion certificate
    const cert = await createDeletionCertificate(nodeId, "memory", deletedBy);

    // Tombstone the memory
    await this.memoryGraph.deleteMemory(nodeId);

    // Audit
    await this.auditLog.record({
      audit_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      timestamp: Date.now(),
      action: "delete_memory",
      target_type: "memory",
      target_id: nodeId,
      details: {
        deleted_by: deletedBy,
        tombstone_hash: cert.tombstone_hash,
      },
    });

    return cert;
  }
}

// === Export Manager ===

export class ExportManager {
  constructor(
    private memoryGraph: MemoryGraph,
    private eventStore: EventStore,
    private auditLog: AuditLogAdapter,
    private motebitId: string,
  ) {}

  /**
   * Export all user data as a JSON manifest.
   */
  async exportAll(identity: MotebitIdentity): Promise<ExportManifest> {
    // Audit the export request
    await this.auditLog.record({
      audit_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      timestamp: Date.now(),
      action: "export_all",
      target_type: "motebit",
      target_id: this.motebitId,
      details: {},
    });

    // Log the export event
    const clock = await this.eventStore.getLatestClock(this.motebitId);
    await this.eventStore.append({
      event_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      timestamp: Date.now(),
      event_type: EventType.ExportRequested,
      payload: {},
      version_clock: clock + 1,
      tombstoned: false,
    });

    const { nodes, edges } = await this.memoryGraph.exportAll();
    const events = await this.eventStore.query({ motebit_id: this.motebitId });
    const auditRecords = await this.auditLog.query(this.motebitId);

    return {
      motebit_id: this.motebitId,
      exported_at: Date.now(),
      identity,
      memories: nodes,
      edges,
      events,
      audit_log: auditRecords,
    };
  }
}

// === Privacy Layer (fail-closed facade) ===

export class PrivacyLayer {
  private inspector: MemoryInspector;
  private sensitivityManager: SensitivityManager;
  private deleteManager: DeleteManager;
  private exportManager: ExportManager;

  constructor(
    storage: MemoryStorageAdapter,
    memoryGraph: MemoryGraph,
    eventStore: EventStore,
    auditLog: AuditLogAdapter,
    motebitId: string,
  ) {
    this.inspector = new MemoryInspector(storage, auditLog, motebitId);
    this.sensitivityManager = new SensitivityManager(storage, auditLog, motebitId);
    this.deleteManager = new DeleteManager(memoryGraph, eventStore, auditLog, motebitId);
    this.exportManager = new ExportManager(memoryGraph, eventStore, auditLog, motebitId);
  }

  /**
   * All operations are fail-closed: if an error occurs, deny rather than silently allow.
   */
  async listMemories(
    options: Parameters<MemoryInspector["listMemories"]>[0] = {},
  ): Promise<MemoryNode[]> {
    try {
      return await this.inspector.listMemories(options);
    } catch (error) {
      throw new Error(`Privacy layer: access denied (fail-closed). Cause: ${String(error)}`);
    }
  }

  async inspectMemory(nodeId: string): Promise<MemoryNode | null> {
    try {
      return await this.inspector.inspectMemory(nodeId);
    } catch (error) {
      throw new Error(`Privacy layer: access denied (fail-closed). Cause: ${String(error)}`);
    }
  }

  async setSensitivity(nodeId: string, level: SensitivityLevel): Promise<void> {
    try {
      return await this.sensitivityManager.setSensitivity(nodeId, level);
    } catch (error) {
      throw new Error(`Privacy layer: access denied (fail-closed). Cause: ${String(error)}`);
    }
  }

  async deleteMemory(nodeId: string, deletedBy: string): Promise<DeletionCertificate> {
    try {
      return await this.deleteManager.deleteMemory(nodeId, deletedBy);
    } catch (error) {
      throw new Error(`Privacy layer: access denied (fail-closed). Cause: ${String(error)}`);
    }
  }

  async exportAll(identity: MotebitIdentity): Promise<ExportManifest> {
    try {
      return await this.exportManager.exportAll(identity);
    } catch (error) {
      throw new Error(`Privacy layer: access denied (fail-closed). Cause: ${String(error)}`);
    }
  }

  getRetentionRules(level: SensitivityLevel) {
    return this.sensitivityManager.getRetentionRules(level);
  }
}
