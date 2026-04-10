/**
 * Memory commands — thin functional wrappers around the runtime's memory
 * APIs, extracted from the DesktopApp god class.
 *
 * Every function here is a one- or two-liner that delegates to a runtime
 * method, with consistent error handling (return empty / null on failure)
 * matching the desktop's "never throw to UI" convention. The DesktopApp
 * keeps its public methods (listMemories, deleteMemory, etc.) as one-line
 * delegates so the public API is unchanged.
 *
 * Why pure functions instead of a class: there's no instance state.
 * Each function takes a runtime reference and the call's parameters.
 * No constructor, no `this`, no lifecycle. The DesktopApp owns the
 * runtime; this module owns the operations on it.
 */

import type { MemoryNode, MemoryEdge, SensitivityLevel } from "@motebit/sdk";
import { SensitivityLevel as SensitivityLevelEnum } from "@motebit/sdk";
import { computeDecayedConfidence, embedText } from "@motebit/memory-graph";
import type { MotebitRuntime } from "@motebit/runtime";
import type { DeletionCertificate } from "@motebit/encryption";

/**
 * List all non-tombstoned memories for the local agent, sorted newest first.
 * Filters out memories whose `valid_until` has passed. Returns `[]` if the
 * runtime isn't yet ready or the underlying export call throws.
 */
export async function listMemories(runtime: MotebitRuntime | null): Promise<MemoryNode[]> {
  if (!runtime) return [];
  try {
    const { nodes } = await runtime.memory.exportAll();
    const now = Date.now();
    return nodes
      .filter((n) => !n.tombstoned && (n.valid_until == null || n.valid_until > now))
      .sort((a, b) => b.created_at - a.created_at);
  } catch {
    return [];
  }
}

/** List all edges in the local memory graph. Returns `[]` on any failure. */
export async function listMemoryEdges(runtime: MotebitRuntime | null): Promise<MemoryEdge[]> {
  if (!runtime) return [];
  try {
    const { edges } = await runtime.memory.exportAll();
    return edges;
  } catch {
    return [];
  }
}

/**
 * Form a memory directly, bypassing the agentic loop. Used only for the
 * first-run greeting fallback path. Embeds the content locally (no
 * network call) before passing to the memory graph.
 */
export async function formMemoryDirect(
  runtime: MotebitRuntime | null,
  content: string,
  confidence: number,
): Promise<MemoryNode | null> {
  if (!runtime) return null;
  const embedding = await embedText(content);
  return runtime.memory.formMemory(
    { content, confidence, sensitivity: SensitivityLevelEnum.None as SensitivityLevel },
    embedding,
  );
}

/**
 * Soft-delete a memory with audit trail. Tries the privacy layer first
 * (which signs a deletion certificate); falls back to direct memory
 * deletion if the privacy layer is unavailable or throws. Returns the
 * deletion certificate when one was issued, `null` otherwise.
 */
export async function deleteMemory(
  runtime: MotebitRuntime | null,
  motebitId: string,
  nodeId: string,
): Promise<DeletionCertificate | null> {
  if (!runtime) return null;
  try {
    return await runtime.privacy.deleteMemory(nodeId, motebitId);
  } catch {
    // Fall back to direct deletion if privacy layer fails
    await runtime.memory.deleteMemory(nodeId);
    return null;
  }
}

/**
 * List deletion certificates from the audit log. Each entry is a
 * minimal projection (audit_id, timestamp, target_id, tombstone_hash,
 * deleted_by) suitable for the UI's audit-trail panel. Returns `[]` on
 * any failure.
 */
export async function listDeletionCertificates(
  runtime: MotebitRuntime | null,
  motebitId: string,
): Promise<
  Array<{
    auditId: string;
    timestamp: number;
    targetId: string;
    tombstoneHash: string;
    deletedBy: string;
  }>
> {
  if (!runtime) return [];
  try {
    const records = await runtime.auditLog.query(motebitId);
    return records
      .filter((r) => r.action === "delete_memory")
      .map((r) => ({
        auditId: r.audit_id,
        timestamp: r.timestamp,
        targetId: r.target_id,
        tombstoneHash: (r.details as Record<string, string>).tombstone_hash ?? "",
        deletedBy: (r.details as Record<string, string>).deleted_by ?? "",
      }));
  } catch {
    return [];
  }
}

/** Pin or unpin a memory. No-op if the runtime isn't ready. */
export async function pinMemory(
  runtime: MotebitRuntime | null,
  nodeId: string,
  pinned: boolean,
): Promise<void> {
  if (!runtime) return;
  await runtime.memory.pinMemory(nodeId, pinned);
}

/**
 * Compute effective confidence after half-life decay. Pure function —
 * no runtime needed. Re-exported here so callers don't have to import
 * `computeDecayedConfidence` from `@motebit/memory-graph` directly.
 */
export function getDecayedConfidence(node: MemoryNode): number {
  return computeDecayedConfidence(node.confidence, node.half_life, Date.now() - node.created_at);
}
