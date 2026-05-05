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

import { verifyBySuite } from "./suite-dispatch.js";
// The @noble/ed25519 SHA-512 binding is performed in suite-dispatch.ts
// as a side effect of module load. Importing verifyBySuite here is
// enough to guarantee that the primitive is ready before any verify
// call in this module.

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
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-hex-v1"`
   * for this artifact today — same suite as the identity frontmatter.
   */
  suite: "motebit-jcs-ed25519-hex-v1";
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
import type { SkillEnvelope } from "@motebit/protocol";
import { verifySkillEnvelopeDetailed, decodeSkillSignaturePublicKey } from "./skills.js";
import type { SkillVerifyReason } from "./skills.js";

// Hardware-attestation verification (secure_enclave handled in-package;
// platform adapters for device_check / tpm / android_keystore / webauthn
// inject via optional-verifier — see `HardwareAttestationVerifiers`).
export {
  verifyHardwareAttestationClaim,
  canonicalSecureEnclaveBodyForTest,
  encodeSecureEnclaveReceiptForTest,
  mintSecureEnclaveReceiptForTest,
} from "./hardware-attestation.js";
export type {
  AttestationPlatform,
  HardwareAttestationError,
  HardwareAttestationVerifyResult,
  HardwareAttestationVerifiers,
  DeviceCheckVerifierContext,
} from "./hardware-attestation.js";
import { verifyHardwareAttestationClaim } from "./hardware-attestation.js";
import type {
  HardwareAttestationVerifiers,
  HardwareAttestationVerifyResult,
} from "./hardware-attestation.js";

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
  /**
   * Hardware-attestation verification outcome. Present only when the
   * credential's subject declared a `hardware_attestation` claim. Absent
   * means "no claim" (not "fails closed" — the credential's own
   * signature is independent of the attestation). Populated by the
   * unified `verify()` dispatcher via `verifyHardwareAttestationClaim`.
   */
  hardware_attestation?: HardwareAttestationVerifyResult;
}

export interface PresentationVerifyResult extends BaseResult {
  type: "presentation";
  presentation: VerifiablePresentation | null;
  holder?: string;
  credentials?: CredentialVerifyResult[];
}

/**
 * Per-file verification outcome inside a `SkillVerifyResult`. Each entry
 * cross-checks `envelope.files[].hash` against `sha256(<file bytes>)`.
 * `actual === null` means the verifier had no on-disk bytes to compare —
 * either the bundle didn't ship the file or a directory walker couldn't
 * locate it. Distinct shape from envelope-signature failure: a missing
 * file is an unverifiable claim, not a forged one.
 */
export interface SkillFileVerifyResult {
  readonly path: string;
  readonly valid: boolean;
  readonly expected: string;
  readonly actual: string | null;
  /** `"ok" | "hash_mismatch" | "missing"`. */
  readonly reason: "ok" | "hash_mismatch" | "missing";
}

/**
 * Verification outcome for a `SkillEnvelope` (per `spec/skills-v1.md` §5)
 * with optional on-disk body + file cross-checks.
 *
 * Three independent verification axes:
 *   - `steps.envelope` — Ed25519 signature over canonical envelope bytes.
 *     Always populated; the primitive lives in this package.
 *   - `steps.body_hash` — `sha256(LF-normalized SKILL.md bytes)` cross-
 *     checked against `envelope.body_hash`. Populated by callers that
 *     read the body from disk (the `@motebit/verifier` directory walker
 *     does this); `null` when this layer was called with bare envelope
 *     JSON and had no body bytes to compare.
 *   - `steps.files` — per-file `sha256` cross-checks. Empty array when
 *     no file bytes were provided to compare; otherwise one entry per
 *     `envelope.files[]` declaration.
 *
 * `valid` reflects "every attempted axis passed AND every declared
 * cross-check was attempted." Calling crypto's `verify(envelope)`
 * directly returns `valid: false` with `body_hash: null` and `files:
 * []` because the bare envelope can only be sig-verified — full
 * verification requires the on-disk bytes. The
 * `@motebit/verifier::verifySkillDirectory` library completes the
 * other two axes; that's the canonical full-verify entry point for
 * skills.
 */
