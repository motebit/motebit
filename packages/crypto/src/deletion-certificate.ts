/**
 * Deletion certificate — sign + verify for the three retention shapes.
 *
 * Permissive floor (Apache-2.0). Zero monorepo dependencies — types
 * mirror `@motebit/protocol`'s discriminated union; primitives route
 * through `@motebit/crypto/suite-dispatch`.
 *
 * Three arms in one union (`@motebit/protocol :: DeletionCertificate`):
 *
 *   - `mutable_pruning` and `consolidation_flush` — multi-signature
 *     certs (subject / operator / delegate / guardian, at-least-one
 *     required by the reason-table). Each present signature covers the
 *     same canonical bytes: `canonicalJson(cert minus all *_signature
 *     fields)`. Pattern matches identity-v1 §3.8.1 dual-signature
 *     succession (one canonical payload, multiple verifiable signers).
 *
 *   - `append_only_horizon` — single-issuer signature plus witness
 *     signatures. Both the issuer and every witness sign the same
 *     `canonicalJson(cert minus signature)`. Witness array is part of
 *     the signed body — a forged witness fails verification.
 *
 * Verification dispatches by `kind`. Reason × signer × mode table
 * (decision 5) gates which signer compositions are admissible. Each
 * admissible signature is then cryptographically verified through
 * `verifyBySuite`.
 */

import type {
  DeletionCertificate,
  DeletionReason,
  HorizonWitness,
  SuiteId,
} from "@motebit/protocol";

import { canonicalJson, hexToBytes, fromBase64Url, toBase64Url, bytesToHex } from "./signing.js";
import { signBySuite, verifyBySuite } from "./suite-dispatch.js";

// ── Constants ────────────────────────────────────────────────────────

/** The cryptosuite every deletion certificate signs under today. */
export const DELETION_CERTIFICATE_SUITE: SuiteId = "motebit-jcs-ed25519-b64-v1";

/**
 * Filing window for `WitnessOmissionDispute` (retention phase 4b-3).
 * A dispute MUST be filed within 24h of the cert's `issued_at`;
 * `verifyWitnessOmissionDispute` rejects beyond this window. Mirrors
 * the 24h cadence of `spec/dispute-v1.md` §7.5 (filing / withdrawal /
 * appeal windows).
 */
export const WITNESS_OMISSION_DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Canonical empty-tree merkle root — hex-encoded SHA-256 of zero
 * bytes. The verifier in `verifyHorizonCert` rejects horizon certs
 * whose `federation_graph_anchor.leaf_count = 0` carries a
 * `merkle_root` other than this value, so a malicious issuer cannot
 * mint a self-witnessed cert with arbitrary anchor bytes. Mirrors
 * `EMPTY_FEDERATION_GRAPH_ANCHOR.merkle_root` in `@motebit/protocol`.
 */
const EMPTY_FEDERATION_GRAPH_ANCHOR_ROOT =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ── Reason × signer × mode table (decision 5) ────────────────────────

type SignerKind = "subject" | "operator" | "delegate" | "guardian";
type DeploymentMode = "sovereign" | "mediated" | "enterprise";

interface ReasonRule {
  /** The signer kind that MUST be present and cryptographically valid. */
  readonly required: SignerKind;
  /** Signer kinds whose presence is permitted; verified if present. */
  readonly optional: readonly SignerKind[];
  /** Signer kinds whose presence is a verification failure. */
  readonly forbidden: readonly SignerKind[];
  /** Deployment modes that admit this reason. */
  readonly modes: readonly DeploymentMode[];
}

