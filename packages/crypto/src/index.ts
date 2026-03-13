/**
 * @motebit/crypto — Key handling, encryption, delete semantics.
 *
 * Uses @noble/hashes and @noble/ciphers for zero-dependency,
 * audited cryptographic operations. Ed25519 signing via @noble/ed25519.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// @noble/ed25519 v3 requires setting the SHA-512 hash function for sync operations
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface SignedTokenPayload {
  mid: string;
  did: string;
  iat: number;
  exp: number;
}

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
 * Per NIST SP 800-132, salts should be at least 128 bits (16 bytes).
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
  // AES-GCM appends a 16-byte tag
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
  // Reconstruct ciphertext + tag for Web Crypto API
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

/**
 * Derive a key from a password using PBKDF2.
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number = 600_000,
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
 * Create a SHA-256 hash of the input.
 */
export async function hash(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data as BufferSource);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  const tombstoneHash = await hash(payload);
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

// === did:key (W3C Decentralized Identifier) ===

/** Base58btc alphabet (Bitcoin/IPFS standard). */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encode bytes as base58btc (no dependencies).
 */
export function base58btcEncode(bytes: Uint8Array): string {
  // Count leading zeros
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert to bigint for base conversion
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = value * 256n + BigInt(bytes[i]!);
  }

  let result = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    value = value / 58n;
    result = BASE58_ALPHABET[remainder]! + result;
  }

  // Preserve leading zeros as '1's
  return BASE58_ALPHABET[0]!.repeat(zeros) + result;
}

/**
 * Decode a base58btc string back to bytes.
 */
export function base58btcDecode(str: string): Uint8Array {
  // Count leading '1's (zero bytes)
  let zeros = 0;
  while (zeros < str.length && str[zeros] === BASE58_ALPHABET[0]) zeros++;

  // Convert from base58
  let value = 0n;
  for (let i = 0; i < str.length; i++) {
    const idx = BASE58_ALPHABET.indexOf(str[i]!);
    if (idx === -1) throw new Error(`Invalid base58 character: ${str[i]}`);
    value = value * 58n + BigInt(idx);
  }

  // Convert bigint to bytes
  const hex: string[] = [];
  while (value > 0n) {
    const byte = Number(value & 0xffn);
    hex.unshift(byte.toString(16).padStart(2, "0"));
    value >>= 8n;
  }

  const dataBytes =
    hex.length > 0 ? new Uint8Array(hex.map((h) => parseInt(h, 16))) : new Uint8Array(0);

  // Prepend leading zero bytes
  const result = new Uint8Array(zeros + dataBytes.length);
  result.set(dataBytes, zeros);
  return result;
}

/**
 * Extract a raw 32-byte Ed25519 public key from a did:key URI.
 *
 * Parses `did:key:z<base58btc(0xed01 + publicKey)>`, strips the 2-byte
 * multicodec prefix, and returns the raw public key bytes.
 */
export function didKeyToPublicKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) {
    throw new Error("Invalid did:key URI: must start with did:key:z");
  }
  const encoded = did.slice("did:key:z".length);
  const decoded = base58btcDecode(encoded);
  if (decoded.length !== 34) {
    throw new Error(
      `Invalid did:key: expected 34 bytes (2 prefix + 32 key), got ${decoded.length}`,
    );
  }
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error("Invalid did:key: multicodec prefix is not ed25519-pub (0xed01)");
  }
  return decoded.slice(2);
}

/**
 * Convert a hex string to bytes.
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Derive a did:key URI from an Ed25519 public key.
 *
 * Format: did:key:z<base58btc(0xed01 + publicKey)>
 * See: https://w3c-ccg.github.io/did-method-key/
 */
export function publicKeyToDidKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error("Ed25519 public key must be 32 bytes");
  }
  // 0xed, 0x01 = multicodec varint for ed25519-pub
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(publicKey, 2);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

/**
 * Derive a did:key URI from a hex-encoded Ed25519 public key.
 */
export function hexPublicKeyToDidKey(hexPublicKey: string): string {
  return publicKeyToDidKey(hexToBytes(hexPublicKey));
}

// === Ed25519 Signing ===

/**
 * Generate an Ed25519 keypair.
 */
export async function generateKeypair(): Promise<KeyPair> {
  const { secretKey, publicKey } = await ed.keygenAsync();
  return { publicKey, privateKey: secretKey };
}

/**
 * Sign a message with an Ed25519 private key.
 */
export async function sign(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
  return ed.signAsync(message, privateKey);
}

/**
 * Verify an Ed25519 signature.
 */
export async function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    return await ed.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

