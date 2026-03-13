import type {
  BudgetAllocation,
  ExecutionReceipt,
  GoalExecutionManifest,
  SettlementId,
  SettlementRecord,
} from "@motebit/sdk";

export interface SettlementAdapter {
  lock(allocation: BudgetAllocation): Promise<boolean>;
  release(settlementId: string, amount: number): Promise<void>;
  refund(allocationId: string): Promise<void>;
}

/**
 * Pure: allocation + verified receipt + ledger → SettlementRecord
 * Completed receipt → full settlement
 * Failed/denied → refund
 * Partial (some steps failed in ledger) → proportional
 */
export function settleOnReceipt(
  allocation: BudgetAllocation,
  receipt: ExecutionReceipt,
  ledger: GoalExecutionManifest | null,
  settlementId: SettlementId,
): SettlementRecord {
  const receiptHash = receipt.result_hash ?? "";

  if (receipt.status === "failed" || receipt.status === "denied") {
    return {
      settlement_id: settlementId,
      allocation_id: allocation.allocation_id,
      receipt_hash: receiptHash,
      ledger_hash: ledger?.content_hash ?? null,
      amount_settled: 0,
      status: "refunded",
      settled_at: Date.now(),
    };
  }

  // Check for partial completion via ledger
  if (ledger && ledger.steps.length > 0) {
    const total = ledger.steps.length;
    const completed = ledger.steps.filter((s) => s.status === "completed").length;
    if (completed < total && completed > 0) {
      const proportion = completed / total;
      return {
        settlement_id: settlementId,
        allocation_id: allocation.allocation_id,
        receipt_hash: receiptHash,
        ledger_hash: ledger.content_hash,
        amount_settled: Math.round(allocation.amount_locked * proportion * 100) / 100,
        status: "partial",
        settled_at: Date.now(),
      };
    }
  }

  // Full settlement
  return {
    settlement_id: settlementId,
    allocation_id: allocation.allocation_id,
    receipt_hash: receiptHash,
    ledger_hash: ledger?.content_hash ?? null,
    amount_settled: allocation.amount_locked,
    status: "completed",
    settled_at: Date.now(),
  };
}

/** In-memory settlement adapter for testing and local development */
export class InMemorySettlementAdapter implements SettlementAdapter {
  private locks = new Map<string, { amount: number; released: boolean }>();

  async lock(allocation: BudgetAllocation): Promise<boolean> {
    if (this.locks.has(allocation.allocation_id)) return false;
    this.locks.set(allocation.allocation_id, {
      amount: allocation.amount_locked,
      released: false,
    });
    return true;
  }

  async release(_settlementId: string, _amount: number): Promise<void> {
    for (const [, lock] of this.locks) {
      if (!lock.released) {
        lock.released = true;
        return;
      }
    }
  }

  async refund(allocationId: string): Promise<void> {
    this.locks.delete(allocationId);
  }

  /** Test helper: check if an allocation is locked */
  isLocked(allocationId: string): boolean {
    const lock = this.locks.get(allocationId);
    return lock != null && !lock.released;
  }

  /** Test helper: get lock count */
  get size(): number {
    return this.locks.size;
  }
}