const REASON_TABLE: Readonly<Record<DeletionReason, ReasonRule>> = Object.freeze({
  user_request: {
    required: "subject",
    optional: ["operator"],
    forbidden: [],
    modes: ["sovereign", "mediated", "enterprise"],
  },
  retention_enforcement: {
    required: "operator",
    optional: ["subject"],
    forbidden: [],
    modes: ["mediated", "enterprise"],
  },
  retention_enforcement_post_classification: {
    required: "operator",
    optional: ["subject"],
    forbidden: [],
    modes: ["mediated", "enterprise"],
  },
  operator_request: {
    required: "operator",
    optional: [],
    forbidden: ["subject"],
    modes: ["mediated", "enterprise"],
  },
  delegated_request: {
    required: "delegate",
    optional: ["operator"],
    forbidden: [],
    modes: ["mediated", "enterprise"],
  },
  self_enforcement: {
    required: "subject",
    optional: [],
    forbidden: ["operator"],
    // Admitted in every mode: the subject's runtime can drive its own
    // retention policy whether or not an operator exists. The
    // distinction from `retention_enforcement` is who signs — subject
    // for self_enforcement, operator for retention_enforcement.
    modes: ["sovereign", "mediated", "enterprise"],
  },
  guardian_request: {
    required: "guardian",
    optional: ["operator"],
    forbidden: [],
    modes: ["enterprise"],
  },
});

// ── Verification result ──────────────────────────────────────────────

/** Result of verifying a deletion certificate. Fail-closed: any failure → `valid: false`. */
export interface DeletionCertificateVerifyResult {
  readonly valid: boolean;
  readonly errors: string[];
  /** Per-step breakdown — useful for debugging and audit display. */
  readonly steps: {
    readonly reason_table_satisfied: boolean;
    readonly subject_signature_valid: boolean | null;
    readonly operator_signature_valid: boolean | null;
    readonly delegate_signature_valid: boolean | null;
    readonly guardian_signature_valid: boolean | null;
    /** Horizon-arm only: issuer signature on the cert body. */
    readonly horizon_issuer_signature_valid: boolean | null;
    /** Horizon-arm only: count of witness signatures that verified. */
    readonly horizon_witnesses_valid_count: number | null;
    /** Horizon-arm only: count of witness signatures present. */
    readonly horizon_witnesses_present_count: number | null;
  };
}

/**
 * Resolver context for the verifier. Callers supply the public-key
 * resolution paths the cert's signers reference. Resolvers return
 * `null` when the key cannot be resolved (unknown id, registry miss);
 * the verifier rejects fail-closed in that case.
 *
 * The guardian signature embeds its own public key (`guardian_public_key`),
 * so no guardian resolver is needed — the verifier does cross-check that
 * the embedded key matches the motebit's declared guardian via the
 * `validateGuardianBinding` callback when supplied.
 */
export interface DeletionCertificateVerifyContext {
  /** Resolve a motebit's identity Ed25519 public key (32 bytes). */
  readonly resolveMotebitPublicKey: (motebitId: string) => Promise<Uint8Array | null>;
  /** Resolve an operator's Ed25519 public key (32 bytes). */
  readonly resolveOperatorPublicKey: (operatorId: string) => Promise<Uint8Array | null>;
  /**
   * Optional cross-check that an embedded `guardian_public_key` actually
   * is the declared guardian for the cert's subject motebit. When
   * absent, the verifier verifies the signature against the embedded
   * key without checking the binding.
   */
  readonly validateGuardianBinding?: (
    targetMotebitId: string | undefined,
    guardianPublicKeyHex: string,
  ) => Promise<boolean>;
  /**
   * Optional declared deployment mode. When supplied, the verifier
   * additionally checks the cert's reason against
   * `REASON_TABLE[reason].modes`. When absent, mode-checking is skipped
   * (the reason × signer table still applies).
   */
  readonly deploymentMode?: DeploymentMode;
}

// ── Signing helpers ──────────────────────────────────────────────────

/**
 * Compute the canonical signing bytes for a `mutable_pruning` or
 * `consolidation_flush` cert. Strips every `*_signature` field so all
 * present signers sign identical bytes — matches identity-v1 §3.8.1's
 * dual-signature canonical payload.
 */
