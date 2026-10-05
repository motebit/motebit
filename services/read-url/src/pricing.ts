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
  // Unpriced by decision (2026-09-13): read-url is an internal utility atom
  // whose value is priced into the molecules that call it (research $0.25,
  // code-review $0.20). A separate price created an unpayable internal hop
  // (code-review has no payer seam) that kept admission open here. A price
  // may return when an external payer exists; the listing shape stays.
  const unitCost = parseFloat(env["MOTEBIT_UNIT_COST"] ?? "0");
  return [{ capability: "read_url", unit_cost: unitCost, currency: "USD", per: "request" }];
}
