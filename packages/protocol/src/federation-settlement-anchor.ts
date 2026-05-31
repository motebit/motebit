/**
 * Federation settlement anchor types — motebit/relay-federation@1.2 §7.6.
 *
 * Permissive floor (Apache-2.0): these types define the interoperable format
 * for inter-relay settlement anchoring — peer audit between federated relays.
 *
 * Audience-distinct from per-agent settlement anchoring (agent-settlement-anchor-v1.md,
 * worker audit of relay-as-counterparty) and credential anchoring
 * (credential-anchor-v1.md, agent reputation portability). Same Merkle
 * primitive, different proof endpoint and source table — see
 * spec/agent-settlement-anchor-v1.md §9.
 *
 * Convergence (spec/agent-settlement-anchor-v1.md §9.1, the arc-closer): the
 * federation leaf is now `canonicalLeaf(the WHOLE signed FederationSettlementRecord)`
 * — the verbatim-artifact hash the per-agent and credential streams already
 * use — never a hand-typed column projection. The relay signs a canonical
 * record of each settlement it books, persists it verbatim, and anchors the
 * exact bytes; a peer who holds that signed record reproduces the leaf with
 * `@motebit/crypto` alone (`verifyFederationSettlementAnchor`).
 */

import type { MerkleTreeVersion } from "./merkle-tree-hash.js";

// === Federation Settlement Record (the signed leaf artifact) ===

/**
 * A relay's signed record of one federation settlement it booked — the exact
 * artifact whose canonical bytes become the Merkle leaf (the "verbatim-leaf"
 * shape per spec/agent-settlement-anchor-v1.md §9.1). Each relay signs and
 * anchors its OWN copy of a settlement (the issuer is whichever relay booked
 * the row), so the leaf reproduces from the bytes a peer holds — no
 * re-projection of a sibling's database.
 *
 * The signing "floor" mirrors the per-agent `SettlementRecord` (settlement-v1.md
 * §3): the issuing relay commits to the (gross, fee, net, rate) tuple, so it
 * cannot issue inconsistent records to different observers. The Merkle anchor
 * (relay-federation-v1.md §7.6) is the "ceiling" on top.
 */
export interface FederationSettlementRecord {
  /** UUID settlement identifier (unique per booking relay). */
  settlement_id: string;
  /** Task this settlement pays for. */
  task_id: string;
  /** MotebitId of the upstream (origin) relay in the federation hop. */
  upstream_relay_id: string;
  /** MotebitId of the downstream relay, or null when this relay is the origin. */
  downstream_relay_id: string | null;
  /** MotebitId of the executing agent, or null when not attributed. */
  agent_id: string | null;
  /** Gross amount in micro-units before the platform fee. */
  gross_amount: number;
  /** Platform fee extracted by the relay, in micro-units. */
  fee_amount: number;
  /** Net amount forwarded, in micro-units (`gross_amount - fee_amount`). */
  net_amount: number;
  /** Fee rate applied (e.g. 0.05 = 5%). Recorded per-settlement for auditability. */
  fee_rate: number;
  /** Hash of the execution receipt this settlement pays against. */
  receipt_hash: string;
  /** Millisecond timestamp when this relay booked the settlement. */
  settled_at: number;
  /** x402 payment transaction hash (when paid on-chain). */
  x402_tx_hash?: string;
  /** x402 network used for payment (CAIP-2 identifier). */
  x402_network?: string;
  /** MotebitId of the relay that signed this record (the booking relay). */
  issuer_relay_id: string;
  /**
   * Cryptosuite discriminator for `signature`. Always
   * `"motebit-jcs-ed25519-b64-v1"` — JCS canonicalization of the unsigned
   * record, Ed25519 primitive, base64url signature encoding (matching the
   * per-agent `SettlementRecord` suite). Verifiers reject missing or unknown
   * suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  /** Base64url-encoded Ed25519 signature over the canonical unsigned record. */
  signature: string;
}

// === Federation Settlement Anchor Proof ===

/** Onchain anchor reference — chain-agnostic. */
export interface FederationSettlementChainAnchor {
  /** Chain identifier (e.g., "eip155"). */
  chain: string;
  /** CAIP-2 network identifier (e.g., "eip155:8453" for Base). */
  network: string;
  /** Transaction hash on the target chain. */
  tx_hash: string;
  /** Millisecond timestamp when the anchor was confirmed. */
  anchored_at: number;
}

/** Self-verifiable Merkle inclusion proof for a federation settlement in an anchored batch. */
export interface FederationSettlementAnchorProof {
  /** Settlement identifier. */
  settlement_id: string;
  /**
   * Hex-encoded SHA-256 hash of the canonical signed `FederationSettlementRecord`
   * (the exact bytes a peer holds, signature included) — the verbatim-artifact
   * leaf per spec/agent-settlement-anchor-v1.md §9.1.
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
   * encoding. Suite-bound (cryptosuite-agility: part of the signed payload).
   * Verifiers reject missing or unknown suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-hex-v1";
  /** Hex-encoded Ed25519 signature over the canonical batch payload. */
  batch_signature: string;
  /** Onchain anchor metadata, or null if not yet submitted. */
  anchor: FederationSettlementChainAnchor | null;
  /**
   * Tree-hash recipe for the Merkle path (leaf-domain / node-domain tags +
   * hash). A `MerkleTreeVersion` from `merkle-tree-hash.ts`. **Absent ⇒
   * `merkle-sha256-plain-v1`** — every proof minted before this axis existed
   * still verifies offline. Verifiers resolve absent to the default and reject
   * an unknown value fail-closed (never silently downgrade); a v2 producer MUST
   * emit it rather than rely on the default. Separate axis from `suite` (the
   * batch-signature recipe). See
   * `docs/doctrine/merkle-tree-hash-versioning.md`.
   */
  tree_hash_version?: MerkleTreeVersion;
}
