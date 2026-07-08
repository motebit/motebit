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

import type { MerkleTreeVersion } from "@motebit/protocol";
import { verifyBySuite } from "./suite-dispatch.js";
import { verifyMerkleInclusion, canonicalLeaf, resolveTreeHashVersion } from "./merkle.js";
import {
  verifyToolInvocationReceipt,
  verifyExecutionReceipt,
  verifyDelegation,
  verifyStandingDelegation,
  findGrantRevocation,
  type SignableToolInvocationReceipt,
  type SignableReceipt,
} from "./artifacts.js";
import type { DelegationToken, StandingDelegation, DelegationRevocation } from "@motebit/protocol";
import type {
  EvidenceRef,
  EvidenceProvenance,
  DigestRef,
  DigestAlgorithm,
  ProjectionClass,
  IntegrityVerdict,
  IdentityBindingVerdict,
  AuthorityVerdict,
  RevocationStatus,
  TemporalBasis,
  RevocationFreshness,
  RevocationVerdict,
  RepairInstruction,
  VerdictSubject,
  VerificationVerdict,
} from "@motebit/protocol";
import { hash, isScopeNarrowed } from "./signing.js";
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
  /**
   * Always `"embedded"` when present: `verifyReceipt` resolves the key from
   * the receipt's own `public_key`, which proves byte-integrity but NOT
   * identity binding. Establishing that the key belongs to `motebit_id`
   * requires an external anchor (transparency log / known-keys map /
   * identity file); see `verifyReceiptChain` for the external-key path.
   * Callers MUST NOT present a `valid: true` result as proof of identity
   * on the strength of an embedded key alone.
   */
  keySource?: "embedded";
  delegations?: ReceiptVerifyResult[];
}

export interface ToolInvocationVerifyResult extends BaseResult {
  type: "tool-invocation";
  toolInvocation: SignableToolInvocationReceipt | null;
  signer?: string;
  /**
   * Always `"embedded"` when present: resolved from the receipt's own
   * `public_key` — proves byte-integrity, NOT identity binding (same caveat as
   * `ReceiptVerifyResult.keySource`). The binding rung is computed by the
   * `@motebit/verifier` wrapper, not asserted here.
   */
  keySource?: "embedded";
}

