/**
 * #962 round 2 — `pushCompactionFloor` groups push cursors by RELAY STREAM.
 *
 * One relay can carry several push cursors (mobile's /sync E2E HTTP cursor
 * beside its live socket cursor; a raw CLI process beside an E2E one). Within
 * one stream the MAX counts: every push path sends every local event of the
 * identity in clock order, the relay keys what it holds by event_id whatever
 * the payload mode, and a cursor moves only past events acked by — or seen
 * held at — that relay. So any cursor for a stream proves the relay holds
 * everything up to it. Across distinct streams (another relay origin, another
 * identity, a remote that names no relay) the MIN.
 */
import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import { pushCompactionFloor, relayStreamOfPushKey, resolveSeqCursorStore } from "../index.js";

describe("relayStreamOfPushKey (#962 round 2)", () => {
  it("maps every adapter's key for one relay to one stream", () => {
    const stream = "https://relay.one#m1";
    for (const key of [
      `push:relay:${stream}`,
      `push:raw:${stream}`,
      `push:e2e:raw:${stream}`,
      `push:e2e:${stream}`,
    ]) {
      expect(relayStreamOfPushKey(key)).toBe(stream);
    }
  });

  it("keeps another origin, another identity and an unnamed remote distinct", () => {
    const streams = new Set(
      [
        "push:relay:https://relay.one#m1",
        "push:e2e:raw:https://relay.two#m1",
        "push:raw:https://relay.one#m2",
        "push:#m1",
      ].map(relayStreamOfPushKey),
    );
    expect(streams.size).toBe(4);
  });
});

describe("pushCompactionFloor stream grouping (#962 round 2)", () => {
  async function storeWith(cursors: Record<string, number>): Promise<InMemoryEventStore> {
    const store = new InMemoryEventStore();
    const cursorStore = resolveSeqCursorStore(store);
    for (const [k, v] of Object.entries(cursors)) await cursorStore.setSyncSeqCursor(k, v);
    return store;
  }

  it("the MAX within one relay: a stale /sync cursor never pins the live one", async () => {
    const store = await storeWith({
      "push:relay:https://r#m": 100,
      "push:e2e:raw:https://r#m": 5,
    });
    expect(await pushCompactionFloor(store, 99)).toBe(99);
  });

  it("the MIN across relays", async () => {
    const store = await storeWith({
      "push:relay:https://a#m": 100,
      "push:e2e:raw:https://a#m": 5,
      "push:raw:https://b#m": 7,
      "push:e2e:raw:https://b#m": 3,
    });
    expect(await pushCompactionFloor(store, 99)).toBe(7);
  });

  it("an unnamed remote's cursor is a stream of its own", async () => {
    const store = await storeWith({ "push:relay:https://a#m": 50, "push:#m": 2 });
    expect(await pushCompactionFloor(store, 49)).toBe(2);
  });

  it("no stream: 0 when sync is configured, `requested` otherwise", async () => {
    const store = new InMemoryEventStore();
    expect(await pushCompactionFloor(store, 9, { syncConfigured: true })).toBe(0);
    expect(await pushCompactionFloor(store, 9, { syncConfigured: false })).toBe(9);
    expect(await pushCompactionFloor(store, 9)).toBe(9);
  });

  it("streams bound the floor even when the host says no relay", async () => {
    const store = await storeWith({ "push:relay:https://a#m": 4 });
    expect(await pushCompactionFloor(store, 9, { syncConfigured: false })).toBe(4);
  });
});