export interface SkillVerifyResult extends BaseResult {
  type: "skill";
  envelope: SkillEnvelope | null;
  /** Compact identifier — `<name>@<version>` from `envelope.skill`. */
  skill?: string;
  /** Echoed from `envelope.signature.public_key`. */
  signer?: string;
  steps: {
    envelope: { valid: boolean; reason: SkillVerifyReason };
    body_hash: { valid: boolean; expected: string; actual: string } | null;
    files: ReadonlyArray<SkillFileVerifyResult>;
  };
}

export type VerifyResult =
  | IdentityVerifyResult
  | ReceiptVerifyResult
  | CredentialVerifyResult
  | PresentationVerifyResult
  | SkillVerifyResult;

export type ArtifactType = VerifyResult["type"];

export interface VerifyOptions {
  expectedType?: ArtifactType;
  /** Clock skew tolerance in seconds for credential expiry checks. Default: 60. */
  clockSkewSeconds?: number;
  /**
   * Optional injection of platform-specific hardware-attestation
   * verifiers. Consumers that need `device_check` / `tpm` /
   * `android_keystore` / `webauthn` verification pass the corresponding
   * leaf package's verifier function here (e.g. `deviceCheckVerifier(...)`
   * from `@motebit/crypto-appattest`). Absence keeps the permissive-floor
   * `@motebit/crypto` path pure: unknown platforms fail-closed with a
   * named-missing-adapter error. See
   * `hardware-attestation.ts::HardwareAttestationVerifiers`.
   */
  hardwareAttestation?: HardwareAttestationVerifiers;
}

// ===========================================================================
// Legacy VerifyResult — backward compatible with pre-0.4.0
// ===========================================================================

/**
 * @deprecated since 1.0.0, removed in 2.0.0. Use {@link VerifyResult} instead.
 *
 * Reason: pre-0.4.0 return shape with a flat `error: string` field and no
 * type discriminator. The modern {@link VerifyResult} is a discriminated
 * union (`type: "identity" | "receipt" | "credential" | "presentation"`)
 * with a structured `errors: Array<{ message: string }>` — one shape covers
 * every artifact type motebit verifies.
 */
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

/** Lowercase hex encoder used internally by `verifySkillBundle` and the credential paths. */
function bytesToLowerHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// ===========================================================================
// Constants
// ===========================================================================

// Identity-file signature comment format (cryptosuite-agility):
//   <!-- motebit:sig:{suite_id}:{hex_signature} -->
// The suite value MUST be `motebit-jcs-ed25519-hex-v1` — the sole suite
// identity files sign under today. Verifiers reject any other suite
// value and the legacy `Ed25519:` prefix fail-closed (no legacy path).
const IDENTITY_FILE_SUITE = "motebit-jcs-ed25519-hex-v1" as const;
const SIG_PREFIX = `<!-- motebit:sig:${IDENTITY_FILE_SUITE}:`;
const SIG_SUFFIX = " -->";

// ===========================================================================
// Artifact detection
// ===========================================================================

