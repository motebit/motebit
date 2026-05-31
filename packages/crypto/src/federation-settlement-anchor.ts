/**
 * Federation settlement anchor — leaf hashing and self-verification.
 *
 * Permissive floor (Apache-2.0): these functions are part of the open
 * protocol. A peer relay that holds (a) a signed `FederationSettlementRecord`,
 * (b) a `FederationSettlementAnchorProof` for it, and (c) the booking relay's
 * public key can verify — offline, with only `@motebit/crypto` — that the
 * relay anchored exactly that record into a Merkle root, without contacting it.
 *
 * relay-federation-v1.md §7.6 (Merkle batch) + the §9.1 convergence
 * (agent-settlement-anchor-v1.md): the federation leaf is now the
 * verbatim-artifact hash the per-agent and credential streams already use, and
 * this is the portable verifier that closes the self-attesting loop the
 * producer (`services/relay/src/anchoring.ts`), the proof endpoint
 * (`GET /federation/v1/settlement/proof`), and the wire types
 * (`@motebit/protocol`) were shipping without.
 *
 * Sibling of `agent-settlement-anchor.ts` and `credential-anchor.ts`: same
 * Merkle primitive (`verifyMerkleInclusion`), same 4-step shape. The FOURTH
 * consumer of the canonical `merkle.ts` primitive (see `crypto/CLAUDE.md` rule 6).
 */

import type { MerkleTreeVersion } from "@motebit/protocol";
import { canonicalJson, hexToBytes, verifyBySuite } from "./signing.js";
import { verifyMerkleInclusion, canonicalLeaf, resolveTreeHashVersion } from "./merkle.js";
// Reuse the sibling's onchain-verification callback shape (identical) rather
// than redefining it — one `ChainAnchorVerifier` name across the anchor family.
import type { ChainAnchorVerifier } from "./credential-anchor.js";

/**
 * The one suite federation anchor batch records sign under today. JCS
 * canonicalization, Ed25519 primitive, hex signature + hex public-key encoding
 * (note: hex, unlike the base64url `FederationSettlementRecord` suite — the
 * anchor batch and the settlement it commits are independently signed artifacts
 * with their own suites, exactly as on the per-agent stream).
 */
export const FEDERATION_SETTLEMENT_ANCHOR_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

// === Leaf Hash ===

/**
 * Compute a federation settlement leaf hash for Merkle anchoring.
 *
 * The input is the WHOLE signed `FederationSettlementRecord` (signature
 * included), passed as a plain object. The leaf is `SHA-256(canonicalJson(record))`
 * — the holder reproduces it from exactly the bytes they hold, with no field
 * projection. (This is the SCITT / RFC 6962 invariant: anchor the exact signed
 * object; never a re-typed subset — a subset cannot be reproduced from the
 * holder's record and the receipt dies on arrival. It is the move
 * agent-settlement-anchor-v1.md §9.1 named for this stream.)
 *
 * `canonicalJson` is JCS/RFC 8785 — the same canonicalization the relay used to
 * sign the record, so a peer who holds the signed record and a verifier who
 * holds the producer's row derive the identical leaf.
 *
 * @param settlement - The full signed FederationSettlementRecord object
 * @returns Hex-encoded SHA-256 hash
 */
export async function computeFederationSettlementLeaf(
  settlement: Record<string, unknown>,
  treeHashVersion: MerkleTreeVersion = "merkle-sha256-plain-v1",
): Promise<string> {
  // Routes through the canonical leaf primitive so the RFC 6962 §2.1 leaf tag
  // (under v2) is applied in one place. v1 (default) is byte-identical to the
  // previous `bytesToHex(sha256(canonicalJson(settlement)))`.
  return canonicalLeaf(settlement, treeHashVersion);
}

// === Anchor Verification ===