export function canonicalizeMultiSignatureCert(
  cert: Extract<DeletionCertificate, { kind: "mutable_pruning" | "consolidation_flush" }>,
): Uint8Array {
  const { subject_signature, operator_signature, delegate_signature, guardian_signature, ...body } =
    cert;
  // touch all extracted fields so unused-locals lint doesn't fail
  void subject_signature;
  void operator_signature;
  void delegate_signature;
  void guardian_signature;
  return new TextEncoder().encode(canonicalJson(body));
}

/**
 * Compute the canonical signing bytes for an `append_only_horizon`
 * cert's ISSUER signature. Strips only `signature`. The issuer commits
 * to the full body — including every witness's signature in
 * `witnessed_by` — so a forged witness fails verification at the
 * issuer signature step (the body the issuer signed no longer matches
 * the post-tampering body).
 */
export function canonicalizeHorizonCert(
  cert: Extract<DeletionCertificate, { kind: "append_only_horizon" }>,
): Uint8Array {
  const { signature, ...body } = cert;
  void signature;
  return new TextEncoder().encode(canonicalJson(body));
}

/**
 * Compute the canonical signing bytes for a WITNESS signature on an
 * `append_only_horizon` cert. Strips both `signature` and
 * `witnessed_by` so witnesses can co-sign asynchronously without
 * needing to know each other's signatures.
 *
 * Witness's identity is bound to the signature via the public key
 * used at verification (resolved from `witnessed_by[i].motebit_id`).
 * The cert body's other fields (subject, store_id, horizon_ts,
 * issued_at, federation_graph_anchor) make two distinct horizon
 * advances produce distinct signing bytes, so a witness signature
 * cannot be relayed to a different cert.
 *
 * The issuer's separate signature commits to the assembled witness
 * array — that's the binding that makes a forged or substituted
 * witness detectable.
 */
export function canonicalizeHorizonCertForWitness(
  cert: Extract<DeletionCertificate, { kind: "append_only_horizon" }>,
): Uint8Array {
  const { signature, witnessed_by, ...body } = cert;
  void signature;
  void witnessed_by;
  return new TextEncoder().encode(canonicalJson(body));
}

/**
 * Sign a `mutable_pruning` or `consolidation_flush` cert as the
 * subject (motebit identity key). Adds the `subject_signature` block.
 *
 * Callers compose: sign as subject → optionally sign as operator → emit.
 * Each signing step appends a signature block; the canonical bytes are
 * recomputed from the body each time, so signatures are commutative
 * (any signing order produces identical bytes for every signer).
 */
export async function signCertAsSubject<
  T extends Extract<DeletionCertificate, { kind: "mutable_pruning" | "consolidation_flush" }>,
>(cert: T, motebitId: string, privateKey: Uint8Array): Promise<T> {
  const bytes = canonicalizeMultiSignatureCert(cert);
  const sig = await signBySuite(DELETION_CERTIFICATE_SUITE, bytes, privateKey);
  return {
    ...cert,
    subject_signature: {
      motebit_id: motebitId as never,
      suite: DELETION_CERTIFICATE_SUITE,
      signature: toBase64Url(sig),
    },
  } as T;
}

/** Sign a multi-signature cert as the operator. */
export async function signCertAsOperator<
  T extends Extract<DeletionCertificate, { kind: "mutable_pruning" | "consolidation_flush" }>,
>(cert: T, operatorId: string, privateKey: Uint8Array): Promise<T> {
  const bytes = canonicalizeMultiSignatureCert(cert);
  const sig = await signBySuite(DELETION_CERTIFICATE_SUITE, bytes, privateKey);
  return {
    ...cert,
    operator_signature: {
      operator_id: operatorId,
      suite: DELETION_CERTIFICATE_SUITE,
      signature: toBase64Url(sig),
    },
  } as T;
}

