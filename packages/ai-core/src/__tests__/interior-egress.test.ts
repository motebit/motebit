import { describe, it, expect } from "vitest";
import { EventType, SensitivityLevel } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import {
  interiorEgressCeiling,
  interiorEgressPermits,
  interiorEgressSensitivities,
  interiorEventsPermittedAt,
  METADATA_ONLY_EVENT_TYPES,
} from "../interior-egress.js";

const S = SensitivityLevel;

function ev(event_type: EventType, payload: Record<string, unknown>): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: "m",
    timestamp: 0,
    event_type,
    payload,
    version_clock: 0,
    tombstoned: false,
  } as EventLogEntry;
}

describe("interior-egress rule", () => {
  it("floors the ceiling at the context-safe tier and raises it with the send tier", () => {
    expect(interiorEgressCeiling(undefined)).toBe(S.Personal);
    expect(interiorEgressCeiling(S.None)).toBe(S.Personal);
    expect(interiorEgressCeiling(S.Personal)).toBe(S.Personal);
    expect(interiorEgressCeiling(S.Medical)).toBe(S.Medical);
    expect(interiorEgressCeiling(S.Secret)).toBe(S.Secret);
  });

  it("never permits medical, financial or secret at a context-safe send tier", () => {
    for (const tier of [undefined, S.None, S.Personal]) {
      expect(interiorEgressSensitivities(tier)).toEqual([S.None, S.Personal]);
      for (const s of [S.Medical, S.Financial, S.Secret]) {
        expect(interiorEgressPermits(tier, s)).toBe(false);
      }
    }
  });

  it("permits every tier at Secret", () => {
    expect(interiorEgressSensitivities(S.Secret)).toEqual([
      S.None,
      S.Personal,
      S.Medical,
      S.Financial,
      S.Secret,
    ]);
  });

  it("passes metadata-only events unstamped, and withholds unstamped content events", () => {
    const events = [
      ev(EventType.MemoryAccessed, { node_id: "n" }),
      ev(EventType.ToolUsed, { tool: "t", result_summary: "x" }),
      ev(EventType.StateUpdated, { user_message: "u", response: "r" }),
      ev(EventType.GoalCreated, { prompt: "g" }),
    ];
    expect(interiorEventsPermittedAt(events, S.Secret).map((e) => e.event_type)).toEqual([
      EventType.MemoryAccessed,
    ]);
  });

  it("filters stamped events by the send tier, and withholds a malformed stamp", () => {
    const events = [
      ev(EventType.ToolUsed, { sensitivity: S.Secret }),
      ev(EventType.MemoryFormed, { sensitivity: S.Medical }),
      ev(EventType.StateUpdated, { sensitivity: S.Personal }),
      ev(EventType.StateUpdated, { sensitivity: "bogus" }),
    ];
    expect(interiorEventsPermittedAt(events, S.Personal).map((e) => e.event_type)).toEqual([
      EventType.StateUpdated,
    ]);
    expect(interiorEventsPermittedAt(events, S.Secret)).toHaveLength(3);
  });

  it("names a small, closed metadata-only set", () => {
    expect([...METADATA_ONLY_EVENT_TYPES].sort()).toEqual(
      [
        EventType.IdleTickFired,
        EventType.MemoryAccessed,
        EventType.MemoryDeleted,
        EventType.MemoryPinned,
        EventType.SensitivityGateFired,
      ].sort(),
    );
  });
});
