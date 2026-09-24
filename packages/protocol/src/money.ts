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

/** A settlement's two recorded legs, rounded to whole micro-units. */
export interface SettlementSplitMicro {
  /** Worker net, in whole micro-units. */
  netMicro: number;
  /** Platform fee, in whole micro-units. */
  feeMicro: number;
}

/**
 * Round a settlement's (net, fee) pair to whole micro-units **without breaking
 * conservation**: the returned legs always sum to `round(net + fee)`.
 *
 * Rounding the two legs INDEPENDENTLY does not conserve. `settleOnReceipt`
 * returns a conserving but fractional pair (its `microRound` rounds to six
 * decimal places, which is a no-op on values already at micro precision), and
 * `Math.round` applied separately to each half breaks the sum whenever both
 * land on a .5 boundary — at `feeRate = 0.05` that is every gross ≡ 10 (mod
 * 20), i.e. exactly 5% of integer grosses, each recording one micro of fee the
 * relay never retained.
 *
 * That matters because the recorded pair is not display: `relay_settlements` is
 * the signed, dispute-grade history the business is built on, and the recorded
 * fee sum is the input to the treasury reconciler's `onchain >= recordedFeeSum`
 * invariant. A systematically over-stated fee drifts the reconciler against the
 * chain.
 *
 * The fee is the rounded leg and the net is the remainder — the same direction
 * as {@link computeP2pFeeMicro} and {@link computeFederatedFeeSplit}, so all
 * three lanes (relay-custody, P2P, federated) agree on who absorbs the dust.
 *
 * @param netExact worker net, possibly fractional micro-units
 * @param feeExact platform fee, possibly fractional micro-units
 */
export function roundSettlementSplitMicro(
  netExact: number,
  feeExact: number,
): SettlementSplitMicro {
  const grossMicro = Math.round(netExact + feeExact);
  const feeMicro = Math.round(feeExact);
  return { netMicro: grossMicro - feeMicro, feeMicro };
}

/** The three legs of a cross-operator federated P2P settlement, in micro-units. */
export interface FederatedFeeSplit {
  /** Origin relay (A) fee leg — `round(budget · feeRate)`. */
  originFeeMicro: number;
  /** Executor relay (B) fee leg — `round((budget − originFee) · feeRate)`. */
  executorFeeMicro: number;
  /** Worker net leg — the remainder. `budget − originFee − executorFee`. */
  workerNetMicro: number;
}

/**
 * Cross-operator federated P2P fee-from-budget split (spec `relay-federation-v1`
 * §7.1). Unlike single-operator P2P (fee on TOP of the worker's unit_cost), the
 * remote worker's listed `unit_cost` IS the budget: the origin relay (A) takes
 * `feeRate` of it, forwards the remainder, the executor relay (B) takes `feeRate`
 * of THAT, and the worker nets the rest. `$1.00 → A $0.05 / B $0.0475 / worker
 * $0.9025`. The three legs sum to the budget exactly (no float drift — integer
 * subtraction down the chain).
 *
 * Interop law on the money path: the origin relay's forward-site validator
 * (`federatedP2pIntent`) and the delegator client that builds the 3-leg proof
 * MUST compute this identically, or the proof is rejected leg-by-leg. Hosted
 * here as the single canonical source consumed by both.
 *
 * @param budgetMicro the remote worker's listed unit_cost, in micro-units
 * @param feeRate platform fee rate in [0, 1) — e.g. 0.05
 */
export function computeFederatedFeeSplit(budgetMicro: number, feeRate: number): FederatedFeeSplit {
  if (feeRate < 0 || feeRate >= 1) {
    throw new Error(`feeRate must be in [0, 1), got ${feeRate}`);
  }
  const originFeeMicro = Math.round(budgetMicro * feeRate);
  const forwardedMicro = budgetMicro - originFeeMicro;
  const executorFeeMicro = Math.round(forwardedMicro * feeRate);
  const workerNetMicro = forwardedMicro - executorFeeMicro;
  return { originFeeMicro, executorFeeMicro, workerNetMicro };
}
