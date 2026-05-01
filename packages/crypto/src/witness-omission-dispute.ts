/**
 * Witness-omission dispute — sign + verify (retention phase 4b-3).
 *
 * Permissive floor (Apache-2.0). Zero monorepo deps beyond
 * `@motebit/protocol` types. Routes signing through
 * `@motebit/crypto/suite-dispatch`.
 *
 * Path A quorum's soft-accountability layer for `append_only_horizon`
 * certs: a peer who believes `cert.witnessed_by[]` wrongly omits them
 * files this dispute within 24h of `cert.issued_at`. Two evidence
 * shapes:
 *
 *   - `inclusion_proof` — disputant proves their peer pubkey is in
 *     the cert's `federation_graph_anchor.merkle_root` via a Merkle
 *     inclusion proof. The verifier reconstructs against the cert's
 *     anchor root.
 *
 *   - `alternative_peering` — disputant supplies a signed peering
 *     artifact from the cert issuer (today: a federation Heartbeat,
 *     `motebit-concat-ed25519-hex-v1`) whose timestamp window covers
 *     `cert.horizon_ts ± 5 min` (mirrors heartbeat suspension
 *     threshold). The cert's published anchor is claimed incomplete.
 *
 * The verifier returns a per-step result; certificates remain
 * TERMINAL per `retention-policy.md` decision 5 — a sustained dispute
 * is a reputation hit on the issuer, not a cert invalidation.
 */

import type {
  DeletionCertificate,
  WitnessOmissionDispute,
  WitnessOmissionEvidence,
} from "@motebit/protocol";

import { canonicalJson, fromBase64Url, hexToBytes, toBase64Url } from "./signing.js";
import { signBySuite, verifyBySuite } from "./suite-dispatch.js";
import { verifyMerkleInclusion } from "./merkle.js";
import { WITNESS_OMISSION_DISPUTE_WINDOW_MS } from "./deletion-certificate.js";

// ── Constants ────────────────────────────────────────────────────────

const WITNESS_OMISSION_DISPUTE_SUITE = "motebit-jcs-ed25519-b64-v1" as const;
const FEDERATION_HEARTBEAT_SUITE = "motebit-concat-ed25519-hex-v1" as const;

/**
 * Heartbeat-as-peering-evidence freshness window. A heartbeat whose
 * `timestamp` is within ±5 min of `cert.horizon_ts` proves the issuer
 * was alive on that peering relationship at the horizon — mirrors
 * `HEARTBEAT_REMOVE_THRESHOLD = 5` × `heartbeat_interval = 60s` in
 * `services/relay/src/federation.ts`.
 */
const HEARTBEAT_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

// ── Result type ──────────────────────────────────────────────────────

/** Result of verifying a witness-omission dispute. Fail-closed: any failure → `valid: false`. */
export interface WitnessOmissionDisputeVerifyResult {
  readonly valid: boolean;
  readonly errors: string[];
  /** Per-step breakdown — useful for adjudication audit display. */
  readonly steps: {
    /**
     * Window check (two gates, both must pass):
     *   A. `now - cert.issued_at <= WITNESS_OMISSION_DISPUTE_WINDOW_MS`
     *   B. `dispute.filed_at ∈ [cert.issued_at, cert.issued_at + WINDOW_MS]`
     */
    readonly window_open: boolean;
    /** Dispute pins the disputed cert (`cert_issuer` + `cert_signature` match). */
    readonly cert_binding_valid: boolean;
    /** Disputant's Ed25519 signature over the dispute body. */
    readonly disputant_signature_valid: boolean;
    /** Evidence-shape verification. `null` when prior checks already failed. */
    readonly evidence_valid: boolean | null;
  };
}

// ── Verifier context ─────────────────────────────────────────────────

/**
 * Resolver context for `verifyWitnessOmissionDispute`. The caller
 * supplies the cert (resolved from its local store via the dispute's
 * `cert_signature` pointer), the issuer's pubkey (for verifying the
 * cert binding and any alternative-peering artifact), the disputant's
 * pubkey, and a `now` clock.
 */
export interface WitnessOmissionDisputeVerifyContext {
  /** The disputed cert, resolved by the caller from `dispute.cert_signature`. */
  readonly cert: Extract<DeletionCertificate, { kind: "append_only_horizon" }>;
  /** Cert issuer's Ed25519 public key (32 bytes). */
  readonly issuerPublicKey: Uint8Array;
  /** Disputant peer's Ed25519 public key (32 bytes). `null` → unknown disputant, fail-closed. */
  readonly disputantPublicKey: Uint8Array | null;
  /** Wall-clock at validation time, in unix ms. */
  readonly now: number;
}

// ── Canonicalization ─────────────────────────────────────────────────

/**
 * Compute the canonical signing bytes for a `WitnessOmissionDispute`.
 * Strips `signature` so the disputant signs every other field —
 * including `cert_signature`, `cert_issuer`, and the evidence body.
 */
