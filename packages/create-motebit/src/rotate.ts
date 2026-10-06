/**
 * Key rotation for motebit.md identity files.
 *
 * Generates a new Ed25519 keypair, creates a dual-signed succession record,
 * updates the identity file with the new key and succession chain, and
 * persists the new encrypted key to config.
 *
 * Inlines succession signing (zero monorepo deps).
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { toHex, fromHex, decrypt } from "./generate.js";
import type { EncryptedKey } from "./generate.js";

// @noble/ed25519 v3 requires explicit SHA-512 binding
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Canonical JSON — must match @motebit/crypto exactly
// ---------------------------------------------------------------------------

function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const sorted = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const key of sorted) {
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined) continue;
    entries.push(JSON.stringify(key) + ":" + canonicalJson(val));
  }
  return "{" + entries.join(",") + "}";
}

// ---------------------------------------------------------------------------
// Key succession signing (inlined from @motebit/crypto)
// ---------------------------------------------------------------------------

/** Succession records sign under this suite (identity-file suite). */
const KEY_SUCCESSION_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

export interface KeySuccessionRecord {
  old_public_key: string;
  new_public_key: string;
  timestamp: number;
  reason?: string;
  /** Cryptosuite discriminator — must match `@motebit/protocol` SUITE_REGISTRY. */
  suite: typeof KEY_SUCCESSION_SUITE;
  old_key_signature: string;
  new_key_signature: string;
}

async function signKeySuccession(
  oldPrivateKey: Uint8Array,
  newPrivateKey: Uint8Array,
  oldPublicKeyHex: string,
  newPublicKeyHex: string,
  reason?: string,
): Promise<KeySuccessionRecord> {
  const timestamp = Date.now();

  const obj: Record<string, unknown> = {
    new_public_key: newPublicKeyHex,
    old_public_key: oldPublicKeyHex,
    timestamp,
    suite: KEY_SUCCESSION_SUITE,
  };
  if (reason !== undefined) {
    obj.reason = reason;
  }
  const payload = canonicalJson(obj);
  const message = new TextEncoder().encode(payload);

  const oldSig = await ed.signAsync(message, oldPrivateKey);
  const newSig = await ed.signAsync(message, newPrivateKey);

  return {
    old_public_key: oldPublicKeyHex,
    new_public_key: newPublicKeyHex,
    timestamp,
    ...(reason !== undefined ? { reason } : {}),
    suite: KEY_SUCCESSION_SUITE,
    old_key_signature: toHex(oldSig),
    new_key_signature: toHex(newSig),
  };
}

// ---------------------------------------------------------------------------
// Key encryption (same as generate.ts)
// ---------------------------------------------------------------------------

function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  return nonce;
}

function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

/** Default PBKDF2 iterations. Override via MOTEBIT_PBKDF2_ITERATIONS for tests. */
const DEFAULT_PBKDF2_ITERATIONS = (() => {
  if (typeof process === "undefined") return 600_000;
  const override = process.env["MOTEBIT_PBKDF2_ITERATIONS"];
  if (!override) return 600_000;
  const n = Number(override);
  if (n < 100_000 && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      `PBKDF2 iterations (${n}) too low for non-test environment. ` +
        `Set NODE_ENV=test or use >= 100,000 iterations.`,
    );
  }
  return n;
})();

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new Uint8Array(salt), iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

async function encrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array; tag: Uint8Array }> {
  const nonce = generateNonce();
  const cryptoKey = await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, [
    "encrypt",
  ]);
  const result = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: new Uint8Array(nonce) },
    cryptoKey,
    new Uint8Array(plaintext),
  );
  const resultArray = new Uint8Array(result);
  const ciphertext = resultArray.slice(0, resultArray.length - 16);
  const tag = resultArray.slice(resultArray.length - 16);
  return { ciphertext, nonce, tag };
}

