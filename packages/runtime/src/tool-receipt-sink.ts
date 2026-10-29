/**
 * Durable tool-receipt sink — the port every signed `ToolInvocationReceipt`
 * the runtime produces is appended to, in call order, before the run moves
 * on.
 *
 * Why a port: the in-session buffer (`getRecentReceipts`, capped at
 * `RECEIPTS_BUFFER_CAP`) and the fire-and-forget `onToolInvocation` bus are
 * views, not records — receipts fall off the buffer and are gone at exit.
 * A run whose evidence must survive it (a governed repo change bundles every
 * tool receipt, spec/repo-change-v1.md §3.6) needs a record, and the record
 * is an adapter: in-memory for tests, a file / SQLite / IndexedDB store in
 * production. The interior never binds to a storage provider.
 *
 * Contract (fail-closed):
 *   - `append` is awaited for every receipt, one at a time, in the order
 *     the calls terminated. The runtime never has two appends in flight.
 *   - A rejection is fatal to the run that produced the receipt: the
 *     runtime throws instead of continuing as though the receipt exists.
 *   - The sink stores the receipt as given; it never mutates it (receipts
 *     are frozen by `signToolInvocationReceipt`).
 */

import type { SignableToolInvocationReceipt } from "@motebit/crypto";

export interface ToolReceiptSink {
  append(receipt: SignableToolInvocationReceipt): Promise<void>;
}

/** In-memory sink: the test adapter, and a run-scoped record for callers that persist later. */
export class InMemoryToolReceiptSink implements ToolReceiptSink {
  private readonly _receipts: SignableToolInvocationReceipt[] = [];

  append(receipt: SignableToolInvocationReceipt): Promise<void> {
    this._receipts.push(receipt);
    return Promise.resolve();
  }

  /** Every receipt appended, in append order. */
  list(): readonly SignableToolInvocationReceipt[] {
    return [...this._receipts];
  }
}
