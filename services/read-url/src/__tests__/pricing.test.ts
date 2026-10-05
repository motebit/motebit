/**
 * The listing price is the pure `listingPricing(env)` — the function main()
 * lists (check-service-truth executes main() itself). Default and override, every entry.
 */
import { describe, it, expect } from "vitest";
import { listingPricing } from "../pricing.js";

describe("read-url listingPricing", () => {
  it("lists the coded default with no environment", () => {
    const p = listingPricing({});
    expect(p).toHaveLength(1);
    for (const e of p) expect(e).toMatchObject({ unit_cost: 0, currency: "USD", per: "request" });
  });

  it("MOTEBIT_UNIT_COST overrides every entry", () => {
    for (const e of listingPricing({ MOTEBIT_UNIT_COST: "0.37" })) expect(e.unit_cost).toBe(0.37);
  });
});
