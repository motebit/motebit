/**
 * Per-agent settlement anchor — leaf hashing and self-verification.
 *
 * Permissive floor (Apache-2.0): these functions are part of the open
 * protocol. A worker who holds (a) their signed `SettlementRecord`, (b) an
 * `AgentSettlementAnchorProof` for it, and (c) the relay's public key can
 * verify — offline, with only `@motebit/crypto` — that the relay anchored
 * exactly that record into a Merkle root, without contacting the relay.
 *
 * motebit/agent-settlement-anchor@1.0 §3 (leaf hash) and §5 (verification).
 * This is the portable verifier that closes the self-attesting loop the
 * producer (`services/relay/src/anchoring.ts`), the proof endpoint
 * (`GET /api/v1/settlements/:id/anchor-proof`), and the wire types
 * (`@motebit/protocol`) were already shipping without.
 *
 * Sibling of `credential-anchor.ts`: same Merkle primitive
 * (`verifyMerkleInclusion`), same 4-step shape. The third consumer of the
 * canonical `merkle.ts` primitive (see `crypto/CLAUDE.md` rule 6).
 */

import { canonicalJson, sha256, hexToBytes, bytesToHex, verifyBySuite } from "./signing.js";
import { verifyMerkleInclusion } from "./merkle.js";
// Reuse the sibling's onchain-verification callback shape (identical) rather
// than redefining it — one `ChainAnchorVerifier` name across the anchor family.
import type { ChainAnchorVerifier } from "./credential-anchor.js";

/**
 * The one suite AgentSettlementAnchorBatch records sign under today.
 * JCS canonicalization, Ed25519 primitive, hex signature + hex public-key
 * encoding (note: hex, unlike the base64url SettlementRecord suite — the
 * anchor batch and the settlement it commits are independently signed
 * artifacts with their own suites).
 */
export const AGENT_SETTLEMENT_ANCHOR_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

// === Leaf Hash ===

/**
 * Compute a per-agent settlement leaf hash for Merkle anchoring.
 *
 * The input is the WHOLE signed `SettlementRecord` (signature included),
 * passed as a plain object. The leaf is `SHA-256(canonicalJson(record))` —
 * the holder reproduces it from exactly the bytes they hold, with no field
 * projection. (This is the SCITT / RFC 6962 invariant: anchor the exact
 * signed object; never a re-typed subset — a subset cannot be reproduced
 * from the holder's record and the receipt dies on arrival.)
 *
 * `canonicalJson` is JCS/RFC 8785 — the same canonicalization the relay
 * used to sign the record, so a worker who holds the signed record and a
 * verifier who holds the producer's row derive the identical leaf.
 *
 * @param settlement - The full signed SettlementRecord object (with signature)
 * @returns Hex-encoded SHA-256 hash
 */
export async function computeAgentSettlementLeaf(
  settlement: Record<string, unknown>,
): Promise<string> {
  const canonical = canonicalJson(settlement);
  const hash = await sha256(new TextEncoder().encode(canonical));
  return bytesToHex(hash);
}

// === Anchor Verification ===

/** Result of verifying a per-agent settlement anchor proof. */
export interface AgentSettlementAnchorVerifyResult {
  /** Whether all checked steps passed. */
  valid: boolean;
  /** Individual step results. */
  steps: {
    /** Step 1: the held SettlementRecord hashes to the claimed leaf. */
    hash_valid: boolean;
    /** Step 2: Merkle proof reconstructs to the claimed root. */
    merkle_valid: boolean;
    /** Step 3: relay's Ed25519 signature over the batch payload is valid. */
    relay_signature_valid: boolean;
    /** Step 4: onchain anchor verified (null if not checked). */
    chain_verified: boolean | null;
  };
  /** Error messages for failed steps. */
  errors: string[];
}

/** The anchor-proof fields needed for verification (subset of `AgentSettlementAnchorProof`). */
export interface AgentSettlementAnchorProofFields {
  settlement_hash: string;
  batch_id: string;
  merkle_root: string;
  leaf_count: number;
  first_settled_at: number;
  last_settled_at: number;
  leaf_index: number;
  siblings: string[];
  layer_sizes: number[];
  relay_id: string;
  relay_public_key: string;
  /**
   * Cryptosuite discriminator for `batch_signature`. Always
   * `"motebit-jcs-ed25519-hex-v1"`. Signature-bound: the suite is part of
   * the canonical batch payload (see step 3), so a cross-suite confusion
   * cannot pass verification. Verifiers reject missing or unknown values
   * fail-closed.
   */
  suite: typeof AGENT_SETTLEMENT_ANCHOR_SUITE;
  batch_signature: string;
  anchor: {
    chain: string;
    network: string;
    tx_hash: string;
    anchored_at: number;
  } | null;
}

