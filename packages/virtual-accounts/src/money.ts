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

export { MICRO, toMicro, fromMicro } from "@motebit/protocol";

/** 24-hour dispute window — matches `dispute-v1.md §4.5`. */
export const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
