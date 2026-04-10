/**
 * Credential anchor types — motebit/credential-anchor@1.0.
 *
 * MIT: these types define the interoperable format for credential anchoring.
 * Any implementation can produce and verify anchor proofs using these types.
 */

// === Credential Anchor Batch ===

/** A batch of credential hashes anchored as a Merkle tree. */
export interface CredentialAnchorBatch {
  /** UUID v4 batch identifier. */
  batch_id: string;
  /** MotebitId of the relay that created this batch. */
  relay_id: string;
  /** Hex-encoded SHA-256 Merkle root. */
  merkle_root: string;
  /** Number of credentials in this batch. */
  leaf_count: number;
  /** Millisecond timestamp of the earliest credential in the batch. */
  first_issued_at: number;
  /** Millisecond timestamp of the latest credential in the batch. */
  last_issued_at: number;
  /** Hex-encoded Ed25519 signature over the canonical batch payload. */
  signature: string;
  /** Onchain anchor metadata, or null if signed but not yet submitted. */
  anchor: CredentialChainAnchor | null;
}

/** Onchain anchor reference — chain-agnostic. */
export interface CredentialChainAnchor {
  /** Chain identifier (e.g., "solana"). */
  chain: string;
  /** CAIP-2 network identifier (e.g., "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"). */
  network: string;
  /** Transaction hash on the target chain. */
  tx_hash: string;
  /** Millisecond timestamp when the anchor was confirmed. */
  anchored_at: number;
}

// === Credential Anchor Proof ===

/** Self-verifiable Merkle inclusion proof for a credential in an anchored batch. */
export interface CredentialAnchorProof {
  /** Credential identifier. */
  credential_id: string;
  /** Hex-encoded SHA-256 hash of the full credential (including proof). */
  credential_hash: string;
  /** Batch containing this credential. */
  batch_id: string;
  /** Hex-encoded Merkle root of the batch. */
  merkle_root: string;
  /** Position of this credential's leaf in the sorted array. */
  leaf_index: number;
  /** Hex-encoded sibling hashes for Merkle path verification. */
  siblings: string[];
  /** Layer sizes for odd-leaf promotion detection. */
  layer_sizes: number[];
  /** MotebitId of the relay that created the batch. */
  relay_id: string;
  /** Hex-encoded Ed25519 public key of the relay (for signature verification). */
  relay_public_key: string;
  /** Hex-encoded Ed25519 signature over the canonical batch payload. */
  batch_signature: string;
  /** Onchain anchor metadata, or null if not yet submitted. */
  anchor: CredentialChainAnchor | null;
}

// === Anchor Submitter Interface ===

/**
 * Chain-agnostic interface for submitting Merkle roots onchain.
 *
 * The relay defines what it needs (publish a root). Implementations
 * satisfy it for specific chains (Solana Memo, EVM calldata, etc.).
 */
export interface ChainAnchorSubmitter {
  /** Chain identifier (e.g., "solana", "eip155"). */
  readonly chain: string;
  /** CAIP-2 network identifier. */
  readonly network: string;
  /** Submit a Merkle root onchain. Returns the transaction hash. */
  submitMerkleRoot(root: string, relayId: string, leafCount: number): Promise<{ txHash: string }>;
  /** Whether the submitter is currently available (chain reachable, funded). */
  isAvailable(): Promise<boolean>;
}