/**
 * Verify a per-agent settlement anchor proof — the 4-step self-verification
 * algorithm. Steps 1–3 are fully offline. Step 4 (onchain lookup) requires a
 * callback and is skipped if not provided or if the proof has no onchain anchor.
 *
 * @param settlement - The full signed SettlementRecord the worker holds (with signature)
 * @param proof - The AgentSettlementAnchorProof served by the relay
 * @param chainVerifier - Optional callback for step 4 (onchain verification)
 * @returns Verification result with per-step breakdown
 *
 * @example
 * ```ts
 * import { verifyAgentSettlementAnchor } from "@motebit/crypto";
 *
 * const result = await verifyAgentSettlementAnchor(settlementRecord, proof);
 * if (result.valid) {
 *   // Steps 1-3 passed: the relay anchored exactly this settlement.
 * }
 * ```
 */
export async function verifyAgentSettlementAnchor(
  settlement: Record<string, unknown>,
  proof: AgentSettlementAnchorProofFields,
  chainVerifier?: ChainAnchorVerifier,
): Promise<AgentSettlementAnchorVerifyResult> {
  const errors: string[] = [];

  // Step 1: Hash verification — the held record maps to the claimed leaf.
  const computedHash = await computeAgentSettlementLeaf(settlement);
  const hashValid = computedHash === proof.settlement_hash;
  if (!hashValid) {
    errors.push(
      `Hash mismatch: held record hashes to ${computedHash.slice(0, 16)}…, ` +
        `proof claims ${proof.settlement_hash.slice(0, 16)}…`,
    );
  }

  // Step 2: Merkle inclusion — leaf reconstructs to root.
  const merkleValid = await verifyMerkleInclusion(
    proof.settlement_hash,
    proof.leaf_index,
    proof.siblings,
    proof.layer_sizes,
    proof.merkle_root,
  );
  if (!merkleValid) {
    errors.push("Merkle proof does not reconstruct to the claimed root");
  }

  // Step 3: Relay attestation — relay signed the batch payload. The `suite`
  // discriminator is part of the signed payload (cryptosuite-agility: the
  // suite is signature-bound, not assumed) so verifiers dispatch the
  // primitive via `verifyBySuite`. Field SET must match the producer's
  // `anchorPayload` in services/relay/src/anchoring.ts (key order is
  // irrelevant — JCS sorts).
  const suite = proof.suite;
  let relaySignatureValid = false;
  if (suite !== AGENT_SETTLEMENT_ANCHOR_SUITE) {
    errors.push(`Relay batch signature: missing or unsupported suite "${String(suite)}"`);
  } else {
    const batchPayload = canonicalJson({
      batch_id: proof.batch_id,
      merkle_root: proof.merkle_root,
      leaf_count: proof.leaf_count,
      first_settled_at: proof.first_settled_at,
      last_settled_at: proof.last_settled_at,
      relay_id: proof.relay_id,
      suite,
    });
    const payloadBytes = new TextEncoder().encode(batchPayload);
    try {
      relaySignatureValid = await verifyBySuite(
        suite,
        payloadBytes,
        hexToBytes(proof.batch_signature),
        hexToBytes(proof.relay_public_key),
      );
    } catch {
      relaySignatureValid = false;
    }
    if (!relaySignatureValid) {
      errors.push("Relay batch signature verification failed");
    }
  }

  // Step 4: Onchain anchor (optional — requires network access).
  let chainVerified: boolean | null = null;
  if (proof.anchor && chainVerifier) {
    try {
      chainVerified = await chainVerifier({
        ...proof.anchor,
        expected_root: proof.merkle_root,
      });
      if (!chainVerified) {
        errors.push("Onchain anchor verification failed");
      }
    } catch (err) {
      chainVerified = false;
      errors.push(
        `Onchain verification error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const valid =
    hashValid && merkleValid && relaySignatureValid && (chainVerified === null || chainVerified);

  return {
    valid,
    steps: {
      hash_valid: hashValid,
      merkle_valid: merkleValid,
      relay_signature_valid: relaySignatureValid,
      chain_verified: chainVerified,
    },
    errors,
  };
}
