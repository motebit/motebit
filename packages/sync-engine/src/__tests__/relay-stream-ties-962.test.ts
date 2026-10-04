/**
 * #962 round 7 — a floor pinned by TIED streams is never silent.
 *
 * Round 6 counted what retiring ONE stream frees. With several dead or
 * unacked streams tied at the floor (two typo'd relays at 0 beside the right
 * relay at 90; two old relays at 50), retiring any one of them frees
 * nothing — its twin still holds the floor — so every stream reported
 * `heldBack: 0`, `pinnedFloor` was null, and nothing said compaction was
 * pinned. The tie-aware count is what retiring EVERY stream at the floor
 * frees (the gap to the next distinct stream); the notice reports it
 * whenever that gap is > 0 and names every stream in the tied set.
 */
import { describe, it, expect } from "vitest";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { InMemoryEventStore } from "@motebit/event-log";
import {
  pinnedFloor,
  pushAckedAtKey,
  pushCompactionFloor,
  recordSyncIntent,
  relayStreamOfUrl,
  resolveSeqCursorStore,
  retireRelayStream,
  syncFloorReport,
} from "../index.js";

const MID = "mote-962ties";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1);
const TYPO1 = "https://typo1.invalid";
const TYPO2 = "https://typo2.invalid";
const OLD1 = "https://old1.relay";
const OLD2 = "https://old2.relay";
const RIGHT = "http://relay.right";

function event(clock: number): EventLogEntry {
  return {
    event_id: `e${clock}`,
    motebit_id: MID as EventLogEntry["motebit_id"],
    timestamp: clock,
    event_type: EventType.StateUpdated,
    payload: {},
    version_clock: clock,
    tombstoned: false,
  };
}

async function storeWith(
  n: number,
  cursors: Record<string, number>,
  ackedAt: Record<string, number> = {},
): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  for (let i = 1; i <= n; i++) await store.append(event(i));
  const cs = resolveSeqCursorStore(store);
  for (const [url, v] of Object.entries(cursors)) {
    await cs.setSyncSeqCursor(`push:raw:${url}#${MID}`, v);
  }
  for (const [url, at] of Object.entries(ackedAt)) {
    await cs.setSyncSeqCursor(pushAckedAtKey(`${url}#${MID}`), at);
  }
  await recordSyncIntent(store, MID);
  return store;
}

describe("#962 round 7 — two typo'd relays tied at 0, the right relay at 90", () => {
  it("each tied stream frees nothing alone; together they free 90 — and the notice names both", async () => {
    const store = await storeWith(100, { [TYPO1]: 0, [TYPO2]: 0, [RIGHT]: 90 });
    const report = await syncFloorReport(store, MID);
    expect(report.floor).toBe(0);
    const t1 = report.streams.find((s) => s.relayUrl === TYPO1)!;
    const t2 = report.streams.find((s) => s.relayUrl === TYPO2)!;
    // Alone: truthful — retiring one leaves its twin holding the floor.
    expect(t1).toMatchObject({ holdsFloor: true, heldBack: 0, heldBackTied: 90 });
    expect(t2).toMatchObject({ holdsFloor: true, heldBack: 0, heldBackTied: 90 });
    expect(t1.tiedWith).toEqual([t2.stream]);
    expect(t2.tiedWith).toEqual([t1.stream]);
    expect(report.streams.find((s) => s.relayUrl === RIGHT)).toMatchObject({
      holdsFloor: false,
      tiedWith: [],
    });

    const pinned = pinnedFloor(report, NOW);
    expect(pinned).not.toBeNull();
    expect(pinned!.reason).toBe("never-acked");
    expect(pinned!.heldBack).toBe(90);
    expect(pinned!.streams.map((s) => s.relayUrl).sort()).toEqual([TYPO1, TYPO2]);

    // The count is honest: retiring both frees exactly 90.
    await retireRelayStream(store, MID, relayStreamOfUrl(TYPO1, MID));
    expect(await pushCompactionFloor(store, 99, { motebitId: MID })).toBe(0);
    await retireRelayStream(store, MID, relayStreamOfUrl(TYPO2, MID));
    expect(await pushCompactionFloor(store, 99, { motebitId: MID })).toBe(90);
    expect(pinnedFloor(await syncFloorReport(store, MID), NOW)).toBeNull();
  });

  it("after retiring one twin, the other alone is reported, freeing the same 90", async () => {
    const store = await storeWith(100, { [TYPO1]: 0, [TYPO2]: 0, [RIGHT]: 90 });
    await retireRelayStream(store, MID, relayStreamOfUrl(TYPO1, MID));
    const pinned = pinnedFloor(await syncFloorReport(store, MID), NOW);
    expect(pinned!.streams.map((s) => s.relayUrl)).toEqual([TYPO2]);
    expect(pinned!.heldBack).toBe(90);
  });
});

describe("#962 round 7 — two old relays tied at 50, stale; the right relay at 90", () => {
  it("the stale tie is reported with the gap to the next distinct stream (40)", async () => {
    const store = await storeWith(
      100,
      { [OLD1]: 50, [OLD2]: 50, [RIGHT]: 90 },
      { [OLD1]: NOW - 9 * DAY, [OLD2]: NOW - 8 * DAY, [RIGHT]: NOW - DAY },
    );
    const report = await syncFloorReport(store, MID);
    expect(report.floor).toBe(50);
    for (const url of [OLD1, OLD2]) {
      expect(report.streams.find((s) => s.relayUrl === url)).toMatchObject({
        holdsFloor: true,
        heldBack: 0,
        heldBackTied: 40,
      });
    }
    const pinned = pinnedFloor(report, NOW);
    expect(pinned!.reason).toBe("stale");
    expect(pinned!.heldBack).toBe(40);
    expect(pinned!.streams.map((s) => s.relayUrl).sort()).toEqual([OLD1, OLD2]);
  });

  it("a tie with a stream that acked recently is not reported (that relay is live; the floor moves)", async () => {
    const store = await storeWith(
      100,
      { [OLD1]: 50, [OLD2]: 50, [RIGHT]: 90 },
      { [OLD1]: NOW - 9 * DAY, [OLD2]: NOW - DAY, [RIGHT]: NOW - DAY },
    );
    expect(pinnedFloor(await syncFloorReport(store, MID), NOW)).toBeNull();
  });

  it("streams tied with nothing past them, under the recorded intent: the gap is 0, no notice", async () => {
    const ties: Array<Record<string, number>> = [
      { [OLD1]: 50, [OLD2]: 50 },
      { [TYPO1]: 0, [TYPO2]: 0 },
    ];
    for (const cursors of ties) {
      const store = await storeWith(100, cursors);
      const report = await syncFloorReport(store, MID);
      // Retiring every stream leaves the recorded intent holding the floor at 0.
      for (const s of report.streams) {
        expect(s).toMatchObject({ holdsFloor: true, heldBack: 0, heldBackTied: 0 });
      }
      expect(pinnedFloor(report, NOW)).toBeNull();
    }
  });
});
