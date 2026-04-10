/**
 * @motebit/crypto — Protocol cryptography for Motebit artifacts.
 *
 * Sign and verify identity files, execution receipts, verifiable credentials,
 * delegation tokens, key successions, and presentations. One package, any
 * artifact, zero monorepo dependencies.
 *
 * Zero monorepo dependencies — only @noble/ed25519 for cryptography.
 *
 * Usage:
 *   import { verify } from "@motebit/crypto";
 *
 *   // Verify any artifact
 *   const result = await verify(fs.readFileSync("motebit.md", "utf-8"));
 *
 *   // Sign an execution receipt
 *   import { signExecutionReceipt } from "@motebit/crypto";
 *   const signed = await signExecutionReceipt(receipt, privateKey, publicKey);
 *
 *   // Issue a verifiable credential
 *   import { issueReputationCredential } from "@motebit/crypto";
 *   const vc = await issueReputationCredential(snapshot, privateKey, publicKey, did);
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// @noble/ed25519 v3 requires explicit SHA-512 binding
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

// ===========================================================================
// Types — Identity (motebit/identity@1.0 schema)
// ===========================================================================

export interface MotebitIdentityFile {
  spec: string;
  motebit_id: string;
  created_at: string;
  owner_id: string;

  // Service identity fields (optional, spec §3.6)
  type?: "personal" | "service" | "collaborative";
  service_name?: string;
  service_description?: string;
  service_url?: string;
  capabilities?: string[];
  terms_url?: string;

  identity: {
    algorithm: "Ed25519";
    public_key: string;
  };

  governance: {
    trust_mode: "full" | "guarded" | "minimal";
    max_risk_auto: string;
    require_approval_above: string;
    deny_above: string;
    operator_mode: boolean;
  };

  privacy: {
    default_sensitivity: string;
    retention_days: Record<string, number>;
    fail_closed: boolean;
  };

  memory: {
    half_life_days: number;
    confidence_threshold: number;
    per_turn_limit: number;
  };

  /** Organizational guardian for key recovery and enterprise custody (§3.3). */
  guardian?: {
    public_key: string;
    organization?: string;
    organization_id?: string;
    established_at: string;
    /** Ed25519 signature proving guardian governs this agent. */
    attestation?: string;
  };

  devices: Array<{
    device_id: string;
    name: string;
    public_key: string;
    registered_at: string;
  }>;

  succession?: Array<SuccessionRecord>;
}

export interface SuccessionRecord {
  old_public_key: string;
  new_public_key: string;
  timestamp: number;
  reason?: string;
  old_key_signature?: string;
  new_key_signature: string;
  /** True when succession was authorized by guardian, not old key. */
  recovery?: boolean;
  /** Guardian signature — present only when recovery is true. */
  guardian_signature?: string;
}

// ===========================================================================
// Types — Execution Receipt
// ===========================================================================

export interface ExecutionReceipt {
  task_id: string;
  motebit_id: string;
  /** Signer's Ed25519 public key (hex). Enables verification without relay lookup. */
  public_key?: string;
  device_id: string;
  submitted_at: number;
  completed_at: number;
  status: string;
  result: string;
  tools_used: string[];
  memories_formed: number;
  prompt_hash: string;
  result_hash: string;
  delegation_receipts?: ExecutionReceipt[];
  delegated_scope?: string;
  signature: string;
}

// ===========================================================================
// Types — W3C Verifiable Credentials / Presentations
// Canonical definitions in credentials.ts; re-exported here for verify consumers.
// ===========================================================================

export type {
  DataIntegrityProof,
  VerifiableCredential,
  VerifiablePresentation,
} from "./credentials.js";
import type {
  DataIntegrityProof,
  VerifiableCredential,
  VerifiablePresentation,
} from "./credentials.js";

// ===========================================================================
// Types — Verification Results (discriminated union)
// ===========================================================================

