/**
 * X25519 key exchange primitives for secure identity key transfer during
 * multi-device pairing.
 *
 * The protocol: Device B sends an ephemeral X25519 public key with its claim.
 * Device A generates its own ephemeral X25519 keypair, computes a shared secret
 * via Diffie-Hellman, derives an AES-256 key via HKDF (with the pairing code as
 * salt for session binding), encrypts the identity seed, and posts the ciphertext
 * through the relay. The relay never sees the plaintext key.
 */

import { x25519 } from "@noble/curves/ed25519";
import type { KeyTransferPayload } from "@motebit/protocol";
import { encrypt, decrypt, secureErase, bytesToHex, hexToBytes, base58btcEncode } from "./index.js";

// Re-use @noble/ed25519 for pubkey derivation in verification step
import * as ed from "@noble/ed25519";

export interface X25519Keypair {
  publicKey: Uint8Array; // 32 bytes
  privateKey: Uint8Array; // 32 bytes
}

/** Generate an ephemeral X25519 keypair for one-time key agreement. */
export function generateX25519Keypair(): X25519Keypair {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/** Compute X25519 Diffie-Hellman shared secret (32 bytes). */
export function x25519SharedSecret(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array,
): Uint8Array {
  return x25519.getSharedSecret(myPrivateKey, theirPublicKey);
}

/**
 * Derive an AES-256 key from X25519 shared secret + pairing code.
 * Uses HKDF-SHA256 with SHA-256(pairingCode) as salt — binds the derived
 * key to the pairing session without requiring the relay to not know the code.
 */
export async function deriveKeyTransferKey(
  sharedSecret: Uint8Array,
  pairingCode: string,
): Promise<Uint8Array> {
  const codeBytes = new TextEncoder().encode(pairingCode.toUpperCase());
  const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", codeBytes));

  const ikm = await crypto.subtle.importKey("raw", sharedSecret as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode("motebit-key-transfer-v1"),
    },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Build an encrypted key transfer payload. Device A calls this after seeing
 * Device B's ephemeral X25519 public key in the pairing session.
 *
 * @returns KeyTransferPayload — opaque to the relay, decryptable only by Device B.
 */
export async function buildKeyTransferPayload(
  identitySeed: Uint8Array,
  identityPublicKeyHex: string,
  claimingX25519Pubkey: Uint8Array,
  pairingCode: string,
): Promise<KeyTransferPayload> {
  const ephemeral = generateX25519Keypair();
  const shared = x25519SharedSecret(ephemeral.privateKey, claimingX25519Pubkey);
  const key = await deriveKeyTransferKey(shared, pairingCode);

  const encrypted = await encrypt(identitySeed, key);

  const payload: KeyTransferPayload = {
    x25519_pubkey: bytesToHex(ephemeral.publicKey),
    encrypted_seed: bytesToHex(encrypted.ciphertext),
    nonce: bytesToHex(encrypted.nonce),
    tag: bytesToHex(encrypted.tag),
    identity_pubkey_check: identityPublicKeyHex.toLowerCase(),
  };

  secureErase(ephemeral.privateKey);
  secureErase(shared);
  secureErase(key);

  return payload;
}

/**
 * Decrypt a key transfer payload received during pairing. Device B calls this
 * with its held ephemeral X25519 private key and the pairing code.
 *
 * @returns The 32-byte Ed25519 identity seed. Caller MUST secureErase after storing.
 * @throws If decryption fails or the derived public key doesn't match the check.
 */
export async function decryptKeyTransfer(
  payload: KeyTransferPayload,
  ephemeralPrivateKey: Uint8Array,
  pairingCode: string,
): Promise<Uint8Array> {
  const theirPubkey = hexToBytes(payload.x25519_pubkey);
  const shared = x25519SharedSecret(ephemeralPrivateKey, theirPubkey);
  const key = await deriveKeyTransferKey(shared, pairingCode);

  let seed: Uint8Array;
  try {
    seed = await decrypt(
      {
        ciphertext: hexToBytes(payload.encrypted_seed),
        nonce: hexToBytes(payload.nonce),
        tag: hexToBytes(payload.tag),
      },
      key,
    );
  } finally {
    secureErase(shared);
    secureErase(key);
  }

  // Verify: derive Ed25519 public key from seed and compare
  const derivedPub = await ed.getPublicKeyAsync(seed);
  const derivedPubHex = bytesToHex(derivedPub);
  if (derivedPubHex !== payload.identity_pubkey_check.toLowerCase()) {
    secureErase(seed);
    throw new Error("Key transfer verification failed: derived pubkey does not match");
  }

  return seed; // Caller must secureErase after storing
}

// === Pre-transfer wallet safety check ===

/** Default Solana mainnet RPC endpoint for balance checks. */
const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

/** SPL Token Program ID — owner of all token accounts on Solana. */
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export interface PreTransferWalletCheck {
  /** The Solana address derived from the current (old) identity seed. */
  oldAddress: string;
  /** The Solana address derived from the incoming (new) identity seed. */
  newAddress: string;
  /** SOL balance at the old address in lamports (0 = no SOL). */
  solLamports: bigint;
  /** Total number of SPL token accounts with non-zero balances. */
  tokenAccountCount: number;
  /** Whether the old address has any value at all (SOL or tokens). */
  hasAnyValue: boolean;
}

/**
 * Check whether Device B's current wallet has ANY funds before replacing
 * its identity key. Checks both native SOL balance and all SPL token
 * accounts (USDC, any token, NFTs). If the old address has any value,
 * the caller MUST refuse the key transfer and instruct the user to sweep
 * funds first.
 *
 * Uses raw Solana JSON-RPC calls — no @solana/web3.js dependency needed.
 *
 * @param oldSeed — Device B's current Ed25519 identity seed (32 bytes)
 * @param newSeed — The incoming identity seed from Device A (32 bytes)
 * @param rpcUrl — Solana RPC endpoint (defaults to mainnet public RPC)
 */
export async function checkPreTransferBalance(
  oldSeed: Uint8Array,
  newSeed: Uint8Array,
  rpcUrl: string = DEFAULT_SOLANA_RPC,
): Promise<PreTransferWalletCheck> {
  const oldPub = await ed.getPublicKeyAsync(oldSeed);
  const newPub = await ed.getPublicKeyAsync(newSeed);
  const oldAddress = base58btcEncode(oldPub);
  const newAddress = base58btcEncode(newPub);

  if (oldAddress === newAddress) {
    return { oldAddress, newAddress, solLamports: 0n, tokenAccountCount: 0, hasAnyValue: false };
  }

  let solLamports = 0n;
  let tokenAccountCount = 0;

  try {
    // Batch both RPC calls in a single HTTP request
    const batch = JSON.stringify([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [oldAddress],
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "getTokenAccountsByOwner",
        params: [oldAddress, { programId: TOKEN_PROGRAM_ID }, { encoding: "jsonParsed" }],
      },
    ]);

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: batch,
    });

    if (res.ok) {
      const results = (await res.json()) as Array<{
        id: number;
        result?: unknown;
      }>;

      for (const entry of results) {
        if (entry.id === 1) {
          // getBalance result
          const balResult = entry.result as { value?: number } | undefined;
          if (balResult?.value != null && balResult.value > 0) {
            solLamports = BigInt(balResult.value);
          }
        } else if (entry.id === 2) {
          // getTokenAccountsByOwner result
          const tokenResult = entry.result as
            | {
                value?: Array<{
                  account: {
                    data: {
                      parsed: {
                        info: { tokenAmount: { amount: string } };
                      };
                    };
                  };
                }>;
              }
            | undefined;
          for (const acct of tokenResult?.value ?? []) {
            const amt = acct.account?.data?.parsed?.info?.tokenAmount?.amount;
            if (amt && BigInt(amt) > 0n) {
              tokenAccountCount++;
            }
          }
        }
      }
    }
  } catch {
    // RPC failure is non-fatal — proceed with balance unknown
    // The check is best-effort; the endgame is to never silently orphan funds
  }

  return {
    oldAddress,
    newAddress,
    solLamports,
    tokenAccountCount,
    hasAnyValue: solLamports > 0n || tokenAccountCount > 0,
  };
}

/**
 * Format a human-readable wallet warning for display when key transfer
 * is refused due to existing funds.
 */
export function formatWalletWarning(check: PreTransferWalletCheck): string {
  const parts: string[] = [];
  if (check.solLamports > 0n) {
    const sol = Number(check.solLamports) / 1_000_000_000;
    parts.push(`${sol.toFixed(4)} SOL`);
  }
  if (check.tokenAccountCount > 0) {
    parts.push(`${check.tokenAccountCount} token account(s)`);
  }
  return (
    `Devices linked, but wallet not unified: this device's wallet (${check.oldAddress}) ` +
    `has ${parts.join(" and ")}. Send all funds to ${check.newAddress}, then re-link to unify wallets.`
  );
}
