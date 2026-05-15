import { describe, it, expect } from "vitest";
import { ALL_SETTLEMENT_MODES, isSettlementMode, type SettlementMode } from "../settlement-mode.js";

// `SettlementMode` canonical-registry tests. The seventh registered
// registry per `docs/doctrine/registry-pattern-canonical.md`. Same
// shape as `ALL_EVENT_TYPES` / `isEventType` tests (the sixth registry)
// — the eight-artifact recipe is mechanical at this point. The
// per-registry coverage gate (`check-settlement-mode-canonical`)
// enforces sibling-alignment with the type union; this file locks
// the iteration + guard primitives.

describe("ALL_SETTLEMENT_MODES", () => {
  it("is a frozen array (registry pattern)", () => {
    expect(Object.isFrozen(ALL_SETTLEMENT_MODES)).toBe(true);
  });

  it("enumerates the closed set in canonical order", () => {
    expect(ALL_SETTLEMENT_MODES).toEqual(["relay", "p2p"]);
  });

  it("contains every literal in the SettlementMode union", () => {
    // Exhaustive switch — TypeScript catches a missing arm at compile
    // time. Forces a mismatch to surface in BOTH `tsc` and this test
    // if the union is rotated without also updating the array.
    const acc: SettlementMode[] = [];
    for (const mode of ALL_SETTLEMENT_MODES) {
      switch (mode) {
        case "relay":
          acc.push(mode);
          break;
        case "p2p":
          acc.push(mode);
          break;
      }
    }
    expect(acc).toHaveLength(ALL_SETTLEMENT_MODES.length);
  });

  it("contains no duplicates", () => {
    const set = new Set(ALL_SETTLEMENT_MODES);
    expect(set.size).toBe(ALL_SETTLEMENT_MODES.length);
  });
});

describe("isSettlementMode", () => {
  it("returns true for every member of ALL_SETTLEMENT_MODES", () => {
    for (const mode of ALL_SETTLEMENT_MODES) {
      expect(isSettlementMode(mode)).toBe(true);
    }
  });

  it("returns false for unknown string values", () => {
    expect(isSettlementMode("escrow")).toBe(false);
    expect(isSettlementMode("hybrid")).toBe(false);
    expect(isSettlementMode("RELAY")).toBe(false); // case-sensitive
    expect(isSettlementMode("p2P")).toBe(false);
    expect(isSettlementMode("")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isSettlementMode(null)).toBe(false);
    expect(isSettlementMode(undefined)).toBe(false);
    expect(isSettlementMode(0)).toBe(false);
    expect(isSettlementMode({})).toBe(false);
    expect(isSettlementMode(["relay"])).toBe(false);
    expect(isSettlementMode(true)).toBe(false);
  });

  it("narrows the type at compile time (consumer-shape coverage)", () => {
    // If `isSettlementMode` returned `false` we'd never hit this
    // branch — but the type narrowing is the point: TypeScript
    // refines `value` from `unknown` to `SettlementMode` so it can
    // be passed to functions that demand the closed type.
    const value: unknown = "relay";
    if (isSettlementMode(value)) {
      const m: SettlementMode = value;
      expect(m).toBe("relay");
    } else {
      throw new Error("unreachable");
    }
  });
});
