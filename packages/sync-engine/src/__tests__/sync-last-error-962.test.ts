/**
 * #962 round 3 — `SyncEngine.getLastError()`. `sync()` never rejects, so a
 * relay refusing every push (a revoked device, a bad token) was silent — and
 * a refused push holds compaction. The reason is kept until a cycle succeeds.
 */
import { describe, it, expect } from "vitest";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { InMemoryEventStore } from "@motebit/event-log";
import { SyncEngine } from "../index.js";

const MID = "mote-962le";

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

describe("SyncEngine.getLastError (#962 round 3)", () => {
  it("carries a refused push's reason, and clears once a cycle succeeds", async () => {
    const local = new InMemoryEventStore();
    await local.append(event(1));
    const remote = new InMemoryEventStore();
    let refuse = true;
    const relay = Object.assign(Object.create(remote) as InMemoryEventStore, {
      append: (e: EventLogEntry) =>
        refuse ? Promise.reject(new Error("Push failed: 401 Unauthorized")) : remote.append(e),
    });
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(relay);
    expect(engine.getLastError()).toBeNull();

    const refused = await engine.sync();
    expect(refused.pushed).toBe(0);
    expect(engine.getStatus()).toBe("error");
    expect(engine.getLastError()?.message).toBe("Push failed: 401 Unauthorized");

    refuse = false;
    const ok = await engine.sync();
    expect(ok.pushed).toBe(1);
    expect(engine.getLastError()).toBeNull();
  });
});
