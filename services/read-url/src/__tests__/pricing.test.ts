/**
 * The listing price is literal data (`LISTING_PRICE`); the runner's
 * `resolveListingPricing` — the one function runMolecule lists through —
 * applies MOTEBIT_UNIT_COST. Default, override on every entry, and the boot
 * refusal on a malformed override.
 */
import { describe, it, expect } from "vitest";
import { resolveListingPricing } from "@motebit/molecule-runner";
import { LISTING_PRICE } from "../pricing.js";

describe("read-url LISTING_PRICE", () => {
  it("lists the coded default with no override", () => {
    expect(resolveListingPricing(LISTING_PRICE, undefined)).toEqual([
      { capability: "read_url", unit_cost: 0, currency: "USD", per: "request" },
    ]);
  });

  it("MOTEBIT_UNIT_COST overrides every entry", () => {
    expect(resolveListingPricing(LISTING_PRICE, "0.37")).toEqual([
      { capability: "read_url", unit_cost: 0.37, currency: "USD", per: "request" },
    ]);
  });

  it("a malformed MOTEBIT_UNIT_COST refuses instead of listing NaN", () => {
    for (const bad of ["abc", "", "-1", "0.20abc", "NaN", "1e3"])
      expect(() => resolveListingPricing(LISTING_PRICE, bad), bad).toThrow(/MOTEBIT_UNIT_COST/);
  });
});
