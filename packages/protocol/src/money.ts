/**
 * Money primitives — interop law for integer-unit accounting.
 *
 * Every motebit implementation must agree on what "1 USD" means at the
 * wire boundary. The two reference precisions ship here as pure algebra:
 *
 *   - micro-units (×1,000,000) — the canonical ledger precision; matches
 *     USDC on-chain (6 decimals) exactly. `@motebit/virtual-accounts` is
 *     the reference ledger consumer.
 *   - cents (×100) — Stripe's API precision and the fiat-rail family.
 *
 * Internal code never does arithmetic on dollar-floats. Conversions
 * happen at the API boundary: `to{Cents,Micro}` on ingest, `from{Cents,Micro}`
 * on egress. A function whose parameter is named `dollars` or `usd` is an
 * API-boundary function; everything else speaks integer units.
 *
 * Drift gate: `scripts/check-money-boundary.ts` forbids inline copies of
 * the converter formula (`Math.round(amount * 100|1_000_000)`) in
 * money-touching packages. The formula is a primitive, not a snippet.
 */

/** 1 USD = 1,000,000 micro-units. USDC on-chain is 6 decimals. */
export const MICRO = 1_000_000;

/** 1 USD = 100 cents. Stripe and fiat rails use this precision. */
export const CENTS = 100;

/** API dollars (float) → integer micro-units. */
export function toMicro(dollars: number): number {
  return Math.round(dollars * MICRO);
}

/** Integer micro-units → API dollars (float). */
export function fromMicro(micro: number): number {
  return micro / MICRO;
}

/** API dollars (float) → integer cents. */
export function toCents(dollars: number): number {
  return Math.round(dollars * CENTS);
}

/** Integer cents → API dollars (float). */
export function fromCents(cents: number): number {
  return cents / CENTS;
}

/**
 * P2P settlement fee leg, in micro-units. A paid direct delegation settles in
 * one atomic onchain transaction that splits into a worker leg
 * (`netCostMicro` — the listing unit_cost the worker earns net) and this fee
 * leg to the relay treasury. The fee is `gross - net` where
 * `gross = round(net / (1 - feeRate))`.
 *
 * This is interop law on the money path: the relay's settlement validator (the
 * `requiresP2pProof` submission check) and the delegator client that builds the
 * proof MUST compute the fee identically — a one-micro disagreement rejects the
 * proof (`TASK_P2P_FEE_AMOUNT_MISMATCH`). The formula therefore lives here as
 * the single canonical source, never inline at each site. Pure integer math
 * over a float `feeRate` ratio — no dollar arithmetic.
 *
 * @param netCostMicro worker net in micro-units (integer)
 * @param feeRate platform fee rate in [0, 1) — e.g. 0.05
 */
export function computeP2pFeeMicro(netCostMicro: number, feeRate: number): number {
  if (feeRate < 0 || feeRate >= 1) {
    throw new Error(`feeRate must be in [0, 1), got ${feeRate}`);
  }
  return Math.round(netCostMicro / (1 - feeRate)) - netCostMicro;
}