// === Signed Tokens ===

export function toBase64Url(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Create a signed token: base64url(payload) + "." + base64url(signature).
 * Default expiry: 5 minutes from now.
 */
export async function createSignedToken(
  payload: SignedTokenPayload,
  privateKey: Uint8Array,
): Promise<string> {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const payloadB64 = toBase64Url(payloadBytes);
  const signature = await sign(payloadBytes, privateKey);
  const sigB64 = toBase64Url(signature);
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a signed token. Returns the parsed payload if valid and not expired, null otherwise.
 */
export async function verifySignedToken(
  token: string,
  publicKey: Uint8Array,
): Promise<SignedTokenPayload | null> {
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return null;

  const payloadB64 = token.slice(0, dotIdx);
  const sigB64 = token.slice(dotIdx + 1);

  let payloadBytes: Uint8Array;
  let signature: Uint8Array;
  try {
    payloadBytes = fromBase64Url(payloadB64);
    signature = fromBase64Url(sigB64);
  } catch {
    return null;
  }

  const valid = await verify(signature, payloadBytes, publicKey);
  if (!valid) return null;

  let payload: SignedTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SignedTokenPayload;
  } catch {
    return null;
  }

  if (payload.exp <= Date.now()) return null;

  return payload;
}

// === Execution Receipt Signing ===

/**
 * Shape of an execution receipt for signing/verification.
 * Structurally compatible with @motebit/sdk ExecutionReceipt.
 */
export interface SignableReceipt {
  task_id: string;
  motebit_id: string;
  device_id: string;
  submitted_at: number;
  completed_at: number;
  status: string;
  result: string;
  tools_used: string[];
  memories_formed: number;
  prompt_hash: string;
  result_hash: string;
  delegation_receipts?: SignableReceipt[];
  signature: string;
}

/**
 * Deterministic JSON serialization with sorted keys (recursive).
 * Produces identical output regardless of insertion order.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const entries = sorted.map(
    (key) => JSON.stringify(key) + ":" + canonicalJson((obj as Record<string, unknown>)[key]),
  );
  return "{" + entries.join(",") + "}";
}

/**
 * Sign an execution receipt. Produces a canonical JSON representation
 * of all fields except `signature`, signs it with Ed25519, and sets
 * the `signature` field to the base64url-encoded result.
 */
export async function signExecutionReceipt<T extends Omit<SignableReceipt, "signature">>(
  receipt: T,
  privateKey: Uint8Array,
): Promise<T & { signature: string }> {
  const canonical = canonicalJson(receipt);
  const message = new TextEncoder().encode(canonical);
  const sig = await sign(message, privateKey);
  return { ...receipt, signature: toBase64Url(sig) };
}

/**
 * Verify an execution receipt's Ed25519 signature.
 * Reconstructs the canonical JSON from all fields except `signature`
 * and verifies against the provided public key.
 */
export async function verifyExecutionReceipt(
  receipt: SignableReceipt,
  publicKey: Uint8Array,
): Promise<boolean> {
  const { signature, ...body } = receipt;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await verify(sig, message, publicKey);
  } catch {
    return false;
  }
}

// === Receipt Chain Verification ===

/**
 * Result of verifying a single receipt in a chain.
 */
export interface ReceiptVerification {
  task_id: string;
  motebit_id: string;
  verified: boolean;
  error?: string;
  delegations: ReceiptVerification[];
}

/**
 * Known public keys map: motebit_id → Uint8Array public key.
 * Used to look up the correct key for each receipt in the chain.
 */
export type KnownKeys = Map<string, Uint8Array>;

/**
 * Recursively verify an execution receipt and all its delegation receipts.
 * Each receipt is verified against the public key found in `knownKeys` for its `motebit_id`.
 * Returns a tree of verification results mirroring the delegation structure.
 */
export async function verifyReceiptChain(
  receipt: SignableReceipt,
  knownKeys: KnownKeys,
): Promise<ReceiptVerification> {
  const { task_id, motebit_id } = receipt;

  // Look up public key for this receipt's motebit_id
  const publicKey = knownKeys.get(motebit_id);
  if (!publicKey) {
    // Recurse into delegations even if this receipt can't be verified
    const delegations = await verifyDelegations(receipt, knownKeys);
    return { task_id, motebit_id, verified: false, error: "unknown motebit_id", delegations };
  }

  // Verify the receipt's signature
  let verified: boolean;
  let error: string | undefined;
  try {
    verified = await verifyExecutionReceipt(receipt, publicKey);
  } catch (err: unknown) {
    verified = false;
    error = err instanceof Error ? err.message : String(err);
  }

  // Recursively verify delegation receipts
  const delegations = await verifyDelegations(receipt, knownKeys);

  const result: ReceiptVerification = { task_id, motebit_id, verified, delegations };
  if (error) {
    result.error = error;
  }
  return result;
}

