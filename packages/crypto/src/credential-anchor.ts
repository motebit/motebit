/**
 * Credential anchor — leaf hashing and self-verification.
 *
 * MIT: these functions are part of the open protocol. Any implementation
 * can compute credential leaves and verify anchor proofs using this module.
 *
 * motebit/credential-anchor@1.0 §3 (leaf hash) and §5.2 (verification).
 */

import { canonicalJson, sha256, hexToBytes, verifyBySuite } from "./signing.js";

/** The one suite CredentialAnchorBatch records sign under today. */
export const CREDENTIAL_ANCHOR_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

// === Helpers (inlined — zero monorepo deps) ===

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// === Leaf Hash ===

/**
 * Compute a credential leaf hash for Merkle anchoring.
 *
 * The input is the full W3C VC 2.0 credential including its `proof` field.
 * The proof is included because it binds the credential to its issuer's
 * signature — without it, anyone could claim arbitrary credential content.
 *
 * @param credential - Full verifiable credential object (with proof)
 * @returns Hex-encoded SHA-256 hash
 */
export async function computeCredentialLeaf(credential: Record<string, unknown>): Promise<string> {
  const canonical = canonicalJson(credential);
  const hash = await sha256(new TextEncoder().encode(canonical));
  return toHex(hash);
}

// === Merkle Proof Verification ===

/**
 * Verify a Merkle inclusion proof against an expected root.
 *
 * Binary tree with odd-leaf promotion (no duplication).
 * Same algorithm as @motebit/encryption/merkle.ts — inlined here
 * so the crypto package remains zero-monorepo-deps.
 */
async function verifyMerkleInclusion(
  leaf: string,
  index: number,
  siblings: string[],
  layerSizes: number[],
  expectedRoot: string,
): Promise<boolean> {
  let current = fromHex(leaf);
  let idx = index;
  let sibIdx = 0;

  for (const layerSize of layerSizes) {
    const siblingPos = idx % 2 === 0 ? idx + 1 : idx - 1;
    const hasSibling = siblingPos >= 0 && siblingPos < layerSize;

    if (hasSibling) {
      if (sibIdx >= siblings.length) return false;
      const siblingBytes = fromHex(siblings[sibIdx]!);
      const combined =
        idx % 2 === 0 ? concat(current, siblingBytes) : concat(siblingBytes, current);
      current = await sha256(combined);
      sibIdx++;
    }
    // Odd promotion: current passes through unchanged

    idx = Math.floor(idx / 2);
  }

  return toHex(current) === expectedRoot;
}

// === Anchor Verification ===

