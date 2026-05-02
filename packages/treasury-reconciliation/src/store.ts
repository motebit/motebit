/**
 * In-memory implementation of {@link TreasuryReconciliationStore} for tests.
 * Production consumers (services/relay) provide a SQLite-backed store that
 * queries `relay_settlements.platform_fee` and persists into
 * `relay_treasury_reconciliations`.
 */

import type { ReconciliationResult, TreasuryReconciliationStore } from "./types.js";

export interface InMemoryTreasuryReconciliationStoreOptions {
  /**
   * Pre-seeded fee sum per chain, optionally with `settled_at` timestamps so
   * tests can exercise the confirmation-lag exclusion. Each entry contributes
   * its `feeMicro` to the sum returned by `getRecordedFeeSumMicro(chain, asOfMs)`
   * iff the entry's chain matches AND `settledAtMs <= asOfMs`.
   */
  seededSettlements?: Array<{ chain: string; feeMicro: bigint; settledAtMs: number }>;
}

export class InMemoryTreasuryReconciliationStore implements TreasuryReconciliationStore {
  private readonly settlements: Array<{
    chain: string;
    feeMicro: bigint;
    settledAtMs: number;
  }>;
  private readonly persistedRecords: ReconciliationResult[] = [];

  constructor(opts: InMemoryTreasuryReconciliationStoreOptions = {}) {
    this.settlements = [...(opts.seededSettlements ?? [])];
  }

  getRecordedFeeSumMicro(chain: string, asOfMs: number): bigint {
    let sum = 0n;
    for (const s of this.settlements) {
      if (s.chain !== chain) continue;
      if (s.settledAtMs > asOfMs) continue; // confirmation-lag exclusion
      sum += s.feeMicro;
    }
    return sum;
  }

  persistReconciliation(result: ReconciliationResult): void {
    this.persistedRecords.push(result);
  }

  /** Test-only: snapshot of persisted records. */
  getPersistedRecords(): readonly ReconciliationResult[] {
    return this.persistedRecords;
  }
}