async function verifyDelegations(
  receipt: SignableReceipt,
  knownKeys: KnownKeys,
): Promise<ReceiptVerification[]> {
  if (!receipt.delegation_receipts || receipt.delegation_receipts.length === 0) {
    return [];
  }
  return Promise.all(receipt.delegation_receipts.map((dr) => verifyReceiptChain(dr, knownKeys)));
}

// === Delegation Tokens ===

/**
 * A signed delegation token authorizing one entity to act on behalf of another.
 * The delegator signs (delegator_id, delegate_id, scope, issued_at, expires_at)
 * with their private key, proving they authorized the delegate.
 */
export interface DelegationToken {
  delegator_id: string;
  delegator_public_key: string; // base64url-encoded Ed25519 public key
  delegate_id: string;
  delegate_public_key: string; // base64url-encoded Ed25519 public key
  scope: string; // what the delegate is authorized to do
  issued_at: number;
  expires_at: number;
  signature: string; // base64url-encoded Ed25519 signature
}

/**
 * Sign a delegation token. The delegator authorizes the delegate to act
 * within the given scope. The signature covers all fields except `signature`.
 */
export async function signDelegation(
  delegation: Omit<DelegationToken, "signature">,
  delegatorPrivateKey: Uint8Array,
): Promise<DelegationToken> {
  const canonical = canonicalJson(delegation);
  const message = new TextEncoder().encode(canonical);
  const sig = await sign(message, delegatorPrivateKey);
  return { ...delegation, signature: toBase64Url(sig) };
}

/**
 * Verify a delegation token's signature using the delegator's public key.
 * Does NOT check expiration — caller should check `expires_at` separately.
 */
export async function verifyDelegation(delegation: DelegationToken): Promise<boolean> {
  const { signature, ...body } = delegation;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const pubKey = fromBase64Url(delegation.delegator_public_key);
    const sig = fromBase64Url(signature);
    return await verify(sig, message, pubKey);
  } catch {
    return false;
  }
}

/**
 * Verify a chain of delegation tokens.
 *
 * A valid chain means:
 * 1. Each delegation's signature is valid (signed by the delegator's key).
 * 2. Adjacent delegations are linked: delegation[i].delegate_id === delegation[i+1].delegator_id
 *    and delegation[i].delegate_public_key === delegation[i+1].delegator_public_key.
 *
 * An empty chain is considered valid (no delegations to verify).
 */
export async function verifyDelegationChain(
  chain: DelegationToken[],
): Promise<{ valid: boolean; error?: string }> {
  if (chain.length === 0) return { valid: true };

  for (let i = 0; i < chain.length; i++) {
    const delegation = chain[i]!;
    const sigValid = await verifyDelegation(delegation);
    if (!sigValid) {
      return { valid: false, error: `Delegation ${i} has invalid signature` };
    }

    if (i > 0) {
      const prev = chain[i - 1]!;
      if (prev.delegate_id !== delegation.delegator_id) {
        return {
          valid: false,
          error: `Chain break at ${i}: delegate_id "${prev.delegate_id}" !== delegator_id "${delegation.delegator_id}"`,
        };
      }
      if (prev.delegate_public_key !== delegation.delegator_public_key) {
        return {
          valid: false,
          error: `Chain break at ${i}: delegate_public_key mismatch`,
        };
      }
    }
  }

  return { valid: true };
}

// === Receipt Sequence Verification ===

/**
 * A receipt chain entry pairs a signed execution receipt with the
 * public key of the signer (the service that produced the receipt).
 */
export interface ReceiptChainEntry {
  receipt: SignableReceipt;
  signer_public_key: Uint8Array;
}

/**
 * Verify a flat sequence of execution receipts.
 *
 * A valid sequence means:
 * 1. Each receipt's signature is valid against its signer's public key.
 * 2. Adjacent receipts are temporally ordered: receipt[i].completed_at <= receipt[i+1].submitted_at.
 *
 * An empty sequence is considered valid.
 * Use `verifyReceiptChain` for nested/tree-structured delegation receipts.
 */
