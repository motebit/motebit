/**
 * @motebit/encryption — Product security: encryption, key derivation, deletion.
 *
 * Protocol signing primitives (Ed25519, canonical JSON, receipts, delegations,
 * credentials, successions) live in MIT @motebit/crypto. This package
 * re-exports them for backward compatibility and adds product-level encryption,
 * PBKDF2 key derivation, sync encryption, and deletion certificates.
 *
 * Uses Web Crypto API for AES-256-GCM/PBKDF2.
 */

// ── Re-export protocol signing primitives from @motebit/crypto ──────
// Backward compat: consumers import from @motebit/encryption unchanged.

export {
  // Core primitives
  canonicalJson,
  canonicalSha256,
  bytesToHex,
  hexToBytes,
  toBase64Url,
  fromBase64Url,
  base58btcEncode,
  base58btcDecode,
  didKeyToPublicKey,
  publicKeyToDidKey,
  hexPublicKeyToDidKey,
  hash,
  sha256,
  generateKeypair,
  createSignedToken,
  verifySignedToken,
  parseScopeSet,
  isScopeNarrowed,
  // Ed25519 — aliased from ed25519Sign/ed25519Verify for backward compat
  ed25519Sign as sign,
  ed25519Verify as verify,
  // Types
  type KeyPair,
  type SignedTokenPayload,
  // Artifacts
  signExecutionReceipt,
  verifyExecutionReceipt,
  verifyExecutionReceiptDetailed,
  type ReceiptVerifyDetail,
  signSovereignPaymentReceipt,
  verifyReceiptChain,
  verifyReceiptSequence,
  signDelegation,
  verifyDelegation,
  verifyDelegationChain,
  signSettlement,
  verifySettlement,
  SETTLEMENT_RECORD_SUITE,
  signBalanceWaiver,
  verifyBalanceWaiver,
  BALANCE_WAIVER_SUITE,
  type BalanceWaiver,
  signKeySuccession,
  signGuardianRecoverySuccession,
  verifyKeySuccession,
  verifySuccessionChain,
  signGuardianRevocation,
  verifyGuardianRevocation,
  signCollaborativeReceipt,
  verifyCollaborativeReceipt,
  signDeviceRegistration,
  verifyDeviceRegistration,
  DEVICE_REGISTRATION_SUITE,
  DEVICE_REGISTRATION_MAX_AGE_MS,
  type SignableDeviceRegistration,
  type DeviceRegistrationVerifyResult,
  type SignableReceipt,
  type SovereignPaymentReceiptInput,
  type ReceiptVerification,
  type KnownKeys,
  type ReceiptChainEntry,
  type DelegationToken,
  type SettlementRecord,
  type KeySuccessionRecord,
  type SignableCollaborativeReceipt,
  type SuccessionChainResult,
} from "@motebit/crypto";

// ── Re-export credential signing from @motebit/crypto ───────────────

export {
  signVerifiableCredential,
  verifyVerifiableCredential,
  signVerifiablePresentation,
  verifyVerifiablePresentation,
  issueGradientCredential,
  issueReputationCredential,
  issueTrustCredential,
  createPresentation,
  type DataIntegrityProof,
  type VerifiableCredential,
  type VerifiablePresentation,
} from "@motebit/crypto";

// ── Product security (BSL — stays here) ─────────────────────────────

export interface EncryptedPayload {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
}

export interface DeletionCertificate {
  target_id: string;
  target_type: "memory" | "event" | "identity";
  deleted_at: number;
  deleted_by: string;
  tombstone_hash: string;
}

/**
 * Generate a random 256-bit key.
 */
export function generateKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

/**
 * Generate a random nonce (12 bytes for AES-GCM / ChaCha20-Poly1305).
 */
export function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * Generate a random salt (16 bytes) for PBKDF2 key derivation.
 */
export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

/**
 * Encrypt plaintext with a 256-bit key using AES-256-GCM via Web Crypto API.
 */
export async function encrypt(plaintext: Uint8Array, key: Uint8Array): Promise<EncryptedPayload> {
  const nonce = generateNonce();
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const result = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    cryptoKey,
    plaintext as BufferSource,
  );
  const resultArray = new Uint8Array(result);
  const ciphertext = resultArray.slice(0, resultArray.length - 16);
  const tag = resultArray.slice(resultArray.length - 16);
  return { ciphertext, nonce, tag };
}

/**
 * Decrypt an encrypted payload with a 256-bit key.
 */
export async function decrypt(payload: EncryptedPayload, key: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    "decrypt",
  ]);
  const combined = new Uint8Array(payload.ciphertext.length + payload.tag.length);
  combined.set(payload.ciphertext);
  combined.set(payload.tag, payload.ciphertext.length);
  const result = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: payload.nonce as BufferSource },
    cryptoKey,
    combined as BufferSource,
  );
  return new Uint8Array(result);
}

/** Default PBKDF2 iterations. Override via MOTEBIT_PBKDF2_ITERATIONS for tests. */
const DEFAULT_PBKDF2_ITERATIONS = (() => {
  const proc = (globalThis as Record<string, unknown>).process as
    | { env: Record<string, string | undefined> }
    | undefined;
  if (!proc?.env) return 600_000;
  const override = proc.env["MOTEBIT_PBKDF2_ITERATIONS"];
  if (!override) return 600_000;
  /* v8 ignore start -- module-level IIFE runs once at import; env override is a runtime safety guard */
  const n = Number(override);
  if (n < 100_000 && proc.env["NODE_ENV"] !== "test") {
    throw new Error(
      `PBKDF2 iterations (${n}) too low for non-test environment. ` +
        `Set NODE_ENV=test or use >= 100,000 iterations.`,
    );
  }
  return n;
  /* v8 ignore stop */
})();

/**
 * Derive a key from a password using PBKDF2.
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Derive a deterministic AES-256 encryption key from an Ed25519 private key using HKDF-SHA256.
 * Used for sync encryption: all devices sharing the same identity derive the same key.
 */
export async function deriveSyncEncryptionKey(privateKey: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    privateKey as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("motebit-sync-encryption-v1"),
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Create a deletion certificate for audit-trail purposes.
 */
export async function createDeletionCertificate(
  targetId: string,
  targetType: "memory" | "event" | "identity",
  deletedBy: string,
): Promise<DeletionCertificate> {
  const encoder = new TextEncoder();
  const timestamp = Date.now();
  const payload = encoder.encode(`${targetId}:${targetType}:${timestamp}:${deletedBy}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", payload as BufferSource);
  const hashArray = new Uint8Array(hashBuffer);
  const tombstoneHash = Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    target_id: targetId,
    target_type: targetType,
    deleted_at: timestamp,
    deleted_by: deletedBy,
    tombstone_hash: tombstoneHash,
  };
}

/**
 * Securely erase a Uint8Array by overwriting with random data then zeros.
 */
export function secureErase(data: Uint8Array): void {
  crypto.getRandomValues(data);
  data.fill(0);
}

// ── Merkle tree (federation settlement anchoring) ───────────────────

export {
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  computeSettlementLeaf,
} from "./merkle.js";
export type { MerkleTree, MerkleProof } from "./merkle.js";

// ── X25519 Key Transfer (multi-device pairing) ─────────────────────

export {
  generateX25519Keypair,
  x25519SharedSecret,
  deriveKeyTransferKey,
  buildKeyTransferPayload,
  decryptKeyTransfer,
  checkPreTransferBalance,
  formatWalletWarning,
} from "./x25519.js";
export type { X25519Keypair, PreTransferWalletCheck } from "./x25519.js";