/** Sign a multi-signature cert as a delegate (multi-hop authorization). */
export async function signCertAsDelegate<
  T extends Extract<DeletionCertificate, { kind: "mutable_pruning" | "consolidation_flush" }>,
>(
  cert: T,
  delegateMotebitId: string,
  delegationReceiptId: string,
  privateKey: Uint8Array,
): Promise<T> {
  const bytes = canonicalizeMultiSignatureCert(cert);
  const sig = await signBySuite(DELETION_CERTIFICATE_SUITE, bytes, privateKey);
  return {
    ...cert,
    delegate_signature: {
      motebit_id: delegateMotebitId as never,
      delegation_receipt_id: delegationReceiptId,
      suite: DELETION_CERTIFICATE_SUITE,
      signature: toBase64Url(sig),
    },
  } as T;
}

/** Sign a multi-signature cert as the guardian (enterprise custody). */
export async function signCertAsGuardian<
  T extends Extract<DeletionCertificate, { kind: "mutable_pruning" | "consolidation_flush" }>,
>(cert: T, guardianPublicKey: Uint8Array, privateKey: Uint8Array): Promise<T> {
  const bytes = canonicalizeMultiSignatureCert(cert);
  const sig = await signBySuite(DELETION_CERTIFICATE_SUITE, bytes, privateKey);
  return {
    ...cert,
    guardian_signature: {
      guardian_public_key: bytesToHex(guardianPublicKey),
      suite: DELETION_CERTIFICATE_SUITE,
      signature: toBase64Url(sig),
    },
  } as T;
}

/**
 * Sign an `append_only_horizon` cert as the issuer. The issuer is the
 * subject named by the discriminator — motebit identity key for
 * per-motebit horizons, operator key for operator-wide horizons.
 */
export async function signHorizonCertAsIssuer(
  cert: Omit<Extract<DeletionCertificate, { kind: "append_only_horizon" }>, "suite" | "signature">,
  privateKey: Uint8Array,
): Promise<Extract<DeletionCertificate, { kind: "append_only_horizon" }>> {
  const withSuite = { ...cert, suite: DELETION_CERTIFICATE_SUITE, signature: "" };
  const bytes = canonicalizeHorizonCert(withSuite);
  const sig = await signBySuite(DELETION_CERTIFICATE_SUITE, bytes, privateKey);
  return { ...withSuite, signature: toBase64Url(sig) };
}

/**
 * Add a witness signature to an `append_only_horizon` cert. Witness
 * signs the same canonical body as the issuer; the witness array is
 * part of the signed body, so once the issuer has signed, the witness
 * additions are appended without re-signing the issuer side.
 *
 * Note: the issuer's signature is over the body INCLUDING the
 * witness array as it stood when the issuer signed. Witnesses added
 * after issuer-signing invalidate the issuer signature. Production
 * flow: build the witness array first → issuer signs last. This
 * function is here for tests and offline witness aggregation.
 */
export async function signHorizonWitness(
  cert: Extract<DeletionCertificate, { kind: "append_only_horizon" }>,
  witnessMotebitId: string,
  privateKey: Uint8Array,
  inclusionProof?: HorizonWitness["inclusion_proof"],
): Promise<HorizonWitness> {
  const bytes = canonicalizeHorizonCertForWitness(cert);
  const sig = await signBySuite(DELETION_CERTIFICATE_SUITE, bytes, privateKey);
  const witness: HorizonWitness = {
    motebit_id: witnessMotebitId as never,
    signature: toBase64Url(sig),
    ...(inclusionProof !== undefined ? { inclusion_proof: inclusionProof } : {}),
  };
  return witness;
}

// ── Verifier ─────────────────────────────────────────────────────────

