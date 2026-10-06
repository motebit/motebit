/**
 * Confirm a Solana transaction by HTTP polling — the ONE confirmation path in
 * this package.
 *
 * `@solana/web3.js`'s `confirmTransaction` / `sendAndConfirmTransaction` wait
 * on a websocket `signatureSubscribe`. An RPC that does not implement that
 * method (JSON-RPC -32601) makes every confirm throw AFTER the transaction has
 * landed; a caller that treats the throw as "not sent" sends it again. In
 * production that resubmitted the same anchor memo on every cycle and drained
 * the fee payer. So nothing here subscribes: the outcome is read with
 * `getSignatureStatuses` (plain HTTP) and `getBlockHeight` until it is decided
 * or a bounded wait ends. The package test `no-websocket-confirm.test.ts`
 * fails if a websocket confirm call appears anywhere else in `src/`.
 *
 * Outcomes:
 *   - `confirmed` — the status reached the requested commitment, no error;
 *   - `failed` — the transaction landed with an error (its fee was spent; it
 *     did nothing else);
 *   - `expired` — the chain's finalized block height (read BEFORE the status) is past
 *     `lastValidBlockHeight` and the status, history included, is absent. The
 *     blockhash can no longer be used, so the transaction can never land;
 *   - `pending` — the bounded wait ended with neither. Never evidence that it
 *     did not land: the caller keeps the signature and asks again later.
 *
 * `expired` is read from absence, and one absent read can be a lagging
 * load-balanced node. A caller that re-sends on it should see it twice, on
 * separate passes (the relay's anchor broadcasts do), and only where a mistaken
 * re-send costs one duplicate idempotent write (an anchor memo); a value-moving
 * send must not re-sign on it (the adapter's payment paths never do — #990).
 */

import type { Commitment, SignatureStatus } from "@solana/web3.js";

/** The two HTTP reads the poller needs. A web3.js `Connection` satisfies it. */
export interface SignatureStatusReader {
  getSignatureStatuses(
    signatures: string[],
    config?: { searchTransactionHistory?: boolean },
  ): Promise<{ value: (SignatureStatus | null)[] }>;
  getBlockHeight(commitment?: Commitment): Promise<number>;
}

/** A signed transaction to confirm: its signature and blockhash expiry height. */
export interface PolledSignatureRef {
  signature: string;
  lastValidBlockHeight: number;
}

export type PolledSignatureOutcome =
  | { status: "confirmed"; slot: number }
  | { status: "failed"; slot: number; err: unknown }
  | { status: "expired"; blockHeight: number }
  | { status: "pending"; seen: boolean; reason?: string };

export interface ConfirmByPollingOptions {
  /** Delay between polls. Default 1 s. */
  pollMs?: number;
  /** Total bound on the wait. Default 90 s (a blockhash lives ~60–90 s). */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_MAX_WAIT_MS = 90_000;

type Level = 0 | 1 | 2;

function requiredLevel(commitment: Commitment): Level {
  switch (commitment) {
    case "processed":
    case "recent":
      return 0;
    case "finalized":
    case "max":
    case "root":
      return 2;
    default:
      return 1;
  }
}

function statusLevel(s: SignatureStatus): Level {
  if (s.confirmationStatus === "finalized") return 2;
  if (s.confirmationStatus === "confirmed") return 1;
  // Released agave always sets confirmationStatus; an old node without it
  // counts as confirmed only when it reports confirmations === null (rooted).
  if (s.confirmationStatus === undefined && s.confirmations === null) return 2;
  return 0;
}

/**
 * Ask the chain ONCE what became of `ref`. Read-only; an RPC error is
 * `pending` with a reason (never a verdict).
 */
export async function checkSignatureOnce(
  conn: SignatureStatusReader,
  ref: PolledSignatureRef,
  commitment: Commitment,
): Promise<PolledSignatureOutcome> {
  try {
    // Height FIRST: if it is already past the expiry, a transaction that
    // landed did so before this read, so the status read below must see it.
    // Read at `finalized` whatever the requested commitment: the expiry
    // verdict needs the most conservative height (the lowest the cluster
    // agrees on), never an optimistic one.
    const blockHeight = await conn.getBlockHeight("finalized");
    const resp = await conn.getSignatureStatuses([ref.signature], {
      searchTransactionHistory: true,
    });
    const status = resp.value[0] ?? null;
    if (status != null) {
      if (status.err != null) {
        // A landed error is final once it is not a minority-fork view.
        if (statusLevel(status) >= Math.min(1, requiredLevel(commitment))) {
          return { status: "failed", slot: status.slot, err: status.err };
        }
        return { status: "pending", seen: true };
      }
      if (statusLevel(status) >= requiredLevel(commitment)) {
        return { status: "confirmed", slot: status.slot };
      }
      return { status: "pending", seen: true };
    }
    if (blockHeight > ref.lastValidBlockHeight) return { status: "expired", blockHeight };
    return { status: "pending", seen: false };
  } catch (err) {
    return {
      status: "pending",
      seen: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Poll `ref` until it is `confirmed`, `failed` or `expired`, or `maxWaitMs`
 * passes (then the last `pending`). Never throws.
 */
export async function confirmSignatureByPolling(
  conn: SignatureStatusReader,
  ref: PolledSignatureRef,
  commitment: Commitment,
  opts: ConfirmByPollingOptions = {},
): Promise<PolledSignatureOutcome> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + maxWaitMs;
  for (;;) {
    const outcome = await checkSignatureOnce(conn, ref, commitment);
    if (outcome.status !== "pending") return outcome;
    if (now() + pollMs > deadline) return outcome;
    await sleep(pollMs);
  }
}
