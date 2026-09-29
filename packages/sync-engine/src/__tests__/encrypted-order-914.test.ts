/**
 * #914 round 2 — the encrypting wrapper hands pushes to its inner adapter in
 * CALL order, even when the encryptions finish in another order. Here the
 * first encryption is made the slowest.
 */
import { describe, it, expect, vi } from "vitest";
import type { EventStoreAdapter } from "@motebit/event-log";
import type { EventLogEntry } from "@motebit/sdk";

vi.mock("@motebit/encryption", async () => {
  const actual = await vi.importActual<typeof import("@motebit/encryption")>("@motebit/encryption");
  let calls = 0;
  return {
    ...actual,
    encrypt: async (...args: Parameters<typeof actual.encrypt>) => {
      const delay = Math.max(0, 40 - 8 * calls++);
      await new Promise((r) => setTimeout(r, delay));
      return actual.encrypt(...args);
    },
  };
});

import { EncryptedEventStoreAdapter } from "../encrypted-adapter.js";

describe("#914 round 2: encrypted pushes keep their call order", () => {
  it("the inner adapter receives appends in the order they were called", async () => {
    const order: string[] = [];
    const inner: EventStoreAdapter = {
      append: (e) => {
        order.push(e.event_id);
        return Promise.resolve();
      },
      query: () => Promise.resolve([]),
      getLatestClock: () => Promise.resolve(0),
      tombstone: () => Promise.resolve(),
    };
    const enc = new EncryptedEventStoreAdapter({ inner, key: new Uint8Array(32).fill(1) });
    const ids = ["a", "b", "c", "d", "e"];
    await Promise.all(
      ids.map((id, i) =>
        enc.append({
          event_id: id,
          motebit_id: "m",
          timestamp: 0,
          event_type: "state_updated",
          payload: { i },
          version_clock: i + 1,
          tombstoned: false,
        } as unknown as EventLogEntry),
      ),
    );
    expect(order).toEqual(ids);
  });
});
