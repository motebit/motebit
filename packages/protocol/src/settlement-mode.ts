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

// === Solvency Proof ===

/**
 * Relay-signed attestation of an agent's available balance.
 *
 * Workers verify this before starting expensive p2p tasks where
 * the relay doesn't escrow. Short TTL (5 minutes) prevents stale attestations.
 *
 * Verification: strip `signature`, canonicalJson the rest, Ed25519 verify
 * against the relay's public key (from /.well-known/motebit.json).
 */
export interface SolvencyProof {
  /** The agent whose balance is attested. */
  motebit_id: string;
  /** Available balance in micro-units (after dispute holds). */
  balance_available: number;
  /** The amount the requester asked about. */
  amount_requested: number;
  /** Whether balance_available >= amount_requested. */
  sufficient: boolean;
  /** Relay that issued this proof. */
  relay_id: string;
  /** When the proof was generated (ms since epoch). */
  attested_at: number;
  /** When the proof expires (ms since epoch). attested_at + 300_000. */
  expires_at: number;
  /** Ed25519 signature over canonical JSON of all other fields. */
  signature: string;
}

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
