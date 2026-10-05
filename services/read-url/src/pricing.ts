/**
 * The market listing's price — the ONE place this service's price is coded.
 *
 * DATA, not a function: literals only, so it cannot read the environment.
 * main() passes it to the runner as config `pricing: LISTING_PRICE`;
 * `@motebit/molecule-runner` owns everything else by construction — it reads
 * the operator override `MOTEBIT_UNIT_COST` once (refusing to start on a
 * malformed value), applies it to every capability alike, and lists exactly
 * that in task admission, relay registration and the MCP listing tool.
 * `scripts/check-service-truth.ts` holds this file to that shape by AST and
 * compares `unit_cost` / `per` with the docs and `.env.example`.
 */
import type { ListingPriceSpec } from "@motebit/molecule-runner";

// Unpriced by decision (2026-09-13): read-url is an internal utility atom
// whose value is priced into the molecules that call it (research $0.25,
// code-review $0.20). A separate price created an unpayable internal hop
// (code-review has no payer seam) that kept admission open here. A price
// may return when an external payer exists; the listing shape stays.
export const LISTING_PRICE: ListingPriceSpec = {
  capabilities: ["read_url"],
  unit_cost: 0,
  per: "request",
};