export interface VerificationError {
  message: string;
  path?: string;
}

interface BaseResult {
  valid: boolean;
  errors?: VerificationError[];
}

export interface IdentityVerifyResult extends BaseResult {
  type: "identity";
  identity: MotebitIdentityFile | null;
  did?: string;
  /** First error message. Convenience accessor for backward compatibility. */
  error?: string;
  succession?: {
    valid: boolean;
    genesis_public_key?: string;
    rotations: number;
    error?: string;
  };
}

export interface ReceiptVerifyResult extends BaseResult {
  type: "receipt";
  receipt: ExecutionReceipt | null;
  signer?: string;
  delegations?: ReceiptVerifyResult[];
}

export interface CredentialVerifyResult extends BaseResult {
  type: "credential";
  credential: VerifiableCredential | null;
  issuer?: string;
  subject?: string;
  expired?: boolean;
}

export interface PresentationVerifyResult extends BaseResult {
  type: "presentation";
  presentation: VerifiablePresentation | null;
  holder?: string;
  credentials?: CredentialVerifyResult[];
}

export type VerifyResult =
  | IdentityVerifyResult
  | ReceiptVerifyResult
  | CredentialVerifyResult
  | PresentationVerifyResult;

export type ArtifactType = VerifyResult["type"];

export interface VerifyOptions {
  expectedType?: ArtifactType;
  /** Clock skew tolerance in seconds for credential expiry checks. Default: 60. */
  clockSkewSeconds?: number;
}

// ===========================================================================
// Legacy VerifyResult — backward compatible with pre-0.4.0
// ===========================================================================

/** @deprecated Use VerifyResult instead. Kept for backward compatibility. */
export interface LegacyVerifyResult {
  valid: boolean;
  identity: MotebitIdentityFile | null;
  did?: string;
  error?: string;
  succession?: {
    valid: boolean;
    genesis_public_key?: string;
    rotations: number;
    error?: string;
  };
}

// ===========================================================================
// Minimal YAML parser — handles only the motebit identity schema
// ===========================================================================

function parseYamlValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return JSON.parse(trimmed);
  }

  const num = Number(trimmed);
  if (trimmed !== "" && !isNaN(num) && isFinite(num)) return num;

  return trimmed;
}

function parseYaml(text: string): MotebitIdentityFile {
  const lines = text.split("\n");
  const root: Record<string, unknown> = {};
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
    { obj: root, indent: -1 },
  ];
  let currentArray: unknown[] | null = null;
  let currentArrayIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const lineIndent = line.length - line.trimStart().length;
    const trimmed = line.trimStart();

    if (trimmed.startsWith("- ")) {
      const itemContent = trimmed.slice(2);
      const colonIdx = itemContent.indexOf(": ");

      if (colonIdx !== -1) {
        const obj: Record<string, unknown> = {};
        const key = itemContent.slice(0, colonIdx);
        const val = itemContent.slice(colonIdx + 2);
        obj[key] = parseYamlValue(val);

        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j]!;
          if (nextLine.trim() === "") continue;
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          const nextTrimmed = nextLine.trimStart();

          if (nextIndent > lineIndent && !nextTrimmed.startsWith("- ")) {
            const nextColonIdx = nextTrimmed.indexOf(": ");
            if (nextColonIdx !== -1) {
              const nk = nextTrimmed.slice(0, nextColonIdx);
              const nv = nextTrimmed.slice(nextColonIdx + 2);
              obj[nk] = parseYamlValue(nv);
              i = j;
            }
          } else {
            break;
          }
        }

        if (currentArray) currentArray.push(obj);
      } else {
        if (currentArray) currentArray.push(parseYamlValue(itemContent));
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(": ");
    const endsWithColon = trimmed.endsWith(":") && colonIdx === -1;

    if (endsWithColon) {
      const key = trimmed.slice(0, -1);

      if (currentArray && lineIndent <= currentArrayIndent) {
        currentArray = null;
        currentArrayIndent = -1;
      }

      while (stack.length > 1 && stack[stack.length - 1]!.indent >= lineIndent) {
        stack.pop();
      }

      const parent = stack[stack.length - 1]!.obj;

      let nextIdx = i + 1;
      while (nextIdx < lines.length && lines[nextIdx]!.trim() === "") nextIdx++;

      if (nextIdx < lines.length && lines[nextIdx]!.trimStart().startsWith("- ")) {
        const arr: unknown[] = [];
        parent[key] = arr;
        currentArray = arr;
        currentArrayIndent = lineIndent;
      } else {
        const nested: Record<string, unknown> = {};
        parent[key] = nested;
        stack.push({ obj: nested, indent: lineIndent });
      }
      continue;
    }

    if (colonIdx !== -1) {
      if (currentArray && lineIndent <= currentArrayIndent) {
        currentArray = null;
        currentArrayIndent = -1;
      }

      while (stack.length > 1 && stack[stack.length - 1]!.indent >= lineIndent) {
        stack.pop();
      }

      const key = trimmed.slice(0, colonIdx);
      const val = trimmed.slice(colonIdx + 2);
      const parent = stack[stack.length - 1]!.obj;
      parent[key] = parseYamlValue(val);
    }
  }

  return root as unknown as MotebitIdentityFile;
}

