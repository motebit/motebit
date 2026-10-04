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

import { x25519 } from "@noble/curves/ed25519.js";
import type { KeySuccessionRecord, KeyTransferPayload } from "@motebit/protocol";
import {
  encrypt,
  decrypt,
  secureErase,
  bytesToHex,
  hexToBytes,
  base58btcEncode,
  verifyPairingIdentityBinding,
  type PairingRelayCheck,
} from "./index.js";

// Re-use @noble/ed25519 for pubkey derivation in verification step
import * as ed from "@noble/ed25519";

export interface X25519Keypair {
  publicKey: Uint8Array; // 32 bytes
  privateKey: Uint8Array; // 32 bytes
}

/** Generate an ephemeral X25519 keypair for one-time key agreement. */
export function generateX25519Keypair(): X25519Keypair {
  const privateKey = x25519.utils.randomSecretKey(); // v2 rename of randomPrivateKey
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
  options?: {
    /**
     * Device A's own key-succession records (any order, any source — the
     * identity file's chain, the roster replica's). Sent encrypted so Device B
     * can bind a rotated self-certifying id even when the relay has no chain.
     * Empty or absent ⇒ no succession fields (the earlier payload shape).
     */
    successionRecords?: readonly KeySuccessionRecord[];
  },
): Promise<KeyTransferPayload> {
  const ephemeral = generateX25519Keypair();
  const shared = x25519SharedSecret(ephemeral.privateKey, claimingX25519Pubkey);
  const key = await deriveKeyTransferKey(shared, pairingCode);

  try {
    const encrypted = await encrypt(identitySeed, key);

    const payload: KeyTransferPayload = {
      x25519_pubkey: bytesToHex(ephemeral.publicKey),
      encrypted_seed: bytesToHex(encrypted.ciphertext),
      nonce: bytesToHex(encrypted.nonce),
      tag: bytesToHex(encrypted.tag),
      identity_pubkey_check: identityPublicKeyHex.toLowerCase(),
    };

    const records = options?.successionRecords ?? [];
    if (records.length > 0) {
      const sealed = await encrypt(new TextEncoder().encode(JSON.stringify(records)), key);
      payload.encrypted_succession = bytesToHex(sealed.ciphertext);
      payload.succession_nonce = bytesToHex(sealed.nonce);
      payload.succession_tag = bytesToHex(sealed.tag);
    }
    return payload;
  } finally {
    secureErase(ephemeral.privateKey);
    secureErase(shared);
    secureErase(key);
  }
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
  return (await openTransfer(payload, ephemeralPrivateKey, pairingCode)).seed;
}

