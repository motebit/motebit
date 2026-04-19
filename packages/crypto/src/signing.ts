/**
 * Protocol signing primitives — Ed25519, encoding, canonical JSON, signed tokens.
 *
 * These are the cryptographic building blocks that any protocol participant
 * needs to produce valid Motebit artifacts. Moved from BSL @motebit/crypto
 * to MIT @motebit/crypto so the protocol's signing format is open.
 *
 * Zero monorepo dependencies — only @noble/ed25519 for cryptography.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// @noble/ed25519 v3 requires explicit SHA-512 binding
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

// === Types ===

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface SignedTokenPayload {
  mid: string;
  did: string;
  iat: number;
  exp: number;
  /** Unique token nonce (JWT ID) — prevents replay attacks. Required for verification. */
  jti: string;
  /** Audience claim — binds token to a specific endpoint/operation. Prevents cross-endpoint replay. */
  aud: string;
  /**
   * Cryptosuite identifier. Always `"motebit-jwt-ed25519-v1"` for this
   * token shape today. Present in the signed payload so verifiers
   * dispatch primitive verification through `verifyBySuite` rather
   * than assuming Ed25519. Missing or unknown values are rejected
   * fail-closed — no legacy-no-suite path.
   */
  suite: "motebit-jwt-ed25519-v1";
}

/** The one suite this token shape uses. Exported as a const so the
 * signer emits exactly this value and the verifier checks for exactly
 * this value — no string drift risk.
 */
export const SIGNED_TOKEN_SUITE = "motebit-jwt-ed25519-v1" as const;

// === Canonical JSON (JCS/RFC 8785) ===

/**
 * Deterministic JSON serialization with sorted keys (recursive).
 * Produces identical output regardless of insertion order.
 *
 * Used by every signed-payload helper: execution receipts, identity files,
 * succession records, settlement leaves, etc. Two structurally-equal payloads
 * always produce identical bytes here, which is what makes the Ed25519
 * signatures verifiable.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const entries: string[] = [];
  for (const key of sorted) {
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined) continue;
    entries.push(JSON.stringify(key) + ":" + canonicalJson(val));
  }
  return "{" + entries.join(",") + "}";
}

// === Encoding Helpers ===

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

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

// === Base58btc ===

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
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
  return BASE58_ALPHABET[0]!.repeat(zeros) + result;
}

export function base58btcDecode(str: string): Uint8Array {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === BASE58_ALPHABET[0]) zeros++;
  let value = 0n;
  for (let i = 0; i < str.length; i++) {
    const idx = BASE58_ALPHABET.indexOf(str[i]!);
    if (idx === -1) throw new Error(`Invalid base58 character: ${str[i]}`);
    value = value * 58n + BigInt(idx);
  }
  const hex: string[] = [];
  while (value > 0n) {
    const byte = Number(value & 0xffn);
    hex.unshift(byte.toString(16).padStart(2, "0"));
    value >>= 8n;
  }
  const dataBytes =
    hex.length > 0 ? new Uint8Array(hex.map((h) => parseInt(h, 16))) : new Uint8Array(0);
  const result = new Uint8Array(zeros + dataBytes.length);
  result.set(dataBytes, zeros);
  return result;
}

// === did:key (W3C Decentralized Identifier) ===

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
 * Derive a did:key URI from an Ed25519 public key.
 *
 * Format: did:key:z<base58btc(0xed01 + publicKey)>
 * See: https://w3c-ccg.github.io/did-method-key/
 */
export function publicKeyToDidKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error("Ed25519 public key must be 32 bytes");
  }
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(publicKey, 2);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

export function hexPublicKeyToDidKey(hexPublicKey: string): string {
  return publicKeyToDidKey(hexToBytes(hexPublicKey));
}

// === SHA-256 ===

export async function hash(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data as BufferSource);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Canonical-bytes hash. Convenience wrapper over `canonicalJson` + SHA-256
 * for diagnostic and audit use: lets a producer and a verifier deterministically
 * agree on (or disagree about) the exact bytes a signature was computed over,
 * without re-implementing the canonicalization recipe at the call site.
 *
 * Returns the hex SHA-256 of the UTF-8 bytes of `canonicalJson(obj)`. Stable
 * across processes, machines, and Node versions — same input ⇒ same output,
 * always. The only requirement on `obj` is that it be a JSON-serializable
 * value (no functions, no symbols, no cycles).
 *
 * Primary use case: when a signed-artifact verification fails, both ends of
 * the pipeline can log `canonicalSha256(body)` and the producer can confirm
 * whether the bytes the verifier reproduced match the bytes the producer
 * signed. A hash mismatch localizes the bug to the wire path; a hash match
 * localizes it to the signature primitive (which is far less likely).
 */
