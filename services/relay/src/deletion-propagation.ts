/**
 * Deletion propagation — a synced `DeleteRequested` erases the deleted
 * record's content from the relay's stores.
 *
 * The subject-side deletion flow (privacy-layer `DeleteManager`:
 * DeleteRequested event → signed mutable_pruning cert → physical erase)
 * syncs its DeleteRequested event to the relay like any other event —
 * but until this module, the relay's stored copy of the node's
 * `memory_formed` content outlived the subject's deletion certificate.
 * "Forgotten" must mean forgotten at the relay too.
 *
 * Invoked after each successful event append on both sync push surfaces
 * (HTTP `sync-routes.ts`, WebSocket `websocket.ts`); the admin
 * `DELETE /api/v1/memory/:motebitId/:nodeId` route converges on the
 * same core. Tenant isolation rides the AUTHORITATIVE path-bound
 * `motebitId` (the device-auth middleware binds the sync push path to
 * it) — never the event's self-declared `motebit_id`, which a device
 * authenticated for one tenant can set to any value. `redactMemoryContent`
 * and the node tombstone both scope by that authoritative id, so
 * identical node_ids across tenants cannot cross-erase.
 *
 * Encrypted `memory_formed` payloads are opaque (node_id inside the
 * ciphertext): propagation no-ops on them by design — the client-side
 * key lifecycle is the erasure mechanism for ciphertext, as the
 * transparency declaration states.
 */

import type { EventLogEntry } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";
import type { MotebitDatabase } from "@motebit/persistence";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "deletion-propagation" });

export interface DeletionPropagationDeps {
  eventStore: EventStore;
  moteDb: MotebitDatabase;
}

/**
 * Erase the relay-side content for a deleted memory node: rewrite the
 * stored `memory_formed` payload(s) to the redaction sentinel and
 * best-effort tombstone the relay's node projection. Idempotent —
 * a duplicate DeleteRequested changes zero rows.
 */
export async function propagateMemoryDeletion(
  deps: DeletionPropagationDeps,
  motebitId: string,
  nodeId: string,
): Promise<{ redactedEvents: number }> {
  const result = await deps.eventStore.redactMemoryEvents(motebitId, nodeId);
  if (!result.supported) {
    logger.warn("deletion-propagation.adapter_unsupported", { motebitId });
    return { redactedEvents: 0 };
  }

  // Best-effort: tombstone the relay-side memory node projection when
  // one exists (state-export reads it). Failure here never blocks the
  // event-content erasure above. The tombstone MUST be tenant-scoped:
  // an adapter without the owned variant is skipped (fail-closed) rather
  // than falling back to the unscoped `tombstoneNode`, which would let a
  // mismatched node_id tombstone another tenant's projection.
  try {
    const storage = deps.moteDb.memoryStorage as {
      tombstoneNodeOwned?: (nodeId: string, motebitId: string) => Promise<boolean>;
    };
    if (storage.tombstoneNodeOwned) {
      await storage.tombstoneNodeOwned(nodeId, motebitId);
    } else {
      logger.warn("deletion-propagation.tombstone_skipped_unscoped", { motebitId });
    }
  } catch (err: unknown) {
    logger.warn("deletion-propagation.node_tombstone_failed", {
      motebitId,
      nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (result.changed > 0) {
    logger.info("deletion-propagation.redacted", {
      motebitId,
      nodeId,
      redactedEvents: result.changed,
    });
  }
  return { redactedEvents: result.changed };
}

/**
 * Inspect a just-appended synced event; when it is a memory-targeted
 * `DeleteRequested`, propagate the deletion. No-op for everything else.
 *
 * `pathMotebitId` is the AUTHORITATIVE tenant — the device-auth
 * middleware binds the sync push path to it. The destructive action is
 * scoped to it, NOT to the event's self-declared `motebit_id`: a device
 * authenticated for tenant A can put any `motebit_id` in an event body
 * (pre-existing write surface), so trusting `entry.motebit_id` here would
 * let A erase tenant B's content. A mismatched event is skipped (it
 * cannot legitimately target another tenant through A's path).
 */
export async function propagateDeletionForEvent(
  deps: DeletionPropagationDeps,
  entry: EventLogEntry,
  pathMotebitId: string,
): Promise<void> {
  if (entry.event_type !== EventType.DeleteRequested) return;
  if (entry.motebit_id !== pathMotebitId) return;
  const payload = entry.payload as { target_type?: string; target_id?: string } | undefined;
  if (!payload || payload.target_type !== "memory") return;
  if (typeof payload.target_id !== "string" || payload.target_id === "") return;
  await propagateMemoryDeletion(deps, pathMotebitId, payload.target_id);
}
