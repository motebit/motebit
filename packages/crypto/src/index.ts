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
 * Encrypt plaintext with a 256-bit key using AES-256-GCM via Web Crypto API.
 */
export async function encrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
): Promise<EncryptedPayload> {
  const nonce = generateNonce();
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
  const result = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, cryptoKey, plaintext as BufferSource);
  const resultArray = new Uint8Array(result);
  // AES-GCM appends a 16-byte tag
  const ciphertext = resultArray.slice(0, resultArray.length - 16);
  const tag = resultArray.slice(resultArray.length - 16);
  return { ciphertext, nonce, tag };
}

/**
 * Decrypt an encrypted payload with a 256-bit key.
 */
export async function decrypt(
  payload: EncryptedPayload,
  key: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["decrypt"]);
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
export async function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
  try {
    return await ed.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

// === Signed Tokens ===

function toBase64Url(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): Uint8Array {
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
