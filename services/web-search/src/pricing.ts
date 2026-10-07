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

export const LISTING_PRICE: ListingPriceSpec = {
  capabilities: ["web_search", "read_url"],
  unit_cost: 0.05,
  per: "request",
};
