/**
 * The market listing's pricing — the ONE place this service's price is coded.
 *
 * Pure, with the environment injected. main() hands it to the runner as
 * config `pricing: listingPricing(process.env)`; `@motebit/molecule-runner`
 * owns the listing's pricing by construction (it lists exactly this, in task
 * admission, relay registration and the MCP listing tool, and refuses a
 * getServiceListing that brings its own). `scripts/check-service-truth.ts`
 * imports this function and calls it with `{}` (the default the docs and
 * .env.example must state) and with a sentinel MOTEBIT_UNIT_COST every entry
 * must carry, and checks main()'s runMolecule call passes exactly
 * `pricing: listingPricing(process.env)`.
 */
import type { ListingPrice } from "@motebit/molecule-runner";

export type { ListingPrice };

export function listingPricing(env: Readonly<Record<string, string | undefined>>): ListingPrice[] {
  // Zero-cost atom until the multi-hop settlement arc; listed so the market
  // renders it as priced (conformance "pricing listed").
  const unitCost = parseFloat(env["MOTEBIT_UNIT_COST"] ?? "0");
  return [{ capability: "summarize_search", unit_cost: unitCost, currency: "USD", per: "task" }];
}
