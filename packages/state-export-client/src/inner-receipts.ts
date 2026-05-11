/**
 * Recursive verification for v1.1 inner signed receipts.
 *
 * The relay-assembled execution-ledger reconstruction at
 * `/api/v1/execution/:motebitId/:goalId` carries the v1.1 optional
 * `signed_receipts: string[]` field — byte-identical canonical-JSON of
 * each delegated motebit's signed `ExecutionReceipt`, sourced from the
 * relay's `relay_receipts.receipt_json` archive (per
 * `services/relay/CLAUDE.md` Rule 11). The wire shape and rationale
 * live in `spec/execution-ledger-v1.md` §4.3 (Inner Signed Receipts —
 * v1.1 additive).
 *
 * Without recursive verification, the v1.1 wire change is invisible
 * truth: the verifier sees the field but does nothing with it. This
 * module closes the consumer-side asymmetry. Each receipt is parsed
 * back into its `ExecutionReceipt` shape, passed to
 * `verifyReceipt` from `@motebit/crypto`, and its Ed25519 signature
 * checked against the embedded `public_key` independently of the
 * relay. Multi-hop delegation chains are walked recursively.
 *
 * Doctrine: `docs/doctrine/nist-alignment.md` §8 "Inner-receipt
 * verification closed"; `docs/doctrine/self-attesting-system.md`.
 */

import type { ExecutionReceipt, GoalExecutionManifest } from "@motebit/protocol";
import { EXECUTION_LEDGER_SPEC_V1_1 } from "@motebit/protocol";
import { verifyReceipt } from "@motebit/crypto";

/** Per-receipt verification outcome surfaced to UI / audit logging. */
export interface InnerReceiptVerification {
  /** Task identifier of the inner receipt. Pulled from the parsed receipt body. */
  readonly taskId: string;
  /** The producing motebit's identifier — what the relay claims; the signature proves it. */
  readonly motebitId: string;
  /** `did:key:zXXX` derived from the receipt's embedded public key when verification succeeded. */
  readonly signerDid?: string;
  /** Whether the inner receipt's signature verifies against its embedded `public_key`. */
  readonly valid: boolean;
  /** Typed failure reason when `valid === false`. */
  readonly reason?: InnerReceiptVerificationFailureReason;
  /** Free-form detail (e.g. underlying error message). */
  readonly detail?: string;
  /** Nested delegations verified recursively. Present when the receipt carries `delegation_receipts`. */
  readonly delegations?: InnerReceiptVerification[];
}

export type InnerReceiptVerificationFailureReason =
  | "malformed_json"
  | "missing_public_key"
  | "signature_invalid"
  | "delegation_failed"
  | "unknown";

/** Aggregate result for the whole `signed_receipts` array on a v1.1 ledger body. */
export interface InnerReceiptsVerification {
  /** True only when every entry's outer signature + every nested delegation verifies. */
  readonly allValid: boolean;
  /** Number of top-level entries successfully verified. */
  readonly verifiedCount: number;
  /** Number of top-level entries inspected (`signed_receipts.length` when the field is present). */
  readonly totalCount: number;
  /** Per-receipt outcomes, ordered as `signed_receipts` appeared on the wire. */
  readonly results: ReadonlyArray<InnerReceiptVerification>;
  /** True when the body declared a v1.1 spec and carried a non-empty `signed_receipts` array. */
  readonly applicable: boolean;
}

/**
 * Verify the inner signed receipts inside an execution-ledger response
 * body. Idempotent + side-effect-free; no network calls beyond what
 * `verifyReceipt` performs (which itself is offline — every receipt
 * carries its own `public_key`).
 *
 * Returns `{ applicable: false }` for v1.0 bodies, bodies without
 * `signed_receipts`, or bodies that aren't execution-ledger shape.
 * Returns `{ applicable: true, allValid, ... }` with per-receipt
 * outcomes for v1.1 bodies that carry the field.
 */
