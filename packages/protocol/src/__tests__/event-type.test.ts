/**
 * `EventType` canonical-registry tests. Mirror of
 * `sensitivity-level.test.ts` / `artifact-type.test.ts` /
 * `audience.test.ts` / `routing.test.ts` — locks the closed
 * iteration over `EventType` so a new event type can only land via
 * intentional update of (a) the enum in `index.ts`, (b)
 * `ALL_EVENT_TYPES` in `event-type.ts`, and (c) the drift gate
 * `check-event-type-canonical`. This file pins the registry-
 * coverage surface.
 *
 * Doctrine: `docs/doctrine/registry-pattern-canonical.md` (sixth
 * registered registry).
 */
import { describe, it, expect } from "vitest";
import { ALL_EVENT_TYPES, isEventType, EventType } from "../index.js";

describe("ALL_EVENT_TYPES", () => {
  it("has at least 50 registered entries (motebit's event vocabulary)", () => {
    // Lower-bounded by 50 because the exact count is a moving
    // target as the codebase evolves; the sibling-alignment block
    // in `check-event-type-canonical` is the load-bearing
    // exact-match check.
    expect(ALL_EVENT_TYPES.length).toBeGreaterThanOrEqual(50);
  });

  it("matches the enum's value set exactly", () => {
    // The array values and the enum values must agree byte-
    // identically. Convert both to sets and compare.
    const arrayValues = new Set<string>(ALL_EVENT_TYPES);
    const enumValues = new Set<string>(Object.values(EventType));
    expect(arrayValues).toEqual(enumValues);
  });

  it("has no duplicates", () => {
    expect(new Set(ALL_EVENT_TYPES).size).toBe(ALL_EVENT_TYPES.length);
  });

  it("is frozen — additions must edit the source, not the array at runtime", () => {
    expect(Object.isFrozen(ALL_EVENT_TYPES)).toBe(true);
  });

  it("uses snake_case identifiers — wire-form convention", () => {
    for (const eventType of ALL_EVENT_TYPES) {
      expect(eventType).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });
});

describe("isEventType", () => {
  it("narrows every registered event type", () => {
    for (const eventType of ALL_EVENT_TYPES) {
      const value: unknown = eventType;
      if (isEventType(value)) {
        const narrowed: EventType = value;
        expect(narrowed).toBe(eventType);
      } else {
        throw new Error(`isEventType should have narrowed ${String(eventType)}`);
      }
    }
  });

  it("rejects unknown strings — the typo class the registry exists to catch", () => {
    expect(isEventType("memry_formed")).toBe(false); // missing letter
    expect(isEventType("MemoryFormed")).toBe(false); // wrong case
    expect(isEventType("memory-formed")).toBe(false); // hyphen instead of underscore
    expect(isEventType("identity_created_v2")).toBe(false); // unregistered variant
    expect(isEventType("tool_call")).toBe(false); // audit-chain's event_type, not EventType
    expect(isEventType("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isEventType(0)).toBe(false);
    expect(isEventType(null)).toBe(false);
    expect(isEventType(undefined)).toBe(false);
    expect(isEventType({ event_type: "memory_formed" })).toBe(false);
    expect(isEventType(["memory_formed"])).toBe(false);
  });
});