export function canonicalizeWitnessOmissionDispute(dispute: WitnessOmissionDispute): Uint8Array {
  const { signature, ...body } = dispute;
  void signature;
  return new TextEncoder().encode(canonicalJson(body));
}

// ── Signing ──────────────────────────────────────────────────────────

/**
 * Sign a `WitnessOmissionDispute` as the disputant. Caller provides
 * the unsigned body (everything except `suite` and `signature`); this
 * function appends both.
 */
export async function signWitnessOmissionDispute(
  body: Omit<WitnessOmissionDispute, "suite" | "signature">,
  privateKey: Uint8Array,
): Promise<WitnessOmissionDispute> {
  const withSuite: WitnessOmissionDispute = {
    ...body,
    suite: WITNESS_OMISSION_DISPUTE_SUITE,
    signature: "",
  };
  const bytes = canonicalizeWitnessOmissionDispute(withSuite);
  const sig = await signBySuite(WITNESS_OMISSION_DISPUTE_SUITE, bytes, privateKey);
  return { ...withSuite, signature: toBase64Url(sig) };
}

// ── Verifier ─────────────────────────────────────────────────────────

/**
 * Verify a `WitnessOmissionDispute` against the disputed cert.
 *
 * Step ladder (fail-closed throughout):
 *   1. Window: `now - cert.issued_at <= WINDOW` AND
 *      `filed_at ∈ [cert.issued_at, cert.issued_at + WINDOW]`.
 *   2. Cert binding: `dispute.cert_signature === cert.signature` and
 *      `dispute.cert_issuer` matches the cert's subject.
 *   3. Disputant signature over `canonicalJson(dispute minus signature)`.
 *   4. Evidence: dispatched by `evidence.kind` —
 *      - `inclusion_proof`: requires cert has a `federation_graph_anchor`;
 *        verifies the Merkle proof against `anchor.merkle_root`.
 *      - `alternative_peering`: dispatches on `peering_artifact`'s
 *        self-described shape (today: federation Heartbeat); verifies
 *        the embedded signature against the issuer pubkey and the
 *        timestamp window covers `cert.horizon_ts`.
 */
export async function verifyWitnessOmissionDispute(
  dispute: WitnessOmissionDispute,
  ctx: WitnessOmissionDisputeVerifyContext,
): Promise<WitnessOmissionDisputeVerifyResult> {
  const errors: string[] = [];
  const { cert } = ctx;

  // ── Step 1: window (two gates) ────────────────────────────────────
  const windowEnd = cert.issued_at + WITNESS_OMISSION_DISPUTE_WINDOW_MS;
  const wallClockOpen = ctx.now <= windowEnd;
  const filedAtInRange = dispute.filed_at >= cert.issued_at && dispute.filed_at <= windowEnd;
  const windowOpen = wallClockOpen && filedAtInRange;
  if (!wallClockOpen) {
    errors.push(
      `dispute window expired: now (${ctx.now}) > cert.issued_at + ${WITNESS_OMISSION_DISPUTE_WINDOW_MS}ms`,
    );
  }
  if (!filedAtInRange) {
    errors.push(
      "dispute.filed_at outside [cert.issued_at, cert.issued_at + WINDOW] — disputant-attested clock cannot widen window",
    );
  }

  // ── Step 2: cert binding ──────────────────────────────────────────
  let certBindingValid = true;
  if (dispute.cert_signature !== cert.signature) {
    errors.push("dispute.cert_signature does not match cert.signature");
    certBindingValid = false;
  }
  const certSubjectId =
    cert.subject.kind === "motebit"
      ? (cert.subject.motebit_id as string)
      : cert.subject.operator_id;
  if (dispute.cert_issuer !== certSubjectId) {
    errors.push(
      `dispute.cert_issuer (${dispute.cert_issuer}) does not match cert subject (${certSubjectId})`,
    );
    certBindingValid = false;
  }

  // ── Step 3: disputant signature ───────────────────────────────────
  let disputantSignatureValid = false;
  if (ctx.disputantPublicKey === null) {
    errors.push("disputant public key not resolvable");
  } else if (dispute.suite !== WITNESS_OMISSION_DISPUTE_SUITE) {
    errors.push(`unexpected suite: ${String(dispute.suite)}`);
  } else {
    const bytes = canonicalizeWitnessOmissionDispute(dispute);
    let sigBytes: Uint8Array;
    try {
      sigBytes = fromBase64Url(dispute.signature);
    } catch {
      sigBytes = new Uint8Array(0);
    }
    if (sigBytes.length === 0) {
      errors.push("dispute.signature decode failed");
    } else {
      disputantSignatureValid = await verifyBySuite(
        dispute.suite,
        bytes,
        sigBytes,
        ctx.disputantPublicKey,
      );
      if (!disputantSignatureValid) errors.push("dispute.signature does not verify");
    }
  }

  // Short-circuit evidence verification when prior gates already failed.
  // The dispute is invalid; the evidence-step result is meaningless.
  if (!windowOpen || !certBindingValid || !disputantSignatureValid) {
    return {
      valid: false,
      errors,
      steps: {
        window_open: windowOpen,
        cert_binding_valid: certBindingValid,
        disputant_signature_valid: disputantSignatureValid,
        evidence_valid: null,
      },
    };
  }

  // ── Step 4: evidence dispatch ─────────────────────────────────────
  const evidenceValid = await verifyEvidence(dispute.evidence, cert, ctx, errors);

  return {
    valid: errors.length === 0,
    errors,
    steps: {
      window_open: windowOpen,
      cert_binding_valid: certBindingValid,
      disputant_signature_valid: disputantSignatureValid,
      evidence_valid: evidenceValid,
    },
  };
}

