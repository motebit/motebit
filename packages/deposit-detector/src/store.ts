/**
 * In-memory test double for `DepositDetectorStore`.
 *
 * Production implementations (e.g. `SqliteDepositDetectorStore` in
 * `services/relay`) back the same interface with real persistence.
 */

import type { DepositDetectorStore, KnownWallet } from "./types.js";

export interface InMemoryDepositDetectorStoreOptions {
  /** Initial known wallets. */
  wallets?: readonly KnownWallet[];
  /** Initial cursors by chain. */
  cursors?: Readonly<Record<string, bigint>>;
}

export class InMemoryDepositDetectorStore implements DepositDetectorStore {
  private readonly wallets: KnownWallet[];
  private readonly cursors = new Map<string, bigint>();
  private readonly processedLogs = new Set<string>();

  constructor(options: InMemoryDepositDetectorStoreOptions = {}) {
    this.wallets = [...(options.wallets ?? [])];
    if (options.cursors) {
      for (const [chain, block] of Object.entries(options.cursors)) {
        this.cursors.set(chain, block);
      }
    }
  }

  getCursor(chain: string): bigint | null {
    return this.cursors.get(chain) ?? null;
  }

  setCursor(chain: string, block: bigint): void {
    this.cursors.set(chain, block);
  }

  getWallets(): KnownWallet[] {
    return [...this.wallets];
  }

  hasProcessedLog(txHash: string, logIndex: number): boolean {
    return this.processedLogs.has(`${txHash}:${logIndex}`);
  }

  /** Test helper — mark a log processed without going through the detector. */
  markProcessed(txHash: string, logIndex: number): void {
    this.processedLogs.add(`${txHash}:${logIndex}`);
  }
}
