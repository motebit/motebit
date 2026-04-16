/**
 * X402SettlementRail — x402 protocol as a GuestRail.
 *
 * Wraps the x402 facilitator behind the GuestRail interface.
 * x402 is pay-per-request: deposits are not interactive flows — they happen
 * at the HTTP boundary via x402 middleware. The rail records completed payments
 * and can initiate withdrawals (stablecoin transfers).
 *
 * Metabolic principle: absorbs the x402 facilitator as nutrient via a thin
 * client interface. Does not reimplement the protocol.
 */

import type { GuestRail, PaymentProof, WithdrawalResult } from "@motebit/sdk";
import { createLogger } from "../logger.js";

const logger = createLogger({ service: "x402-rail" });

/**
 * Minimal facilitator client interface.
 * The real HTTPFacilitatorClient from @x402/core satisfies this.
 * Tests inject a mock. The rail absorbs the SDK — does not reimplement it.
 */
export interface X402FacilitatorClient {
  readonly url: string;
  getSupported(): Promise<{ kinds: unknown[] }>;
  settle(
    paymentPayload: unknown,
    paymentRequirements: unknown,
  ): Promise<{
    success: boolean;
    transaction: string;
    network: string;
    errorReason?: string;
    payer?: string;
  }>;
}

export interface X402RailConfig {
  /** x402 facilitator client instance. */
  facilitatorClient: X402FacilitatorClient;
  /** CAIP-2 network identifier (e.g., "eip155:8453" for Base mainnet). */
  network: string;
  /** Relay operator's wallet address — receives platform fees. */
  payToAddress: string;
  /** Callback to persist proof. Injected by relay — the rail does not own storage. */
  onProofAttached?: (settlementId: string, proof: PaymentProof) => void;
}

export class X402SettlementRail implements GuestRail {
  readonly custody = "relay" as const;
  readonly railType = "protocol" as const;
  readonly name = "x402";
  readonly supportsDeposit = false as const;
  readonly supportsBatch = false as const;

  private readonly facilitator: X402FacilitatorClient;
  readonly network: string;
  readonly payToAddress: string;
  private readonly onProofAttached?: (settlementId: string, proof: PaymentProof) => void;

  constructor(config: X402RailConfig) {
    this.facilitator = config.facilitatorClient;
    this.network = config.network;
    this.payToAddress = config.payToAddress;
    this.onProofAttached = config.onProofAttached;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const supported = await this.facilitator.getSupported();
      return Array.isArray(supported.kinds) && supported.kinds.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Initiate a stablecoin withdrawal to a destination address.
   * Constructs a payment payload and settles via the x402 facilitator.
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
      throw new Error("Destination address is required for x402 withdrawal");
    }

    // Construct x402 payment payload for facilitator settlement.
    // The facilitator handles the onchain transfer.
    const paymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: this.network,
      payload: {
        signature: idempotencyKey,
        authorization: {
          from: this.payToAddress,
          to: destination,
          value: String(Math.round(amount * 1_000_000)), // USDC 6 decimals
          validAfter: 0,
          validBefore: Math.floor(Date.now() / 1000) + 3600,
          nonce: idempotencyKey,
        },
      },
    };

    const paymentRequirements = {
      scheme: "exact",
      network: this.network,
      maxAmountRequired: String(Math.round(amount * 1_000_000)),
      payTo: destination,
      asset: currency.toUpperCase() === "USDC" ? "USDC" : currency,
      maxTimeoutSeconds: 60,
      extra: {},
    };

    const result = await this.facilitator.settle(paymentPayload, paymentRequirements);

    if (!result.success) {
      throw new Error(`x402 withdrawal failed: ${result.errorReason ?? "unknown error"}`);
    }

    logger.info("x402.withdrawal.settled", {
      motebitId,
      amount,
      destination,
      txHash: result.transaction,
      network: result.network,
    });

    return {
      amount,
      currency,
      proof: {
        reference: result.transaction,
        railType: "protocol",
        network: result.network,
        confirmedAt: Date.now(),
      },
    };
  }

  /**
   * Attach an x402 payment proof (tx hash + CAIP-2 network) to a settlement record.
   * Called after x402 middleware captures the onAfterSettle hook data.
   */
  attachProof(settlementId: string, proof: PaymentProof): Promise<void> {
    logger.info("x402.proof.attached", {
      settlementId,
      reference: proof.reference,
      network: proof.network,
      railType: proof.railType,
    });
    this.onProofAttached?.(settlementId, proof);
    return Promise.resolve();
  }
}