/**
 * Verify a deletion certificate. Single entry point — dispatches by
 * `kind` to the per-arm verifier. Fail-closed throughout: any
 * verification step that errors or returns false → `valid: false`.
 *
 * The verifier checks, in order:
 *   1. Reason × signer × mode table is satisfied (decision 5).
 *   2. Each present signature is cryptographically valid against the
 *      cert's canonical signing bytes.
 *   3. (Horizon arm only) the issuer signature and each witness
 *      signature verify.
 *   4. (Optional, when `validateGuardianBinding` supplied) the
 *      embedded guardian public key matches the subject motebit's
 *      declared guardian.
 */
export async function verifyDeletionCertificate(
  cert: DeletionCertificate,
  ctx: DeletionCertificateVerifyContext,
): Promise<DeletionCertificateVerifyResult> {
  switch (cert.kind) {
    case "mutable_pruning":
    case "consolidation_flush":
      return verifyMultiSignatureCert(cert, ctx);
    case "append_only_horizon":
      return verifyHorizonCert(cert, ctx);
  }
}

async function verifyMultiSignatureCert(
  cert: Extract<DeletionCertificate, { kind: "mutable_pruning" | "consolidation_flush" }>,
  ctx: DeletionCertificateVerifyContext,
): Promise<DeletionCertificateVerifyResult> {
  const errors: string[] = [];
  const rule = REASON_TABLE[cert.reason];
  if (rule === undefined) {
    return failResult(`unknown reason: ${cert.reason}`);
  }

  // Mode check (only when caller declared a mode).
  if (ctx.deploymentMode !== undefined && !rule.modes.includes(ctx.deploymentMode)) {
    errors.push(`reason "${cert.reason}" not admitted in deployment mode "${ctx.deploymentMode}"`);
  }

  // Presence check — required signer must be present, forbidden must be absent.
  const present: Record<SignerKind, boolean> = {
    subject: cert.subject_signature !== undefined,
    operator: cert.operator_signature !== undefined,
    delegate: cert.delegate_signature !== undefined,
    guardian: cert.guardian_signature !== undefined,
  };
  if (!present[rule.required]) {
    errors.push(`reason "${cert.reason}" requires ${rule.required}_signature, not present`);
  }
  for (const f of rule.forbidden) {
    if (present[f]) {
      errors.push(`reason "${cert.reason}" forbids ${f}_signature, present`);
    }
  }

  // Signature verification — verify every present signature against canonical bytes.
  const bytes = canonicalizeMultiSignatureCert(cert);

  let subjectValid: boolean | null = null;
  if (cert.subject_signature !== undefined) {
    subjectValid = await verifyOneSignature(
      bytes,
      cert.subject_signature.signature,
      cert.subject_signature.suite,
      await ctx.resolveMotebitPublicKey(cert.subject_signature.motebit_id as string),
    );
    if (!subjectValid) errors.push("subject_signature invalid");
  }

  let operatorValid: boolean | null = null;
  if (cert.operator_signature !== undefined) {
    operatorValid = await verifyOneSignature(
      bytes,
      cert.operator_signature.signature,
      cert.operator_signature.suite,
      await ctx.resolveOperatorPublicKey(cert.operator_signature.operator_id),
    );
    if (!operatorValid) errors.push("operator_signature invalid");
  }

  let delegateValid: boolean | null = null;
  if (cert.delegate_signature !== undefined) {
    delegateValid = await verifyOneSignature(
      bytes,
      cert.delegate_signature.signature,
      cert.delegate_signature.suite,
      await ctx.resolveMotebitPublicKey(cert.delegate_signature.motebit_id as string),
    );
    if (!delegateValid) errors.push("delegate_signature invalid");
  }

  let guardianValid: boolean | null = null;
  if (cert.guardian_signature !== undefined) {
    let guardianKey: Uint8Array | null;
    try {
      guardianKey = hexToBytes(cert.guardian_signature.guardian_public_key);
    } catch {
      guardianKey = null;
      errors.push("guardian_public_key not valid hex");
    }
    if (ctx.validateGuardianBinding !== undefined) {
      const subjectMotebitId =
        cert.subject_signature !== undefined
          ? (cert.subject_signature.motebit_id as string)
          : undefined;
      const ok = await ctx.validateGuardianBinding(
        subjectMotebitId,
        cert.guardian_signature.guardian_public_key,
      );
      if (!ok) errors.push("guardian_public_key not bound to subject motebit");
    }
    guardianValid = await verifyOneSignature(
      bytes,
      cert.guardian_signature.signature,
      cert.guardian_signature.suite,
      guardianKey,
    );
    if (!guardianValid) errors.push("guardian_signature invalid");
  }

  return {
    valid: errors.length === 0,
    errors,
    steps: {
      reason_table_satisfied: errors.length === 0,
      subject_signature_valid: subjectValid,
      operator_signature_valid: operatorValid,
      delegate_signature_valid: delegateValid,
      guardian_signature_valid: guardianValid,
      horizon_issuer_signature_valid: null,
      horizon_witnesses_valid_count: null,
      horizon_witnesses_present_count: null,
    },
  };
}

