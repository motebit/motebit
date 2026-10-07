/**
 * The listing price — one price, one unit, one override, by construction.
 *
 * A market service codes its price as DATA: `services/<name>/src/pricing.ts`
 * exports `LISTING_PRICE: ListingPriceSpec` (literals only — it cannot read
 * the environment; `scripts/check-service-truth.ts` holds it to that by AST)
 * and main() passes it to `runMolecule` as config `pricing`. This module is
 * the ONE place the operator override is applied: `runMolecule` reads
 * `MOTEBIT_UNIT_COST` once and hands it here. A malformed override REFUSES
 * the boot (fail-closed) — the previous `parseFloat` listed `NaN` (serialised
 * `null`) for "abc" and `0.2` for "0.20abc".
 *
 * Zero imports on purpose: the service-truth gate imports this file to prove
 * the rule it documents (default, sentinel override, refusals) without
 * loading the runner.
 */

/** A market service's coded listing price: one `unit_cost` and one `per` for every capability. */
export interface ListingPriceSpec {
  /** The capabilities the price lists, one entry each. */
  readonly capabilities: readonly string[];
  /** Default price in USD, before any `MOTEBIT_UNIT_COST` override. */
  readonly unit_cost: number;
  /** The unit the price is per ("task", "request", "review", …). */
  readonly per: string;
}

/** One entry of the market listing's `pricing` array. */
export interface ListingPrice {
  capability: string;
  unit_cost: number;
  currency: string;
  per: string;
}

/** The env key the runner reads. */
export const UNIT_COST_ENV = "MOTEBIT_UNIT_COST";

/** A plain non-negative decimal: "0", "0.25", "12", ".5". No sign, exponent, or trailing junk. */
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parse an operator's `MOTEBIT_UNIT_COST`. `undefined` ⇒ no override.
 * Anything else must be a plain non-negative decimal (surrounding whitespace
 * ignored), or this throws — including the empty string.
 */
export function parseUnitCostOverride(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  const n = DECIMAL.test(t) ? Number(t) : Number.NaN;
  if (!Number.isFinite(n) || n < 0)
    throw new Error(
      `${UNIT_COST_ENV}=${JSON.stringify(raw)} is not a non-negative decimal price in USD (e.g. "0.25"); refusing to start rather than list a malformed price — fix or unset it`,
    );
  return n;
}

/**
 * The listing's `pricing` array: one entry per capability, every entry the
 * same `unit_cost` (the override when given, else the coded default), the
 * same `per`, currency USD. Throws on a malformed spec or override.
 */
export function resolveListingPricing(
  spec: ListingPriceSpec,
  rawOverride: string | undefined,
): ListingPrice[] {
  const caps: unknown = spec.capabilities;
  if (
    !Array.isArray(caps) ||
    caps.length === 0 ||
    caps.some((c) => typeof c !== "string" || c === "")
  )
    throw new Error("listing price: `capabilities` must be a non-empty list of capability names");
  if (typeof spec.unit_cost !== "number" || !Number.isFinite(spec.unit_cost) || spec.unit_cost < 0)
    throw new Error(
      `listing price: default \`unit_cost\` ${String(spec.unit_cost)} is not a finite price ≥ 0`,
    );
  if (typeof spec.per !== "string" || spec.per === "")
    throw new Error("listing price: `per` must name a unit");
  const unitCost = parseUnitCostOverride(rawOverride) ?? spec.unit_cost;
  return (caps as string[]).map((capability) => ({
    capability,
    unit_cost: unitCost,
    currency: "USD",
    per: spec.per,
  }));
}
