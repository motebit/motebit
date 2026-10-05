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
  // Unpriced by decision (2026-09-13): read-url is an internal utility atom
  // whose value is priced into the molecules that call it (research $0.25,
  // code-review $0.20). A separate price created an unpayable internal hop
  // (code-review has no payer seam) that kept admission open here. A price
  // may return when an external payer exists; the listing shape stays.
  const unitCost = parseFloat(env["MOTEBIT_UNIT_COST"] ?? "0");
  return [{ capability: "read_url", unit_cost: unitCost, currency: "USD", per: "request" }];
}