async function encryptPrivateKey(privKeyHex: string, passphrase: string): Promise<EncryptedKey> {
  const salt = generateSalt();
  const key = await deriveKey(passphrase, salt);
  const payload = await encrypt(new TextEncoder().encode(privKeyHex), key);
  return {
    ciphertext: toHex(payload.ciphertext),
    nonce: toHex(payload.nonce),
    tag: toHex(payload.tag),
    salt: toHex(salt),
  };
}

// ---------------------------------------------------------------------------
// Decrypt existing private key
// ---------------------------------------------------------------------------

async function decryptPrivateKey(enc: EncryptedKey, passphrase: string): Promise<string> {
  const salt = fromHex(enc.salt);
  const key = await deriveKey(passphrase, salt);
  const plaintext = await decrypt(
    {
      ciphertext: fromHex(enc.ciphertext),
      nonce: fromHex(enc.nonce),
      tag: fromHex(enc.tag),
    },
    key,
  );
  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// Rotation funds preflight (inlined sibling of @motebit/encryption's
// `checkRotationFunds` / `rotationFundsRefusal` — zero monorepo deps)
// ---------------------------------------------------------------------------
//
// A motebit's Solana address IS its identity key. Rotating retires that key,
// so value at its address would be left behind a key nobody uses again. The
// preflight reads the address BEFORE the new key is minted and refuses while
// it holds value — or while it cannot be read (fail-closed) — unless the
// owner passed --abandon-funds. An automatic sweep is deliberately not done.

export interface WalletTokenHolding {
  mint: string;
  amount: bigint;
  decimals: number;
}
export interface WalletHoldings {
  solLamports: bigint;
  tokens: WalletTokenHolding[];
}
/** MUST throw when it cannot answer — a reader that answers "empty" on failure is fail-open. */
export type WalletHoldingsReader = (address: string) => Promise<WalletHoldings>;

const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const SPL_TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EHFLe7ZYgc6UiBV4L3tcz",
];
const KNOWN_TOKEN_SYMBOLS: Readonly<Record<string, string>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "USDC (devnet)",
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** The Solana address of an Ed25519 public key: its 32 bytes, base58. */
export function solanaAddressOf(publicKey: Uint8Array): string {
  let n = 0n;
  for (const b of publicKey) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of publicKey) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** One batched JSON-RPC call: SOL plus token accounts under both SPL programs. Throws on any failure. */
export function createSolanaHoldingsReader(
  rpcUrl: string = DEFAULT_SOLANA_RPC,
): WalletHoldingsReader {
  return async (address) => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] },
        ...SPL_TOKEN_PROGRAMS.map((programId, i) => ({
          jsonrpc: "2.0",
          id: i + 2,
          method: "getTokenAccountsByOwner",
          params: [address, { programId }, { encoding: "jsonParsed" }],
        })),
      ]),
    });
    if (!res.ok) throw new Error(`Solana RPC answered HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error("Solana RPC answered a non-batch body");
    const resultOf = (id: number): { value?: unknown } => {
      const e = (body as { id?: unknown; result?: unknown; error?: { message?: string } }[]).find(
        (x) => x?.id === id,
      );
      if (e?.error != null) throw new Error(`Solana RPC error: ${e.error.message ?? "unknown"}`);
      if (e == null || e.result == null)
        throw new Error(`Solana RPC answered no result for request ${id}`);
      return e.result;
    };
    const bal = resultOf(1).value;
    if (typeof bal !== "number" || !Number.isFinite(bal) || bal < 0) {
      throw new Error("Solana RPC answered a malformed balance");
    }
    const tokens: WalletTokenHolding[] = [];
    for (let id = 2; id < 2 + SPL_TOKEN_PROGRAMS.length; id++) {
      const value = resultOf(id).value;
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

function formatUnits(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}

function describeWalletHoldings(h: WalletHoldings): string {
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

/** The rotation was refused because the retiring key's wallet holds value or could not be read. */
export class RotationFundsRefused extends Error {
  constructor(
    message: string,
    readonly address: string,
  ) {
    super(message);
    this.name = "RotationFundsRefused";
  }
}

/** Throws `RotationFundsRefused` unless the address is empty. */
export async function preflightRotationFunds(
  publicKey: Uint8Array,
  read: WalletHoldingsReader,
): Promise<void> {
  const address = solanaAddressOf(publicKey);
  const consequence = `Rotating retires this key; anything left at ${address} can then be moved only with the retired key.`;
  let holdings: WalletHoldings;
  try {
    holdings = await read(address);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RotationFundsRefused(
      `rotation refused before anything changed: the balance of this identity's wallet ${address} could not be read (${reason}). ${consequence} ` +
        `Either retry when the Solana RPC is reachable (and move any funds off ${address} first); ` +
        `or, if this key must be retired now (e.g. it is compromised), rotate with --abandon-funds, acknowledging any funds there stay at the retired key's address.`,
      address,
    );
  }
  const summary = describeWalletHoldings(holdings);
  if (summary === "") return;
  throw new RotationFundsRefused(
    `rotation refused before anything changed: this identity's wallet ${address} holds ${summary}. ${consequence} ` +
      `Either move the funds off ${address} first (to a wallet you control), then rotate; ` +
      `or rotate anyway with --abandon-funds, acknowledging the funds stay at the retired key's address.`,
    address,
  );
}

