/**
 * Ed25519 verification using Web Crypto API (SubtleCrypto).
 * Self-contained, browser-only, no dependencies.
 */

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function fromBase64Url(str: string): Uint8Array {
  let padded = str.replace(/-/g, "+").replace(/_/g, "/");
  // Add padding if needed
  while (padded.length % 4 !== 0) {
    padded += "=";
  }
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Ed25519 verification via Web Crypto
// ---------------------------------------------------------------------------

/**
 * Verify an Ed25519 signature using the Web Crypto API.
 *
 * @param signature - 64-byte Ed25519 signature
 * @param message - the message bytes that were signed
 * @param publicKey - 32-byte Ed25519 public key
 * @returns true if the signature is valid
 */
export async function verifyEd25519(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    // Import the raw public key as a CryptoKey
    const key = await crypto.subtle.importKey(
      "raw",
      publicKey.buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );

    // Verify the signature
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature.buffer as ArrayBuffer,
      message.buffer as ArrayBuffer,
    );

    return valid;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// High-level verify for motebit.md
// ---------------------------------------------------------------------------

import { parse } from "./parse.js";
import type { MotebitIdentityFile } from "./parse.js";

export interface VerifyResult {
  valid: boolean;
  identity: MotebitIdentityFile | null;
  error?: string;
}

/**
 * Verify a motebit.md file content.
 * Implements the motebit/identity@1.0 verification algorithm (spec section 4.3).
 */
export async function verify(content: string): Promise<VerifyResult> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, identity: null, error: msg };
  }

  // Extract and validate public key
  const pubKeyHex = parsed.frontmatter.identity?.public_key;
  if (!pubKeyHex) {
    return { valid: false, identity: null, error: "No public key in frontmatter" };
  }

  let pubKey: Uint8Array;
  try {
    pubKey = hexToBytes(pubKeyHex);
  } catch {
    return { valid: false, identity: null, error: "Invalid public key hex" };
  }
  if (pubKey.length !== 32) {
    return { valid: false, identity: null, error: "Public key must be 32 bytes" };
  }

  // Extract and validate signature
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(parsed.signature);
  } catch {
    return { valid: false, identity: null, error: "Invalid signature encoding" };
  }
  if (sigBytes.length !== 64) {
    return { valid: false, identity: null, error: "Signature must be 64 bytes" };
  }

  // Verify Ed25519 signature over frontmatter bytes
  const frontmatterBytes = new TextEncoder().encode(parsed.rawFrontmatter);

  const valid = await verifyEd25519(sigBytes, frontmatterBytes, pubKey);

  return {
    valid,
    identity: valid ? parsed.frontmatter : null,
    error: valid ? undefined : "Signature verification failed",
  };
}
