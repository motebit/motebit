/**
 * @motebit/crypto — Key handling, encryption, delete semantics.
 *
 * Uses @noble/hashes and @noble/ciphers for zero-dependency,
 * audited cryptographic operations.
 */

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
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
