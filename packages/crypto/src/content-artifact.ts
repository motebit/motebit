/**
 * Content-artifact provenance — sign and verify arbitrary content bytes
 * with a manifest binding them to a producer identity, an invocation
 * context, and a moment in time.
 *
 * Where motebit produces a **standalone artifact that travels
 * independently** of the conversation context — memory exports, audit-
 * trail JSON, plan dumps, eventually generated documents and media —
 * the `ContentArtifactManifest` is the provenance envelope. C2PA-shape
 * (industry standard for content authenticity): manifest separate from
 * content, signed over canonical JSON of the manifest with the
 * content's SHA-256 hash bound in.
 *
 * Verification:
 *
 *   1. Recompute SHA-256 over the content bytes; reject if it doesn't
 *      match `manifest.content_hash`.
 *   2. Verify the manifest signature against `manifest.producer_public_key`
 *      via `verifyBySuite`. Reject on signature mismatch.
 *
 * Both passes → the artifact is provably produced by the named identity
 * at the named time. No relay contact, no operator trust, no
 * out-of-band metadata — only `@motebit/crypto` and the bytes.
 *
 * Doctrine: `docs/doctrine/self-attesting-system.md` — every motebit
 * claim is independently verifiable using only published primitives
 * and the signer's public key. `docs/doctrine/nist-alignment.md` §8 —
 * the content-provenance ask collapses here.
 *
 * Same canonical-JSON + Ed25519 + suite-dispatch pattern as
 * `signExecutionReceipt` (artifacts.ts) and `signSkillManifest`
 * (skills.ts). Permissive-floor primitive.
 */

import {
  canonicalJson,
  bytesToHex,
  hexToBytes,
  toBase64Url,
  fromBase64Url,
  sha256,
} from "./signing.js";
import { signBySuite, verifyBySuite } from "./suite-dispatch.js";
import type { ContentArtifactType, SuiteId } from "@motebit/protocol";

/**
 * Pinned cryptosuite for content-artifact manifests. JCS canonicalization
 * + Ed25519 + hex signature encoding. Matches identity-file + credential-
 * anchor + relay-metadata family (see `SUITE_REGISTRY` in
 * `@motebit/protocol/crypto-suite.ts`).
 */
export const CONTENT_ARTIFACT_SUITE: SuiteId = "motebit-jcs-ed25519-hex-v1";

/**
 * The provenance manifest. Bound to its content via `content_hash`;
 * bound to its producer via signature over `producer_public_key`.
 *
 * `claim_generator` mirrors C2PA's identifier-of-producing-software
 * field; `produced_at` is the wall-clock time the artifact was
 * assembled; `invocation` is the optional cross-reference back into
 * motebit's execution ledger (the receipt or task that triggered the
 * artifact's production).
 */
export interface ContentArtifactManifest {
  /** Cryptosuite identifier — `motebit-jcs-ed25519-hex-v1` today. */
  readonly suite: SuiteId;
  /** Identifier of the software that produced the artifact, e.g. `"motebit/1.2.3"`. */
  readonly claim_generator: string;
  /** ISO-8601 UTC timestamp when the artifact was produced. */
  readonly produced_at: string;
  /** Producer's DID — typically `did:key:zXXX` derived from the public key. */
  readonly producer: string;
  /** Producer's public key in lowercase hex (32 bytes / 64 chars for Ed25519). */
  readonly producer_public_key: string;
  /**
   * Artifact category from the closed `ContentArtifactType` registry in
   * `@motebit/protocol`. Producer-declared; drift gate
   * `check-artifact-type-canonical` enforces every literal at a
   * signing site is a registry member.
   */
  readonly artifact_type: ContentArtifactType;
  /** SHA-256 of the canonical content bytes, lowercase hex. */
  readonly content_hash: string;
  /** Optional cross-reference into motebit's execution ledger. */
  readonly invocation?: {
    readonly task_id?: string;
    readonly receipt_id?: string;
  };
  /** Signature over `canonicalJson({...manifest minus signature})`, base64url-encoded. */
  readonly signature: string;
}

/**
 * Inputs for `signContentArtifact`. `producerPublicKey` is required
 * alongside the private key so the manifest carries it self-describingly
 * — verifiers don't need a separate channel to learn the verification
 * key.
 */
export interface SignContentArtifactOptions {
  /** Artifact category — embedded in the manifest. Closed registry in `@motebit/protocol`. */
  readonly artifactType: ContentArtifactType;
  /** Producer's DID (e.g. `did:key:zXXX`). */
  readonly producer: string;
  /** Producer's Ed25519 public key (32 bytes). */
  readonly producerPublicKey: Uint8Array;
  /** Producer's Ed25519 private key (32 bytes). */
  readonly producerPrivateKey: Uint8Array;
  /** Software-identity claim, e.g. `"motebit/1.2.3"`. */
  readonly claimGenerator: string;
  /** Optional invocation cross-reference. */
  readonly invocation?: { readonly task_id?: string; readonly receipt_id?: string };
  /**
   * Override the pinned suite. Default `CONTENT_ARTIFACT_SUITE`. Useful
   * only for PQ migration once a new `SuiteId` lands; today every caller
   * uses the default.
   */
  readonly suite?: SuiteId;
  /**
   * Override the `produced_at` timestamp. Internal — exposed only for
   * deterministic tests. Production callers omit this and let the
   * primitive stamp the current time.
   */
  readonly producedAt?: string;
}