async function verifyHorizonCert(
  cert: Extract<DeletionCertificate, { kind: "append_only_horizon" }>,
  ctx: DeletionCertificateVerifyContext,
): Promise<DeletionCertificateVerifyResult> {
  const errors: string[] = [];

  // Empty-tree anchor sanity check — when `leaf_count = 0`, the only
  // admissible `merkle_root` is the empty-tree value. Otherwise an
  // issuer could mint a self-witnessed cert with arbitrary anchor
  // bytes and dodge inclusion-proof scrutiny in WitnessOmissionDispute.
  const anchor = cert.federation_graph_anchor;
  if (anchor !== undefined) {
    if (anchor.leaf_count === 0 && anchor.merkle_root !== EMPTY_FEDERATION_GRAPH_ANCHOR_ROOT) {
      errors.push("federation_graph_anchor.leaf_count=0 requires the empty-tree merkle_root");
    }
    if (anchor.leaf_count < 0 || !Number.isInteger(anchor.leaf_count)) {
      errors.push("federation_graph_anchor.leaf_count must be a non-negative integer");
    }
  }

  const issuerBytes = canonicalizeHorizonCert(cert);
  const witnessBytes = canonicalizeHorizonCertForWitness(cert);

  // Issuer key resolution depends on subject discriminator.
  const issuerKey =
    cert.subject.kind === "motebit"
      ? await ctx.resolveMotebitPublicKey(cert.subject.motebit_id as string)
      : await ctx.resolveOperatorPublicKey(cert.subject.operator_id);

  const issuerValid = await verifyOneSignature(issuerBytes, cert.signature, cert.suite, issuerKey);
  if (!issuerValid) errors.push("horizon issuer signature invalid");

  // Witness verification — witnesses sign the body without `witnessed_by`,
  // so each witness signature can be co-signed asynchronously. The
  // issuer's separate signature commits to the assembled witness array
  // (a forged witness fails issuer-signature verification above).
  let witnessesValid = 0;
  for (const w of cert.witnessed_by) {
    const key = await ctx.resolveMotebitPublicKey(w.motebit_id as string);
    const ok = await verifyOneSignature(witnessBytes, w.signature, cert.suite, key);
    if (ok) witnessesValid++;
    else errors.push(`witness ${w.motebit_id as string} signature invalid`);
  }

  return {
    valid: errors.length === 0,
    errors,
    steps: {
      reason_table_satisfied: true,
      subject_signature_valid: null,
      operator_signature_valid: null,
      delegate_signature_valid: null,
      guardian_signature_valid: null,
      horizon_issuer_signature_valid: issuerValid,
      horizon_witnesses_valid_count: witnessesValid,
      horizon_witnesses_present_count: cert.witnessed_by.length,
    },
  };
}

