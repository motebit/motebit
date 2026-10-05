/**
 * Micro-unit accounting — the only math the ledger does.
 *
 * The canonical converters (`MICRO`, `toMicro`, `fromMicro`) live in
 * `@motebit/protocol` as permissive-floor algebra; every motebit
 * implementation, in any language, uses the same formula. This module
 * re-exports them so consumers importing from `@motebit/virtual-accounts`
 * (the reference ledger) keep working unchanged.
 *
 * The API boundary converts:
 *   - `toMicro(dollars)` on ingest (API / webhook payload → ledger).
 *   - `fromMicro(micro)` on egress (ledger → API response).
 *
 * Internal code must NEVER do arithmetic on dollar-floats. If a function
 * signature names its amount `dollars` or `usd`, it is an API-boundary
 * function. Everything else speaks micro-units.
 */

import { isPositiveMicro } from "@motebit/protocol";

export { MICRO, toMicro, fromMicro } from "@motebit/protocol";

/**
 * The ledger's amount floor for a value-moving write: a positive safe integer
 * of micro-units, else a `RangeError`. A violation is a programming error —
 * callers validate at the API boundary first (`parsePositiveMicro(dollars)` in
 * `@motebit/protocol`) — so this throws rather than returning a refusal. It
 * exists because the boundary once validated the dollar value instead of the
 * converted one, and 1e-7 USD (`toMicro` → 0) recorded $0 withdrawals.
 */
export function assertPositiveMicro(amount: unknown, context: string): asserts amount is number {
  if (!isPositiveMicro(amount)) {
    throw new RangeError(
      `${context}: amount must be a positive safe integer of micro-units ` +
        `(minimum 1 = 0.000001 USD), got ${String(amount)}. ` +
        `Validate at the API boundary with parsePositiveMicro(dollars).`,
    );
  }
}

/** 24-hour dispute window — matches `dispute-v1.md §4.5`. */
export const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
