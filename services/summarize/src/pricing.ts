/**
 * The market listing's pricing — the ONE place this service's price is coded.
 *
 * Pure and import-free, with the environment injected, so
 * `scripts/check-service-truth.ts` EXECUTES it with an empty env to read the
 * price this service actually lists (the default the docs must state), and
 * with a sentinel `MOTEBIT_UNIT_COST` to prove the override reaches every
 * entry. `main()` lists exactly `listingPricing(process.env)`; the gate
 * refuses any other pricing construction in this service's source.
 */
export interface ListingPrice {
  capability: string;
  unit_cost: number;
  currency: string;
  per: string;
}

export function listingPricing(env: Readonly<Record<string, string | undefined>>): ListingPrice[] {
  // Zero-cost atom until the multi-hop settlement arc; listed so the market
  // renders it as priced (conformance "pricing listed").
  const unitCost = parseFloat(env["MOTEBIT_UNIT_COST"] ?? "0");
  return [{ capability: "summarize_search", unit_cost: unitCost, currency: "USD", per: "task" }];
}