export interface CredentialVerifyResult extends BaseResult {
  type: "credential";
  credential: VerifiableCredential | null;
  issuer?: string;
  subject?: string;
  expired?: boolean;
  /**
   * True when `validFrom` is in the future (with clock skew) — the credential
   * is not yet active. Counts against `valid`, mirroring `expired`. Absent ⇒
   * the credential is within its validity window (or carries no `validFrom`).
   */
  not_yet_valid?: boolean;
  /**
   * True when the credential carries a `credentialStatus` (it is revocable) but
   * this verifier could not consult a revocation source. The offline aggregator
   * `verify()` is I/O-free and CANNOT check revocation — so it does not silently
   * imply "not revoked": it sets this flag, and a consumer that needs revocation
   * MUST check `credentialStatus.id` against its own source (or call
   * `verifyVerifiableCredential` with an injected `isRevoked` seam). `valid` here
   * means "signature + temporal validity", NOT "not revoked".
   */
  revocation_unchecked?: boolean;
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

/**
 * The artifact is not a recognized Motebit type — `detectArtifactType` matched
 * no branch. This is distinct from `valid: false` on a *recognized* type
 * (which means "a known artifact whose signature/structure failed"). A consumer
 * MUST be able to tell "I don't know what this is" apart from "this is a forged
 * receipt/identity/credential" — conflating the two reads an unrecognized blob
 * as a forgery. `valid` is always `false` (nothing was verified). Artifacts that
 * verify through a type-specific primitive rather than auto-detect (e.g. a flat
 * `ApprovalDecision` → `verifyApprovalDecision`) land here under `verify()`.
 */
export interface UnknownVerifyResult extends BaseResult {
  type: "unknown";
  valid: false;
  reason: "unrecognized_artifact_type";
}

export type VerifyResult =
  | IdentityVerifyResult
  | ReceiptVerifyResult
  | ToolInvocationVerifyResult
  | CredentialVerifyResult
  | PresentationVerifyResult
  | SkillVerifyResult
  | UnknownVerifyResult;

export type ArtifactType = VerifyResult["type"];

// ===========================================================================
// Types — Structured Verification Verdict (the VerificationVerdict arc)
//
// The reshape named in docs/doctrine/verify-family-fail-closed.md § "The
// VerificationVerdict arc": the verify family's bare booleans become one
// structured verdict whose every axis states what was ESTABLISHED and what
// remains UNKNOWN. The governing rule — no unknown / unchecked / stale /
// integrity-only result may silently read `true` — is enforced by the SHAPE:
// there is DELIBERATELY no top-level `valid` boolean to over-read; a consumer
// branches on the axis it depends on.
//
// Landing additive-first, ahead of the coordinated major: this type is the API
// contract consumer #2 (agency.computer) codes against now; the verify
// functions that RETURN it, and the fail-closed back-compat adapter that
// derives the old boolean, ship in the next increment. Until then the
// boolean-returning verifiers remain authoritative. Co-designed with consumer
// #2 — revocation as a freshness BASIS (not a bare label), `repair` first-class.
// ===========================================================================

// The verdict vocabulary (IntegrityVerdict … VerificationVerdict) graduated
// to @motebit/protocol — the closed verdict vocabulary's home — in the
// 2026-07-08 EvalAttestation arc: EvalAttestation embeds whole verdicts per
// measurement, and @motebit/wire-schemas (which may only see protocol) needs
// the shape for its zod parity block. Re-exported here type-only (crypto
// keeps zero runtime monorepo deps; the EvidenceRef graduation precedent) so
// the verify family's public surface is unchanged.
export type {
  IntegrityVerdict,
  IdentityBindingVerdict,
  AuthorityVerdict,
  RevocationStatus,
  TemporalBasis,
  RevocationFreshness,
  RevocationVerdict,
  RepairInstruction,
  VerdictSubject,
  VerificationVerdict,
};

// Compile-time drift lock for the graduation: protocol RESTATES VerdictSubject
// as an explicit closed literal union (it cannot derive from crypto's
// VerifyResult — that would be a dependency cycle), so containment is asserted
// here instead. A new VerifyResult member that protocol's union doesn't carry
// turns this line into a build error rather than a silent divergence.
type _ArtifactTypeWithinVerdictSubject = ArtifactType extends VerdictSubject ? true : never;
const _assertVerdictSubjectCoverage: _ArtifactTypeWithinVerdictSubject = true;
void _assertVerdictSubjectCoverage;

/** A reference to the evidence an axis was established from (a receipt hash, a key id, a revocation root). */
// EvidenceRef + the evidence-provenance vocabulary graduated to @motebit/protocol
// (the closed verdict vocabulary's home). Re-exported here (local type bindings,
// import-type only — crypto keeps zero runtime monorepo deps) so the verify
// family's public surface is unchanged. The optional `provenance` makes a
// verdict's evidence axis re-verifiable down to the primary record — see
// `verifyEvidenceProvenance` below (evidence-provenance arc).
export type { EvidenceRef, EvidenceProvenance, DigestRef, DigestAlgorithm, ProjectionClass };

// RepairInstruction, VerdictSubject, and VerificationVerdict graduated to
// @motebit/protocol with the rest of the verdict vocabulary (see the
// re-export block above).

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
  /**
   * When `true`, additionally verify that an `ExecutionReceipt`'s `result_hash`
   * equals `hex(SHA-256(UTF-8(result)))` — the spec formula
   * (`spec/execution-ledger-v1.md` § Hash fields). Default `false`
   * (signature-only), for backward compatibility AND because a valid signature
   * proves the bytes are authentic, NOT that the receipt is internally
   * self-consistent. Strict mode catches a receipt whose committed
   * `result_hash` does not bind its own `result` field — a mis-minted receipt
   * that would otherwise read `valid:true` yet be unrecomputable by a third
   * party (the "signed number nobody can reproduce" failure). On mismatch the
   * receipt verifies `valid:false` with a `result_hash`-path error. Only
   * `ExecutionReceipt` carries a raw `result` to check; other artifact types
   * (incl. `ToolInvocationReceipt`, which commits args/result by hash only) are
   * unaffected.
   */
  strictHashBinding?: boolean;
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

/**
 * Encode an Ed25519 public key as a W3C `did:key` (multicodec `ed25519-pub`
 * `0xed01`, base58btc / `z`-multibase). The id IS the key — a tautological,
 * by-construction commitment. Inverse of {@link didKeyToPublicKey}.
 */
function publicKeyToDidKey(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(publicKey, 2);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

/**
 * Decode a W3C `did:key` (`ed25519-pub` / base58btc) back to its 32-byte Ed25519
 * public key. Throws on a non-`z` multibase, wrong length, or a non-`ed25519-pub`
 * multicodec prefix (fail-closed). Inverse of {@link publicKeyToDidKey};
 * `verifySovereignBinding` uses it to read a did:key id as the sovereign rung.
 */
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

// Detection yields a concrete artifact type or `null` (unrecognized). It never
// yields "unknown" — that is a verify *result* the dispatcher synthesizes from
// the `null` case, not a detectable input shape. Excluding it keeps `verify()`'s
// dispatch switch exhaustive over exactly the detectable types.
function detectArtifactType(artifact: unknown): Exclude<ArtifactType, "unknown"> | null {
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

  // Tool-Invocation Receipt: has "invocation_id" + "tool_name" + "motebit_id"
  // + "signature". Checked BEFORE the execution-receipt branch on its UNIQUE
  // marker `invocation_id` (an ExecutionReceipt never carries one; conversely a
  // ToolInvocationReceipt never carries `prompt_hash`), so the two are disjoint
  // and neither can be classified as the other. Without this branch a genuine
  // tool-invocation receipt fell through to `null` and `verify()` reported it as
  // a failed identity artifact — a true receipt reading as forged.
  if ("invocation_id" in obj && "tool_name" in obj && "motebit_id" in obj && "signature" in obj) {
    return "tool-invocation";
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

/**
 * Result of binding a signing key to a motebit identity at a point in time.
 * `bound: true` means the key was this identity's legitimate key *at* the given
 * timestamp — sovereign-root binding (rooted in the motebit's own genesis +
 * rotation signatures), with time-windowing. See
 * `docs/doctrine/identity-binding-verification.md`.
 */
export interface KeyBindingResult {
  bound: boolean;
  /** Genesis (root) public key of the identity's succession chain. */
  genesisPublicKey?: string;
  /** Start of the matched key's active window (ms epoch); absent ⇒ unbounded below. */
  activeFrom?: number;
  /** End of the matched key's active window (ms epoch); absent ⇒ still current. */
  activeUntil?: number;
  /**
   * True when `motebit_id` is the sovereign commitment to the genesis key
   * (`deriveSovereignMotebitId(genesisPublicKey) === motebit_id`). The id↔genesis
   * link is then verifiable offline from the identity file alone — no operator,
   * no anchor. This is the strongest binding root (the doctrine's `sovereign`
   * rung); independent of `bound`, which is about the *signing* key's window.
   */
  sovereign?: boolean;
  /** Why binding failed, when `bound` is false. */
  reason?: string;
}

/**
 * The sovereign commitment of a genesis key: a UUIDv8 (RFC 9562) deterministically
 * derived from `sha256(genesisPublicKey)`. When a motebit is minted sovereignly,
 * its `motebit_id` IS this value — so the id↔key binding is self-certifying and
 * needs no operator: a verifier recomputes it and checks equality.
 *
 * Second-preimage resistance is ~2^122 (an attacker cannot grind a different
 * genesis key whose commitment matches a target id), which is the security bar
 * for "you cannot impersonate a sovereign motebit." Existing random UUIDv7 ids
 * carry version nibble 7 and can never equal a v8 commitment, so non-sovereign
 * motebits read as such cleanly. The genesis key derives deterministically from a
 * 32-byte seed (an Ed25519 key *is* its seed), so the id is recoverable from the
 * seed — self-certification AND recovery, the `sovereign` rung's whole point.
 *
 * See `docs/doctrine/identity-binding-verification.md`.
 */
export async function deriveSovereignMotebitId(genesisPublicKeyHex: string): Promise<string> {
  const h = await sha256(hexToBytes(genesisPublicKeyHex));
  const b = h.slice(0, 16);
  b[6] = 0x80 | (b[6]! & 0x0f); // version 8 (vendor-specific, RFC 9562)
  b[8] = 0x80 | (b[8]! & 0x3f); // variant 10b (RFC 4122/9562)
  const hex = Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * True iff `motebitId` is the sovereign commitment to `genesisPublicKeyHex` — the
 * offline, operator-free check that an id is bound to a key. Case-insensitive on
 * the id. Returns false (never throws) on malformed input — fail-closed.
 */
export async function verifySovereignBinding(
  motebitId: string,
  genesisPublicKeyHex: string,
): Promise<boolean> {
  try {
    // A W3C `did:key` IS the multicodec-encoded public key — a tautological,
    // by-construction commitment (the case-1 self-certification in
    // docs/doctrine/identity-binding-verification.md § "The sovereign rung is
    // id-scheme-agnostic"). Decode and compare to the artifact's key; equal ⇒
    // sovereign, the same math-rooted / operator-free property as the motebit_id
    // derivation below, different id scheme (agency.computer + the broader W3C
    // ecosystem). A non-`z` / malformed did:key throws → caught → false
    // (fail-closed). The id IS the key, so there is no forgery surface.
    if (motebitId.startsWith("did:key:")) {
      const decoded = didKeyToPublicKey(motebitId); // throws on non-`z`/malformed → caught → false
      const expected = hexToBytes(genesisPublicKeyHex);
      return decoded.length === expected.length && decoded.every((b, i) => b === expected[i]);
    }
    const expected = await deriveSovereignMotebitId(genesisPublicKeyHex);
    return motebitId.toLowerCase() === expected;
  } catch {
    return false;
  }
}

/**
 * Sovereign-root identity binding with time-windowing: was `signingKeyHex` this
 * motebit's legitimate key *at* `atTimestampMs`?
 *
 * Verifies the identity's succession chain (link signatures + continuity +
 * temporal order, via {@link verifySuccessionChain}), then checks the key's
 * active window contains the timestamp. A since-rotated key therefore does NOT
 * bind a newer receipt, and a future key does not bind an older one — the
 * time-windowing failure mode named in the doctrine.
 *
 * This roots in the motebit's own keys; no operator trust. Tying the genesis key
 * to the `motebit_id` (the non-equivocable anchor) is the caller's responsibility
 * — this primitive proves the key/identity-file relationship, not file/id.
 */
export async function verifyKeyBindingAtTime(
  identity: MotebitIdentityFile,
  signingKeyHex: string,
  atTimestampMs: number,
  guardianPublicKeyHex?: string,
): Promise<KeyBindingResult> {
  const chain = identity.succession ?? [];
  const currentKey = identity.identity.public_key;

  if (chain.length > 0) {
    // A guardian-recovery rotation (the spec's key-compromise mechanism, §3.8.3)
    // is guardian-signed, so verifying it needs the guardian key. Fall back to the
    // identity file's own `guardian.public_key` when the caller doesn't pass one —
    // otherwise a recovery chain carried in the identity file (e.g. served to a
    // third-party verifier) would fail for lack of a key the file already names.
    const guardianKey = guardianPublicKeyHex ?? identity.guardian?.public_key;
    const chk = await verifySuccessionChain(chain, currentKey, guardianKey);
    if (!chk.valid) {
      return { bound: false, reason: chk.error ?? "succession chain invalid" };
    }
  }

  // A malformed `created_at` parses to NaN; comparisons against NaN are always
  // false, so the genesis key simply won't match — fail-closed, no special case
  // (an identity without a valid creation time is malformed and shouldn't bind).
  const createdAtMs = Date.parse(identity.created_at);
  const genesisKey = chain.length > 0 ? chain[0]!.old_public_key : currentKey;

  // Contiguous active windows in chain order: genesis first, then each rotation's
  // new key. The chain is already verified temporally ordered, so windows don't
  // overlap and `[from, until)` is well-formed.
  const windows: Array<{ key: string; from: number; until: number }> = [
    { key: genesisKey, from: createdAtMs, until: chain[0]?.timestamp ?? Number.POSITIVE_INFINITY },
  ];
  for (let i = 0; i < chain.length; i++) {
    windows.push({
      key: chain[i]!.new_public_key,
      from: chain[i]!.timestamp,
      until: chain[i + 1]?.timestamp ?? Number.POSITIVE_INFINITY,
    });
  }

  const match = windows.find(
    (w) => w.key === signingKeyHex && atTimestampMs >= w.from && atTimestampMs < w.until,
  );
  if (!match) {
    const inChain = windows.some((w) => w.key === signingKeyHex);
    return {
      bound: false,
      genesisPublicKey: genesisKey,
      reason: inChain
        ? "signing key is in the succession chain but was not active at the given timestamp"
        : "signing key is not in this identity's succession chain",
    };
  }
  return {
    bound: true,
    genesisPublicKey: genesisKey,
    sovereign: await verifySovereignBinding(identity.motebit_id, genesisKey),
    activeFrom: match.from,
    ...(match.until !== Number.POSITIVE_INFINITY ? { activeUntil: match.until } : {}),
  };
}

/**
 * Does `presentedKeyHex` legitimately control `motebitId` *right now*? The
 * offline, operator-free binding check a destination relay runs before
 * onboarding a migrating agent (spec/migration-v1.md §8.2 step 6). Two tiers,
 * fail-closed (returns false, never throws, on any unmet condition):
 *
 *  1. **Sovereign genesis** — `motebitId` is the sovereign commitment to
 *     `presentedKeyHex` itself (a never-rotated identity). No identity file
 *     needed; this is {@link verifySovereignBinding}.
 *  2. **Sovereign-rooted succession** — with an `identityFile`, `presentedKeyHex`
 *     is the key active *now* in a verified succession chain
 *     ({@link verifyKeyBindingAtTime}) whose genesis is the sovereign commitment
 *     to the file's `motebit_id`, and that file is *for this* `motebitId`. This
 *     binds a ROTATED key to the id — a sovereign agent that has rotated its key
 *     keeps `motebit_id = sha256(genesis key)`, so tier 1 alone would lock it
 *     out of migration; the chain re-establishes the binding without operator
 *     trust.
 *
 * A non-sovereign (legacy random) id satisfies neither tier and cannot migrate —
 * by design, only sovereign-rooted identities migrate without trusting an operator.
 */
export async function verifyMigratingKeyBinding(
  motebitId: string,
  presentedKeyHex: string,
  identityFile?: MotebitIdentityFile,
): Promise<boolean> {
  if (await verifySovereignBinding(motebitId, presentedKeyHex)) return true;
  if (!identityFile || identityFile.motebit_id !== motebitId) return false;
  try {
    const r = await verifyKeyBindingAtTime(identityFile, presentedKeyHex, Date.now());
    return r.bound === true && r.sovereign === true;
  } catch {
    return false;
  }
}

/**
 * Canonical leaf of the identity-transparency log: the operator's
 * non-equivocable commitment that motebit `motebitId`'s current identity key is
 * `currentKeyHex`. Hex SHA-256 of the JCS-canonical commitment. The relay that
 * produces the log and the verifier that checks inclusion MUST agree on this
 * convention. See `docs/doctrine/identity-binding-verification.md`.
 */
export async function identityLogLeaf(
  motebitId: string,
  currentKeyHex: string,
  treeHashVersion: MerkleTreeVersion = "merkle-sha256-plain-v1",
): Promise<string> {
  // Routes through the canonical leaf primitive so the RFC 6962 §2.1 leaf tag
  // (under v2) is applied in exactly one place. v1 (default) is byte-identical
  // to the previous `sha256(canonicalJson(...))`.
  return canonicalLeaf(
    {
      type: "motebit-identity-binding",
      motebit_id: motebitId,
      public_key: currentKeyHex,
    },
    treeHashVersion,
  );
}

/** Merkle inclusion proof of an identity-log leaf under an anchored root. */
export interface IdentityLogInclusionProof {
  /** Leaf position in the bottom layer (0-based). */
  readonly index: number;
  /** Sibling hashes, leaf-to-root order (hex). */
  readonly siblings: string[];
  /** Bottom-up layer cardinalities. */
  readonly layerSizes: number[];
  /**
   * The anchored Merkle root the proof must reconstruct (hex). Confirming this
   * root is actually posted on-chain by the operator is a SEPARATE check, the
   * verifier-caller's responsibility — it is what makes anchored binding
   * non-zero-network and defeats split-view equivocation.
   */
  readonly anchoredRoot: string;
  /**
   * Tree-hash recipe for the leaf + Merkle path. **Absent ⇒
   * `merkle-sha256-plain-v1`** — proofs minted before this axis existed verify
   * unchanged. Resolved fail-closed: an unknown value rejects the binding
   * (never silently downgrades). A v2 identity-log producer emits it.
   */
  readonly tree_hash_version?: MerkleTreeVersion;
}

/**
 * Anchored identity binding: sovereign-root binding (via
 * {@link verifyKeyBindingAtTime}) AND the motebit's current identity key is
 * committed in the identity-transparency log under `proof.anchoredRoot`. The
 * Merkle inclusion is the operator's non-equivocation — it cannot serve a forked
 * chain whose head differs from the anchored leaf. Returns the sovereign
 * `KeyBindingResult` when both hold; `bound: false` if either fails.
 *
 * NOTE: this proves inclusion under a *given* root; verifying that root is the
 * one the operator anchored on-chain is the caller's cross-check. The caller must
 * also confirm `identity.motebit_id` is the receipt's claimed motebit — this
 * primitive binds a key to the supplied identity file, not to a receipt.
 */
export async function verifyIdentityBindingAnchored(
  identity: MotebitIdentityFile,
  signingKeyHex: string,
  atTimestampMs: number,
  proof: IdentityLogInclusionProof,
  guardianPublicKeyHex?: string,
): Promise<KeyBindingResult> {
  const sovereign = await verifyKeyBindingAtTime(
    identity,
    signingKeyHex,
    atTimestampMs,
    guardianPublicKeyHex,
  );
  if (!sovereign.bound) return sovereign;

  // Resolve the tree-hash version at the boundary: absent ⇒ v1, unknown ⇒
  // reject fail-closed (never silently downgrade). Both the leaf builder and the
  // inclusion check then receive a narrow, supported version.
  const treeHashVersion = resolveTreeHashVersion(proof.tree_hash_version);
  if (treeHashVersion === null) {
    return {
      bound: false,
      ...(sovereign.genesisPublicKey ? { genesisPublicKey: sovereign.genesisPublicKey } : {}),
      reason: `unknown tree_hash_version "${String(proof.tree_hash_version)}" on identity-log proof`,
    };
  }

  const leaf = await identityLogLeaf(
    identity.motebit_id,
    identity.identity.public_key,
    treeHashVersion,
  );
  const included = await verifyMerkleInclusion(
    leaf,
    proof.index,
    proof.siblings,
    proof.layerSizes,
    proof.anchoredRoot,
    treeHashVersion,
  );
  if (!included) {
    return {
      bound: false,
      ...(sovereign.genesisPublicKey ? { genesisPublicKey: sovereign.genesisPublicKey } : {}),
      reason: "identity key is not included in the anchored transparency log",
    };
  }
  return sovereign;
}

// ===========================================================================
// Receipt verification
// ===========================================================================

async function verifyReceiptSignature(
  receipt: ExecutionReceipt,
  publicKey: Uint8Array,
): Promise<{ valid: boolean; error?: string }> {
  const { signature, ...body } = receipt;

  // Failure messages cite spec/execution-ledger-v1.md §11.2 (the signature
  // section), phrased to match the Python reference verifier byte-for-byte —
  // the cross-language conformance story depends on both verifiers reporting
  // the same spec violation for the same artifact.
  if (!signature || signature.trim() === "") {
    return { valid: false, error: "§11.2 violation: receipt signature is empty" };
  }

  let sig: Uint8Array;
  try {
    sig = fromBase64Url(signature);
  } catch {
    return { valid: false, error: "§11.2 violation: receipt signature is not valid base64url" };
  }

  if (sig.length !== 64) {
    return {
      valid: false,
      error: `§11.2 violation: receipt signature must be 64 bytes, got ${sig.length}`,
    };
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

/**
 * Verify a single `ExecutionReceipt` by:
 *
 *   1. Resolving the signer key — `receipt.public_key` (embedded hex) is
 *      the canonical source. A receipt without an embedded key cannot
 *      be verified offline; verification fails with a typed error.
 *   2. Verifying the Ed25519 signature over the receipt's content hash
 *      (per `spec/execution-ledger-v1.md` §6).
 *   3. Recursively verifying each entry in `delegation_receipts` (§11.5)
 *      so multi-hop chains are fully audited.
 *
 * Returns a `ReceiptVerifyResult` with the signer's `did:key`, the
 * outer signature validity, and an array of nested delegation results.
 * Fail-closed on every error path — missing key, wrong key length,
 * malformed hex, signature mismatch.
 *
 * Consumed by `@motebit/state-export-client::verifyInnerSignedReceipts`
 * to recursively check each `signed_receipts` entry inside a v1.1
 * relay-assembled execution-ledger reconstruction
 * (`spec/execution-ledger-v1.md` §4.3) and by `motebit-verify
 * content-artifact --verify-inner` for the same purpose at the CLI.
 *
 * Closes the operator-trust gap at the consumer side: a verifier with
 * v1.1 inner receipts in hand can prove "motebit X did this work"
 * directly against motebit X's own public key, without trusting the
 * relay's word.
 */
export async function verifyReceipt(
  receipt: ExecutionReceipt,
  options?: VerifyOptions,
): Promise<ReceiptVerifyResult> {
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
      errors: [
        {
          message: "§11.3 violation: No embedded public_key — cannot verify without known keys",
        },
      ],
      ...(delegations.length > 0 ? { delegations } : {}),
    };
  }

  const sigResult = await verifyReceiptSignature(receipt, publicKey);
  const errors: VerificationError[] = [];

  if (!sigResult.valid) {
    errors.push({
      message: sigResult.error ?? "§11.2 violation: Ed25519 signature did not verify",
    });
  }

  // Recursively verify delegation receipts
  const delegations = await verifyReceiptDelegations(receipt);
  const delegationErrors = delegations.filter((d) => !d.valid);
  for (const d of delegationErrors) {
    errors.push({
      message: `§11.5 violation: delegation ${d.receipt?.task_id ?? "unknown"} verification failed`,
      path: `delegation_receipts`,
    });
  }

  // Strict mode: the signature proves authenticity, NOT that result_hash binds
  // the result field. Recompute it per spec and reject a self-inconsistent
  // receipt (one whose result_hash a third party can't reproduce from result).
  let resultHashOk = true;
  if (options?.strictHashBinding) {
    const expected = await hash(new TextEncoder().encode(receipt.result));
    resultHashOk = expected === receipt.result_hash;
    if (!resultHashOk) {
      errors.push({
        message:
          "result_hash does not equal hex(SHA-256(result)) — receipt is not self-consistent (strict mode)",
        path: "result_hash",
      });
    }
  }

  return {
    type: "receipt",
    valid: sigResult.valid && delegationErrors.length === 0 && resultHashOk,
    receipt,
    signer: signerDid,
    keySource: "embedded",
    ...(delegations.length > 0 ? { delegations } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// ===========================================================================
// Structured verification verdicts (the VerificationVerdict arc) — producers
//
// Phase A.2.1: the receipt-path verdict. Composes the existing primitives
// (`verifyExecutionReceipt` + `verifySovereignBinding`) into the structured
// verdict whose axes cannot silently collapse to `true`. The
// token/grant/revocation verdict path (authority + a real revocation basis)
// ships in the next increment; here authority is `unknown` and revocation is
// `unchecked`, reported honestly rather than manufactured into a pass.
// Doctrine: docs/doctrine/verify-family-fail-closed.md § "The VerificationVerdict arc".
// ===========================================================================

/**
 * Structured verdict for a signed `ExecutionReceipt`. Unlike `verifyReceipt`
 * (which returns a bare `valid` boolean), every axis here states what was
 * ESTABLISHED and what remains UNKNOWN — so an `unverified` binding or an
 * `unchecked` revocation cannot read as a pass. A bare receipt carries no
 * authority/revocation context and is not a temporal claim; those axes report
 * "not established," never a manufactured pass.
 *
 * `identityBinding` is `sovereign` when the `motebit_id` commits to the embedded
 * key (offline-derivable) and `unverified` otherwise — `pinned`/`anchored`
 * require an external anchor (known-keys map / identity file / transparency
 * proof) not present on the bare offline path; that input lands with the next
 * increment.
 */
export async function verifyReceiptVerdict(receipt: SignableReceipt): Promise<VerificationVerdict> {
  const evidenceBasis: EvidenceRef[] = [];

  // Resolve the embedded key (same rule as `verifyReceipt`).
  let publicKey: Uint8Array | null = null;
  if (receipt.public_key) {
    try {
      const b = hexToBytes(receipt.public_key);
      if (b.length === 32) publicKey = b;
    } catch {
      publicKey = null;
    }
    evidenceBasis.push({ kind: "public_key", ref: receipt.public_key });
  }
  evidenceBasis.push({ kind: "receipt", ref: receipt.result_hash });

  // integrity — Ed25519 signature AND STRICT hash binding. A valid signature is
  // NOT sufficient: a receipt whose `result_hash` does not recompute to
  // hex(SHA-256(result)) is a valid signature over a self-inconsistent body —
  // the digest claims to address `result` but commits to different bytes. That
  // is exactly the silent-true this reshape exists to kill (the
  // sovereign-check-was-theater failure mode). `verified` IFF the signature
  // verifies AND `result_hash` binds `result`. The three invalid sub-causes
  // carry distinct repair codes.
  let integrity: IntegrityVerdict;
  let integrityRepair: RepairInstruction | undefined;
  if (!publicKey) {
    integrity = "invalid";
    integrityRepair = {
      code: "integrity.no_key",
      axis: "integrity",
      summary: "Receipt has no usable embedded public_key to verify against.",
      canonical: "docs/doctrine/verify-family-fail-closed.md",
      fix: "Obtain the receipt with its embedded `public_key` (hex), or supply the signer's key out of band.",
    };
  } else if (!(await verifyExecutionReceipt(receipt, publicKey))) {
    integrity = "invalid";
    integrityRepair = {
      code: "integrity.signature_invalid",
      axis: "integrity",
      summary: "Ed25519 signature did not verify over the receipt's canonical bytes.",
      canonical: "docs/doctrine/verify-family-fail-closed.md",
      fix: "The receipt was tampered or signed by a different key — re-fetch the authentic receipt; do not trust this copy.",
    };
  } else if ((await hash(new TextEncoder().encode(receipt.result))) !== receipt.result_hash) {
    integrity = "invalid";
    integrityRepair = {
      code: "integrity.hash_inconsistent",
      axis: "integrity",
      summary:
        "Signature verifies, but result_hash != hex(SHA-256(result)) — a valid signature over a self-inconsistent receipt; the digest does not bind the result.",
      canonical: "the receipt's result_hash field (recompute hex(SHA-256(result)))",
      fix: "result_hash MUST equal hex(SHA-256(result)). The signer committed an inconsistent digest — reject the receipt; never trust result_hash as a content address for the result.",
    };
  } else {
    integrity = "verified";
  }

  // identityBinding — sovereign is offline-derivable; pinned/anchored need an
  // external anchor not present here, so the rung is sovereign-or-unverified.
  let identityBinding: IdentityBindingVerdict = "unverified";
  if (publicKey && receipt.public_key && receipt.motebit_id) {
    identityBinding = (await verifySovereignBinding(receipt.motebit_id, receipt.public_key))
      ? "sovereign"
      : "unverified";
  }

  // A bare receipt has no authority/revocation context and makes no temporal
  // claim — report "not established," never a manufactured pass.
  const authority: AuthorityVerdict = "unknown";
  const revocation: RevocationVerdict = { status: "unchecked" };
  const temporalBasis: TemporalBasis = "clockless";

  // repair — integrity is the more fundamental; then identity.
  let repair: RepairInstruction | undefined = integrityRepair;
  if (!repair && identityBinding === "unverified") {
    repair = {
      code: "identity.binding_unverified",
      axis: "identityBinding",
      summary:
        "Signature verifies, but the key-to-motebit_id binding is NOT established (integrity only).",
      canonical: "docs/doctrine/identity-binding-verification.md",
      fix: "The motebit_id does not commit to this key (not sovereign). Establish a higher rung — supply an identity file / known-keys map (pinned) or a transparency-log inclusion proof (anchored) — before treating this as identity-verified.",
    };
  }

  return {
    type: "receipt",
    integrity,
    identityBinding,
    authority,
    revocation,
    temporalBasis,
    evidenceBasis,
    ...(repair ? { repair } : {}),
  };
}

/**
 * Fail-closed collapse of a verdict to a single boolean — the back-compat
 * adapter shape (consumer #2's constraint). Returns `true` ONLY when every
 * load-bearing axis is in its passing state: integrity verified, identity bound
 * (sovereign/anchored/pinned), authority valid, revocation fresh. `unchecked` /
 * `stale` / `unknown` / `unverified` / `revoked` all derive `false`, never a
 * silent `true`.
 *
 * STRICTER than the legacy per-function booleans by design — a bare receipt
 * with no authority/revocation context returns `false` here. If you only need
 * "a real signed receipt from someone," branch on `integrity` + `identityBinding`
 * directly rather than this collapse.
 */
export function isFullyVerified(verdict: VerificationVerdict): boolean {
  return (
    verdict.integrity === "verified" &&
    (verdict.identityBinding === "sovereign" ||
      verdict.identityBinding === "anchored" ||
      verdict.identityBinding === "pinned") &&
    verdict.authority === "valid" &&
    verdict.revocation.status === "fresh"
  );
}

/**
 * Authority for a per-tick token against its grant — WITHOUT the revocation
 * check (that is its own axis). Structural fit first (a tick of THIS grant,
 * scope narrowed, TTL bounded, grant signed), then the temporal window per the
 * mode. In `ordering` mode the wall-clock window is NOT consulted: validity
 * rests on the signature + grant structure at the token's own slot, so a
 * rolled-back verifier clock is irrelevant. In `wall_clock` mode the token's
 * `not_before`/`expires_at` are judged against `now` — a rolled-back clock can
 * read a valid token as `not_yet_valid`.
 */
async function computeTokenAuthority(
  token: DelegationToken,
  grant: StandingDelegation,
  now: number,
  mode: "wall_clock" | "ordering",
): Promise<AuthorityVerdict> {
  if (token.grant_id !== grant.grant_id) return "insufficient";
  if (
    token.delegator_id !== grant.delegator_id ||
    token.delegator_public_key !== grant.delegator_public_key ||
    token.delegate_id !== grant.delegate_id ||
    token.delegate_public_key !== grant.delegate_public_key
  ) {
    return "insufficient";
  }
  if (!isScopeNarrowed(grant.scope, token.scope)) return "insufficient";
  if (token.expires_at - token.issued_at > grant.max_token_ttl_ms) return "insufficient";

  // The grant's own validity (signature + lifetime), at the temporal reference —
  // the verifier's `now` (wall_clock) or the token's own slot (ordering). NOT the
  // revocation check: that is the orthogonal `revocation` axis.
  const ref = mode === "ordering" ? (token.not_before ?? token.issued_at) : now;
  if (!(await verifyStandingDelegation(grant, { checkExpiry: true, now: ref }))) {
    return "insufficient";
  }

  if (mode === "ordering") return "valid"; // ordering decides; wall-clock window not consulted

  if (token.not_before !== undefined && now < token.not_before) return "not_yet_valid";
  if (token.expires_at < now) return "expired";
  return "valid";
}

function buildVerdictRepair(
  integrity: IntegrityVerdict,
  identityBinding: IdentityBindingVerdict,
  authority: AuthorityVerdict,
  revocation: RevocationVerdict,
): RepairInstruction | undefined {
  if (integrity === "invalid") {
    return {
      code: "integrity.signature_invalid",
      axis: "integrity",
      summary: "Ed25519 signature did not verify over the artifact's canonical bytes.",
      canonical: "docs/doctrine/verify-family-fail-closed.md",
      fix: "Re-fetch the authentic artifact; do not trust this copy.",
    };
  }
  if (identityBinding === "unverified" || identityBinding === "invalid") {
    return {
      code: "identity.binding_unverified",
      axis: "identityBinding",
      summary: "Signature verifies, but the key-to-motebit_id binding is NOT established.",
      canonical: "docs/doctrine/identity-binding-verification.md",
      fix: "Establish a higher rung — supply an identity file / known-keys map (pinned) or a transparency-log inclusion proof (anchored) — before treating this as identity-verified.",
    };
  }
  if (authority !== "valid") {
    return {
      code: `authority.${authority}`,
      axis: "authority",
      summary: `Authority is "${authority}", not "valid" — the token does not currently confer the authority it claims.`,
      canonical: "spec/standing-delegation-v1.md",
      fix:
        authority === "not_yet_valid"
          ? "The token's activation window has not started under this temporal basis — do not act until its slot; if you judge validity by ordering, set temporalMode: 'ordering'."
          : authority === "expired"
            ? "The token's validity window has passed — mint a fresh tick under the grant."
            : "The token is not a valid tick of this grant (scope/parties/TTL/grant). Re-mint within the grant's ceiling.",
    };
  }
  if (revocation.status !== "fresh") {
    return {
      code: `revocation.${revocation.status}`,
      axis: "revocation",
      summary:
        revocation.status === "revoked"
          ? "The standing grant behind this token is REVOKED — every tick minted under it is dead authority."
          : revocation.status === "unchecked"
            ? "Revocation was not checked — no revocation set was supplied."
            : "The revocation set is stale beyond the accepted tolerance.",
      canonical: "docs/doctrine/verify-family-fail-closed.md",
      fix:
        revocation.status === "revoked"
          ? "Reject this token and every token minted under the grant; the only safe action is to stop."
          : revocation.status === "unchecked"
            ? "Supply the revocation set (build the isRevoked seam via findGrantRevocation) and re-verify."
            : "Obtain a fresher revocation set (a newer ledger root or stapled freshness proof) and re-verify.",
    };
  }
  return undefined;
}

/**
 * Structured verdict for a per-tick `DelegationToken` evaluated against its
 * `StandingDelegation` (Phase A.2.2). The token/grant/revocation path — where
 * the axes most need to stay orthogonal: a token can be perfectly in-TTL and
 * well-formed (`authority: "valid"`) while the grant behind it is revoked
 * (`revocation: "revoked"`), and a bare boolean would read a pass. The verdict
 * keeps them separate so no consumer composes a pass over a dead grant.
 *
 * `temporalMode` selects how the token's validity window is judged, reported as
 * `temporalBasis`:
 *   - `"wall_clock"` (default): `not_before`/`expires_at` checked against `now`
 *     — `temporalBasis: "local_clock"`. A rolled-back clock can flip a valid
 *     token to `authority: "not_yet_valid"` (the live behavior of a wall-clock
 *     monitor today).
 *   - `"ordering"`: the wall-clock window is NOT consulted; validity rests on
 *     the signature + grant structure at the token's slot — `temporalBasis:
 *     "clockless"`, so a wall-clock rollback is irrelevant.
 *
 * Revocation is ORTHOGONAL to authority, checked over the caller's `revocations`
 * set: `revoked` when a binding revocation is found, `fresh` when the set was
 * consulted and the grant is absent, `unchecked` when no set was supplied.
 * `revocationFreshness` (basis + asOf) describes the set the caller holds — for
 * a self-hosted offline set, `{ basis: "asserted", … }`, which the consumer
 * down-weights.
 */
export async function verifyDelegationTokenVerdict(
  token: DelegationToken,
  grant: StandingDelegation,
  options?: {
    revocations?: readonly DelegationRevocation[];
    revocationFreshness?: RevocationFreshness;
    now?: number;
    temporalMode?: "wall_clock" | "ordering";
  },
): Promise<VerificationVerdict> {
  const now = options?.now ?? Date.now();
  const temporalMode = options?.temporalMode ?? "wall_clock";
  const evidenceBasis: EvidenceRef[] = [
    { kind: "delegation_token", ref: token.signature },
    { kind: "grant", ref: grant.grant_id },
    { kind: "public_key", ref: token.delegator_public_key },
  ];

  // integrity — the token's signature, clockless (the window is the authority axis).
  const integrity: IntegrityVerdict = (await verifyDelegation(token, { checkExpiry: false }))
    ? "verified"
    : "invalid";

  // identityBinding — sovereign binding of the token's signer (the delegator).
  const identityBinding: IdentityBindingVerdict = (await verifySovereignBinding(
    token.delegator_id,
    token.delegator_public_key,
  ))
    ? "sovereign"
    : "unverified";

  const authority = await computeTokenAuthority(token, grant, now, temporalMode);

  // revocation — orthogonal to authority; consulted over the caller's set.
  let revocation: RevocationVerdict;
  if (!options?.revocations) {
    revocation = { status: "unchecked" };
  } else {
    const rev = await findGrantRevocation(grant, options.revocations);
    const freshness: RevocationFreshness = options.revocationFreshness ?? {
      basis: "asserted",
      asOf: {},
    };
    if (rev) {
      revocation = { status: "revoked", freshness };
      evidenceBasis.push({ kind: "revocation", ref: rev.signature });
    } else {
      revocation = { status: "fresh", freshness };
    }
  }

  const temporalBasis: TemporalBasis = temporalMode === "ordering" ? "clockless" : "local_clock";
  const repair = buildVerdictRepair(integrity, identityBinding, authority, revocation);

  return {
    type: "delegation_token",
    integrity,
    identityBinding,
    authority,
    revocation,
    temporalBasis,
    evidenceBasis,
    ...(repair ? { repair } : {}),
  };
}

/**
 * Result of {@link verifyEvidenceProvenance}. Structured (not a bare boolean) so
 * a non-present result names WHY — same legibility discipline as the verdict.
 */
export type EvidenceProvenanceResult =
  | { present: true }
  | { present: false; reason: "digest_mismatch" | "projection_unresolved" | "span_absent" };

/**
 * Verify an {@link EvidenceProvenance} against the raw bytes it content-addresses
 * — the evidence-axis analog of signature integrity (verifiable-locality
 * extended from signatures to EVIDENCE; agency.computer co-design). The law: the
 * named `span` is an exact substring of `projection(bytes)`, where the bytes hash
 * to `provenance.digest`. It re-verifies PRESENCE ("is this claim backed by a
 * primary record?"), NEVER truth, with no oracle — the bytes either contain the
 * span or they don't.
 *
 * Domain-blind by construction: `projection` is an OPAQUE, app-owned recipe id,
 * so the projection is an INJECTED SEAM (same shape as `verifyStandingDelegation`'s
 * `isRevoked` — motebit never owns a projection catalog, which would be
 * document-format authority):
 *   - projection ABSENT  → the span is checked against the raw bytes directly
 *     (re-verifiable by construction, no shared code).
 *   - projection PRESENT + `resolveProjection` injected → apply, then check.
 *   - projection PRESENT + no resolver → FAIL CLOSED (`projection_unresolved`).
 *
 * `provenance.binding` (issuer authority) is NOT verified here — app-layer.
 * `locator` is advisory: the law is exact-substring presence, never a second
 * thing a re-verifier must reproduce.
 */
export async function verifyEvidenceProvenance(
  bytes: Uint8Array,
  provenance: EvidenceProvenance,
  opts?: {
    /**
     * Apply an opaque, app-owned projection recipe to the raw bytes and return
     * the projected text. Injected so motebit stays domain-blind; a present
     * `projection` with no resolver fails closed (`projection_unresolved`).
     *
     * Assumed TOTAL for any recipe it accepts: if the resolver THROWS, the
     * exception PROPAGATES — a resolver fault is a caller bug, not an evidence
     * verdict, and is never swallowed into a false `present:false` (that would let
     * a broken recipe masquerade as "evidence absent" and hide the bug). To signal
     * "I cannot resolve this recipe," OMIT the resolver and let the no-resolver
     * path fail closed (`projection_unresolved`) — never inject a throwing resolver
     * as a not-supported signal. (Contract clarified from agency.computer adoption,
     * 2026-06 — their wrapper injects a resolver only for the recipes it owns and
     * lets every other recipe fall through to `projection_unresolved`.)
     */
    resolveProjection?: (recipeId: string, bytes: Uint8Array) => string | Promise<string>;
  },
): Promise<EvidenceProvenanceResult> {
  // 1. Content-address the RAW, independently-obtainable bytes. `DigestAlgorithm`
  //    is `"sha-256"` today (the only member), so we hash directly; a second
  //    algorithm adds a dispatch here (the field carries the role so that is a
  //    registry append, not a wire break). An unknown algorithm fails closed —
  //    its value cannot match the sha-256 digest.
  const computed = await hash(bytes);
  if (computed.toLowerCase() !== provenance.digest.value.toLowerCase()) {
    return { present: false, reason: "digest_mismatch" };
  }

  // 2. Projection — the injected seam. motebit owns the law, never the recipe.
  let text: string;
  if (provenance.projection != null) {
    if (opts?.resolveProjection == null) {
      return { present: false, reason: "projection_unresolved" };
    }
    // The resolver is assumed total for recipes it accepts — a throw PROPAGATES
    // (a caller bug, not an evidence verdict; see the resolveProjection contract).
    // "Cannot resolve this recipe" is signaled by OMITTING the resolver above, not
    // by throwing here.
    text = await opts.resolveProjection(provenance.projection, bytes);
  } else {
    text = new TextDecoder().decode(bytes);
  }

  // 3. Exact-substring presence (locator is advisory, not load-bearing).
  return text.includes(provenance.span)
    ? { present: true }
    : { present: false, reason: "span_absent" };
}

/**
 * Verify a `ToolInvocationReceipt` resolved from auto-detection. Mirrors
 * `verifyReceipt`: resolves the signer key from the receipt's own `public_key`
 * (integrity, not identity binding — the rung is computed by `@motebit/verifier`)
 * and dispatches to `verifyToolInvocationReceipt`. Returns a structured result
 * with the same shape contract as the other arms, so a genuine tool-invocation
 * receipt gets a real verdict from `verify()` instead of falling through to a
 * misleading "invalid identity artifact."
 */
async function verifyToolInvocation(
  receipt: SignableToolInvocationReceipt,
): Promise<ToolInvocationVerifyResult> {
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
    return {
      type: "tool-invocation",
      valid: false,
      toolInvocation: receipt,
      errors: [{ message: "No embedded public_key — cannot verify without known keys" }],
    };
  }

  const valid = await verifyToolInvocationReceipt(receipt, publicKey);
  return {
    type: "tool-invocation",
    valid,
    toolInvocation: receipt,
    signer: signerDid,
    keySource: "embedded",
    ...(valid ? {} : { errors: [{ message: "Ed25519 signature did not verify" }] }),
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

  const skewMs = clockSkewSeconds * 1000;

  // Check expiry (with clock skew tolerance for distributed systems)
  let expired = false;
  if (vc.validUntil) {
    const expiresAt = new Date(vc.validUntil).getTime();
    if (Date.now() > expiresAt + skewMs) {
      expired = true;
      errors.push({ message: "Credential has expired", path: "validUntil" });
    }
  }

  // Check activation — `validFrom` is REQUIRED (credential-v1 §2.1: "when the
  // credential becomes valid"). A credential dated to activate in the future is
  // not yet valid, fail-closed — the temporal sibling of the expiry check.
  let notYetValid = false;
  if (vc.validFrom) {
    const activeAt = new Date(vc.validFrom).getTime();
    if (Date.now() + skewMs < activeAt) {
      notYetValid = true;
      errors.push({ message: "Credential is not yet valid", path: "validFrom" });
    }
  }

  // Revocation is a relay/federation concern (§6); the offline aggregator cannot
  // consult it. Surface that honestly rather than implying "not revoked".
  const revocationUnchecked = vc.credentialStatus !== undefined;

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
    valid: proofValid && !expired && !notYetValid,
    credential: vc,
    issuer: issuerDid,
    subject: subjectId,
    expired,
    ...(notYetValid ? { not_yet_valid: true } : {}),
    ...(revocationUnchecked ? { revocation_unchecked: true } : {}),
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
    // Unrecognized artifact type — distinct from "valid:false on a known type."
    // Previously this returned a degenerate `type:"identity", valid:false`
    // ("backward compat"), which made an unrecognized blob indistinguishable
    // from a forged identity file. An honest verifier reports "I don't know
    // what this is" as its own result so a consumer never reads unrecognized as
    // forged. `valid` stays false (nothing was verified).
    const expected = options?.expectedType;
    return {
      type: "unknown",
      valid: false,
      reason: "unrecognized_artifact_type",
      errors: [
        {
          message: expected
            ? `Unrecognized artifact format (expected "${expected}")`
            : "Unrecognized artifact format",
        },
      ],
    };
  }

  if (options?.expectedType && options.expectedType !== detected) {
    return {
      type: detected,
      valid: false,
      ...(detected === "identity" ? { identity: null } : {}),
      ...(detected === "receipt" ? { receipt: null } : {}),
      ...(detected === "tool-invocation" ? { toolInvocation: null } : {}),
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
        ...(detected === "tool-invocation" ? { toolInvocation: null } : {}),
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
      return verifyReceipt(resolved as ExecutionReceipt, options);
    case "tool-invocation":
      return verifyToolInvocation(resolved as SignableToolInvocationReceipt);
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
  signContentArtifact,
  verifyContentArtifact,
  CONTENT_ARTIFACT_SUITE,
} from "./content-artifact.js";
export type {
  ContentArtifactManifest,
  SignContentArtifactOptions,
  VerifyContentArtifactResult,
} from "./content-artifact.js";
export {
  signEvalAttestation,
  verifyEvalAttestation,
  EVAL_ATTESTATION_SUITE,
  EVAL_KINDS_MIRROR,
} from "./eval-attestation.js";
export type { VerifyEvalAttestationResult } from "./eval-attestation.js";
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
  AGENT_SETTLEMENT_ANCHOR_SUITE,
  computeAgentSettlementLeaf,
  verifyAgentSettlementAnchor,
  type AgentSettlementAnchorVerifyResult,
  type AgentSettlementAnchorProofFields,
} from "./agent-settlement-anchor.js";
export {
  FEDERATION_SETTLEMENT_ANCHOR_SUITE,
  computeFederationSettlementLeaf,
  verifyFederationSettlementAnchor,
  type FederationSettlementAnchorVerifyResult,
  type FederationSettlementAnchorProofFields,
} from "./federation-settlement-anchor.js";
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
export {
  verifyMerkleInclusion,
  hashLeaf,
  canonicalLeaf,
  resolveTreeHashVersion,
} from "./merkle.js";

// Agent-command envelope convention — the first consumer binding of
// signed-request-envelope@1.0: remote `command_request` ingress is
// signed by the agent's own identity, audience-bound to the target
// (`agent-command/{motebit_id}`), digest-bound to `{command, args}`.
// Relay verifies at ingress as defense in depth; every consuming
// surface re-verifies fail-closed. See
// `docs/doctrine/daemon-desktop-unification.md` increment 4.
export {
  agentCommandAudience,
  agentCommandPayload,
  signAgentCommandEnvelope,
  verifyAgentCommandEnvelope,
  type AgentCommandVerdict,
} from "./agent-command.js";
