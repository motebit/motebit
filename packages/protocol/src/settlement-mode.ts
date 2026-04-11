/**
 * Settlement mode types — relay-mediated vs peer-to-peer settlement.
 *
 * MIT: these types define the interoperable format for settlement mode
 * selection and payment proof verification.
 */

// === Settlement Mode ===

/** How money moves for a task: through the relay's virtual accounts, or directly onchain. */
export type SettlementMode = "relay" | "p2p";

// === P2P Payment Proof ===

/**
 * Proof of direct onchain payment from delegator to worker.
 * Submitted by the delegator at task submission time.
 */
export interface P2pPaymentProof {
  /** Onchain transaction signature (Solana base58, 87-88 chars). */
  tx_hash: string;
  /** Chain identifier (e.g., "solana"). */
  chain: string;
  /** CAIP-2 network identifier. */
  network: string;
  /** Worker's declared settlement address (base58 for Solana). */
  to_address: string;
  /** Exact payment amount in micro-units (USDC 6 decimals). Must match expected amount. */
  amount_micro: number;
}

// === Payment Verification ===

/** Verification status of an onchain payment proof. */
export type PaymentVerificationStatus = "pending" | "verified" | "failed";

// === Settlement Eligibility ===

/**
 * Result of policy-based settlement mode evaluation.
 *
 * The eligibility check considers: mutual opt-in, trust level,
 * interaction history, active disputes, and declared settlement capabilities.
 */
export interface SettlementEligibility {
  /** Whether p2p settlement is allowed for this pair + task. */
  allowed: boolean;
  /** Selected settlement mode. */
  mode: SettlementMode;
  /** Human-readable reason for the decision. */
  reason: string;
}
