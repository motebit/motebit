/**
 * BridgeSettlementRail — Bridge.xyz orchestration as a GuestRail.
 *
 * Wraps Bridge's transfer API behind the GuestRail interface.
 * Bridge is fiat↔crypto bridging — the first orchestration rail type.
 *
 * Transfer lifecycle (13 states, 4 on happy path):
 *   awaiting_funds → funds_received → payment_submitted → payment_processed
 *
 * Two withdrawal paths:
 * - Instant (crypto→crypto with prefunded Bridge wallet): withdraw() polls
 *   briefly for payment_processed, returns confirmed WithdrawalResult.
 * - Async (crypto→fiat): withdraw() creates transfer, returns pending
 *   WithdrawalResult with Bridge transfer ID as reference and confirmedAt: 0.
 *   Completion happens via webhook (same pattern as Stripe pending withdrawals).
 *
 * Metabolic principle: absorbs Bridge's REST API through a thin BridgeClient
 * interface. Does not reimplement the transfer state machine.
 */

import type { GuestRail, PaymentProof, WithdrawalResult } from "@motebit/sdk";
import { createLogger } from "../logger.js";

const logger = createLogger({ service: "bridge-rail" });

/** Terminal states where no further progress is possible. */
const TERMINAL_STATES = new Set([
  "payment_processed",
  "canceled",
  "refunded",
  "refund_failed",
  "error",
]);

/** Success state. */
const COMPLETED_STATE = "payment_processed";

/**
 * Minimal Bridge client interface.
 * The real Bridge REST client satisfies this. Tests inject a mock.
 * The rail absorbs the API — does not reimplement it.
 */
export interface BridgeClient {
  /**
   * Create a transfer.
   * Maps to POST /transfers on Bridge's API.
   */
  createTransfer(params: {
    onBehalfOf: string;
    amount: string;
    sourceCurrency: string;
    sourcePaymentRail: string;
    destinationCurrency: string;
    destinationPaymentRail: string;
    destinationAddress?: string;
    externalAccountId?: string;
    idempotencyKey: string;
  }): Promise<BridgeTransfer>;

  /**
   * Get transfer status by ID.
   * Maps to GET /transfers/{transferID}.
   */
  getTransfer(transferId: string): Promise<BridgeTransfer>;

  /**
   * Health check — verifies API key is valid and API is reachable.
   */
  isReachable(): Promise<boolean>;
}

/** Bridge transfer object (subset of fields we need). */
export interface BridgeTransfer {
  id: string;
  state: string;
  amount: string;
  receipt?: {
    sourceTxHash?: string;
    destinationTxHash?: string;
  };
  source?: {
    paymentRail: string;
  };
  destination?: {
    paymentRail: string;
  };
}

export interface BridgeRailConfig {
  /** Bridge API client instance. */
  bridgeClient: BridgeClient;
  /** Bridge customer ID for the relay operator. */
  customerId: string;
  /** Source payment rail for withdrawals (e.g., "base", "solana", "bridge_wallet"). */
  sourcePaymentRail: string;
  /** Source currency for withdrawals (e.g., "usdc"). */
  sourceCurrency: string;
  /** Max poll attempts for instant settlement path. Default: 10. */
  maxPollAttempts?: number;
  /** Poll interval in ms. Default: 2000. */
  pollIntervalMs?: number;
  /** Callback to persist proof. Injected by relay — the rail does not own storage. */
  onProofAttached?: (settlementId: string, proof: PaymentProof) => void;
}

export class BridgeSettlementRail implements GuestRail {
  readonly custody = "relay" as const;
  readonly railType = "orchestration" as const;
  readonly name = "bridge";
  readonly supportsDeposit = false as const;
  readonly supportsBatch = false as const;

  private readonly client: BridgeClient;
  private readonly customerId: string;
  private readonly sourcePaymentRail: string;
  private readonly sourceCurrency: string;
  private readonly maxPollAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly onProofAttached?: (settlementId: string, proof: PaymentProof) => void;

