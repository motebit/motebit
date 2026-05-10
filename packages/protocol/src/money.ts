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