// Decrypt the seed (verified against identity_pubkey_check) and, when the
// payload carries one, the succession records Device A sealed beside it. The
// records are untrusted input: an absent, undecryptable or unparsable
// succession is `[]` — it can only cost a fallback, never an acceptance.
async function openTransfer(
  payload: KeyTransferPayload,
  ephemeralPrivateKey: Uint8Array,
  pairingCode: string,
): Promise<{ seed: Uint8Array; succession: unknown[] }> {
  const theirPubkey = hexToBytes(payload.x25519_pubkey);
  const shared = x25519SharedSecret(ephemeralPrivateKey, theirPubkey);
  const key = await deriveKeyTransferKey(shared, pairingCode);

  let seed: Uint8Array;
  let succession: unknown[] = [];
  try {
    seed = await decrypt(
      {
        ciphertext: hexToBytes(payload.encrypted_seed),
        nonce: hexToBytes(payload.nonce),
        tag: hexToBytes(payload.tag),
      },
      key,
    );
    if (
      typeof payload.encrypted_succession === "string" &&
      typeof payload.succession_nonce === "string" &&
      typeof payload.succession_tag === "string"
    ) {
      try {
        const bytes = await decrypt(
          {
            ciphertext: hexToBytes(payload.encrypted_succession),
            nonce: hexToBytes(payload.succession_nonce),
            tag: hexToBytes(payload.succession_tag),
          },
          key,
        );
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (Array.isArray(parsed)) succession = parsed;
      } catch {
        succession = [];
      }
    }
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

  return { seed, succession }; // Caller must secureErase the seed after storing
}

/** What Device B may install once {@link openPairingKeyTransfer} accepts. */
export interface OpenedPairingKeyTransfer {
  /** The 32-byte Ed25519 identity seed. Caller MUST secureErase after storing. */
  identitySeed: Uint8Array;
  /** Its public key, lowercase hex (`identity_pubkey_check`, verified against the seed). */
  publicKeyHex: string;
  /** How the relay-supplied motebit_id binds to that key. */
  identityBinding: "sovereign" | "unverified";
  /**
   * Whether the relay's served chain was checked for a fork of that key's
   * lineage. `unreachable` is a weaker acceptance than `no_conflict`: a fork
   * signed by a superseded-key holder cannot have been seen.
   */
  relayCheck: PairingRelayCheck;
  /**
   * The VERIFIED succession links connecting the genesis key the id commits
   * to to `publicKeyHex`, oldest first — taken from whichever source bound it
   * (the chain Device A sealed, or the relay's). Empty for a legacy id and for
   * an id that commits to the key itself. A surface persists exactly these
   * after acceptance (`persistVerifiedLineage` in `@motebit/surface-kit`), so
   * this device can carry the lineage when it later approves another device —
   * an offline rotation is on no relay.
   */
  succession: KeySuccessionRecord[];
}

/**
 * Device B's whole acceptance decision for a pairing approval — the one path
 * every surface's `completePairing` calls, before it writes anything:
 *
 *  1. the key transfer is REQUIRED (every in-tree Device B claims with an
 *     X25519 key and every Device A answers with a transfer — an approval
 *     without one means the relay dropped it);
 *  2. it must decrypt and its seed must re-derive `identity_pubkey_check`;
 *  3. the relay-supplied `motebitId` must bind to that key
 *     ({@link verifyPairingIdentityBinding}): the succession records Device A
 *     sealed inside the transfer are tried first, the relay's public
 *     `GET /succession` (`fetchSuccessionChain`) only when they do not bind;
 *  4. for a self-certifying id, the relay's chain is ALWAYS fetched as well
 *     and checked against the lineage — a verified record that supersedes the
 *     transferred key or forks its lineage refuses ("identity fork detected").
 *     An unreachable relay accepts, reported as `relayCheck: "unreachable"`.
 *
 * Throws `Error("Pairing refused: …")` — the seed erased, nothing returned —
 * on any failure. The caller still owns (and must erase) `ephemeralPrivateKey`.
 */
export async function openPairingKeyTransfer(input: {
  motebitId: string;
  keyTransfer: KeyTransferPayload | null | undefined;
  ephemeralPrivateKey: Uint8Array;
  pairingCode: string;
  /** The relay's public succession chain for `motebitId`: the fallback source and the fork check. */
  fetchSuccessionChain?: () => Promise<readonly unknown[]>;
  /** A guardian public key pinned on THIS device — never one the pairing supplied. */
  guardianKey?: string;
}): Promise<OpenedPairingKeyTransfer> {
  if (input.keyTransfer == null) {
    throw new Error("Pairing refused: the approval carried no identity key transfer");
  }
  let opened: { seed: Uint8Array; succession: unknown[] };
  try {
    opened = await openTransfer(input.keyTransfer, input.ephemeralPrivateKey, input.pairingCode);
  } catch (err) {
    throw new Error("Pairing refused: the identity key transfer could not be verified", {
      cause: err,
    });
  }
  const publicKeyHex = input.keyTransfer.identity_pubkey_check.toLowerCase();
  const binding = await verifyPairingIdentityBinding(input.motebitId, publicKeyHex, {
    successionSources: [opened.succession],
    ...(input.fetchSuccessionChain ? { relaySuccession: input.fetchSuccessionChain } : {}),
    ...(input.guardianKey !== undefined ? { guardianKey: input.guardianKey } : {}),
  });
  if (!binding.accepted || binding.identityBinding === "invalid") {
    secureErase(opened.seed);
    throw new Error(`Pairing refused: ${binding.reason ?? "the motebit_id does not bind"}`);
  }
  return {
    identitySeed: opened.seed,
    publicKeyHex,
    identityBinding: binding.identityBinding,
    relayCheck: binding.relayCheck ?? "not_checked",
    succession: binding.identityBinding === "sovereign" ? (binding.lineage ?? []) : [],
  };
}

/**
 * The persistence gate: of `records` (untrusted — any source), the ones that
 * form a VERIFIED lineage from the genesis key `motebitId` commits to to
 * `publicKeyHex`, oldest first; `[]` when they do not reach it, when the id
 * commits to the key itself, or when the id commits to no key (legacy). Every
 * link is signature-verified and the chain must be continuous and strictly
 * ordered, so a forged, foreign or off-lineage record is never returned.
 * Offline; no relay is consulted. Never throws.
 */
export async function verifiedIdentityLineage(input: {
  motebitId: string;
  publicKeyHex: string;
  records: readonly unknown[];
}): Promise<KeySuccessionRecord[]> {
  const binding = await verifyPairingIdentityBinding(input.motebitId, input.publicKeyHex, {
    successionSources: [input.records],
  });
  return binding.accepted && binding.identityBinding === "sovereign" ? (binding.lineage ?? []) : [];
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

// === Rotation funds preflight (fail-closed) ===
//
// The sibling of `checkPreTransferBalance` for KEY ROTATION. A motebit's
// Solana address IS its current identity key, and a rotation retires that
// key (surfaces erase or overwrite it once the relay records the rotation),
// so value at the retired address would become unrecoverable. Unlike the
// pairing check above — best-effort, a failed read counts as empty — this
// one is FAIL-CLOSED: a balance that cannot be read is never "nothing there".

/** Token-2022 program — owner of token accounts minted under the newer SPL program. */
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EHFLe7ZYgc6UiBV4L3tcz";

/** USDC mints, named in refusals so the owner reads "12.5 USDC", not a mint address. */
const KNOWN_TOKEN_SYMBOLS: Readonly<Record<string, string>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "USDC (devnet)",
};

/** One SPL token holding, in base units. */
export interface WalletTokenHolding {
  mint: string;
  amount: bigint;
  decimals: number;
}

/** Everything an address holds that a rotation could strand. */
export interface WalletHoldings {
  solLamports: bigint;
  tokens: WalletTokenHolding[];
}

/**
 * Reads an address's holdings. MUST throw when it cannot answer — a reader
 * that answers "empty" on failure turns the preflight fail-open.
 */
export type WalletHoldingsReader = (address: string) => Promise<WalletHoldings>;

/**
 * The production reader: one batched Solana JSON-RPC call — native SOL plus
 * every token account under both SPL token programs. Throws on a transport
 * failure, a non-2xx, a JSON-RPC error, or a missing/malformed result.
 */
export function createSolanaHoldingsReader(
  opts: { rpcUrl?: string; fetchImpl?: typeof fetch } = {},
): WalletHoldingsReader {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_SOLANA_RPC;
  const doFetch = opts.fetchImpl ?? fetch;
  return async (address) => {
    const res = await doFetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "getTokenAccountsByOwner",
          params: [address, { programId: TOKEN_PROGRAM_ID }, { encoding: "jsonParsed" }],
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "getTokenAccountsByOwner",
          params: [address, { programId: TOKEN_2022_PROGRAM_ID }, { encoding: "jsonParsed" }],
        },
      ]),
    });
    if (!res.ok) throw new Error(`Solana RPC answered HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new Error("Solana RPC answered a non-batch body");
    const byId = new Map<number, { result?: unknown; error?: { message?: string } }>();
    for (const e of body as { id?: unknown; result?: unknown; error?: { message?: string } }[]) {
      if (typeof e?.id === "number") byId.set(e.id, e);
    }
    const resultOf = (id: number): unknown => {
      const e = byId.get(id);
      if (e == null) throw new Error(`Solana RPC answered no result for request ${id}`);
      if (e.error != null) throw new Error(`Solana RPC error: ${e.error.message ?? "unknown"}`);
      if (e.result == null)
        throw new Error(`Solana RPC answered an empty result for request ${id}`);
      return e.result;
    };
    const bal = (resultOf(1) as { value?: unknown }).value;
    if (typeof bal !== "number" || !Number.isFinite(bal) || bal < 0) {
      throw new Error("Solana RPC answered a malformed balance");
    }
    const tokens: WalletTokenHolding[] = [];
    for (const id of [2, 3]) {
      const value = (resultOf(id) as { value?: unknown }).value;
      if (!Array.isArray(value)) throw new Error("Solana RPC answered malformed token accounts");
      for (const acct of value as {
        account?: {
          data?: {
            parsed?: {
              info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } };
            };
          };
        };
      }[]) {
        const info = acct.account?.data?.parsed?.info;
        const amount = info?.tokenAmount?.amount;
        if (typeof info?.mint !== "string" || typeof amount !== "string" || !/^\d+$/.test(amount)) {
          throw new Error("Solana RPC answered a token account it did not parse");
        }
        tokens.push({
          mint: info.mint,
          amount: BigInt(amount),
          decimals: info.tokenAmount?.decimals ?? 0,
        });
      }
    }
    return { solLamports: BigInt(bal), tokens };
  };
}

/** Base units → decimal string, no float, trailing zeros trimmed ("1.5", "12.5", "1000"). */
function formatUnits(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}

/** Human summary of non-zero holdings: "1.5 SOL, 12.5 USDC, 1000 of token <mint>". */
export function describeWalletHoldings(h: WalletHoldings): string {
  const parts: string[] = [];
  if (h.solLamports > 0n) parts.push(`${formatUnits(h.solLamports, 9)} SOL`);
  for (const t of h.tokens) {
    if (t.amount <= 0n) continue;
    const symbol = KNOWN_TOKEN_SYMBOLS[t.mint];
    parts.push(
      symbol != null
        ? `${formatUnits(t.amount, t.decimals)} ${symbol}`
        : `${formatUnits(t.amount, t.decimals)} of token ${t.mint}`,
    );
  }
  return parts.join(", ");
}

export type RotationFundsVerdict =
  /** Nothing at the retired address: the rotation may proceed. */
  | { kind: "clear"; address: string }
  /** Value at the retired address: refused unless acknowledged. */
  | { kind: "holds-value"; address: string; holdings: WalletHoldings; summary: string }
  /** The balance could not be read: refused unless acknowledged (fail-closed). */
  | { kind: "unknown"; address: string; reason: string };

/**
 * The one rotation preflight every rotation entry point calls BEFORE any
 * side effect. `publicKey` is the key being retired (32 bytes or hex); its
 * address is the base58 of those bytes. Never throws for a reader failure —
 * that is the `unknown` verdict.
 */
export async function checkRotationFunds(opts: {
  publicKey: Uint8Array | string;
  readHoldings: WalletHoldingsReader;
}): Promise<RotationFundsVerdict> {
  const bytes = typeof opts.publicKey === "string" ? hexToBytes(opts.publicKey) : opts.publicKey;
  const address = base58btcEncode(bytes);
  let holdings: WalletHoldings;
  try {
    holdings = await opts.readHoldings(address);
  } catch (err) {
    return { kind: "unknown", address, reason: err instanceof Error ? err.message : String(err) };
  }
  const summary = describeWalletHoldings(holdings);
  if (summary === "") return { kind: "clear", address };
  return { kind: "holds-value", address, holdings, summary };
}

/**
 * The refusal an owner reads. `acknowledge` names this surface's explicit
 * acknowledgment (a CLI flag, a confirm dialog). Says the address, what it
 * holds (or that it could not be read), and both ways forward.
 */
export function rotationFundsRefusal(
  verdict: Exclude<RotationFundsVerdict, { kind: "clear" }>,
  acknowledge: string,
): string {
  const consequence = `Rotating retires this key; anything left at ${verdict.address} can then be moved only with the retired key, which most surfaces erase once the rotation is recorded.`;
  if (verdict.kind === "holds-value") {
    return (
      `rotation refused before anything changed: this identity's wallet ${verdict.address} holds ${verdict.summary}. ${consequence} ` +
      `Either move the funds off ${verdict.address} first (to a wallet you control), then rotate; ` +
      `or rotate anyway with ${acknowledge}, acknowledging the funds stay at the retired key's address.`
    );
  }
  return (
    `rotation refused before anything changed: the balance of this identity's wallet ${verdict.address} could not be read (${verdict.reason}). ${consequence} ` +
    `Either retry when the Solana RPC is reachable (and move any funds off ${verdict.address} first); ` +
    `or, if this key must be retired now (e.g. it is compromised), rotate with ${acknowledge}, acknowledging any funds there stay at the retired key's address.`
  );
}