export async function verifyInnerSignedReceipts(body: unknown): Promise<InnerReceiptsVerification> {
  if (!isV1_1ExecutionLedger(body)) {
    return {
      applicable: false,
      allValid: false,
      verifiedCount: 0,
      totalCount: 0,
      results: [],
    };
  }

  const signedReceipts = body.signed_receipts;
  if (signedReceipts === undefined || signedReceipts.length === 0) {
    return {
      applicable: false,
      allValid: false,
      verifiedCount: 0,
      totalCount: 0,
      results: [],
    };
  }

  const results: InnerReceiptVerification[] = [];
  for (const entry of signedReceipts) {
    results.push(await verifyOneInner(entry));
  }
  const verifiedCount = results.filter((r) => r.valid).length;
  return {
    applicable: true,
    allValid: verifiedCount === results.length,
    verifiedCount,
    totalCount: results.length,
    results,
  };
}

function isV1_1ExecutionLedger(body: unknown): body is GoalExecutionManifest & {
  signed_receipts?: string[];
} {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { spec?: unknown; signed_receipts?: unknown };
  if (b.spec !== EXECUTION_LEDGER_SPEC_V1_1) return false;
  return b.signed_receipts === undefined || Array.isArray(b.signed_receipts);
}

async function verifyOneInner(entryJson: string): Promise<InnerReceiptVerification> {
  let receipt: ExecutionReceipt;
  try {
    receipt = JSON.parse(entryJson) as ExecutionReceipt;
  } catch (err) {
    return {
      taskId: "<unparseable>",
      motebitId: "<unparseable>",
      valid: false,
      reason: "malformed_json",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const result = await verifyReceipt(receipt);

  if (result.valid) {
    return {
      taskId: receipt.task_id,
      motebitId: String(receipt.motebit_id),
      ...(result.signer !== undefined && { signerDid: result.signer }),
      valid: true,
      ...(result.delegations !== undefined && result.delegations.length > 0
        ? { delegations: result.delegations.map(toInnerShape) }
        : {}),
    };
  }

  // Map the crypto-layer ReceiptVerifyResult into the consumer-facing
  // typed-failure shape. We surface the cheapest cause: missing key
  // before signature failure, delegation failures last.
  const errs = result.errors ?? [];
  let reason: InnerReceiptVerificationFailureReason = "unknown";
  let detail: string | undefined;
  if (errs.some((e) => e.message.includes("No embedded public_key"))) {
    reason = "missing_public_key";
    detail = errs.find((e) => e.message.includes("No embedded public_key"))?.message;
  } else if (errs.some((e) => e.path === "delegation_receipts")) {
    reason = "delegation_failed";
    detail = errs.find((e) => e.path === "delegation_receipts")?.message;
  } else if (errs.length > 0) {
    reason = "signature_invalid";
    detail = errs[0]?.message;
  }

  return {
    taskId: receipt.task_id,
    motebitId: String(receipt.motebit_id),
    ...(result.signer !== undefined && { signerDid: result.signer }),
    valid: false,
    reason,
    ...(detail !== undefined && { detail }),
    ...(result.delegations !== undefined && result.delegations.length > 0
      ? { delegations: result.delegations.map(toInnerShape) }
      : {}),
  };
}

// Lift the crypto-layer ReceiptVerifyResult shape into the consumer
// shape so callers don't need to import @motebit/crypto types.
function toInnerShape(r: Awaited<ReturnType<typeof verifyReceipt>>): InnerReceiptVerification {
  const errs = r.errors ?? [];
  let reason: InnerReceiptVerificationFailureReason | undefined;
  if (!r.valid) {
    if (errs.some((e) => e.message.includes("No embedded public_key")))
      reason = "missing_public_key";
    else if (errs.some((e) => e.path === "delegation_receipts")) reason = "delegation_failed";
    else if (errs.length > 0) reason = "signature_invalid";
    else reason = "unknown";
  }
  return {
    taskId: r.receipt?.task_id ?? "<unknown>",
    motebitId: String(r.receipt?.motebit_id ?? "<unknown>"),
    ...(r.signer !== undefined && { signerDid: r.signer }),
    valid: r.valid,
    ...(reason !== undefined && { reason }),
    ...(errs[0]?.message !== undefined && !r.valid && { detail: errs[0].message }),
    ...(r.delegations !== undefined && r.delegations.length > 0
      ? { delegations: r.delegations.map(toInnerShape) }
      : {}),
  };
}