export async function canonicalSha256(obj: unknown): Promise<string> {
  return hash(new TextEncoder().encode(canonicalJson(obj)));
}

/** SHA-256 returning raw bytes (used by credential signing). */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

// === Ed25519 Signing ===
//
// The primitive sign/verify functions and keypair generation now live
// in `./suite-dispatch.ts`, which is the one file in @motebit/crypto
// permitted to call `ed.signAsync` / `ed.verifyAsync` directly (the
// `check-suite-dispatch` drift gate enforces that rule). These
// re-exports preserve the historical call sites that import from
// signing.ts directly (especially tests and @motebit/encryption).
// New artifact-level verifiers should prefer `verifyBySuite`.
import { generateEd25519Keypair, signBySuite, verifyBySuite } from "./suite-dispatch.js";

export {
  ed25519Sign,
  ed25519Verify,
  generateEd25519Keypair,
  getPublicKeyBySuite,
  signBySuite,
  verifyBySuite,
} from "./suite-dispatch.js";

export async function generateKeypair(): Promise<KeyPair> {
  return generateEd25519Keypair();
}

// === Signed Tokens ===

/**
 * Create a signed token: base64url(payload) + "." + base64url(signature).
 * Default expiry: 5 minutes from now.
 *
 * The payload includes a fixed `suite` field (`SIGNED_TOKEN_SUITE`) so
 * the verifier can dispatch primitive verification explicitly rather
 * than implicitly assuming Ed25519. Callers MUST supply every other
 * required payload field; this function does not fill defaults for
 * `mid` / `did` / `iat` / `exp` / `jti` / `aud`.
 */
export async function createSignedToken(
  payload: Omit<SignedTokenPayload, "suite">,
  privateKey: Uint8Array,
): Promise<string> {
  const withSuite: SignedTokenPayload = { ...payload, suite: SIGNED_TOKEN_SUITE };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(withSuite));
  const payloadB64 = toBase64Url(payloadBytes);
  const signature = await signBySuite(SIGNED_TOKEN_SUITE, payloadBytes, privateKey);
  const sigB64 = toBase64Url(signature);
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a signed token. Returns the parsed payload if valid and not
 * expired, null otherwise.
 *
 * Rejects fail-closed on:
 *   - malformed token string (no dot separator, invalid base64url),
 *   - missing `suite` field,
 *   - `suite` value other than `SIGNED_TOKEN_SUITE`,
 *   - signature mismatch,
 *   - expired token,
 *   - missing `jti` (replay defense),
 *   - missing `aud` (cross-endpoint replay defense).
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

  // Parse before verify so the suite value routes the primitive call.
  // Malformed JSON → reject.
  let payload: SignedTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SignedTokenPayload;
  } catch {
    return null;
  }

  // Missing or unknown suite → reject fail-closed. No legacy-no-suite path.
  if (payload.suite !== SIGNED_TOKEN_SUITE) return null;

  const valid = await verifyBySuite(payload.suite, payloadBytes, signature, publicKey);
  if (!valid) return null;

  if (payload.exp <= Date.now()) return null;
  if (!payload.jti) return null;
  if (!payload.aud) return null;

  return payload;
}

// === Scope Utilities (Capability Attenuation) ===

/**
 * Parse a comma-separated scope string into a Set.
 * `"*"` is the wildcard meaning "all capabilities".
 * Trims whitespace from each element.
 */
export function parseScopeSet(scope: string): Set<string> {
  if (scope === "*") return new Set(["*"]);
  return new Set(
    scope
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Returns true if `childScope` is a proper subset of (or equal to) `parentScope`.
 *
 * Rules:
 * - If parentScope is `"*"`, any childScope is valid (wildcard grants all).
 * - If childScope is `"*"`, it's only valid if parentScope is also `"*"`.
 * - Otherwise, every capability in childScope must appear in parentScope.
 */
export function isScopeNarrowed(parentScope: string, childScope: string): boolean {
  const parent = parseScopeSet(parentScope);
  const child = parseScopeSet(childScope);

  // Wildcard parent allows anything
  if (parent.has("*")) return true;

  // Child requests wildcard but parent is not wildcard — scope widening
  if (child.has("*")) return false;

  // Every capability in child must exist in parent
  for (const cap of child) {
    if (!parent.has(cap)) return false;
  }
  return true;
}