  constructor(config: BridgeRailConfig) {
    this.client = config.bridgeClient;
    this.customerId = config.customerId;
    this.sourcePaymentRail = config.sourcePaymentRail;
    this.sourceCurrency = config.sourceCurrency;
    this.maxPollAttempts = config.maxPollAttempts ?? 10;
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
    this.onProofAttached = config.onProofAttached;
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await this.client.isReachable();
    } catch {
      return false;
    }
  }

  /**
   * Create a Bridge transfer for withdrawal.
   *
   * For crypto→crypto with prefunded wallet: polls briefly for completion.
   * For crypto→fiat or slow paths: returns pending result immediately.
   * Completion via webhook — same pattern as Stripe pending withdrawals.
   */
  async withdraw(
    motebitId: string,
    amount: number,
    currency: string,
    destination: string,
    idempotencyKey: string,
  ): Promise<WithdrawalResult> {
    if (amount <= 0) {
      throw new Error("Withdrawal amount must be positive");
    }
    if (!destination) {
      throw new Error("Destination is required for Bridge withdrawal");
    }

    // Determine destination rail from the destination format.
    // Wallet addresses (0x...) → crypto rail matching source.
    // Everything else → external account (fiat).
    const isCryptoDestination = /^0x[0-9a-fA-F]{40}$/.test(destination);

    const transfer = await this.client.createTransfer({
      onBehalfOf: this.customerId,
      amount: amount.toFixed(6),
      sourceCurrency: this.sourceCurrency,
      sourcePaymentRail: this.sourcePaymentRail,
      destinationCurrency: isCryptoDestination ? this.sourceCurrency : currency.toLowerCase(),
      destinationPaymentRail: isCryptoDestination ? this.sourcePaymentRail : "wire",
      destinationAddress: isCryptoDestination ? destination : undefined,
      externalAccountId: isCryptoDestination ? undefined : destination,
      idempotencyKey,
    });

    logger.info("bridge.transfer.created", {
      motebitId,
      transferId: transfer.id,
      state: transfer.state,
      amount,
      destination,
    });

    // For crypto→crypto: try polling for fast completion
    if (isCryptoDestination) {
      const completed = await this.pollForCompletion(transfer.id);
      if (completed) {
        const txHash = completed.receipt?.destinationTxHash ?? completed.id;
        const network = completed.destination?.paymentRail ?? this.sourcePaymentRail;

        logger.info("bridge.transfer.completed", {
          motebitId,
          transferId: completed.id,
          txHash,
          network,
        });

        return {
          amount,
          currency,
          proof: {
            reference: txHash,
            railType: "orchestration",
            network,
            confirmedAt: Date.now(),
          },
        };
      }
    }

    // Async path: return pending result. Completion via webhook.
    return {
      amount,
      currency,
      proof: {
        reference: `bridge:${transfer.id}`,
        railType: "orchestration",
        network: transfer.destination?.paymentRail,
        confirmedAt: 0, // Not confirmed yet — webhook completes
      },
    };
  }

  /**
   * Poll for transfer completion. Returns the completed transfer,
   * or null if it hasn't completed within the poll window.
   */
  private async pollForCompletion(transferId: string): Promise<BridgeTransfer | null> {
    for (let i = 0; i < this.maxPollAttempts; i++) {
      const transfer = await this.client.getTransfer(transferId);

      if (transfer.state === COMPLETED_STATE) {
        return transfer;
      }
      if (TERMINAL_STATES.has(transfer.state) && transfer.state !== COMPLETED_STATE) {
        throw new Error(`Bridge transfer ${transferId} failed: ${transfer.state}`);
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    // Not completed within poll window — falls back to async/webhook path
    return null;
  }

  attachProof(settlementId: string, proof: PaymentProof): Promise<void> {
    logger.info("bridge.proof.attached", {
      settlementId,
      reference: proof.reference,
      network: proof.network,
      railType: proof.railType,
    });
    this.onProofAttached?.(settlementId, proof);
    return Promise.resolve();
  }
}