export async function verifyReceiptSequence(
  chain: ReceiptChainEntry[],
): Promise<{ valid: boolean; error?: string; index?: number }> {
  if (chain.length === 0) return { valid: true };

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i]!;
    const sigValid = await verifyExecutionReceipt(entry.receipt, entry.signer_public_key);
    if (!sigValid) {
      return { valid: false, error: `Receipt ${i} has invalid signature`, index: i };
    }
  }

  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1]!;
    const curr = chain[i]!;
    if (prev.receipt.completed_at > curr.receipt.submitted_at) {
      return {
        valid: false,
        error: `Receipt ${i} submitted_at (${curr.receipt.submitted_at}) is before receipt ${i - 1} completed_at (${prev.receipt.completed_at})`,
        index: i,
      };
    }
  }

  return { valid: true };
}

// === Collaborative Receipt ===

/**
 * Shape of a collaborative receipt for signing/verification.
 * Aggregates multiple participant execution receipts under a single proposal.
 */
export interface SignableCollaborativeReceipt {
  proposal_id: string;
  plan_id: string;
  participant_receipts: SignableReceipt[];
  content_hash: string;
  initiator_signature: string;
}

/**
 * Sign a collaborative receipt. Computes a content hash over the canonical
 * JSON of all participant receipts, then signs the aggregate with the
 * initiator's Ed25519 private key.
 */
export async function signCollaborativeReceipt(
  receipt: Omit<SignableCollaborativeReceipt, "content_hash" | "initiator_signature">,
  initiatorPrivateKey: Uint8Array,
): Promise<SignableCollaborativeReceipt> {
  // Canonicalize participant receipts for deterministic hashing
  const receiptsCanonical = canonicalJson(receipt.participant_receipts);
  const receiptsBytes = new TextEncoder().encode(receiptsCanonical);
  const contentHash = await hash(receiptsBytes);

  // Sign the content hash + proposal/plan metadata
  const sigPayload = canonicalJson({
    proposal_id: receipt.proposal_id,
    plan_id: receipt.plan_id,
    content_hash: contentHash,
  });
  const sigMessage = new TextEncoder().encode(sigPayload);
  const sig = await sign(sigMessage, initiatorPrivateKey);

  return {
    ...receipt,
    content_hash: contentHash,
    initiator_signature: toBase64Url(sig),
  };
}

/**
 * Verify a collaborative receipt:
 * 1. Recomputes content hash from participant receipts and checks it matches.
 * 2. Verifies the initiator's Ed25519 signature over the aggregate.
 * 3. Optionally verifies each participant receipt against known keys.
 */
export async function verifyCollaborativeReceipt(
  receipt: SignableCollaborativeReceipt,
  initiatorPublicKey: Uint8Array,
  participantKeys?: KnownKeys,
): Promise<{ valid: boolean; error?: string }> {
  // 1. Recompute content hash
  const receiptsCanonical = canonicalJson(receipt.participant_receipts);
  const receiptsBytes = new TextEncoder().encode(receiptsCanonical);
  const expectedHash = await hash(receiptsBytes);

  if (expectedHash !== receipt.content_hash) {
    return { valid: false, error: "Content hash mismatch" };
  }

  // 2. Verify initiator signature
  const sigPayload = canonicalJson({
    proposal_id: receipt.proposal_id,
    plan_id: receipt.plan_id,
    content_hash: receipt.content_hash,
  });
  const sigMessage = new TextEncoder().encode(sigPayload);
  try {
    const sig = fromBase64Url(receipt.initiator_signature);
    const sigValid = await verify(sig, sigMessage, initiatorPublicKey);
    if (!sigValid) {
      return { valid: false, error: "Initiator signature invalid" };
    }
  } catch {
    return { valid: false, error: "Initiator signature decode failed" };
  }

  // 3. Verify participant receipts if keys provided
  if (participantKeys) {
    for (let i = 0; i < receipt.participant_receipts.length; i++) {
      const pr = receipt.participant_receipts[i]!;
      const pubKey = participantKeys.get(pr.motebit_id);
      if (!pubKey) {
        return {
          valid: false,
          error: `Unknown participant key for receipt ${i} (${pr.motebit_id})`,
        };
      }
      const prValid = await verifyExecutionReceipt(pr, pubKey);
      if (!prValid) {
        return {
          valid: false,
          error: `Participant receipt ${i} (${pr.motebit_id}) signature invalid`,
        };
      }
    }
  }

  return { valid: true };
}

// === Verifiable Credentials ===

export {
  signVerifiableCredential,
  verifyVerifiableCredential,
  signVerifiablePresentation,
  verifyVerifiablePresentation,
  issueGradientCredential,
  issueReputationCredential,
  issueTrustCredential,
  createPresentation,
} from "./credentials.js";
export type {
  DataIntegrityProof,
  VerifiableCredential,
  VerifiablePresentation,
} from "./credentials.js";