async function verifyOneSignature(
  canonicalBytes: Uint8Array,
  signatureBase64Url: string,
  suite: SuiteId,
  publicKey: Uint8Array | null,
): Promise<boolean> {
  if (publicKey === null) return false;
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(signatureBase64Url);
  } catch {
    return false;
  }
  return verifyBySuite(suite, canonicalBytes, sigBytes, publicKey);
}

function failResult(message: string): DeletionCertificateVerifyResult {
  return {
    valid: false,
    errors: [message],
    steps: {
      reason_table_satisfied: false,
      subject_signature_valid: null,
      operator_signature_valid: null,
      delegate_signature_valid: null,
      guardian_signature_valid: null,
      horizon_issuer_signature_valid: null,
      horizon_witnesses_valid_count: null,
      horizon_witnesses_present_count: null,
    },
  };
}

// ── Retention manifest verification ──────────────────────────────────

import type { RetentionManifest, MotebitId } from "@motebit/protocol";

/** Result of verifying a retention manifest. Fail-closed: any failure → `valid: false`. */
export interface RetentionManifestVerifyResult {
  readonly valid: boolean;
  readonly errors: string[];
  /** The parsed manifest if signature verified, else `null`. */
  readonly manifest: RetentionManifest | null;
}

/**
 * Verify a retention manifest published at
 * `/.well-known/motebit-retention.json`. The manifest's signature
 * covers `canonicalJson(manifest minus signature)`, signed by the
 * operator's identity key under `motebit-jcs-ed25519-hex-v1` —
 * sibling to the operator-transparency manifest's signing flow.
 *
 * Browser-side re-verifier per docs/doctrine/retention-policy.md
 * §"Self-attesting transparency". Composes existing primitives —
 * `canonicalJson` from signing.ts, `verifyBySuite` from
 * suite-dispatch.ts. Same shape as the `verifySkillBundle`
 * (87e2f174) browser primitive.
 *
 * The verifier accepts the operator's public key directly — callers
 * resolve it from the operator-transparency manifest at
 * `/.well-known/motebit-transparency.json` (its `relay_public_key`
 * field), so a single manifest fetch + verify pair gives users a
 * full retention claim audit.
 */
export async function verifyRetentionManifest(
  manifest: RetentionManifest,
  operatorPublicKey: Uint8Array,
): Promise<RetentionManifestVerifyResult> {
  const errors: string[] = [];

  if (manifest.spec !== "motebit/retention-manifest@1") {
    errors.push(`unexpected spec: ${manifest.spec}`);
  }
  if (manifest.suite !== "motebit-jcs-ed25519-hex-v1") {
    errors.push(`unexpected suite: ${manifest.suite}`);
  }

  if (errors.length > 0) {
    return { valid: false, errors, manifest: null };
  }

  const { signature, ...body } = manifest;
  const canonical = canonicalJson(body);
  const canonicalBytes = new TextEncoder().encode(canonical);

  let signatureBytes: Uint8Array;
  try {
    // hex-encoded signature per `motebit-jcs-ed25519-hex-v1`
    if (signature.length !== 128 || !/^[0-9a-f]+$/i.test(signature)) {
      errors.push("signature is not 128-char hex");
      return { valid: false, errors, manifest: null };
    }
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      out[i] = parseInt(signature.slice(i * 2, i * 2 + 2), 16);
    }
    signatureBytes = out;
  } catch {
    errors.push("signature decode failed");
    return { valid: false, errors, manifest: null };
  }

  const ok = await verifyBySuite(
    "motebit-jcs-ed25519-hex-v1",
    canonicalBytes,
    signatureBytes,
    operatorPublicKey,
  );
  if (!ok) {
    errors.push("manifest signature does not verify against operator_public_key");
    return { valid: false, errors, manifest: null };
  }

  return { valid: true, errors: [], manifest };
}

// Re-export to satisfy unused-import lint when MotebitId only appears in JSDoc.
void (null as unknown as MotebitId);
