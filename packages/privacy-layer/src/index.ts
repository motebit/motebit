import type { MemoryNode, AuditRecord, ExportManifest, MotebitIdentity } from "@motebit/sdk";
import { EventType, SensitivityLevel } from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";
import type { MemoryGraph, MemoryStorageAdapter } from "@motebit/memory-graph";
import type { DeletionCertificate, MotebitId, DeletionReason } from "@motebit/protocol";
import { asNodeId } from "@motebit/protocol";
import { signCertAsSubject } from "@motebit/crypto";

/**
 * Signer for `mutable_pruning` deletion certificates. The motebit's
 * identity key signs each cert per docs/doctrine/retention-policy.md
 * §"Decision 5". Production code injects the key from the runtime's
 * key-keeper; tests pass a generated keypair directly.
 */
export interface DeletionCertSigner {
  readonly motebitId: MotebitId;
  /** Ed25519 private key (32 bytes). */
  readonly privateKey: Uint8Array;
}

// === Audit Log ===

export type { AuditLogAdapter } from "@motebit/sdk";
import type { AuditLogAdapter } from "@motebit/sdk";

export class InMemoryAuditLog implements AuditLogAdapter {
  private records: AuditRecord[] = [];

  record(entry: AuditRecord): Promise<void> {
    this.records.push({ ...entry });
    return Promise.resolve();
  }

