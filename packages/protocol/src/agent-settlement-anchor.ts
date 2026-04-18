/**
 * Per-agent settlement anchor types — motebit/agent-settlement-anchor@1.0.
 *
 * MIT: these types define the interoperable format for per-agent settlement
 * anchoring (the "ceiling" alongside the SettlementRecord signing "floor"
 * in delegation-v1.md §6.4 and settlement-v1.md §3).
 *
 * Audience-distinct from federation settlement anchoring (relay-federation-v1.md
 * §7.6, peer audit between relays) and credential anchoring (credential-anchor-v1.md,
 * agent reputation portability). Same Merkle primitive, different proof endpoint
 * and source table — see spec/agent-settlement-anchor-v1.md §9.
 *
 * Any implementation can produce and verify per-agent settlement anchor proofs
 * using these types and the shared Merkle library.
 */

// === Agent Settlement Anchor Batch ===

/**
 * A batch of per-agent settlement leaf hashes anchored as a Merkle tree.
 *
 * Each leaf commits the WHOLE signed `SettlementRecord` (including the
 * relay's signature), so reconstruction at verification time requires only
 * the bytes the worker already holds.
 */
export interface AgentSettlementAnchorBatch {
  /** UUID v4 batch identifier. */
  batch_id: string;
  /** MotebitId of the relay that created this batch. */
  relay_id: string;
  /** Hex-encoded SHA-256 Merkle root. */
  merkle_root: string;
  /** Number of settlements in this batch. */
  leaf_count: number;
  /** Millisecond timestamp of the earliest settlement in the batch. */
  first_settled_at: number;
  /** Millisecond timestamp of the latest settlement in the batch. */
  last_settled_at: number;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-hex-v1"` —
   * JCS canonicalization of the unsigned batch payload, Ed25519
   * primitive, hex signature encoding, hex public-key encoding.
   * Verifiers reject missing or unknown suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-hex-v1";
  /** Hex-encoded Ed25519 signature over the canonical batch payload. */
  signature: string;
  /** Onchain anchor metadata, or null if signed but not yet submitted. */
  anchor: AgentSettlementChainAnchor | null;
}

/** Onchain anchor reference — chain-agnostic. */
export interface AgentSettlementChainAnchor {
  /** Chain identifier (e.g., "eip155"). */
  chain: string;
  /** CAIP-2 network identifier (e.g., "eip155:8453" for Base). */
  network: string;
  /** Transaction hash on the target chain. */
  tx_hash: string;
  /** Millisecond timestamp when the anchor was confirmed. */
  anchored_at: number;
}

// === Agent Settlement Anchor Proof ===

/** Self-verifiable Merkle inclusion proof for a per-agent settlement in an anchored batch. */
export interface AgentSettlementAnchorProof {
  /** Settlement identifier. */
  settlement_id: string;
  /**
   * Hex-encoded SHA-256 hash of the canonical signed `SettlementRecord`
   * (the worker's bytes-on-the-wire form, signature included). See
   * spec/agent-settlement-anchor-v1.md §3.
   */
  settlement_hash: string;
  /** Batch containing this settlement. */
  batch_id: string;
  /** Hex-encoded Merkle root of the batch. */
  merkle_root: string;
  /** Number of settlements in this batch (needed for batch signature verification). */
  leaf_count: number;
  /** Millisecond timestamp of the earliest settlement in the batch. */
  first_settled_at: number;
  /** Millisecond timestamp of the latest settlement in the batch. */
  last_settled_at: number;
  /** Position of this settlement's leaf in the sorted array. */
  leaf_index: number;
  /** Hex-encoded sibling hashes for Merkle path verification. */
  siblings: string[];
  /** Layer sizes for odd-leaf promotion detection. */
  layer_sizes: number[];
  /** MotebitId of the relay that created the batch. */
  relay_id: string;
  /** Hex-encoded Ed25519 public key of the relay (for batch_signature verification). */
  relay_public_key: string;
  /**
   * Cryptosuite discriminator for `batch_signature`. Always
   * `"motebit-jcs-ed25519-hex-v1"` — JCS canonicalization of the batch
   * payload, Ed25519 primitive, hex signature encoding, hex public-key
   * encoding. Verifiers reject missing or unknown suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-hex-v1";
  /** Hex-encoded Ed25519 signature over the canonical batch payload. */
  batch_signature: string;
  /** Onchain anchor metadata, or null if not yet submitted. */
  anchor: AgentSettlementChainAnchor | null;
}
