/**
 * Ingress redaction — memory content above the sync-safe sensitivity
 * ceiling must never reach the relay's event store or other devices.
 *
 * Before redaction.ts, the push paths appended events RAW and redacted
 * only on read (pull responses + fan-out on the HTTP path; the WS path's
 * fan-out was raw). These tests pin the ingress contract: the STORED row
 * is redacted, fan-out frames are redacted, benign and encrypted payloads
 * pass byte-identical, and receipt idempotency is unaffected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import type { EventLogEntry } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import { redactSensitiveEvents, redactMemoryFormedPayload } from "../redaction.js";

const MOTEBIT_ID = "redaction-test-mote";

let clock = 1;
function makeMemoryFormedEvent(
  payload: Record<string, unknown>,
  overrides: Partial<EventLogEntry> = {},
): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: MOTEBIT_ID,
    timestamp: Date.now(),
    event_type: EventType.MemoryFormed,
    payload,
    version_clock: clock++,
    tombstoned: false,
    ...overrides,
  } as EventLogEntry;
}

async function pushEvents(relay: SyncRelay, events: EventLogEntry[], deviceId = "device-a") {
  return relay.app.request(`/sync/${MOTEBIT_ID}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-id": deviceId, ...AUTH_HEADER },
    body: JSON.stringify({ events }),
  });
}

function storedPayload(relay: SyncRelay, eventId: string): Record<string, unknown> {
  const row = relay.moteDb.db
    .prepare("SELECT payload FROM events WHERE event_id = ?")
    .get(eventId) as { payload: string } | undefined;
  expect(row, `event ${eventId} should be stored`).toBeDefined();
  return JSON.parse(row!.payload) as Record<string, unknown>;
}

describe("sync ingress redaction (HTTP push)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("stores medical memory_formed content as [REDACTED], preserving metadata", async () => {
    const event = makeMemoryFormedEvent({
      node_id: "node-med-1",
      content: "patient has condition X",
      sensitivity: "medical",
      valid_from: 1000,
    });
    const res = await pushEvents(relay, [event]);
    expect(res.status).toBe(200);

    const stored = storedPayload(relay, event.event_id);
    expect(stored.content).toBe("[REDACTED]");
    expect(stored.redacted).toBe(true);
    expect(stored.redacted_sensitivity).toBe("medical");
    expect(stored.node_id).toBe("node-med-1");
    expect(stored.valid_from).toBe(1000);
  });

  it.each(["financial", "secret"])("redacts %s content at ingress", async (sensitivity) => {
    const event = makeMemoryFormedEvent({
      node_id: `node-${sensitivity}`,
      content: "sensitive detail",
      sensitivity,
    });
    await pushEvents(relay, [event]);
    const stored = storedPayload(relay, event.event_id);
    expect(stored.content).toBe("[REDACTED]");
    expect(stored.redacted_sensitivity).toBe(sensitivity);
  });

  it.each(["none", "personal"])("stores %s content byte-identical", async (sensitivity) => {
    const event = makeMemoryFormedEvent({
      node_id: `node-safe-${sensitivity}`,
      content: "benign fact",
      sensitivity,
    });
    await pushEvents(relay, [event]);
    const stored = storedPayload(relay, event.event_id);
    expect(stored).toEqual(event.payload);
  });

  it("passes E2E-encrypted payloads through untouched", async () => {
    const event = makeMemoryFormedEvent({
      _encrypted: true,
      _data: "base64-ciphertext",
      v: 1,
    });
    await pushEvents(relay, [event]);
    const stored = storedPayload(relay, event.event_id);
    expect(stored).toEqual(event.payload);
  });

  it("leaves non-memory events untouched", async () => {
    const event = makeMemoryFormedEvent(
      { detail: "anything", sensitivity: "secret" },
      { event_type: EventType.StateUpdated },
    );
    await pushEvents(relay, [event]);
    const stored = storedPayload(relay, event.event_id);
    expect(stored).toEqual(event.payload);
  });

  it("fan-out frames to connected peers are redacted", async () => {
    const peerWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(MOTEBIT_ID, [{ ws: peerWs as never, deviceId: "device-b" }]);

    const event = makeMemoryFormedEvent({
      node_id: "node-fanout",
      content: "secret detail",
      sensitivity: "secret",
    });
    await pushEvents(relay, [event], "device-a");

    expect(peerWs.send).toHaveBeenCalledTimes(1);
    const frame = JSON.parse(peerWs.send.mock.calls[0]![0] as string) as {
      type: string;
      event: EventLogEntry;
    };
    expect(frame.event.payload.content).toBe("[REDACTED]");
    expect(frame.event.payload.redacted).toBe(true);
  });

  it("receipt idempotency survives redaction (duplicate receipt still detected)", async () => {
    const receipt = { receipt_id: "r-1", signature: "sig-abc" };
    const first = makeMemoryFormedEvent({
      node_id: "node-r1",
      content: "paid thing",
      sensitivity: "financial",
      receipt,
    });
    const res1 = await pushEvents(relay, [first]);
    expect(((await res1.json()) as { accepted: number }).accepted).toBe(1);

    const second = makeMemoryFormedEvent({
      node_id: "node-r2",
      content: "paid thing again",
      sensitivity: "financial",
      receipt,
    });
    const res2 = await pushEvents(relay, [second]);
    const body2 = (await res2.json()) as { accepted: number; duplicate?: boolean };
    expect(body2.accepted).toBe(0);
  });
});

describe("redactMemoryFormedPayload unit", () => {
  it("is idempotent — already-redacted payloads return null", () => {
    const redacted = redactMemoryFormedPayload({
      content: "x",
      sensitivity: "medical",
    });
    expect(redacted).not.toBeNull();
    expect(redactMemoryFormedPayload(redacted!)).toBeNull();
  });

  it("returns null for safe, encrypted, and missing sensitivity", () => {
    expect(redactMemoryFormedPayload({ content: "x", sensitivity: "none" })).toBeNull();
    expect(redactMemoryFormedPayload({ content: "x", sensitivity: "personal" })).toBeNull();
    expect(redactMemoryFormedPayload({ content: "x" })).toBeNull();
    expect(redactMemoryFormedPayload({ _encrypted: true, _data: "ct" })).toBeNull();
  });

  it("redactSensitiveEvents only touches memory_formed entries", () => {
    const memory = makeMemoryFormedEvent({ content: "x", sensitivity: "secret" });
    const other = makeMemoryFormedEvent(
      { content: "y", sensitivity: "secret" },
      { event_type: EventType.StateUpdated },
    );
    const [m, o] = redactSensitiveEvents([memory, other]);
    expect(m!.payload.content).toBe("[REDACTED]");
    expect(o!.payload).toEqual(other.payload);
  });
});
