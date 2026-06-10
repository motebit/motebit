/**
 * Deletion propagation — a synced DeleteRequested erases the deleted
 * memory node's stored memory_formed content at the relay. "Forgotten"
 * must mean forgotten at the relay too: until this module, the relay's
 * copy of the formation content outlived the subject's signed deletion
 * certificate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import type { EventLogEntry } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

const MOTEBIT_A = "deletion-mote-a";
const MOTEBIT_B = "deletion-mote-b";

let clock = 1;
function makeEvent(
  motebitId: string,
  eventType: EventType,
  payload: Record<string, unknown>,
): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: motebitId,
    timestamp: Date.now(),
    event_type: eventType,
    payload,
    version_clock: clock++,
    tombstoned: false,
  } as EventLogEntry;
}

async function push(relay: SyncRelay, motebitId: string, events: EventLogEntry[]) {
  return relay.app.request(`/sync/${motebitId}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ events }),
  });
}

function storedPayload(relay: SyncRelay, eventId: string): Record<string, unknown> {
  const row = relay.moteDb.db
    .prepare("SELECT payload FROM events WHERE event_id = ?")
    .get(eventId) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

describe("deletion propagation (sync push path)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("a synced DeleteRequested erases the node's stored memory_formed content", async () => {
    const formed = makeEvent(MOTEBIT_A, EventType.MemoryFormed, {
      node_id: "node-del-1",
      content: "user's home address is 123 Main St",
      sensitivity: "personal",
    });
    await push(relay, MOTEBIT_A, [formed]);
    expect(storedPayload(relay, formed.event_id).content).toContain("123 Main St");

    const deleteReq = makeEvent(MOTEBIT_A, EventType.DeleteRequested, {
      target_type: "memory",
      target_id: "node-del-1",
      reason: "user_request",
    });
    const res = await push(relay, MOTEBIT_A, [deleteReq]);
    expect(res.status).toBe(200);

    const after = storedPayload(relay, formed.event_id);
    expect(after.content).toBe("[REDACTED]");
    expect(after.redacted).toBe(true);
    expect(after.redacted_reason).toBe("deleted");
    // The DeleteRequested event itself survives as the audit record.
    expect(storedPayload(relay, deleteReq.event_id).target_id).toBe("node-del-1");
    // A subsequent pull carries no content for the node.
    const pull = await relay.app.request(`/sync/${MOTEBIT_A}/pull`, {
      headers: { ...AUTH_HEADER },
    });
    const body = (await pull.json()) as { events: EventLogEntry[] };
    const pulled = body.events.find((e) => e.event_id === formed.event_id)!;
    expect(pulled.payload.content).toBe("[REDACTED]");
  });

  it("is idempotent — a duplicate DeleteRequested changes nothing further", async () => {
    const formed = makeEvent(MOTEBIT_A, EventType.MemoryFormed, {
      node_id: "node-del-2",
      content: "secret-ish detail",
      sensitivity: "none",
    });
    await push(relay, MOTEBIT_A, [formed]);
    const del = () =>
      push(relay, MOTEBIT_A, [
        makeEvent(MOTEBIT_A, EventType.DeleteRequested, {
          target_type: "memory",
          target_id: "node-del-2",
        }),
      ]);
    await del();
    const first = storedPayload(relay, formed.event_id);
    await del();
    expect(storedPayload(relay, formed.event_id)).toEqual(first);
  });

  it("is tenant-scoped — identical node_ids across motebits never cross-erase", async () => {
    const sharedNodeId = "node-shared-id";
    const formedA = makeEvent(MOTEBIT_A, EventType.MemoryFormed, {
      node_id: sharedNodeId,
      content: "A's fact",
      sensitivity: "none",
    });
    const formedB = makeEvent(MOTEBIT_B, EventType.MemoryFormed, {
      node_id: sharedNodeId,
      content: "B's fact",
      sensitivity: "none",
    });
    await push(relay, MOTEBIT_A, [formedA]);
    await push(relay, MOTEBIT_B, [formedB]);

    await push(relay, MOTEBIT_A, [
      makeEvent(MOTEBIT_A, EventType.DeleteRequested, {
        target_type: "memory",
        target_id: sharedNodeId,
      }),
    ]);

    expect(storedPayload(relay, formedA.event_id).content).toBe("[REDACTED]");
    expect(storedPayload(relay, formedB.event_id).content).toBe("B's fact");
  });

  it("no-ops on encrypted payloads — the client key lifecycle is the erasure mechanism", async () => {
    const encrypted = makeEvent(MOTEBIT_A, EventType.MemoryFormed, {
      _encrypted: true,
      _data: "ciphertext-blob",
    });
    await push(relay, MOTEBIT_A, [encrypted]);
    await push(relay, MOTEBIT_A, [
      makeEvent(MOTEBIT_A, EventType.DeleteRequested, {
        target_type: "memory",
        target_id: "node-inside-ciphertext",
      }),
    ]);
    expect(storedPayload(relay, encrypted.event_id)).toEqual(encrypted.payload);
  });

  it("ignores DeleteRequested for non-memory targets", async () => {
    const formed = makeEvent(MOTEBIT_A, EventType.MemoryFormed, {
      node_id: "node-keep",
      content: "still here",
      sensitivity: "none",
    });
    await push(relay, MOTEBIT_A, [formed]);
    await push(relay, MOTEBIT_A, [
      makeEvent(MOTEBIT_A, EventType.DeleteRequested, {
        target_type: "conversation",
        target_id: "node-keep",
      }),
    ]);
    expect(storedPayload(relay, formed.event_id).content).toBe("still here");
  });

  it("the admin DELETE route converges on the same erasure", async () => {
    const formed = makeEvent(MOTEBIT_A, EventType.MemoryFormed, {
      node_id: "node-admin-del",
      content: "admin-deleted detail",
      sensitivity: "none",
    });
    await push(relay, MOTEBIT_A, [formed]);
    // Seed a relay-side node projection so the tombstone half succeeds.
    await relay.moteDb.memoryStorage.saveNode({
      node_id: "node-admin-del",
      motebit_id: MOTEBIT_A,
      content: "admin-deleted detail",
      embedding: [0],
      confidence: 0.5,
      sensitivity: "none" as never,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 1000,
      tombstoned: false,
      pinned: false,
    });

    const res = await relay.app.request(`/api/v1/memory/${MOTEBIT_A}/node-admin-del`, {
      method: "DELETE",
      headers: { ...AUTH_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; redacted_events: number };
    expect(body.deleted).toBe(true);
    expect(body.redacted_events).toBe(1);
    expect(storedPayload(relay, formed.event_id).content).toBe("[REDACTED]");
  });
});