  query(
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
    return Promise.resolve(results);
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
  async listMemories(
    options: {
      include_tombstoned?: boolean;
      sensitivity?: SensitivityLevel[];
      limit?: number;
    } = {},
  ): Promise<MemoryNode[]> {
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
  async setSensitivity(nodeId: string, level: SensitivityLevel): Promise<void> {
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
  getRetentionRules(level: SensitivityLevel): {
    max_retention_days: number;
    display_allowed: boolean;
  } {
    switch (level) {
      case SensitivityLevel.None:
        return { max_retention_days: Infinity, display_allowed: true };
      case SensitivityLevel.Personal:
        return { max_retention_days: 365, display_allowed: true };
      case SensitivityLevel.Medical:
        return { max_retention_days: 90, display_allowed: false };
      case SensitivityLevel.Financial:
        return { max_retention_days: 90, display_allowed: false };
      case SensitivityLevel.Secret:
        return { max_retention_days: 30, display_allowed: false };
      default:
        return { max_retention_days: 0, display_allowed: false };
    }
  }
}

// === Delete Manager ===

/**
 * Map a string `deletedBy` parameter to a `DeletionReason`. The legacy
 * API took a free-form string; phase 3 normalizes via this small set so
 * the cert's reason field is verifier-checkable per the reason × signer
 * × mode table (decision 5). Unknown values default to `user_request`.
 */
function normalizeDeletionReason(deletedBy: string): DeletionReason {
  switch (deletedBy) {
    case "user_request":
    case "retention_enforcement":
    case "retention_enforcement_post_classification":
    case "operator_request":
    case "delegated_request":
    case "self_enforcement":
    case "guardian_request":
      return deletedBy;
    default:
      return "user_request";
  }
}

export class DeleteManager {
  constructor(
    private memoryGraph: MemoryGraph,
    _eventStore: EventStore,
    private auditLog: AuditLogAdapter,
    private motebitId: string,
    private signer: DeletionCertSigner,
  ) {}

  /**
   * Erase a memory and emit a signed `mutable_pruning` deletion
   * certificate. Decision 7: the underlying storage operation is
   * physical erase, not tombstone. Decision 5: the cert is signed by
   * the subject motebit's identity key.
   */
  async deleteMemory(nodeId: string, deletedBy: string): Promise<DeletionCertificate> {
    const node = await this.memoryGraph.getNode(nodeId);
    const sensitivity = node?.sensitivity ?? SensitivityLevel.None;
    const reason = normalizeDeletionReason(deletedBy);
    const deletedAt = Date.now();

    const certBody: Extract<DeletionCertificate, { kind: "mutable_pruning" }> = {
      kind: "mutable_pruning",
      target_id: asNodeId(nodeId),
      sensitivity,
      reason,
      deleted_at: deletedAt,
    };
    const cert = await signCertAsSubject(
      certBody,
      this.signer.motebitId as string,
      this.signer.privateKey,
    );

    // Erase the memory — bytes unrecoverable per decision 7.
    await this.memoryGraph.deleteMemory(nodeId);

    // Audit trail. Events live in append_only_horizon space and survive
    // node erasure by design — they are the audit, not the deleted data.
    await this.auditLog.record({
      audit_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      timestamp: deletedAt,
      action: "delete_memory",
      target_type: "memory",
      target_id: nodeId,
      details: {
        deleted_by: deletedBy,
        reason,
        sensitivity,
        cert_kind: cert.kind,
        cert_signature: cert.subject_signature?.signature ?? null,
      },
    });

    return cert;
  }

  /**
   * Sign a `consolidation_flush` certificate for an expired record from
   * the conversation store or tool-audit store. The caller erases the
   * underlying row; the privacy layer signs and audits.
   */
  async flushRecord(args: {
    targetKind: "conversation_message" | "tool_audit";
    targetId: string;
    sensitivity: SensitivityLevel;
    reason:
      | "user_request"
      | "retention_enforcement"
      | "retention_enforcement_post_classification"
      | "self_enforcement";
  }): Promise<DeletionCertificate> {
    const flushedAt = Date.now();

    const certBody: Extract<DeletionCertificate, { kind: "consolidation_flush" }> = {
      kind: "consolidation_flush",
      target_id: args.targetId,
      sensitivity: args.sensitivity,
      reason: args.reason,
      flushed_to: "expire",
      flushed_at: flushedAt,
    };
    const cert = await signCertAsSubject(
      certBody,
      this.signer.motebitId as string,
      this.signer.privateKey,
    );

    await this.auditLog.record({
      audit_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      timestamp: flushedAt,
      action: "flush_record",
      target_type: args.targetKind,
      target_id: args.targetId,
      details: {
        reason: args.reason,
        sensitivity: args.sensitivity,
        cert_kind: cert.kind,
        cert_signature: cert.subject_signature?.signature ?? null,
      },
    });

    return cert;
  }
}

// Re-export the new wire types so downstream consumers (runtime, cli,
// tests) import the cert union from a single product-vocabulary path.
// The legacy unsigned `DeletionCertificate` in `@motebit/encryption`
// remains available for migration but is the deprecated shape; new
// consumers should import from here.
export type { DeletionCertificate, DeletionReason } from "@motebit/protocol";
export {
  MAX_RETENTION_DAYS_BY_SENSITIVITY,
  REFERENCE_RETENTION_DAYS_BY_SENSITIVITY,
} from "@motebit/protocol";
export { signCertAsSubject, verifyDeletionCertificate } from "@motebit/crypto";

// === Export Manager ===

export class ExportManager {
  constructor(
    private memoryGraph: MemoryGraph,
    private eventStore: EventStore,
    private auditLog: AuditLogAdapter,
    private motebitId: string,
  ) {}

  /** Sensitivity levels where display_allowed is true. */
  private static readonly DISPLAY_ALLOWED = new Set<string>([
    SensitivityLevel.None,
    SensitivityLevel.Personal,
  ]);

  /**
   * Export all user data as a JSON manifest.
   *
   * By default, memories with sensitive classifications (medical, financial, secret)
   * are filtered out. Pass `includeAllSensitivity: true` to bypass the filter
   * (e.g. for the agent owner who explicitly requests everything via --all).
   *
   * Returns the manifest plus a count of redacted memories.
   */
  async exportAll(
    identity: MotebitIdentity,
    options?: { includeAllSensitivity?: boolean },
  ): Promise<ExportManifest & { redacted_count: number }> {
    const includeAll = options?.includeAllSensitivity === true;

    // Audit the export request
    await this.auditLog.record({
      audit_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      timestamp: Date.now(),
      action: "export_all",
      target_type: "motebit",
      target_id: this.motebitId,
      details: { include_all_sensitivity: includeAll },
    });

    // Log the export event
    await this.eventStore.appendWithClock({
      event_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      timestamp: Date.now(),
      event_type: EventType.ExportRequested,
      payload: {},
      tombstoned: false,
    });

    const { nodes, edges } = await this.memoryGraph.exportAll();
    const events = await this.eventStore.query({ motebit_id: this.motebitId });
    const auditRecords = await this.auditLog.query(this.motebitId);

    // Filter sensitive memories unless explicitly bypassed
    const filteredNodes = includeAll
      ? nodes
      : nodes.filter((n) => ExportManager.DISPLAY_ALLOWED.has(n.sensitivity));
    const redactedCount = nodes.length - filteredNodes.length;

    return {
      motebit_id: this.motebitId,
      exported_at: Date.now(),
      identity,
      memories: filteredNodes,
      edges,
      events,
      audit_log: auditRecords,
      redacted_count: redactedCount,
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
    signer: DeletionCertSigner,
  ) {
    this.inspector = new MemoryInspector(storage, auditLog, motebitId);
    this.sensitivityManager = new SensitivityManager(storage, auditLog, motebitId);
    this.deleteManager = new DeleteManager(memoryGraph, eventStore, auditLog, motebitId, signer);
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
      throw new Error("Privacy layer: access denied (fail-closed)", { cause: error });
    }
  }

  async inspectMemory(nodeId: string): Promise<MemoryNode | null> {
    try {
      return await this.inspector.inspectMemory(nodeId);
    } catch (error) {
      throw new Error("Privacy layer: access denied (fail-closed)", { cause: error });
    }
  }

  async setSensitivity(nodeId: string, level: SensitivityLevel): Promise<void> {
    try {
      return await this.sensitivityManager.setSensitivity(nodeId, level);
    } catch (error) {
      throw new Error("Privacy layer: access denied (fail-closed)", { cause: error });
    }
  }

  async deleteMemory(nodeId: string, deletedBy: string): Promise<DeletionCertificate> {
    try {
      return await this.deleteManager.deleteMemory(nodeId, deletedBy);
    } catch (error) {
      throw new Error("Privacy layer: access denied (fail-closed)", { cause: error });
    }
  }

  /**
   * Sign a `consolidation_flush` deletion certificate for one expired
   * record (conversation message or tool-audit entry). The caller is
   * responsible for the underlying erase — the privacy layer signs the
   * cert and writes the audit trail.
   *
   * Phase 5-ship per docs/doctrine/retention-policy.md §"Consolidation
   * flush". Decision 5: subject signature; the consolidation cycle
   * runs on the user's device, signing with the motebit's identity
   * key, so `self_enforcement` is the structural reason (not
   * `retention_enforcement` which requires operator signature).
   * `retention_enforcement_post_classification` distinguishes the
   * lazy-classify-on-flush cohort per decision 6b.
   */
  async signFlushCert(args: {
    targetKind: "conversation_message" | "tool_audit";
    targetId: string;
    sensitivity: SensitivityLevel;
    reason:
      | "user_request"
      | "retention_enforcement"
      | "retention_enforcement_post_classification"
      | "self_enforcement";
  }): Promise<DeletionCertificate> {
    try {
      return await this.deleteManager.flushRecord(args);
    } catch (error) {
      throw new Error("Privacy layer: access denied (fail-closed)", { cause: error });
    }
  }

  async exportAll(
    identity: MotebitIdentity,
    options?: { includeAllSensitivity?: boolean },
  ): Promise<ExportManifest & { redacted_count: number }> {
    try {
      return await this.exportManager.exportAll(identity, options);
    } catch (error) {
      throw new Error("Privacy layer: access denied (fail-closed)", { cause: error });
    }
  }

  getRetentionRules(level: SensitivityLevel) {
    return this.sensitivityManager.getRetentionRules(level);
  }
}