async function verifyEvidence(
  evidence: WitnessOmissionEvidence,
  cert: Extract<DeletionCertificate, { kind: "append_only_horizon" }>,
  ctx: WitnessOmissionDisputeVerifyContext,
  errors: string[],
): Promise<boolean> {
  if (evidence.kind === "inclusion_proof") {
    const anchor = cert.federation_graph_anchor;
    if (anchor === undefined) {
      errors.push("inclusion_proof evidence requires cert.federation_graph_anchor — none present");
      return false;
    }
    if (anchor.leaf_count === 0) {
      errors.push(
        "inclusion_proof evidence rejected: cert is self-witnessed (anchor.leaf_count=0)",
      );
      return false;
    }
    const ok = await verifyMerkleInclusion(
      evidence.leaf_hash,
      evidence.proof.leaf_index,
      evidence.proof.siblings,
      evidence.proof.layer_sizes,
      anchor.merkle_root,
    );
    if (!ok) errors.push("inclusion proof does not reconstruct to anchor.merkle_root");
    return ok;
  }
  // alternative_peering — closed union; TS narrows after the if-branch.
  return verifyAlternativePeeringArtifact(evidence.peering_artifact, cert, ctx, errors);
}

/**
 * Verify a peering artifact embedded in `alternative_peering` evidence.
 * Today: federation Heartbeat is the canonical shape — the only
 * recurring signed peering attestation in `relay-federation-v1`.
 *
 * Heartbeat signing payload (FEDERATION_SUITE = motebit-concat-ed25519-hex-v1):
 *   `${relay_id}|${timestamp}|${suite}` — UTF-8 concatenation, hex sig.
 *
 * The verifier dispatches on the artifact's self-described shape:
 * presence of `relay_id` (string) + `timestamp` (number) + `signature`
 * (hex string) identifies the heartbeat shape. Future: PeeringConfirm
 * or other peering attestations land as additive dispatch arms.
 */
async function verifyAlternativePeeringArtifact(
  artifact: Record<string, unknown>,
  cert: Extract<DeletionCertificate, { kind: "append_only_horizon" }>,
  ctx: WitnessOmissionDisputeVerifyContext,
  errors: string[],
): Promise<boolean> {
  const relayId = artifact["relay_id"];
  const timestamp = artifact["timestamp"];
  const signatureHex = artifact["signature"];

  if (
    typeof relayId !== "string" ||
    typeof timestamp !== "number" ||
    typeof signatureHex !== "string"
  ) {
    errors.push(
      "alternative_peering artifact unrecognized — expected federation Heartbeat shape (relay_id, timestamp, signature)",
    );
    return false;
  }

  const certSubjectId =
    cert.subject.kind === "motebit"
      ? (cert.subject.motebit_id as string)
      : cert.subject.operator_id;
  if (relayId !== certSubjectId) {
    errors.push(
      `peering artifact relay_id (${relayId}) does not match cert issuer (${certSubjectId})`,
    );
    return false;
  }

  if (Math.abs(timestamp - cert.horizon_ts) > HEARTBEAT_FRESHNESS_WINDOW_MS) {
    errors.push(
      `peering artifact timestamp (${timestamp}) outside ±${HEARTBEAT_FRESHNESS_WINDOW_MS}ms of cert.horizon_ts (${cert.horizon_ts})`,
    );
    return false;
  }

  let sigBytes: Uint8Array;
  /* c8 ignore start -- defensive catch; `hexToBytes` (signing.ts) uses parseInt which silently returns NaN for non-hex chars rather than throwing, so this catch is unreachable today. Keep for forward-compat: a future hex-decode primitive that throws (e.g. native Uint8Array.fromHex) would route through this branch and fail closed rather than passing garbage bytes through to verifyBySuite. */
  try {
    sigBytes = hexToBytes(signatureHex);
  } catch {
    errors.push("peering artifact signature is not valid hex");
    return false;
  }
  /* c8 ignore stop */

  const payload = new TextEncoder().encode(`${relayId}|${timestamp}|${FEDERATION_HEARTBEAT_SUITE}`);
  const ok = await verifyBySuite(
    FEDERATION_HEARTBEAT_SUITE,
    payload,
    sigBytes,
    ctx.issuerPublicKey,
  );
  if (!ok) errors.push("peering artifact signature does not verify against cert issuer pubkey");
  return ok;
}
