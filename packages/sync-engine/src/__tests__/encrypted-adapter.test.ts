import { describe, it, expect } from "vitest";
import { EncryptedEventStoreAdapter, decryptEventPayload } from "../encrypted-adapter.js";
import { InMemoryEventStore } from "@motebit/event-log";
import { generateKey } from "@motebit/crypto";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTEBIT_ID = "motebit-enc-test";

function makeEvent(
  clock: number,
  payload: Record<string, unknown> = { value: clock },
): EventLogEntry {
  return {
    event_id: `event-${clock}`,
    motebit_id: MOTEBIT_ID,
    device_id: "test-device",
    timestamp: Date.now(),
    event_type: EventType.StateUpdated,
    payload,
    version_clock: clock,
    tombstoned: false,
  };
}

function makeAdapter(inner?: InMemoryEventStore, key?: Uint8Array) {
  const store = inner ?? new InMemoryEventStore();
  const k = key ?? generateKey();
  const adapter = new EncryptedEventStoreAdapter({ inner: store, key: k });
  return { adapter, store, key: k };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EncryptedEventStoreAdapter", () => {
  it("round-trips a single event through encrypt/decrypt", async () => {
    const { adapter } = makeAdapter();
    const event = makeEvent(1, { greeting: "hello", nested: { a: 1 } });

    await adapter.append(event);
    const results = await adapter.query({ motebit_id: MOTEBIT_ID });

    expect(results).toHaveLength(1);
    expect(results[0]!.payload).toEqual({ greeting: "hello", nested: { a: 1 } });
    expect(results[0]!.event_id).toBe("event-1");
  });

  it("stores encrypted payload in the inner adapter", async () => {
    const { adapter, store } = makeAdapter();
    await adapter.append(makeEvent(1, { secret: "classified" }));

    // Query the inner store directly — payload should be encrypted, not plaintext
    const raw = await store.query({ motebit_id: MOTEBIT_ID });
    expect(raw).toHaveLength(1);
    const rawPayload = raw[0]!.payload;
    expect(rawPayload._encrypted).toBe(true);
    expect(typeof rawPayload._data).toBe("string");
    // The plaintext value must not appear in the encrypted blob
    expect(JSON.stringify(rawPayload)).not.toContain("classified");
  });

  it("preserves cleartext metadata fields", async () => {
    const { adapter, store } = makeAdapter();
    const event = makeEvent(5);
    await adapter.append(event);

    const raw = await store.query({ motebit_id: MOTEBIT_ID });
    expect(raw[0]!.event_id).toBe("event-5");
    expect(raw[0]!.motebit_id).toBe(MOTEBIT_ID);
    expect(raw[0]!.version_clock).toBe(5);
    expect(raw[0]!.event_type).toBe(EventType.StateUpdated);
  });

  it("round-trips multiple events", async () => {
    const { adapter } = makeAdapter();
    await adapter.append(makeEvent(1, { a: 1 }));
    await adapter.append(makeEvent(2, { b: 2 }));
    await adapter.append(makeEvent(3, { c: 3 }));

    const results = await adapter.query({ motebit_id: MOTEBIT_ID });
    expect(results).toHaveLength(3);
    expect(results[0]!.payload).toEqual({ a: 1 });
    expect(results[1]!.payload).toEqual({ b: 2 });
    expect(results[2]!.payload).toEqual({ c: 3 });
  });

  it("decrypts only encrypted entries — passes through unencrypted ones", async () => {
    const store = new InMemoryEventStore();
    const key = generateKey();
    const adapter = new EncryptedEventStoreAdapter({ inner: store, key });

    // Append one encrypted event through the adapter
    await adapter.append(makeEvent(1, { encrypted: true }));

    // Append one unencrypted event directly to the inner store
    await store.append(makeEvent(2, { encrypted: false }));

    const results = await adapter.query({ motebit_id: MOTEBIT_ID });
    expect(results).toHaveLength(2);
    expect(results[0]!.payload).toEqual({ encrypted: true });
    expect(results[1]!.payload).toEqual({ encrypted: false });
  });

  it("fails to decrypt with a wrong key", async () => {
    const store = new InMemoryEventStore();
    const key1 = generateKey();
    const key2 = generateKey();

    const writer = new EncryptedEventStoreAdapter({ inner: store, key: key1 });
    await writer.append(makeEvent(1, { secret: "data" }));

    const reader = new EncryptedEventStoreAdapter({ inner: store, key: key2 });
    await expect(reader.query({ motebit_id: MOTEBIT_ID })).rejects.toThrow();
  });

  it("delegates getLatestClock to inner adapter", async () => {
    const { adapter, store } = makeAdapter();
    await store.append(makeEvent(10));
    await store.append(makeEvent(20));

    const clock = await adapter.getLatestClock(MOTEBIT_ID);
    expect(clock).toBe(20);
  });

  it("delegates tombstone to inner adapter", async () => {
    const { adapter, store } = makeAdapter();
    await store.append(makeEvent(1));

    await adapter.tombstone("event-1", MOTEBIT_ID);
    const results = await store.query({ motebit_id: MOTEBIT_ID });
    expect(results[0]!.tombstoned).toBe(true);
  });

  it("handles empty payload", async () => {
    const { adapter } = makeAdapter();
    await adapter.append(makeEvent(1, {}));

    const results = await adapter.query({ motebit_id: MOTEBIT_ID });
    expect(results[0]!.payload).toEqual({});
  });

  it("handles payload with unicode and special characters", async () => {
    const { adapter } = makeAdapter();
    const payload = { text: "Hello 🌊 world — \"quotes\" & <tags>" };
    await adapter.append(makeEvent(1, payload));

    const results = await adapter.query({ motebit_id: MOTEBIT_ID });
    expect(results[0]!.payload).toEqual(payload);
  });

  it("each encryption produces unique ciphertext (unique nonce)", async () => {
    const store = new InMemoryEventStore();
    const key = generateKey();
    const adapter = new EncryptedEventStoreAdapter({ inner: store, key });

    // Append the same payload twice
    await adapter.append(makeEvent(1, { same: "data" }));
    await adapter.append(makeEvent(2, { same: "data" }));

    const raw = await store.query({ motebit_id: MOTEBIT_ID });
    // The encrypted blobs should differ (different nonces)
    expect(raw[0]!.payload._data).not.toBe(raw[1]!.payload._data);
  });
});