// ===========================================================================
// Encoding helpers
// ===========================================================================

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function fromBase64Url(str: string): Uint8Array {
  // Replace URL-safe chars and re-pad (atob requires padding in some environments)
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad === 2) base64 += "==";
  else if (pad === 3) base64 += "=";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ===========================================================================
// Canonical JSON (JCS/RFC 8785) — must match @motebit/crypto exactly
// ===========================================================================

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

// ===========================================================================
// Base58btc encoding/decoding (for did:key and VC proof values)
// ===========================================================================

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcEncode(bytes: Uint8Array): string {
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

function base58btcDecode(str: string): Uint8Array {
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

// ===========================================================================
// did:key derivation and parsing
// ===========================================================================

function publicKeyToDidKey(pubKey: Uint8Array): string {
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(pubKey, 2);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

function didKeyToPublicKey(did: string): Uint8Array {
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

// ===========================================================================
// SHA-256 (Web Crypto — available in Node 18+ and all browsers)
// ===========================================================================

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

// ===========================================================================
// Constants
// ===========================================================================

const SIG_PREFIX = "<!-- motebit:sig:Ed25519:";
const SIG_SUFFIX = " -->";

// ===========================================================================
// Artifact detection
// ===========================================================================

function detectArtifactType(artifact: unknown): ArtifactType | null {
  // String → identity file (YAML frontmatter) or JSON
  if (typeof artifact === "string") {
    // Any string containing frontmatter delimiters is an identity file attempt
    if (artifact.includes("---")) {
      return "identity";
    }
    // Try parsing as JSON
    try {
      const parsed = JSON.parse(artifact) as unknown;
      return detectArtifactType(parsed);
    } catch {
      return null;
    }
  }

  if (typeof artifact !== "object" || artifact === null) return null;

  const obj = artifact as Record<string, unknown>;

  // Verifiable Presentation: has "holder" + "verifiableCredential" + "proof"
  if ("holder" in obj && "verifiableCredential" in obj && "proof" in obj) {
    return "presentation";
  }

  // Verifiable Credential: has "credentialSubject" + "issuer" + "proof"
  if ("credentialSubject" in obj && "issuer" in obj && "proof" in obj) {
    return "credential";
  }

  // Execution Receipt: has "task_id" + "motebit_id" + "signature" + "prompt_hash"
  if ("task_id" in obj && "motebit_id" in obj && "signature" in obj && "prompt_hash" in obj) {
    return "receipt";
  }

  return null;
}

// ===========================================================================
// Identity file parsing and verification
// ===========================================================================

/**
 * Parse a motebit.md file into its components.
 * Does not verify the signature — use `verify()` for that.
 */
export function parse(content: string): {
  frontmatter: MotebitIdentityFile;
  signature: string;
  rawFrontmatter: string;
} {
  const firstDash = content.indexOf("---\n");
  if (firstDash === -1) throw new Error("Missing frontmatter opening ---");

  const bodyStart = firstDash + 4;
  const secondDash = content.indexOf("\n---", bodyStart);
  if (secondDash === -1) throw new Error("Missing frontmatter closing ---");

  const rawFrontmatter = content.slice(bodyStart, secondDash);
  const frontmatter = parseYaml(rawFrontmatter);

  const sigStart = content.indexOf(SIG_PREFIX);
  if (sigStart === -1) throw new Error("Missing signature");

  const sigValueStart = sigStart + SIG_PREFIX.length;
  const sigEnd = content.indexOf(SIG_SUFFIX, sigValueStart);
  if (sigEnd === -1) throw new Error("Malformed signature");

  const signature = content.slice(sigValueStart, sigEnd);

  return { frontmatter, signature, rawFrontmatter };
}

function identityError(msg: string): IdentityVerifyResult {
  return { type: "identity", valid: false, identity: null, error: msg, errors: [{ message: msg }] };
}

async function verifyIdentity(content: string): Promise<IdentityVerifyResult> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return identityError(msg);
  }

  const pubKeyHex = parsed.frontmatter.identity?.public_key;
  if (!pubKeyHex) {
    return identityError("No public key in frontmatter");
  }

  let pubKey: Uint8Array;
  try {
    pubKey = hexToBytes(pubKeyHex);
  } catch {
    return identityError("Invalid public key hex");
  }
  if (pubKey.length !== 32) {
    return identityError("Public key must be 32 bytes");
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(parsed.signature);
  } catch {
    return identityError("Invalid signature encoding");
  }
  if (sigBytes.length !== 64) {
    return identityError("Signature must be 64 bytes");
  }

  const frontmatterBytes = new TextEncoder().encode(parsed.rawFrontmatter);

  let valid: boolean;
  try {
    valid = await ed.verifyAsync(sigBytes, frontmatterBytes, pubKey);
  } catch {
    valid = false;
  }

  if (!valid) {
    return identityError("Signature verification failed");
  }

  // Verify guardian attestation if present — proves the guardian governs this agent (§3.3).
  // The attestation is an Ed25519 signature by the guardian's private key over the canonical
  // JSON of {action:"guardian_attestation", guardian_public_key, motebit_id}.
  const guardian = parsed.frontmatter.guardian;
  if (guardian?.attestation && guardian.public_key) {
    const motebitId = parsed.frontmatter.motebit_id;
    const attestPayload = canonicalJson({
      action: "guardian_attestation",
      guardian_public_key: guardian.public_key,
      motebit_id: motebitId,
    });
    const attestMessage = new TextEncoder().encode(attestPayload);
    let guardianPubKey: Uint8Array;
    try {
      guardianPubKey = hexToBytes(guardian.public_key);
    } catch {
      return identityError("Invalid guardian public key hex");
    }
    if (guardianPubKey.length !== 32) {
      return identityError("Guardian public key must be 32 bytes");
    }
    let attestSig: Uint8Array;
    try {
      attestSig = hexToBytes(guardian.attestation);
    } catch {
      return identityError("Invalid guardian attestation encoding");
    }
    let attestValid: boolean;
    try {
      attestValid = await ed.verifyAsync(attestSig, attestMessage, guardianPubKey);
    } catch {
      attestValid = false;
    }
    if (!attestValid) {
      return identityError("Guardian attestation signature verification failed");
    }
  }

  const chain = parsed.frontmatter.succession;
  let successionResult: IdentityVerifyResult["succession"];

  if (chain && chain.length > 0) {
    const guardianPubKeyHex = parsed.frontmatter.guardian?.public_key;
    successionResult = await verifySuccessionChain(chain, pubKeyHex, guardianPubKeyHex);
  }

  return {
    type: "identity",
    valid: true,
    identity: parsed.frontmatter,
    did: publicKeyToDidKey(pubKey),
    ...(successionResult ? { succession: successionResult } : {}),
  };
}

// ===========================================================================
// Succession chain verification
// ===========================================================================

async function verifySuccessionChain(
  chain: SuccessionRecord[],
  currentPublicKeyHex: string,
  guardianPublicKeyHex?: string,
): Promise<NonNullable<IdentityVerifyResult["succession"]>> {
  try {
    for (let i = 0; i < chain.length; i++) {
      const record = chain[i]!;

      const payloadObj: Record<string, unknown> = {
        old_public_key: record.old_public_key,
        new_public_key: record.new_public_key,
        timestamp: record.timestamp,
      };
      if (record.reason !== undefined) {
        payloadObj.reason = record.reason;
      }
      if (record.recovery) {
        payloadObj.recovery = true;
      }
      const payload = canonicalJson(payloadObj);
      const message = new TextEncoder().encode(payload);

      // Verify new_key_signature (always required)
      const newPubKey = hexToBytes(record.new_public_key);
      const newSig = hexToBytes(record.new_key_signature);
      const newValid = await ed.verifyAsync(newSig, message, newPubKey);
      if (!newValid) {
        return {
          valid: false,
          rotations: chain.length,
          error: `Succession record ${i}: new_key_signature verification failed`,
        };
      }

      if (record.recovery) {
        // Guardian recovery: verify guardian_signature against guardian.public_key
        if (!guardianPublicKeyHex) {
          return {
            valid: false,
            rotations: chain.length,
            error: `Succession record ${i}: guardian recovery but no guardian public key in identity`,
          };
        }
        if (!record.guardian_signature) {
          return {
            valid: false,
            rotations: chain.length,
            error: `Succession record ${i}: guardian recovery but no guardian_signature`,
          };
        }
        const guardianPubKey = hexToBytes(guardianPublicKeyHex);
        const guardianSig = hexToBytes(record.guardian_signature);
        const guardianValid = await ed.verifyAsync(guardianSig, message, guardianPubKey);
        if (!guardianValid) {
          return {
            valid: false,
            rotations: chain.length,
            error: `Succession record ${i}: guardian_signature verification failed`,
          };
        }
      } else {
        // Normal rotation: verify old_key_signature
        if (!record.old_key_signature) {
          return {
            valid: false,
            rotations: chain.length,
            error: `Succession record ${i}: normal rotation but no old_key_signature`,
          };
        }
        const oldPubKey = hexToBytes(record.old_public_key);
        const oldSig = hexToBytes(record.old_key_signature);
        const oldValid = await ed.verifyAsync(oldSig, message, oldPubKey);
        if (!oldValid) {
          return {
            valid: false,
            rotations: chain.length,
            error: `Succession record ${i}: old_key_signature verification failed`,
          };
        }
      }

      if (i < chain.length - 1) {
        const next = chain[i + 1]!;
        if (record.new_public_key !== next.old_public_key) {
          return {
            valid: false,
            rotations: chain.length,
            error: `Succession chain broken at record ${i}: new_public_key does not match next record's old_public_key`,
          };
        }
      }

      if (i < chain.length - 1) {
        const next = chain[i + 1]!;
        if (record.timestamp >= next.timestamp) {
          return {
            valid: false,
            rotations: chain.length,
            error: `Succession chain temporal ordering violated at record ${i}`,
          };
        }
      }
    }

    const lastRecord = chain[chain.length - 1]!;
    if (lastRecord.new_public_key !== currentPublicKeyHex) {
      return {
        valid: false,
        rotations: chain.length,
        error: "Succession chain terminal: last new_public_key does not match identity public_key",
      };
    }

    return {
      valid: true,
      genesis_public_key: chain[0]!.old_public_key,
      rotations: chain.length,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      rotations: 0,
      error: `Succession verification error: ${msg}`,
    };
  }
}

// ===========================================================================
// Receipt verification
// ===========================================================================

async function verifyReceiptSignature(
  receipt: ExecutionReceipt,
  publicKey: Uint8Array,
): Promise<{ valid: boolean; error?: string }> {
  const { signature, ...body } = receipt;

  if (!signature || signature.trim() === "") {
    return { valid: false, error: "Receipt signature is empty" };
  }

  let sig: Uint8Array;
  try {
    sig = fromBase64Url(signature);
  } catch {
    return { valid: false, error: "Receipt signature is not valid base64url" };
  }

  if (sig.length !== 64) {
    return { valid: false, error: `Receipt signature must be 64 bytes, got ${sig.length}` };
  }

  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const valid = await ed.verifyAsync(sig, message, publicKey);
    return { valid };
  } catch {
    return { valid: false, error: "Ed25519 verification threw" };
  }
}

async function verifyReceipt(receipt: ExecutionReceipt): Promise<ReceiptVerifyResult> {
  // Resolve public key: embedded in receipt, or fail
  let publicKey: Uint8Array | null = null;
  let signerDid: string | undefined;

  if (receipt.public_key) {
    try {
      publicKey = hexToBytes(receipt.public_key);
      if (publicKey.length === 32) {
        signerDid = publicKeyToDidKey(publicKey);
      } else {
        publicKey = null;
      }
    } catch {
      publicKey = null;
    }
  }

  if (!publicKey) {
    // Recursively verify delegations even if root can't be verified
    const delegations = await verifyReceiptDelegations(receipt);
    return {
      type: "receipt",
      valid: false,
      receipt,
      errors: [{ message: "No embedded public_key — cannot verify without known keys" }],
      ...(delegations.length > 0 ? { delegations } : {}),
    };
  }

  const sigResult = await verifyReceiptSignature(receipt, publicKey);
  const errors: VerificationError[] = [];

  if (!sigResult.valid) {
    errors.push({ message: sigResult.error ?? "Receipt signature verification failed" });
  }

  // Recursively verify delegation receipts
  const delegations = await verifyReceiptDelegations(receipt);
  const delegationErrors = delegations.filter((d) => !d.valid);
  for (const d of delegationErrors) {
    errors.push({
      message: `Delegation ${d.receipt?.task_id ?? "unknown"}: verification failed`,
      path: `delegation_receipts`,
    });
  }

  return {
    type: "receipt",
    valid: sigResult.valid && delegationErrors.length === 0,
    receipt,
    signer: signerDid,
    ...(delegations.length > 0 ? { delegations } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function verifyReceiptDelegations(receipt: ExecutionReceipt): Promise<ReceiptVerifyResult[]> {
  if (!receipt.delegation_receipts || receipt.delegation_receipts.length === 0) {
    return [];
  }
  return Promise.all(receipt.delegation_receipts.map((dr) => verifyReceipt(dr)));
}

// ===========================================================================
// Verifiable Credential verification (eddsa-jcs-2022)
// ===========================================================================

async function verifyDataIntegrity(
  document: Record<string, unknown>,
  proof: DataIntegrityProof,
): Promise<boolean> {
  if (proof.type !== "DataIntegrityProof" || proof.cryptosuite !== "eddsa-jcs-2022") {
    return false;
  }

  // Extract public key from verificationMethod (did:key URI)
  const did = proof.verificationMethod.split("#")[0]!;
  let publicKey: Uint8Array;
  try {
    publicKey = didKeyToPublicKey(did);
  } catch {
    return false;
  }

  // Reconstruct proof options (without proofValue)
  const { proofValue, ...proofOptions } = proof;

  const encoder = new TextEncoder();

  // Hash proof options and document separately
  const proofHash = await sha256(encoder.encode(canonicalJson(proofOptions)));
  const { proof: _proof, ...docWithoutProof } = document;
  const docHash = await sha256(encoder.encode(canonicalJson(docWithoutProof)));

  // Concatenate hashes and verify
  const combined = new Uint8Array(proofHash.length + docHash.length);
  combined.set(proofHash);
  combined.set(docHash, proofHash.length);

  // Decode signature (strip "z" prefix — base58btc multibase)
  if (!proofValue.startsWith("z")) return false;
  let signature: Uint8Array;
  try {
    signature = base58btcDecode(proofValue.slice(1));
  } catch {
    return false;
  }

  try {
    return await ed.verifyAsync(signature, combined, publicKey);
  } catch {
    return false;
  }
}

const DEFAULT_CLOCK_SKEW_SECONDS = 60;

async function verifyCredential(
  vc: VerifiableCredential,
  clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
): Promise<CredentialVerifyResult> {
  const errors: VerificationError[] = [];

  // Check expiry (with clock skew tolerance for distributed systems)
  let expired = false;
  if (vc.validUntil) {
    const expiresAt = new Date(vc.validUntil).getTime();
    const skewMs = clockSkewSeconds * 1000;
    if (Date.now() > expiresAt + skewMs) {
      expired = true;
      errors.push({ message: "Credential has expired", path: "validUntil" });
    }
  }

  // Verify proof
  const proofValid = await verifyDataIntegrity(vc as unknown as Record<string, unknown>, vc.proof);
  if (!proofValid) {
    errors.push({ message: "Credential proof verification failed", path: "proof" });
  }

  // Extract issuer DID
  const issuerDid = typeof vc.issuer === "string" ? vc.issuer : undefined;
  const subjectId = vc.credentialSubject?.id;

  return {
    type: "credential",
    valid: proofValid && !expired,
    credential: vc,
    issuer: issuerDid,
    subject: subjectId,
    expired,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// ===========================================================================
// Verifiable Presentation verification
// ===========================================================================

async function verifyPresentation(
  vp: VerifiablePresentation,
  clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
): Promise<PresentationVerifyResult> {
  const errors: VerificationError[] = [];

  // Verify VP envelope proof
  const envelopeValid = await verifyDataIntegrity(
    vp as unknown as Record<string, unknown>,
    vp.proof,
  );
  if (!envelopeValid) {
    errors.push({ message: "Presentation proof verification failed", path: "proof" });
  }

  // Verify each contained credential
  const credentialResults: CredentialVerifyResult[] = [];
  for (let i = 0; i < vp.verifiableCredential.length; i++) {
    const vc = vp.verifiableCredential[i]!;
    const vcResult = await verifyCredential(vc, clockSkewSeconds);
    credentialResults.push(vcResult);
    if (!vcResult.valid) {
      errors.push({
        message: `Credential ${i} verification failed`,
        path: `verifiableCredential[${i}]`,
      });
    }
  }

  const allValid = envelopeValid && credentialResults.every((c) => c.valid);

  return {
    type: "presentation",
    valid: allValid,
    presentation: vp,
    holder: vp.holder,
    credentials: credentialResults,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Verify any Motebit artifact: identity file, execution receipt,
 * verifiable credential, or verifiable presentation.
 *
 * Accepts strings (identity files, JSON) or parsed objects (receipts,
 * credentials, presentations). Detects the artifact type automatically.
 *
 * Use `options.expectedType` to fail fast if the artifact doesn't match
 * the expected type.
 *
 * @example
 * ```ts
 * import { verify } from "@motebit/crypto";
 *
 * // Identity file (string)
 * const r1 = await verify(identityFileContent);
 * if (r1.type === "identity" && r1.valid) console.log(r1.did);
 *
 * // Execution receipt (object or JSON string)
 * const r2 = await verify(receipt, { expectedType: "receipt" });
 * if (r2.type === "receipt" && r2.valid) console.log(r2.signer);
 *
 * // Verifiable credential
 * const r3 = await verify(credential);
 * if (r3.type === "credential" && r3.valid) console.log(r3.issuer);
 * ```
 */
export async function verify(artifact: unknown, options?: VerifyOptions): Promise<VerifyResult> {
  const detected = detectArtifactType(artifact);

  if (detected === null) {
    // Return a generic failure — use identity as the default type for backward compat
    const fallbackType = options?.expectedType ?? "identity";
    return {
      type: fallbackType,
      valid: false,
      ...(fallbackType === "identity" ? { identity: null } : {}),
      ...(fallbackType === "receipt" ? { receipt: null } : {}),
      ...(fallbackType === "credential" ? { credential: null } : {}),
      ...(fallbackType === "presentation" ? { presentation: null } : {}),
      errors: [{ message: "Unrecognized artifact format" }],
    } as VerifyResult;
  }

  if (options?.expectedType && options.expectedType !== detected) {
    return {
      type: detected,
      valid: false,
      ...(detected === "identity" ? { identity: null } : {}),
      ...(detected === "receipt" ? { receipt: null } : {}),
      ...(detected === "credential" ? { credential: null } : {}),
      ...(detected === "presentation" ? { presentation: null } : {}),
      errors: [{ message: `Expected type "${options.expectedType}" but detected "${detected}"` }],
    } as VerifyResult;
  }

  // Parse JSON strings into objects for non-identity types
  let resolved = artifact;
  if (typeof artifact === "string" && detected !== "identity") {
    try {
      resolved = JSON.parse(artifact) as unknown;
    } catch {
      return {
        type: detected,
        valid: false,
        ...(detected === "receipt" ? { receipt: null } : {}),
        ...(detected === "credential" ? { credential: null } : {}),
        ...(detected === "presentation" ? { presentation: null } : {}),
        errors: [{ message: "Failed to parse JSON" }],
      } as VerifyResult;
    }
  }

  switch (detected) {
    case "identity":
      return verifyIdentity(resolved as string);
    case "receipt":
      return verifyReceipt(resolved as ExecutionReceipt);
    case "credential":
      return verifyCredential(resolved as VerifiableCredential, options?.clockSkewSeconds);
    case "presentation":
      return verifyPresentation(resolved as VerifiablePresentation, options?.clockSkewSeconds);
  }
}

/**
 * Verify a motebit.md identity file. Backward-compatible with pre-0.4.0.
 *
 * @deprecated Use `verify(content)` instead — it handles all artifact types.
 */
export async function verifyIdentityFile(content: string): Promise<LegacyVerifyResult> {
  const result = await verifyIdentity(content);
  return {
    valid: result.valid,
    identity: result.identity,
    did: result.did,
    error: result.errors?.[0]?.message,
    succession: result.succession,
  };
}

// ===========================================================================
// Protocol signing primitives — sign and produce valid Motebit artifacts.
// Re-exported from sibling modules (bundled by tsup into a single file).
// ===========================================================================

export * from "./signing.js";
export * from "./artifacts.js";
export {
  signVerifiableCredential,
  verifyVerifiableCredential,
  signVerifiablePresentation,
  verifyVerifiablePresentation,
  issueGradientCredential,
  issueReputationCredential,
  issueTrustCredential,
  createPresentation,
  type GradientCredentialSubject,
  type ReputationCredentialSubject,
  type TrustCredentialSubject,
} from "./credentials.js";
export {
  computeCredentialLeaf,
  verifyCredentialAnchor,
  type CredentialAnchorVerifyResult,
  type CredentialAnchorProofFields,
  type ChainAnchorVerifier,
} from "./credential-anchor.js";
