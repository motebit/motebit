import type { AccountStore } from "./store.js";

/**
 * How much of an account may be SPENT, right now: `balance − escrow hold`,
 * floored at zero.
 *
 * The spend-side sibling of `computeWithdrawableAvailable`, and the same
 * number `AccountStore.debitSpendable` enforces (`balance >= amount + hold`).
 * Every decision that is followed by a `debitSpendable` — "can this delegator
 * fund this task?", "how much should the hold lock?", "should the x402 gate be
 * skipped because the account can pay?" — reads it here, so the check and the
 * debit cannot disagree.
 *
 * The drift this closes (#901): task submission's x402 path checked the RAW
 * balance while the debit netted the escrow hold, so `raw ≥ price > spendable`
 * booked a locked allocation, and admitted the task, with no debit behind it.
 *
 * The grant hold is deliberately absent: promotional credit is spendable
 * (it is withdrawal-only), exactly as in `debitSpendable`.
 *
 * Never creates an account — a read for an unknown id is 0.
 */
export function computeSpendableAvailable(store: AccountStore, motebitId: string): number {
  const balance = store.getAccount(motebitId)?.balance ?? 0;
  const escrowHold = store.getUnwithdrawableHold(motebitId);
  return Math.max(0, balance - escrowHold);
}
