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
import { sha512 } from "@noble/hashes/sha512";
import { toHex, fromHex, decrypt } from "./generate.js";
import type { EncryptedKey } from "./generate.js";

// @noble/ed25519 v3 requires explicit SHA-512 binding
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function toBase64Url(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Canonical JSON — must match @motebit/crypto exactly
// ---------------------------------------------------------------------------

function canonicalJson(obj: unknown): string {
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

// ---------------------------------------------------------------------------
// Key succession signing (inlined from @motebit/crypto)
// ---------------------------------------------------------------------------

export interface KeySuccessionRecord {
  old_public_key: string;
  new_public_key: string;
  timestamp: number;
  reason?: string;
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
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
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
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const result = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, plaintext);
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
// Identity file manipulation
// ---------------------------------------------------------------------------

const SIG_PREFIX = "<!-- motebit:sig:Ed25519:";
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
  const sigB64 = toBase64Url(signature);
  const identityFileContent = `${frontmatter}\n${SIG_PREFIX}${sigB64}${SIG_SUFFIX}\n`;

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
  lines.push(`    old_key_signature: "${record.old_key_signature}"`);
  lines.push(`    new_key_signature: "${record.new_key_signature}"`);
  return lines.join("\n");
}