function detectArtifactType(artifact: unknown): ArtifactType | null {
  // String → JSON artifact OR YAML-frontmatter identity file. The
  // identity-file format is YAML frontmatter wrapped in `---` delimiters
  // and is structurally never JSON-parseable, so JSON-parse first; only
  // fall back to identity-file detection if the parse fails. Earlier
  // logic checked `artifact.includes("---")` before parsing, which
  // misclassified ~0.03% of JSON-stringified receipts as identity files
  // because base64url-encoded ed25519 signatures contain `---` at that
  // rate (alphabet `A-Za-z0-9-_`). Statistical CI flake; the fix is
  // structural — JSON shape is the unambiguous signal.
  if (typeof artifact === "string") {
    try {
      const parsed = JSON.parse(artifact) as unknown;
      return detectArtifactType(parsed);
    } catch {
      // Not JSON — could still be a YAML-frontmatter identity file.
      if (artifact.includes("---")) {
        return "identity";
      }
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

  // Skill envelope: has "spec_version" + "skill" + "manifest" + "body_hash" + "signature".
  // Distinct from credentials (no "credentialSubject"/"issuer"/"proof") and
  // receipts (no "task_id"). The pinned `spec_version: "1.0"` plus the
  // structural shape of `skill: { name, version, content_hash }` is the
  // canonical fingerprint per `spec/skills-v1.md` §5.
  if (
    "spec_version" in obj &&
    "skill" in obj &&
    "manifest" in obj &&
    "body_hash" in obj &&
    "signature" in obj
  ) {
    return "skill";
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
  if (sigStart === -1) {
    // Legacy detection — fail-closed with a clear upgrade path.
    if (content.includes("<!-- motebit:sig:Ed25519:")) {
      throw new Error(
        `Legacy identity-file signature format detected (motebit:sig:Ed25519:). ` +
          `Re-sign under ${IDENTITY_FILE_SUITE} — no legacy fallback.`,
      );
    }
    throw new Error(
      `Missing signature comment (expected <!-- motebit:sig:${IDENTITY_FILE_SUITE}:… -->)`,
    );
  }

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

  // The identity-file suite (motebit-jcs-ed25519-hex-v1) encodes the
  // signature as hex per its `signatureEncoding` contract. The sig
  // comment format is `<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:{hex} -->`.
  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(parsed.signature);
  } catch {
    return identityError("Invalid signature encoding");
  }
  if (sigBytes.length !== 64) {
    return identityError("Signature must be 64 bytes");
  }

  const frontmatterBytes = new TextEncoder().encode(parsed.rawFrontmatter);

  // Identity files are signed under motebit-jcs-ed25519-hex-v1 (JCS
  // canonicalization, hex signature encoding, hex public key). The
  // dispatcher handles primitive verification; this function owns the
  // hex-decoding of the sig marker (see the `<!-- motebit:sig:...:hex -->`
  // format in spec/identity-v1.md §2).
  const valid = await verifyBySuite(
    "motebit-jcs-ed25519-hex-v1",
    frontmatterBytes,
    sigBytes,
    pubKey,
  );

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
    // Guardian attestations share the identity-file suite: JCS + hex.
    const attestValid = await verifyBySuite(
      "motebit-jcs-ed25519-hex-v1",
      attestMessage,
      attestSig,
      guardianPubKey,
    );
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

      // Succession records MUST declare the hex suite. Reject fail-closed
      // on missing or unknown values — no legacy path.
      if ((record as unknown as { suite?: string }).suite !== "motebit-jcs-ed25519-hex-v1") {
        return {
          valid: false,
          rotations: chain.length,
          error: `Succession record ${i}: missing or invalid suite (expected motebit-jcs-ed25519-hex-v1)`,
        };
      }

      const payloadObj: Record<string, unknown> = {
        old_public_key: record.old_public_key,
        new_public_key: record.new_public_key,
        timestamp: record.timestamp,
        suite: "motebit-jcs-ed25519-hex-v1",
      };
      if (record.reason !== undefined) {
        payloadObj.reason = record.reason;
      }
      if (record.recovery) {
        payloadObj.recovery = true;
      }
      const payload = canonicalJson(payloadObj);
      const message = new TextEncoder().encode(payload);

      // Succession records are signed under motebit-jcs-ed25519-hex-v1
      // (same suite as the identity frontmatter — see spec/identity-v1.md §3.8).
      const newPubKey = hexToBytes(record.new_public_key);
      const newSig = hexToBytes(record.new_key_signature);
      const newValid = await verifyBySuite(
        "motebit-jcs-ed25519-hex-v1",
        message,
        newSig,
        newPubKey,
      );
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
        const guardianValid = await verifyBySuite(
          "motebit-jcs-ed25519-hex-v1",
          message,
          guardianSig,
          guardianPubKey,
        );
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
        const oldValid = await verifyBySuite(
          "motebit-jcs-ed25519-hex-v1",
          message,
          oldSig,
          oldPubKey,
        );
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
  // ExecutionReceipts are signed under motebit-jcs-ed25519-b64-v1 (JCS
  // canonicalization, base64url signature encoding). Older receipts
  // that don't yet carry a `suite` field still verify here — the
  // cryptosuite-agility pass flips this to read the artifact's own
  // `suite` field once every receipt constructor includes it.
  const valid = await verifyBySuite("motebit-jcs-ed25519-b64-v1", message, sig, publicKey);
  return { valid };
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

  // W3C Verifiable Credentials use the eddsa-jcs-2022 cryptosuite:
  // JCS canonicalization over proof-options-hash || document-hash,
  // Ed25519 signature, multibase(base58btc) encoding. The `proof.cryptosuite`
  // field already declares this on-wire; the dispatcher routes the
  // primitive call.
  return verifyBySuite("eddsa-jcs-2022", combined, signature, publicKey);
}

/**
 * Bundle-shape input for `verifySkillBundle`. The full-verify
 * primitive — envelope signature + body hash + per-file hashes — runs
 * pure on these bytes, no I/O, no environment-specific shape.
 *
 * Body bytes are LF-normalized SKILL.md content (the exact bytes the
 * envelope's `body_hash` was computed over at sign time). Files map
 * each path declared in `envelope.files[]` to its raw bytes. Callers
 * with base64-encoded inputs (relay-served `SkillRegistryBundle`,
 * tarball decoders) decode to `Uint8Array` before calling.
 *
 * Single canonical primitive across surfaces:
 *   - `motebit-verify` CLI / `@motebit/verifier::verifySkillDirectory`
 *     reads from disk → builds this shape → calls `verifySkillBundle`.
 *   - Browser consumers (`motebit.com/skills`, third-party registries,
 *     CI pipelines) decode from base64 → builds this shape → calls
 *     `verifySkillBundle`.
 *
 * Both paths produce the same `SkillVerifyResult` with the same step
 * semantics. Same primitive, swap the I/O.
 */
export interface SkillBundleInput {
  readonly envelope: SkillEnvelope;
  /** LF-normalized SKILL.md body bytes — the exact bytes signed at envelope-sign time. */
  readonly body: Uint8Array;
  /** Per-path raw bytes for every entry in `envelope.files[]`. Omit a path to mark it missing. */
  readonly files?: Readonly<Record<string, Uint8Array>>;
}

/**
 * Verify a skill bundle end-to-end. Pure function — no I/O. Performs
 * the three independent verification axes:
 *
 *   1. Envelope signature — Ed25519 over the canonical envelope bytes.
 *   2. Body hash — `sha256(body)` cross-checked against `envelope.body_hash`.
 *   3. Per-file hashes — for each entry in `envelope.files[]`,
 *      `sha256(files[path])` cross-checked against `entry.hash`. A
 *      missing path (envelope declared it; bundle didn't ship bytes)
 *      surfaces as `valid: false` with `reason: "missing"`.
 *
 * `valid: true` iff every axis passed AND every declared file was
 * provided. The detailed step shape lets callers render per-axis
 * outcomes — the canonical doctrine is "every routing-input claim
 * MUST be visible to the user", and the same applies to verification:
 * a one-bit valid/invalid throws away which axis failed.
 *
 * Faithful to `services/relay/CLAUDE.md` rule 6 ("relay is a
 * convenience layer, not a trust root"): any consumer with a bundle
 * — from any source, motebit-served or not — answers "is this signed
 * AND do the bytes match what the publisher signed?" using only this
 * primitive, no relay or runtime contact required.
 */
export async function verifySkillBundle(input: SkillBundleInput): Promise<SkillVerifyResult> {
  const { envelope, body, files = {} } = input;

  // Step 1 — envelope signature.
  let publicKey: Uint8Array;
  try {
    publicKey = decodeSkillSignaturePublicKey(envelope.signature);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      type: "skill",
      valid: false,
      envelope,
      skill: `${envelope.skill.name}@${envelope.skill.version}`,
      steps: {
        envelope: { valid: false, reason: "bad_public_key" },
        body_hash: null,
        files: [],
      },
      errors: [{ message: `public key decode failed: ${msg}`, path: "signature.public_key" }],
    };
  }
  const sigDetail = await verifySkillEnvelopeDetailed(envelope, publicKey);
  const envelopeStep = { valid: sigDetail.valid, reason: sigDetail.reason };

  // Step 2 — body hash.
  const bodyHashActual = bytesToLowerHex(await sha256(body));
  const bodyHashStep = {
    valid: bodyHashActual === envelope.body_hash.toLowerCase(),
    expected: envelope.body_hash,
    actual: bodyHashActual,
  };

  // Step 3 — per-file hashes.
  const fileSteps: SkillFileVerifyResult[] = [];
  for (const entry of envelope.files) {
    const fileBytes = files[entry.path];
    if (fileBytes === undefined) {
      fileSteps.push({
        path: entry.path,
        valid: false,
        expected: entry.hash,
        actual: null,
        reason: "missing",
      });
      continue;
    }
    const actual = bytesToLowerHex(await sha256(fileBytes));
    fileSteps.push({
      path: entry.path,
      valid: actual === entry.hash.toLowerCase(),
      expected: entry.hash,
      actual,
      reason: actual === entry.hash.toLowerCase() ? "ok" : "hash_mismatch",
    });
  }

  // Aggregate verdict.
  const filesAllOk = fileSteps.every((f) => f.valid);
  const valid = envelopeStep.valid && bodyHashStep.valid && filesAllOk;

  const errors: VerificationError[] = [];
  if (!envelopeStep.valid) {
    errors.push({
      message: `envelope signature verification failed (${envelopeStep.reason})`,
      path: "signature",
    });
  }
  if (!bodyHashStep.valid) {
    errors.push({
      message: `body_hash mismatch — expected ${bodyHashStep.expected}, got ${bodyHashStep.actual}`,
      path: "body_hash",
    });
  }
  for (const f of fileSteps) {
    if (!f.valid) {
      errors.push({
        message:
          f.reason === "missing"
            ? `file declared in envelope.files[] but not provided in bundle: ${f.path}`
            : `file hash mismatch for ${f.path} — expected ${f.expected}, got ${f.actual ?? "<missing>"}`,
        path: `files[${f.path}]`,
      });
    }
  }

  return {
    type: "skill",
    valid,
    envelope,
    skill: `${envelope.skill.name}@${envelope.skill.version}`,
    signer: envelope.signature.public_key,
    steps: { envelope: envelopeStep, body_hash: bodyHashStep, files: fileSteps },
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/**
 * Verify a `SkillEnvelope` at the signature layer only. Body-hash and
 * per-file cross-checks require on-disk bytes (the
 * `@motebit/verifier::verifySkillDirectory` walker populates them); this
 * layer leaves those steps unattempted so the result honestly reports
 * "envelope sig OK, full-verify pending" rather than false-positive a
 * tampered body that happens to ship a valid envelope sig.
 *
 * Result discipline: `valid: true` iff envelope sig verifies AND body +
 * file cross-checks were both attempted-and-passed. Bare envelope input
 * here returns `valid: false` with `errors[]` naming the unattempted
 * checks — the caller gets a clean signal that they need the on-disk
 * walker to complete the verification.
 */
async function verifySkillEnvelopeArtifact(envelope: SkillEnvelope): Promise<SkillVerifyResult> {
  let publicKey: Uint8Array;
  try {
    publicKey = decodeSkillSignaturePublicKey(envelope.signature);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      type: "skill",
      valid: false,
      envelope,
      skill: `${envelope.skill.name}@${envelope.skill.version}`,
      steps: {
        envelope: { valid: false, reason: "bad_public_key" },
        body_hash: null,
        files: [],
      },
      errors: [{ message: `public key decode failed: ${msg}`, path: "signature.public_key" }],
    };
  }
  const detail = await verifySkillEnvelopeDetailed(envelope, publicKey);
  const errors: VerificationError[] = [];
  if (!detail.valid) {
    errors.push({
      message: `envelope signature verification failed (${detail.reason})`,
      path: "signature",
    });
  }
  // Always emit the body/files-pending signal. A caller that has the
  // on-disk bytes (the verifier package's directory walker) augments
  // these axes; a caller that doesn't — the bare-envelope path used
  // by motebit-verify on a single skill-envelope.json — sees them as
  // skipped, which is structurally honest about what was checked.
  errors.push({
    message:
      "body_hash and files[] cross-check were not attempted — verifying a bare envelope JSON only checks the envelope signature. Use `verifySkillDirectory` from @motebit/verifier (or `motebit-verify <skill-directory>`) for full verification.",
    path: "body_hash",
  });
  return {
    type: "skill",
    valid: false,
    envelope,
    skill: `${envelope.skill.name}@${envelope.skill.version}`,
    signer: envelope.signature.public_key,
    steps: {
      envelope: { valid: detail.valid, reason: detail.reason },
      body_hash: null,
      files: [],
    },
    errors,
  };
}

const DEFAULT_CLOCK_SKEW_SECONDS = 60;

async function verifyCredential(
  vc: VerifiableCredential,
  clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
  hardwareAttestationVerifiers?: HardwareAttestationVerifiers,
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

  // Hardware-attestation verification (additive — absent claim = no
  // field; present claim = one more verification channel, reported
  // separately from the credential's own signature validity).
  const subject = vc.credentialSubject as
    | (Record<string, unknown> & {
        readonly hardware_attestation?: unknown;
        readonly identity_public_key?: unknown;
        readonly motebit_id?: unknown;
        readonly device_id?: unknown;
        readonly attested_at?: unknown;
      })
    | undefined;
  let hardwareAttestation: HardwareAttestationVerifyResult | undefined;
  if (
    subject !== undefined &&
    subject.hardware_attestation !== undefined &&
    subject.hardware_attestation !== null &&
    typeof subject.hardware_attestation === "object" &&
    typeof subject.identity_public_key === "string"
  ) {
    // Lift the subject fields that participate in the Swift-composed
    // JCS body for App Attest. `attested_at` is always on the subject;
    // `motebit_id` / `device_id` may appear on future credential
    // variants. The injected deviceCheck verifier uses them to
    // re-derive the body and byte-compare against the transmitted
    // clientDataHash. Every field is optional at this layer —
    // fail-closed behavior for a missing field lives inside the
    // verifier itself so the outer dispatcher stays uniform across
    // platforms.
    const deviceCheckContext = {
      ...(typeof subject.motebit_id === "string" ? { expectedMotebitId: subject.motebit_id } : {}),
      ...(typeof subject.device_id === "string" ? { expectedDeviceId: subject.device_id } : {}),
      ...(typeof subject.attested_at === "number"
        ? { expectedAttestedAt: subject.attested_at }
        : {}),
    };
    // The dispatcher may return a Promise when an injected adapter
    // (e.g. @motebit/crypto-appattest for device_check) is wired in.
    // Always `await` so the resulting shape is the canonical
    // `HardwareAttestationVerifyResult`.
    hardwareAttestation = await verifyHardwareAttestationClaim(
      subject.hardware_attestation as Parameters<typeof verifyHardwareAttestationClaim>[0],
      subject.identity_public_key,
      hardwareAttestationVerifiers,
      deviceCheckContext,
    );
  }

  return {
    type: "credential",
    valid: proofValid && !expired,
    credential: vc,
    issuer: issuerDid,
    subject: subjectId,
    expired,
    ...(hardwareAttestation && { hardware_attestation: hardwareAttestation }),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// ===========================================================================
// Verifiable Presentation verification
// ===========================================================================

async function verifyPresentation(
  vp: VerifiablePresentation,
  clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
  hardwareAttestationVerifiers?: HardwareAttestationVerifiers,
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
    const vcResult = await verifyCredential(vc, clockSkewSeconds, hardwareAttestationVerifiers);
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
      ...(fallbackType === "skill"
        ? {
            envelope: null,
            steps: {
              envelope: { valid: false, reason: "wrong_suite" as SkillVerifyReason },
              body_hash: null,
              files: [],
            },
          }
        : {}),
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
      ...(detected === "skill"
        ? {
            envelope: null,
            steps: {
              envelope: { valid: false, reason: "wrong_suite" as SkillVerifyReason },
              body_hash: null,
              files: [],
            },
          }
        : {}),
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
        ...(detected === "skill"
          ? {
              envelope: null,
              steps: {
                envelope: { valid: false, reason: "wrong_suite" as SkillVerifyReason },
                body_hash: null,
                files: [],
              },
            }
          : {}),
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
      return verifyCredential(
        resolved as VerifiableCredential,
        options?.clockSkewSeconds,
        options?.hardwareAttestation,
      );
    case "presentation":
      return verifyPresentation(
        resolved as VerifiablePresentation,
        options?.clockSkewSeconds,
        options?.hardwareAttestation,
      );
    case "skill":
      return verifySkillEnvelopeArtifact(resolved as SkillEnvelope);
  }
}

/**
 * Verify a motebit.md identity file. Backward-compatible with pre-0.4.0.
 *
 * @deprecated since 1.0.0, removed in 2.0.0. Use `verify(content, { expectedType: "identity" })` instead.
 *
 * Reason: `verify()` is the unified dispatcher for every signed artifact
 * type (identity, receipt, credential, presentation) and returns a typed
 * {@link VerifyResult} discriminated union. `verifyIdentityFile` is the
 * pre-0.4.0 identity-only wrapper kept alive for the deprecation window —
 * it reshapes `verify()`'s output into the legacy flat-`error` format.
 *
 * Migration:
 * ```ts
 * // Before:
 * const r = await verifyIdentityFile(content);
 * if (r.valid) console.log(r.did);
 * else console.log(r.error);
 *
 * // After:
 * const r = await verify(content, { expectedType: "identity" });
 * if (r.type === "identity" && r.valid) console.log(r.did);
 * else console.log(r.errors?.[0]?.message);
 * ```
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
  verifyRevocationAnchor,
  type CredentialAnchorVerifyResult,
  type CredentialAnchorProofFields,
  type ChainAnchorVerifier,
  type RevocationAnchorVerifyResult,
  type RevocationAnchorProof,
} from "./credential-anchor.js";
export {
  SKILL_SIGNATURE_SUITE,
  canonicalizeSkillManifestBytes,
  canonicalizeSkillEnvelopeBytes,
  signSkillManifest,
  signSkillEnvelope,
  verifySkillManifest,
  verifySkillManifestDetailed,
  verifySkillEnvelope,
  verifySkillEnvelopeDetailed,
  decodeSkillSignaturePublicKey,
  type SkillVerifyReason,
  type SkillVerifyDetail,
} from "./skills.js";
export {
  DELETION_CERTIFICATE_SUITE,
  WITNESS_OMISSION_DISPUTE_WINDOW_MS,
  canonicalizeMultiSignatureCert,
  canonicalizeHorizonCert,
  canonicalizeHorizonCertForWitness,
  signCertAsSubject,
  signCertAsOperator,
  signCertAsDelegate,
  signCertAsGuardian,
  signHorizonCertAsIssuer,
  signHorizonWitness,
  canonicalizeHorizonWitnessRequestBody,
  signHorizonWitnessRequestBody,
  verifyHorizonWitnessRequestSignature,
  verifyDeletionCertificate,
  verifyRetentionManifest,
  type DeletionCertificateVerifyResult,
  type DeletionCertificateVerifyContext,
  type RetentionManifestVerifyResult,
} from "./deletion-certificate.js";
export {
  canonicalizeWitnessOmissionDispute,
  signWitnessOmissionDispute,
  verifyWitnessOmissionDispute,
  type WitnessOmissionDisputeVerifyResult,
  type WitnessOmissionDisputeVerifyContext,
} from "./witness-omission-dispute.js";
export { verifyMerkleInclusion } from "./merkle.js";