// ---------------------------------------------------------------------------
// Identity file manipulation
// ---------------------------------------------------------------------------

// Identity-file signature comment format (cryptosuite-agility):
//   <!-- motebit:sig:motebit-jcs-ed25519-hex-v1:{hex} -->
const IDENTITY_FILE_SUITE = "motebit-jcs-ed25519-hex-v1" as const;
const SIG_PREFIX = `<!-- motebit:sig:${IDENTITY_FILE_SUITE}:`;
const SIG_SUFFIX = " -->";

/**
 * Rotate the key in a motebit.md identity file.
 *
 * Returns the updated identity file content and the new encrypted key
 * for config persistence.
 */
export async function rotateKey(opts: {
  identityFileContent: string;
  encryptedOldKey: EncryptedKey;
  oldPassphrase: string;
  newPassphrase: string;
  reason?: string;
  /** Reads the retiring key's wallet before the new key is minted (throws when it cannot answer). */
  readWalletHoldings: WalletHoldingsReader;
  /** `--abandon-funds`: rotate even though that wallet holds value or cannot be read. */
  abandonFunds?: boolean;
}): Promise<{
  identityFileContent: string;
  newPublicKeyHex: string;
  oldPublicKeyHex: string;
  newEncryptedKey: EncryptedKey;
  rotationCount: number;
}> {
  // 1. Parse the existing identity file
  const firstDash = opts.identityFileContent.indexOf("---\n");
  if (firstDash === -1) throw new Error("Missing frontmatter opening ---");
  const bodyStart = firstDash + 4;
  const secondDash = opts.identityFileContent.indexOf("\n---", bodyStart);
  if (secondDash === -1) throw new Error("Missing frontmatter closing ---");
  const rawFrontmatter = opts.identityFileContent.slice(bodyStart, secondDash);

  // 2. Extract old public key from YAML
  const pubKeyMatch = rawFrontmatter.match(/public_key:\s*"([0-9a-f]+)"/);
  if (!pubKeyMatch) throw new Error("Could not find public_key in identity file");
  const oldPublicKeyHex = pubKeyMatch[1]!;

  // 3. Decrypt old private key
  const oldPrivateKeyHex = await decryptPrivateKey(opts.encryptedOldKey, opts.oldPassphrase);
  const oldPrivateKey = fromHex(oldPrivateKeyHex);

  // Verify the old key matches
  const derivedPubKey = await ed.getPublicKeyAsync(oldPrivateKey);
  const derivedPubKeyHex = toHex(derivedPubKey);
  if (derivedPubKeyHex !== oldPublicKeyHex) {
    throw new Error("Decrypted private key does not match public key in identity file");
  }

  // 3b. The wallet this rotation would retire, read BEFORE the new key exists.
  if (opts.abandonFunds !== true) {
    await preflightRotationFunds(derivedPubKey, opts.readWalletHoldings);
  }

  // 4. Generate new Ed25519 keypair
  const { secretKey: newPrivateKey, publicKey: newPublicKey } = await ed.keygenAsync();
  const newPublicKeyHex = toHex(newPublicKey);
  const newPrivateKeyHex = toHex(newPrivateKey);

  // 5. Create succession record
  const succession = await signKeySuccession(
    oldPrivateKey,
    newPrivateKey,
    oldPublicKeyHex,
    newPublicKeyHex,
    opts.reason,
  );

  // 6. Update the YAML: replace ONLY the identity public_key, add succession record
  // Target the exact old key value to avoid corrupting old_public_key / new_public_key
  // in existing succession records (which contain the substring "public_key:").
  let updatedYaml = rawFrontmatter.replace(
    `public_key: "${oldPublicKeyHex}"`,
    `public_key: "${newPublicKeyHex}"`,
  );

  // Build the succession YAML entry
  const successionEntry = buildSuccessionYaml(succession);

  // Check if succession array already exists
  const successionIdx = updatedYaml.indexOf("\nsuccession:");
  if (successionIdx !== -1) {
    // Append to existing succession array — find the end and add the new entry
    // The succession entries start with "- old_public_key:" indented
    // Find the last line of the succession section
    const lines = updatedYaml.split("\n");
    let lastSuccessionLine = -1;
    let inSuccession = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === "succession:") {
        inSuccession = true;
        continue;
      }
      if (inSuccession) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("- ") || (line.startsWith("  ") && trimmed.length > 0)) {
          lastSuccessionLine = i;
        } else if (trimmed.length > 0 && !line.startsWith("  ")) {
          break;
        }
      }
    }
    if (lastSuccessionLine !== -1) {
      lines.splice(lastSuccessionLine + 1, 0, successionEntry);
      updatedYaml = lines.join("\n");
    }
  } else {
    // Add succession section at the end
    updatedYaml += `\nsuccession:\n${successionEntry}`;
  }

  // 7. Re-sign with new key
  const frontmatter = `---\n${updatedYaml}\n---`;
  const frontmatterBytes = new TextEncoder().encode(updatedYaml);
  const signature = await ed.signAsync(frontmatterBytes, newPrivateKey);
  const sigHex = toHex(signature);
  const identityFileContent = `${frontmatter}\n${SIG_PREFIX}${sigHex}${SIG_SUFFIX}\n`;

  // 8. Encrypt new private key
  const newEncryptedKey = await encryptPrivateKey(newPrivateKeyHex, opts.newPassphrase);

  // Count rotations
  const successionCount = (updatedYaml.match(/- old_public_key:/g) || []).length;

  return {
    identityFileContent,
    newPublicKeyHex,
    oldPublicKeyHex,
    newEncryptedKey,
    rotationCount: successionCount,
  };
}

function buildSuccessionYaml(record: KeySuccessionRecord): string {
  const lines: string[] = [];
  lines.push(`  - old_public_key: "${record.old_public_key}"`);
  lines.push(`    new_public_key: "${record.new_public_key}"`);
  lines.push(`    timestamp: ${record.timestamp}`);
  if (record.reason !== undefined) {
    lines.push(`    reason: ${JSON.stringify(record.reason)}`);
  }
  lines.push(`    suite: "${record.suite}"`);
  lines.push(`    old_key_signature: "${record.old_key_signature}"`);
  lines.push(`    new_key_signature: "${record.new_key_signature}"`);
  return lines.join("\n");
}
