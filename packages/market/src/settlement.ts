import { PLATFORM_FEE_RATE } from "@motebit/sdk";
import type {
  BudgetAllocation,
  ExecutionReceipt,
  GoalExecutionManifest,
  SettlementId,
  SettlementRecord,
} from "@motebit/sdk";

/**
 * Integer-truncate for fee extraction from micro-units.
 * Uses Math.round so the platform fee is never off by more than ½ micro-unit.
 * Input and output are both integer micro-units.
 */
function microRound(n: number): number {
  return Math.round(n);
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
    if (completed < total && completed > 0) {
      gross = Math.round(allocation.amount_locked * (completed / total));
      status = "partial";
    }
  }

  const fee = microRound(gross * feeRate);
  const net = microRound(gross - fee);

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
