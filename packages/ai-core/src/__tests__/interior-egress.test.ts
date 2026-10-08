import { describe, it, expect } from "vitest";
import { EventType, SensitivityLevel } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import {
  interiorEgressCeiling,
  interiorEgressPermits,
  interiorEgressSensitivities,
  interiorEventsPermittedAt,
  METADATA_ONLY_EVENT_TYPES,
  derivedSensitivity,
  maxStampedSensitivity,
  enforcedDerivedSensitivity,
  stampDerivedText,
  readDerivedText,
  derivedTextPermittedAt,
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

describe("derived artifacts inherit the taint of their inputs", () => {
  it("derivedSensitivity is the max of the send tier's ceiling and every input stamp", () => {
    expect(derivedSensitivity(S.None)).toBe(S.Personal);
    expect(derivedSensitivity(S.Secret)).toBe(S.Secret);
    expect(derivedSensitivity(S.Personal, S.Medical, undefined, null)).toBe(S.Medical);
  });

  it("maxStampedSensitivity is unknowable (null) when empty or any member is unstamped", () => {
    expect(maxStampedSensitivity([])).toBeNull();
    expect(maxStampedSensitivity([S.Personal, undefined])).toBeNull();
    expect(maxStampedSensitivity([S.None, S.Financial, S.Personal])).toBe(S.Financial);
  });

  it("an unstamped artifact is enforced at its fallback, else Secret", () => {
    expect(enforcedDerivedSensitivity(S.Personal)).toBe(S.Personal);
    expect(enforcedDerivedSensitivity(undefined, () => S.Medical)).toBe(S.Medical);
    expect(enforcedDerivedSensitivity(undefined, () => null)).toBe(S.Secret);
    expect(enforcedDerivedSensitivity(null)).toBe(S.Secret);
  });

  it("stamped text round-trips; text without a header reads as unstamped", () => {
    const stored = stampDerivedText("the summary\nline two", S.Medical);
    expect(readDerivedText(stored)).toEqual({
      text: "the summary\nline two",
      sensitivity: S.Medical,
    });
    expect(readDerivedText("plain")).toEqual({ text: "plain", sensitivity: null });
    expect(readDerivedText("[motebit:sensitivity=bogus]\nx")).toEqual({
      text: "[motebit:sensitivity=bogus]\nx",
      sensitivity: null,
    });
  });

  it("derived text passes only where the one rule permits its stamp", () => {
    const secret = stampDerivedText("s", S.Secret);
    expect(derivedTextPermittedAt(secret, S.Personal)).toBeNull();
    expect(derivedTextPermittedAt(secret, S.Secret)).toEqual({ text: "s", sensitivity: S.Secret });
    expect(derivedTextPermittedAt(stampDerivedText("p", S.Personal), S.None)?.text).toBe("p");
    // Legacy: held to the fallback, withheld when unknowable.
    expect(derivedTextPermittedAt("legacy", S.Personal, () => S.Personal)?.text).toBe("legacy");
    expect(derivedTextPermittedAt("legacy", S.Personal, () => S.Medical)).toBeNull();
    expect(derivedTextPermittedAt("legacy", S.Personal, () => null)).toBeNull();
    expect(derivedTextPermittedAt("legacy", S.Secret)?.text).toBe("legacy");
    expect(derivedTextPermittedAt(null, S.Secret)).toBeNull();
  });
});
