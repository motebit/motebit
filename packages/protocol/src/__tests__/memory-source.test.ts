/**
 * `MemorySource` canonical-registry tests. Mirror of
 * `sensitivity-level.test.ts` / `settlement-mode` coverage — locks the
 * closed iteration over `MemorySource` so a new provenance tier (e.g.
 * `"web_content"` split out of `"tool_derived"`) can only land via
 * intentional update of (a) the union in `memory-source.ts`,
 * (b) `ALL_MEMORY_SOURCES`, (c) `MEMORY_SOURCE_MARKERS` (compile-locked
 * by `Record<MemorySource, string>`), and (d) the drift gate
 * `check-memory-source-canonical`.
 *
 * Doctrine: `docs/doctrine/memory-provenance.md` — source is assigned
 * by the forming code path, never the model, never the peer.
 */
import { describe, it, expect } from "vitest";
import {
  ALL_MEMORY_SOURCES,
  isMemorySource,
  MEMORY_SOURCE_MARKERS,
  MEMORY_SOURCE_MARKER_UNKNOWN,
  type MemorySource,
} from "../index.js";

describe("ALL_MEMORY_SOURCES", () => {
  it("has exactly the five registered sources", () => {
    expect(ALL_MEMORY_SOURCES.length).toBe(5);
  });

  it("enumerates every source exactly once, in declaration order", () => {
    expect([...ALL_MEMORY_SOURCES]).toEqual([
      "user_stated",
      "agent_inferred",
      "tool_derived",
      "peer_agent",
      "consolidation_derived",
    ]);
  });

  it("is frozen — additions must edit the source, not the array at runtime", () => {
    expect(Object.isFrozen(ALL_MEMORY_SOURCES)).toBe(true);
  });

  it("uses lowercase snake_case identifiers — wire-form convention (same as EventType)", () => {
    for (const source of ALL_MEMORY_SOURCES) {
      expect(source).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("isMemorySource", () => {
  it("narrows every registered source", () => {
    for (const source of ALL_MEMORY_SOURCES) {
      const value: unknown = source;
      if (isMemorySource(value)) {
        const narrowed: MemorySource = value;
        expect(narrowed).toBe(source);
      } else {
        throw new Error(`isMemorySource should have narrowed ${String(source)}`);
      }
    }
  });

  it("rejects unknown strings — the typo/spoof class the registry exists to catch", () => {
    expect(isMemorySource("User_Stated")).toBe(false); // capitalized
    expect(isMemorySource("user")).toBe(false); // render marker, not registry value
    expect(isMemorySource("web_content")).toBe(false); // proposed future tier, not yet registered
    expect(isMemorySource("model_authored")).toBe(false); // structurally impossible by design
    expect(isMemorySource("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isMemorySource(0)).toBe(false);
    expect(isMemorySource(null)).toBe(false);
    expect(isMemorySource(undefined)).toBe(false);
    expect(isMemorySource({ source: "user_stated" })).toBe(false);
    expect(isMemorySource(["user_stated"])).toBe(false);
  });
});

describe("MEMORY_SOURCE_MARKERS", () => {
  it("covers every registered source (Record-locked) with a distinct marker", () => {
    const markers = ALL_MEMORY_SOURCES.map((s) => MEMORY_SOURCE_MARKERS[s]);
    expect(markers.every((m) => typeof m === "string" && m.length > 0)).toBe(true);
    expect(new Set(markers).size).toBe(ALL_MEMORY_SOURCES.length);
  });

  it("no marker collides with the unknown marker", () => {
    for (const source of ALL_MEMORY_SOURCES) {
      expect(MEMORY_SOURCE_MARKERS[source]).not.toBe(MEMORY_SOURCE_MARKER_UNKNOWN);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(MEMORY_SOURCE_MARKERS)).toBe(true);
  });
});
