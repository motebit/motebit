/**
 * Micro-unit accounting — the only math the ledger does.
 *
 * All money is stored and compared as INTEGER micro-units: 1 USD =
 * 1_000_000 units. This matches USDC on-chain precision (6 decimals)
 * exactly and eliminates IEEE-754 drift from every ledger operation.
 * No rounding, no tolerance, no "close enough."
 *
 * The API boundary converts:
 *   - `toMicro(dollars)` on ingest (API / webhook payload → ledger).
 *   - `fromMicro(micro)` on egress (ledger → API response).
 *
 * Internal code must NEVER do arithmetic on dollar-floats. If a function
 * signature names its amount `dollars` or `usd`, it is an API-boundary
 * function. Everything else speaks micro-units.
 */

/** 1 USD = 1,000,000 micro-units. USDC on-chain is 6 decimals. */
export const MICRO = 1_000_000;

/** API dollars (float) → integer micro-units. */
export function toMicro(dollars: number): number {
  return Math.round(dollars * MICRO);
}

/** Integer micro-units → API dollars (float). */
export function fromMicro(micro: number): number {
  return micro / MICRO;
}

/** 24-hour dispute window — matches `dispute-v1.md §4.5`. */
export const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