/** Canonical bytes used for signing — manifest without its own signature field. */
function canonicalizeForSigning(unsigned: Omit<ContentArtifactManifest, "signature">): Uint8Array {
  return new TextEncoder().encode(canonicalJson(unsigned));
}

/**
 * Sign content bytes, returning a `ContentArtifactManifest` that binds
 * the producer, the content, and the moment of production. The content
 * bytes themselves are NOT in the manifest — only their hash — so the
 * manifest can be transported separately (e.g. as an HTTP header)
 * without doubling the payload.
 */
export async function signContentArtifact(
  content: Uint8Array,
  options: SignContentArtifactOptions,
): Promise<ContentArtifactManifest> {
  const suite = options.suite ?? CONTENT_ARTIFACT_SUITE;
  const contentHashBytes = await sha256(content);
  const unsigned: Omit<ContentArtifactManifest, "signature"> = {
    suite,
    claim_generator: options.claimGenerator,
    produced_at: options.producedAt ?? new Date().toISOString(),
    producer: options.producer,
    producer_public_key: bytesToHex(options.producerPublicKey),
    artifact_type: options.artifactType,
    content_hash: bytesToHex(contentHashBytes),
    ...(options.invocation ? { invocation: options.invocation } : {}),
  };
  const message = canonicalizeForSigning(unsigned);
  const sig = await signBySuite(suite, message, options.producerPrivateKey);
  return { ...unsigned, signature: toBase64Url(sig) };
}

/** Verification outcome with a structured failure reason for audit logging. */
export interface VerifyContentArtifactResult {
  readonly valid: boolean;
  /** Structured failure reason when `valid === false`. */
  readonly reason?:
    | "content_hash_mismatch"
    | "signature_invalid"
    | "malformed_public_key"
    | "malformed_signature"
    | "unsupported_suite";
}

/**
 * Verify a `ContentArtifactManifest` against the content bytes it
 * claims to cover. Two-step check: content-hash recomputation
 * (catches tampering of the bytes) and signature verification
 * against the manifest's declared public key (catches tampering of
 * the manifest itself). Both must pass.
 *
 * Fail-closed: every rejection returns a typed reason rather than
 * throwing. The caller decides how to surface — audit log entry,
 * UI banner, 4xx response.
 *
 * Trust note: this primitive verifies the signature against the
 * key declared IN the manifest. The caller is responsible for
 * confirming that declared key is who they expect (e.g. pinning a
 * relay's identity key, checking a known motebit's public key).
 * Without that out-of-band binding, the manifest only proves
 * "someone with this key produced these bytes" — not "this
 * specific motebit." The producer DID is for human display; the
 * key is the cryptographic anchor.
 */
export async function verifyContentArtifact(
  manifest: ContentArtifactManifest,
  content: Uint8Array,
): Promise<VerifyContentArtifactResult> {
  // 1. Recompute content hash. A mismatch means either the content
  //    was tampered with after manifest production, or the manifest
  //    was generated for different content. Either way, reject.
  const recomputedHashBytes = await sha256(content);
  const recomputedHashHex = bytesToHex(recomputedHashBytes);
  if (recomputedHashHex !== manifest.content_hash) {
    return { valid: false, reason: "content_hash_mismatch" };
  }

  // 2. Decode the manifest's declared public key. A malformed hex
  //    string OR a wrong-length key is a manifest-construction error
  //    (distinct from a valid-shape key whose signature fails).
  //    Ed25519 keys are 32 bytes (64 hex chars); the regex catches
  //    non-hex chars AND wrong length in one pass. Future PQ suites
  //    will need their own length validation here.
  if (!/^[0-9a-fA-F]{64}$/.test(manifest.producer_public_key)) {
    return { valid: false, reason: "malformed_public_key" };
  }
  let publicKey: Uint8Array;
  try {
    publicKey = hexToBytes(manifest.producer_public_key);
  } catch {
    return { valid: false, reason: "malformed_public_key" };
  }

  // 3. Decode the signature. Malformed base64url is another
  //    construction error.
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(manifest.signature);
  } catch {
    return { valid: false, reason: "malformed_signature" };
  }

  // 4. Verify the signature over the canonicalized manifest body
  //    (everything except the signature itself).
  const unsigned: Omit<ContentArtifactManifest, "signature"> = {
    suite: manifest.suite,
    claim_generator: manifest.claim_generator,
    produced_at: manifest.produced_at,
    producer: manifest.producer,
    producer_public_key: manifest.producer_public_key,
    artifact_type: manifest.artifact_type,
    content_hash: manifest.content_hash,
    ...(manifest.invocation ? { invocation: manifest.invocation } : {}),
  };
  const message = canonicalizeForSigning(unsigned);
  let valid: boolean;
  try {
    valid = await verifyBySuite(manifest.suite, message, sigBytes, publicKey);
  } catch {
    // verifyBySuite throws on PQ suites that aren't yet implemented.
    // Surface that as a typed unsupported-suite outcome.
    return { valid: false, reason: "unsupported_suite" };
  }
  if (!valid) return { valid: false, reason: "signature_invalid" };

  return { valid: true };
}