// ---------------------------------------------------------------------------
// decryptEventPayload() — standalone decrypt for WS onEvent callback
// ---------------------------------------------------------------------------

describe("decryptEventPayload", () => {
  it("round-trips: encrypt via adapter → decrypt standalone", async () => {
    const store = new InMemoryEventStore();
    const key = generateKey();
    const adapter = new EncryptedEventStoreAdapter({ inner: store, key });

    const original = makeEvent(1, { secret: "value", nested: { x: 42 } });
    await adapter.append(original);

    // Read the raw encrypted event from the inner store
    const rawEvents = await store.query({ motebit_id: MOTEBIT_ID });
    expect(rawEvents).toHaveLength(1);
    expect(rawEvents[0]!.payload._encrypted).toBe(true);

    // Decrypt using the standalone function
    const decrypted = await decryptEventPayload(rawEvents[0]!, key);
    expect(decrypted.payload).toEqual({ secret: "value", nested: { x: 42 } });
    expect(decrypted.event_id).toBe("event-1");
  });

  it("passes through unencrypted events", async () => {
    const key = generateKey();
    const event = makeEvent(1, { plain: true });

    const result = await decryptEventPayload(event, key);
    expect(result).toEqual(event);
  });

  it("fails with wrong key", async () => {
    const store = new InMemoryEventStore();
    const key1 = generateKey();
    const key2 = generateKey();
    const adapter = new EncryptedEventStoreAdapter({ inner: store, key: key1 });

    await adapter.append(makeEvent(1, { data: "test" }));
    const raw = await store.query({ motebit_id: MOTEBIT_ID });

    await expect(decryptEventPayload(raw[0]!, key2)).rejects.toThrow();
  });
});
