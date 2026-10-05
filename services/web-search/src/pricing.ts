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
  const unitCost = parseFloat(env["MOTEBIT_UNIT_COST"] ?? "0.05");
  return [
    { capability: "web_search", unit_cost: unitCost, currency: "USD", per: "request" },
    { capability: "read_url", unit_cost: unitCost, currency: "USD", per: "request" },
  ];
}
