/**
 * Characterization of a PRE-EXISTING SyncEngine property — #868 (not
 * introduced by #816, recorded while root-causing it): the pull cursor is the local max
 * `version_clock`, and the relay stores device-assigned clocks. When this
 * device appends its own event and another device publishes one with the
 * SAME clock before the next pull, the other device's event is never
 * pulled — the query `after_version_clock` skips it, and the local-clock
 * filter would drop it anyway.
 *
 * #816's interleaving harness exposed it on mobile: a controller that pulls
 * EARLIER (as #816's does) can land its own next append on the same clock
 * as a concurrent remote event, where main, pulling later, happened not to.
 * The harness spaces remote clocks so this race cannot decide a comparison
 * of controllers; this test keeps the race itself visible.
 *
 * When the cursor is fixed (e.g. a relay-assigned sequence), this test goes
 * red: flip its expectation and delete this note.
 */
import { it, expect } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import type { EventLogEntry } from "@motebit/sdk";
import { SyncEngine } from "../index.js";

const ev = (id: string, clock: number, device: string): EventLogEntry =>
  ({
    event_id: id,
    motebit_id: "m",
    device_id: device,
    timestamp: 1,
    event_type: "state_updated",
    payload: {},
    version_clock: clock,
    tombstoned: false,
  }) as unknown as EventLogEntry;

it("known gap: another device's event with the same clock as a local append is never pulled", async () => {
  const local = new InMemoryEventStore();
  const relay = new InMemoryEventStore();
  for (let n = 1; n <= 10; n++) await relay.append(ev(`in-${n}`, 1000 + n, "B"));
  const engine = new SyncEngine(local, "m", { sync_interval_ms: 30_000 });
  engine.connectRemote(relay);
  await engine.sync(); // pulls in-1..in-10 (clocks 1001..1010)

  // Device A appends its next event (clock 1011); device B, having seen
  // 1010, publishes its next one — also 1011.
  const { version_clock: _omit, ...own } = ev("evt-11", 0, "A");
  await local.appendWithClock(own);
  await relay.append(ev("in-11", 1011, "B"));
  await engine.sync();
  await engine.sync();

  const ids = (await local.query({ motebit_id: "m" })).map((e) => e.event_id);
  expect(ids).toContain("evt-11");
  expect(ids).not.toContain("in-11"); // the gap
});