/** Result of verifying a credential anchor proof. */
export interface CredentialAnchorVerifyResult {
  /** Whether all checked steps passed. */
  valid: boolean;
  /** Individual step results. */
  steps: {
    /** Step 1: credential hash matches the claimed leaf. */
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

/**
 * Optional callback to verify the onchain anchor.
 *
 * Given a chain, network, and transaction hash, look up the transaction
 * and verify that the memo/data contains the expected Merkle root.
 *
 * This is the only step that requires network access. All other steps
 * are offline-verifiable with the credential, proof, and relay public key.
 */
export type ChainAnchorVerifier = (anchor: {
  chain: string;
  network: string;
  tx_hash: string;
  anchored_at: number;
  expected_root: string;
}) => Promise<boolean>;

/** The anchor proof fields needed for verification. */
export interface CredentialAnchorProofFields {
  credential_hash: string;
  batch_id: string;
  merkle_root: string;
  leaf_count: number;
  first_issued_at: number;
  last_issued_at: number;
  leaf_index: number;
  siblings: string[];
  layer_sizes: number[];
  relay_id: string;
  relay_public_key: string;
  /**
   * Cryptosuite discriminator for `batch_signature`. Always
   * `"motebit-jcs-ed25519-hex-v1"` — JCS canonicalization of the batch
   * payload, Ed25519 primitive, hex signature encoding. Verifiers
   * reject missing or unknown values fail-closed.
   */
  suite: typeof CREDENTIAL_ANCHOR_SUITE;
  batch_signature: string;
  anchor: {
    chain: string;
    network: string;
    tx_hash: string;
    anchored_at: number;
  } | null;
}

/**
 * Verify a credential anchor proof — the 4-step self-verification algorithm.
 *
 * Steps 1–3 are fully offline. Step 4 (onchain lookup) requires a callback
 * and is skipped if not provided or if the proof has no onchain anchor.
 *
 * @param credential - The full W3C VC 2.0 credential (with proof)
 * @param anchorProof - The CredentialAnchorProof from the relay
 * @param chainVerifier - Optional callback for step 4 (onchain verification)
 * @returns Verification result with per-step breakdown
 *
 * @example
 * ```ts
 * import { verifyCredentialAnchor } from "@motebit/crypto";
 *
 * const result = await verifyCredentialAnchor(credential, proof);
 * if (result.valid) {
 *   // Steps 1-3 passed: credential was anchored by this relay
 * }
 * ```
 */
export async function verifyCredentialAnchor(
  credential: Record<string, unknown>,
  anchorProof: CredentialAnchorProofFields,
  chainVerifier?: ChainAnchorVerifier,
): Promise<CredentialAnchorVerifyResult> {
  const errors: string[] = [];

  // Step 1: Hash verification — credential maps to the claimed leaf
  const computedHash = await computeCredentialLeaf(credential);
  const hashValid = computedHash === anchorProof.credential_hash;
  if (!hashValid) {
    errors.push(
      `Hash mismatch: computed ${computedHash.slice(0, 16)}…, proof claims ${anchorProof.credential_hash.slice(0, 16)}…`,
    );
  }

  // Step 2: Merkle inclusion — leaf reconstructs to root
  const merkleValid = await verifyMerkleInclusion(
    anchorProof.credential_hash,
    anchorProof.leaf_index,
    anchorProof.siblings,
    anchorProof.layer_sizes,
    anchorProof.merkle_root,
  );
  if (!merkleValid) {
    errors.push("Merkle proof does not reconstruct to the claimed root");
  }

  // Step 3: Relay attestation — relay signed the batch payload
  // Reconstruct the exact payload signed by cutCredentialBatch. The
  // `suite` discriminator is part of the signed payload so verifiers
  // dispatch the primitive via `verifyBySuite` rather than assuming
  // Ed25519.
  const suite = anchorProof.suite;
  let relaySignatureValid = false;
  if (suite !== CREDENTIAL_ANCHOR_SUITE) {
    errors.push(`Relay batch signature: missing or unsupported suite "${String(suite)}"`);
  } else {
    const batchPayload = canonicalJson({
      batch_id: anchorProof.batch_id,
      merkle_root: anchorProof.merkle_root,
      leaf_count: anchorProof.leaf_count,
      first_issued_at: anchorProof.first_issued_at,
      last_issued_at: anchorProof.last_issued_at,
      relay_id: anchorProof.relay_id,
      suite,
    });
    const payloadBytes = new TextEncoder().encode(batchPayload);
    const signatureBytes = hexToBytes(anchorProof.batch_signature);
    const publicKeyBytes = hexToBytes(anchorProof.relay_public_key);

    try {
      relaySignatureValid = await verifyBySuite(
        suite,
        payloadBytes,
        signatureBytes,
        publicKeyBytes,
      );
    } catch {
      relaySignatureValid = false;
    }
    if (!relaySignatureValid) {
      errors.push("Relay batch signature verification failed");
    }
  }

  // Step 4: Onchain anchor (optional — requires network access)
  let chainVerified: boolean | null = null;
  if (anchorProof.anchor && chainVerifier) {
    try {
      chainVerified = await chainVerifier({
        ...anchorProof.anchor,
        expected_root: anchorProof.merkle_root,
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

// === Revocation Anchoring ===

/** Result of verifying an onchain revocation anchor. */
export interface RevocationAnchorVerifyResult {
  /** Whether the revocation anchor is valid. */
  valid: boolean;
  /** Individual step results. */
  steps: {
    /** Step 1: memo format is valid and contains the expected public key. */
    memo_valid: boolean;
    /** Step 2: relay's Ed25519 signature over the revocation payload is valid. */
    relay_signature_valid: boolean;
    /** Step 3: onchain anchor verified (null if not checked). */
    chain_verified: boolean | null;
  };
  /** Error messages for failed steps. */
  errors: string[];
}

/** The one suite revocation anchor events sign under today (utf8-concat). */
export const REVOCATION_ANCHOR_SUITE = "motebit-concat-ed25519-hex-v1" as const;

/** Fields needed to verify a revocation anchor. */
export interface RevocationAnchorProof {
  /** Hex-encoded public key that was revoked. */
  revoked_public_key: string;
  /** Millisecond timestamp of the revocation event. */
  timestamp: number;
  /**
   * Cryptosuite discriminator. Always `"motebit-concat-ed25519-hex-v1"` —
   * UTF-8 concatenation template + Ed25519 primitive + hex signature.
   * Same suite as federation heartbeat.
   */
  suite: typeof REVOCATION_ANCHOR_SUITE;
  /** Hex-encoded Ed25519 signature over the revocation payload by the relay. */
  signature: string;
  /** Hex-encoded Ed25519 public key of the relay that signed the revocation. */
  relay_public_key: string;
  /** Onchain anchor metadata, or null if not yet submitted. */
  anchor: {
    chain: string;
    network: string;
    tx_hash: string;
  } | null;
}

/**
 * Verify a revocation anchor — confirm a key was revoked.
 *
 * The revocation memo format is: "motebit:revocation:v1:{public_key_hex}:{timestamp}"
 * The relay signs the payload "revocation:{type}:{motebit_id}:{timestamp}" with its
 * identity key. This function verifies:
 *
 * 1. The relay's Ed25519 signature over the revocation event
 * 2. Optionally, the onchain memo transaction via a callback
 *
 * Both steps are offline-verifiable given the relay's public key. The onchain
 * step requires network access but ensures the relay cannot deny the revocation.
 *
 * @param proof - The revocation anchor proof fields
 * @param revocationPayload - The exact signed payload string (e.g., "revocation:key_rotated:mid-xxx:1712345678")
 * @param chainVerifier - Optional callback: given tx_hash + expected memo, verify onchain
 */
export async function verifyRevocationAnchor(
  proof: RevocationAnchorProof,
  revocationPayload: string,
  chainVerifier?: (anchor: {
    chain: string;
    network: string;
    tx_hash: string;
    expected_memo: string;
  }) => Promise<boolean>,
): Promise<RevocationAnchorVerifyResult> {
  const errors: string[] = [];

  // Step 1: Memo format validation — the expected memo matches the proof fields
  const expectedMemo = `motebit:revocation:v1:${proof.revoked_public_key}:${proof.timestamp}`;
  const memoValid = proof.revoked_public_key.length === 64 && proof.timestamp > 0;
  if (!memoValid) {
    errors.push(
      `Invalid revocation proof: public key length ${proof.revoked_public_key.length} (expected 64), timestamp ${proof.timestamp}`,
    );
  }

  // Step 2: Relay signature verification — suite dispatches the primitive
  let relaySignatureValid = false;
  if (proof.suite !== REVOCATION_ANCHOR_SUITE) {
    errors.push(
      `Relay revocation signature: missing or unsupported suite "${String(proof.suite)}"`,
    );
  } else {
    const payloadBytes = new TextEncoder().encode(revocationPayload);
    const signatureBytes = hexToBytes(proof.signature);
    const publicKeyBytes = hexToBytes(proof.relay_public_key);

    try {
      relaySignatureValid = await verifyBySuite(
        proof.suite,
        payloadBytes,
        signatureBytes,
        publicKeyBytes,
      );
    } catch {
      relaySignatureValid = false;
    }
    if (!relaySignatureValid) {
      errors.push("Relay revocation signature verification failed");
    }
  }

  // Step 3: Onchain anchor (optional)
  let chainVerified: boolean | null = null;
  if (proof.anchor && chainVerifier) {
    try {
      chainVerified = await chainVerifier({
        ...proof.anchor,
        expected_memo: expectedMemo,
      });
      if (!chainVerified) {
        errors.push("Onchain revocation anchor verification failed");
      }
    } catch (err) {
      chainVerified = false;
      errors.push(
        `Onchain revocation verification error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const valid = memoValid && relaySignatureValid && (chainVerified === null || chainVerified);

  return {
    valid,
    steps: {
      memo_valid: memoValid,
      relay_signature_valid: relaySignatureValid,
      chain_verified: chainVerified,
    },
    errors,
  };
}
