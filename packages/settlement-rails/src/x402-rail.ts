/**
 * X402SettlementRail — x402 protocol as a GuestRail.
 *
 * Wraps the x402 facilitator behind the GuestRail interface.
 * x402 is pay-per-request: deposits are not interactive flows — they happen
 * at the HTTP boundary via x402 middleware. The rail records completed
 * payments (proof attachment) and reports whether the facilitator is up.
 *
 * **It does not withdraw (#948).** An x402 payout is an EIP-3009
 * `transferWithAuthorization` the PAYER signs — here the relay treasury —
 * which the facilitator then submits. The relay holds no key for its EVM
 * treasury (`payToAddress` is an address only; treasury-custody doctrine
 * keeps that key off the relay), so it cannot sign one. The withdraw this
 * rail used to carry put the withdrawal's idempotency key in the
 * `signature` field; no facilitator can execute that, so every relay Path 1
 * payout either failed or was left for an operator. A withdrawal method that
 * cannot work must not be advertised (paid-failure-recourse's companion
 * law), so the method is removed at the type level, exactly like Bridge's:
 * `supportsWithdraw` is false, `withdraw` does not exist, and
 * `isWithdrawableRail(x402Rail)` is false — no relay path and no batch
 * fire can hand this rail a payout. The relay refuses 0x withdrawal
 * destinations before any debit. Re-adding a withdraw requires a real
 * EIP-3009 signature by a treasury key whose custody the treasury-custody
 * doctrine has decided.
 *
 * Metabolic principle: absorbs the x402 facilitator as nutrient via a thin
 * client interface. Does not reimplement the protocol.
 */

import type { GuestRail, PaymentProof } from "@motebit/sdk";
import { type RailLogger, NOOP_LOGGER } from "./logger.js";

/**
 * Minimal facilitator client interface.
 * The real HTTPFacilitatorClient from @x402/core satisfies this.
 * Tests inject a mock. The rail absorbs the SDK — does not reimplement it.
 * (`settle` is the facilitator's own surface; this rail never calls it —
 * the relay's x402 gate settles a payer's authorization, #907.)
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
  /** Structured logger. Default is silent — relay injects one carrying correlation id. */
  logger?: RailLogger;
}

export class X402SettlementRail implements GuestRail {
  readonly custody = "relay" as const;
  readonly railType = "protocol" as const;
  readonly name = "x402";
  readonly supportsDeposit = false as const;
  /** No withdraw (#948): the relay cannot sign an EIP-3009 authorization. */
  readonly supportsWithdraw = false as const;
  readonly supportsBatch = false as const;

  private readonly facilitator: X402FacilitatorClient;
  readonly network: string;
  readonly payToAddress: string;
  private readonly onProofAttached?: (settlementId: string, proof: PaymentProof) => void;
  private readonly logger: RailLogger;

  constructor(config: X402RailConfig) {
    this.facilitator = config.facilitatorClient;
    this.network = config.network;
    this.payToAddress = config.payToAddress;
    this.onProofAttached = config.onProofAttached;
    this.logger = config.logger ?? NOOP_LOGGER;
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
   * Attach an x402 payment proof (tx hash + CAIP-2 network) to a settlement record.
   * Called by the relay's task-submission handler after it settles that
   * request's own verified x402 payment (#907).
   */
  attachProof(settlementId: string, proof: PaymentProof): Promise<void> {
    this.logger.info("x402.proof.attached", {
      settlementId,
      reference: proof.reference,
      network: proof.network,
      railType: proof.railType,
    });
    this.onProofAttached?.(settlementId, proof);
    return Promise.resolve();
  }
}