/** Result of verifying a federation settlement anchor proof. */
export interface FederationSettlementAnchorVerifyResult {
  /** Whether all checked steps passed. */
  valid: boolean;
  /** Individual step results. */
  steps: {
    /** Step 1: the held FederationSettlementRecord hashes to the claimed leaf. */
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

/** The anchor-proof fields needed for verification (subset of `FederationSettlementAnchorProof`). */
export interface FederationSettlementAnchorProofFields {
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
   * `"motebit-jcs-ed25519-hex-v1"`. Signature-bound: the suite is part of the
   * canonical batch payload (see step 3), so a cross-suite confusion cannot
   * pass verification. Verifiers reject missing or unknown values fail-closed.
   */
  suite: typeof FEDERATION_SETTLEMENT_ANCHOR_SUITE;
  batch_signature: string;
  anchor: {
    chain: string;
    network: string;
    tx_hash: string;
    anchored_at: number;
  } | null;
  /**
   * Tree-hash recipe for the Merkle path. **Absent ⇒ `merkle-sha256-plain-v1`**.
   * Resolved fail-closed (unknown ⇒ reject, never silent-downgrade); threaded to
   * the leaf builder (step 1) and `verifyMerkleInclusion` (step 2).
   */
  tree_hash_version?: MerkleTreeVersion;
}

/**
 * Verify a federation settlement anchor proof — the 4-step self-verification
 * algorithm. Steps 1–3 are fully offline. Step 4 (onchain lookup) requires a
 * callback and is skipped if not provided or if the proof has no onchain anchor.
 *
 * **Scope — what this proves and what it does NOT.** A `valid` result proves the
 * relay anchored *these exact record bytes* into a signed, (optionally) onchain
 * Merkle root — content non-equivocation. It does NOT, by design (mirroring the
 * per-agent `verifyAgentSettlementAnchor`):
 *   - bind the served `settlement` to a particular `settlement_id` or to the
 *     caller's own view of the settlement. A relay could return a *valid*
 *     `{proof, record}` for a *different* settlement. A caller auditing a
 *     specific settlement MUST compare `settlement.settlement_id` / amounts /
 *     counterparties against its own row.
 *   - verify the record's OWN Ed25519 signature. The signature bytes are inside
 *     the hashed leaf (so tampering fails step 1), but "the issuing relay
 *     attested the (gross,fee,net,rate) tuple" requires a separate
 *     `verifyFederationSettlement(record, issuerKey)` call.
 *
 * @param settlement - The full signed FederationSettlementRecord the peer holds
 * @param proof - The FederationSettlementAnchorProof served by the relay
 * @param chainVerifier - Optional callback for step 4 (onchain verification)
 * @returns Verification result with per-step breakdown
 *
 * @example
 * ```ts
 * import { verifyFederationSettlementAnchor } from "@motebit/crypto";
 *
 * const result = await verifyFederationSettlementAnchor(record, proof);
 * if (result.valid) {
 *   // Steps 1-3 passed: the relay anchored exactly this settlement.
 * }
 * ```
 */
export async function verifyFederationSettlementAnchor(
  settlement: Record<string, unknown>,
  proof: FederationSettlementAnchorProofFields,
  chainVerifier?: ChainAnchorVerifier,
): Promise<FederationSettlementAnchorVerifyResult> {
  const errors: string[] = [];

  // Resolve the tree-hash version at the boundary: absent ⇒ v1, unknown ⇒
  // reject fail-closed (every step false, never silent-downgrade). Both the leaf
  // builder and the inclusion check then receive a narrow, supported version.
  const treeHashVersion = resolveTreeHashVersion(proof.tree_hash_version);
  if (treeHashVersion === null) {
    return {
      valid: false,
      steps: {
        hash_valid: false,
        merkle_valid: false,
        relay_signature_valid: false,
        chain_verified: null,
      },
      errors: [`Unknown tree_hash_version "${String(proof.tree_hash_version)}" — rejected`],
    };
  }

  // Step 1: Hash verification — the held record maps to the claimed leaf.
  const computedHash = await computeFederationSettlementLeaf(settlement, treeHashVersion);
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
    treeHashVersion,
  );
  if (!merkleValid) {
    errors.push("Merkle proof does not reconstruct to the claimed root");
  }

  // Step 3: Relay attestation — relay signed the batch payload. The `suite`
  // discriminator is part of the signed payload (cryptosuite-agility: the suite
  // is signature-bound, not assumed) so verifiers dispatch the primitive via
  // `verifyBySuite`. Field SET must match the producer's `anchorPayload` in
  // services/relay/src/anchoring.ts (key order is irrelevant — JCS sorts).
  const suite = proof.suite;
  let relaySignatureValid = false;
  if (suite !== FEDERATION_SETTLEMENT_ANCHOR_SUITE) {
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
