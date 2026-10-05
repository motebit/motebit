/**
 * The market listing's pricing — the ONE place this service's price is coded.
 *
 * Pure, with the environment injected, and listed by main() as
 * `pricing: listingPricing(process.env)`. `scripts/check-service-truth.ts`
 * does not read this file: it EXECUTES this service's real main() with
 * `runMolecule` captured and reads the pricing of the listing main() hands the
 * runner — with no MOTEBIT_UNIT_COST (the default the docs and .env.example
 * must state) and with a sentinel MOTEBIT_UNIT_COST every entry must carry.
 */
export interface ListingPrice {
  capability: string;
  unit_cost: number;
  currency: string;
  per: string;
}

export function listingPricing(env: Readonly<Record<string, string | undefined>>): ListingPrice[] {
  const unitCost = parseFloat(env["MOTEBIT_UNIT_COST"] ?? "0.01");
  return [{ capability: "execute_delegation", unit_cost: unitCost, currency: "USD", per: "task" }];
}
