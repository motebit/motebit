import { describe, it, expect } from "vitest";
import {
  ALL_SETTLEMENT_ASSETS,
  isSettlementAsset,
  type SettlementAsset,
} from "../settlement-asset.js";

// `SettlementAsset` sub-phase A coverage tests. The closed vocabulary
// of stablecoin assets the protocol clears settlement in. Bespoke
// coverage shape — sub-phase A intentionally stops short of the full
// eight-artifact registered-registry set per
// `docs/doctrine/off-ramp-as-user-action.md` § "Asset pluggability"
// and `docs/doctrine/registry-pattern-canonical.md` § "When to add a
// registry to `REGISTERED_REGISTRIES`":
//
//   - Per-registry coverage gate — deferred to sub-phase B (no
//     cross-implementation drift surface with a single literal).
//   - Perturbation probe — deferred to sub-phase B.
//   - Drift-defenses inventory entry — deferred to sub-phase B.
//   - `REGISTERED_REGISTRIES` append — deferred to sub-phase B.
//
// What this file locks: the iteration + guard primitives are ready
// for the second-asset promotion to be a one-line registry append,
// not a refactor. Same test shape as `settlement-mode.test.ts`.

describe("ALL_SETTLEMENT_ASSETS", () => {
  it("is a frozen array (registry pattern)", () => {
    expect(Object.isFrozen(ALL_SETTLEMENT_ASSETS)).toBe(true);
  });

  it("enumerates the closed set in canonical order — USDC only at sub-phase A", () => {
    expect(ALL_SETTLEMENT_ASSETS).toEqual(["USDC"]);
  });

  it("contains every literal in the SettlementAsset union", () => {
    // Exhaustive switch — TypeScript catches a missing arm at compile
    // time. Adding a second asset (PYUSD, USDP) without updating this
    // switch fails `tsc`, which is the sub-phase B promotion trigger.
    const acc: SettlementAsset[] = [];
    for (const asset of ALL_SETTLEMENT_ASSETS) {
      switch (asset) {
        case "USDC":
          acc.push(asset);
          break;
      }
    }
    expect(acc).toHaveLength(ALL_SETTLEMENT_ASSETS.length);
  });

  it("contains no duplicates", () => {
    const set = new Set(ALL_SETTLEMENT_ASSETS);
    expect(set.size).toBe(ALL_SETTLEMENT_ASSETS.length);
  });
});

describe("isSettlementAsset", () => {
  it("returns true for every member of ALL_SETTLEMENT_ASSETS", () => {
    for (const asset of ALL_SETTLEMENT_ASSETS) {
      expect(isSettlementAsset(asset)).toBe(true);
    }
  });

  it("returns false for non-registered asset symbols", () => {
    // Adjacent stablecoins that COULD become sub-phase B candidates
    // but are not yet registered. Fail-closed: a peer announcing
    // `asset: "USDT"` on its sovereign rail must be rejected at the
    // type guard, not silently treated as a settlement asset.
    expect(isSettlementAsset("USDT")).toBe(false);
    expect(isSettlementAsset("DAI")).toBe(false);
    expect(isSettlementAsset("PYUSD")).toBe(false);
    expect(isSettlementAsset("USDP")).toBe(false);
    // Future motebit-cloud overlay candidate — the protocol-vs-product
    // wall: until MOTE lands in `ALL_SETTLEMENT_ASSETS`, the type
    // guard rejects it. See `feedback_no_mote_stablecoin` memory.
    expect(isSettlementAsset("MOTE")).toBe(false);
    // Fiat currencies — `currency` fields on `DepositResult` /
    // `BatchWithdrawalItem` etc. mix fiat and stablecoin, but the
    // `SettlementAsset` vocabulary is stablecoin-only.
    expect(isSettlementAsset("USD")).toBe(false);
    expect(isSettlementAsset("EUR")).toBe(false);
    // Case-sensitive — wire-format convention.
    expect(isSettlementAsset("usdc")).toBe(false);
    expect(isSettlementAsset("Usdc")).toBe(false);
    expect(isSettlementAsset("")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isSettlementAsset(null)).toBe(false);
    expect(isSettlementAsset(undefined)).toBe(false);
    expect(isSettlementAsset(0)).toBe(false);
    expect(isSettlementAsset({})).toBe(false);
    expect(isSettlementAsset(["USDC"])).toBe(false);
    expect(isSettlementAsset(true)).toBe(false);
  });

  it("narrows the type at compile time (consumer-shape coverage)", () => {
    // The type narrowing is the point: TypeScript refines `value`
    // from `unknown` to `SettlementAsset` so it can be passed to
    // functions that demand the closed type (e.g. `SovereignRail.asset`).
    const value: unknown = "USDC";
    if (isSettlementAsset(value)) {
      const a: SettlementAsset = value;
      expect(a).toBe("USDC");
    } else {
      throw new Error("unreachable");
    }
  });
});
