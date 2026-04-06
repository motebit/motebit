import { PLATFORM_FEE_RATE } from "@motebit/protocol";
import type {
  BudgetAllocation,
  ExecutionReceipt,
  GoalExecutionManifest,
  SettlementId,
  SettlementRecord,
} from "@motebit/protocol";

// ---------------------------------------------------------------------------
// Allocation state machine — the canonical transitions for budget allocations.
// An allocation can only be claimed once. Settlement and refund are mutually
// exclusive terminal states. This prevents double-spend: if a late-arriving
// receipt settles an allocation, the retry refund path cannot also release it.
// ---------------------------------------------------------------------------

export type AllocationStatus = BudgetAllocation["status"];

/** Valid allocation status transitions. Every transition not listed here is illegal. */
const VALID_TRANSITIONS: ReadonlyMap<AllocationStatus, ReadonlySet<AllocationStatus>> = new Map([
  ["locked", new Set<AllocationStatus>(["settled", "released", "disputed"])],
  ["disputed", new Set<AllocationStatus>(["settled", "released"])],
  // settled and released are terminal — no outbound transitions
  ["settled", new Set<AllocationStatus>()],
  ["released", new Set<AllocationStatus>()],
]);

/**
 * Check whether an allocation status transition is valid.
 * Relays must call this before any status change to enforce the state machine.
 */
export function canTransitionAllocation(from: AllocationStatus, to: AllocationStatus): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed !== undefined && allowed.has(to);
}

/**
 * Assert that an allocation status transition is valid. Throws with a
 * descriptive message if the transition is illegal — use this in code paths
 * where an invalid transition is a programming error, not a user input issue.
 */
export function assertAllocationTransition(from: AllocationStatus, to: AllocationStatus): void {
  if (!canTransitionAllocation(from, to)) {
    throw new Error(
      `illegal allocation transition: ${from} → ${to}. ` +
        `Valid transitions from '${from}': [${[...(VALID_TRANSITIONS.get(from) ?? [])].join(", ") || "none (terminal)"}]`,
    );
  }
}

/**
 * Round to 6 decimal places (USDC precision). When the relay stores amounts
 * as integer micro-units (1 USD = 1,000,000), this is equivalent to rounding
 * to the nearest integer. When amounts are in dollars, it preserves sub-cent
 * precision for micropayments.
 */
function microRound(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Compute gross amount from a net unit cost and fee rate.
 * Inverse of settlement fee extraction: gross × (1 − feeRate) = net,
 * so gross = net / (1 − feeRate).
 *
 * Used when an agent advertises a net price and the relay needs to know
 * how much to lock (gross) so the agent receives the advertised amount
 * after the platform fee is deducted.
 */
export function computeGrossAmount(
  netUnitCost: number,
  feeRate: number = PLATFORM_FEE_RATE,
): number {
  if (feeRate < 0 || feeRate >= 1) {
    throw new Error(`feeRate must be in [0, 1), got ${feeRate}`);
  }
  return netUnitCost / (1 - feeRate);
}

/**
 * Validate allocation invariants before settlement begins.
 * Throws on negative amount or unsafe integer range.
 */
export function validateAllocation(allocation: BudgetAllocation): void {
  if (allocation.amount_locked < 0) {
    throw new Error("settlement invariant: negative allocation");
  }
  if (
    !Number.isSafeInteger(allocation.amount_locked) &&
    allocation.amount_locked > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("settlement invariant: allocation exceeds safe integer range");
  }
}

/**
 * Pure: allocation + verified receipt + ledger → SettlementRecord
 *
 * The relay extracts a platform fee (PLATFORM_FEE_RATE) from every
 * completed or partial settlement. Refunds pay zero fee.
 *
 * Completed receipt → full settlement minus fee
 * Failed/denied → refund (zero fee)
 * Partial (some steps failed in ledger) → proportional minus fee
 *
 * An optional feeRate override allows custom fee tiers (e.g. early adopter
 * discounts, enterprise rates). Defaults to PLATFORM_FEE_RATE (5%).
 */
export function settleOnReceipt(
  allocation: BudgetAllocation,
  receipt: ExecutionReceipt,
  ledger: GoalExecutionManifest | null,
  settlementId: SettlementId,
  feeRate: number = PLATFORM_FEE_RATE,
): SettlementRecord {
  if (feeRate < 0 || feeRate > 1) {
    throw new Error(`feeRate must be in [0, 1], got ${feeRate}`);
  }

  validateAllocation(allocation);

  const receiptHash = receipt.result_hash ?? "";

  if (receipt.status === "failed" || receipt.status === "denied") {
    return {
      settlement_id: settlementId,
      allocation_id: allocation.allocation_id,
      receipt_hash: receiptHash,
      ledger_hash: ledger?.content_hash ?? null,
      amount_settled: 0,
      platform_fee: 0,
      platform_fee_rate: feeRate,
      status: "refunded",
      settled_at: Date.now(),
    };
  }

  // Compute gross amount (before fee)
  let gross = allocation.amount_locked;

  // Check for partial completion via ledger
  let status: SettlementRecord["status"] = "completed";
  if (ledger && ledger.steps.length > 0) {
    const total = ledger.steps.length;
    const completed = ledger.steps.filter((s) => s.status === "completed").length;

    if (completed > total) {
      throw new Error("settlement invariant: completed steps exceed total");
    }

    if (completed < total && completed > 0) {
      // Guard against integer overflow in the multiplication
      const product = allocation.amount_locked * completed;
      if (!Number.isSafeInteger(product) && product > Number.MAX_SAFE_INTEGER) {
        throw new Error(
          "settlement invariant: amount_locked * completed overflows safe integer range",
        );
      }
      gross = microRound(allocation.amount_locked * (completed / total));
      status = "partial";
    }
  } else if (ledger && ledger.steps.length === 0) {
    // Zero steps with a ledger present — not partial, treated as full settlement.
    // The partial path must never execute with total === 0 (division by zero).
  }

  const fee = microRound(gross * feeRate);
  // Derive net from gross − fee, then round to micro-unit precision.
  // Both operands are already at micro-unit precision, but IEEE 754 subtraction
  // can introduce noise (e.g. 9.99 - 0.70 = 9.289999...98). microRound cleans it.
  const net = microRound(gross - fee);

  if (net < 0) {
    throw new Error("settlement invariant: net amount after fee is negative");
  }

  return {
    settlement_id: settlementId,
    allocation_id: allocation.allocation_id,
    receipt_hash: receiptHash,
    ledger_hash: ledger?.content_hash ?? null,
    amount_settled: net,
    platform_fee: fee,
    platform_fee_rate: feeRate,
    status,
    settled_at: Date.now(),
  };
}
