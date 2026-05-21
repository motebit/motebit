/**
 * Verify a pasted/standalone `ExecutionReceipt` document and project it into an
 * honest, display-ready view model — the brain behind a public receipt verifier
 * (e.g. receipt.computer): paste a receipt, learn what it actually proves.
 *
 * The model's whole point is to keep two facts separate, the way the rest of the
 * stack now does (crypto `keySource`, render-engine `bindingStatusFor`):
 *
 *   - INTEGRITY — "the bytes were signed by *some* key and nothing was tampered."
 *     Always checkable offline from the receipt alone.
 *   - BINDING   — "that key belongs to the claimed `motebit_id`." Established only
 *     when the verifying key came from a trusted external source, never from the
 *     receipt's own embedded `public_key`.
 *
 * This entry verifies against the receipt's embedded key (offline, no anchor), so
 * a successful check is `integrity-only`: it never claims identity binding. When a
 * trusted anchor (the package's `fetchTransparencyAnchor` / a known-keys registry)
 * is later threaded through, the same view model upgrades to `"bound"` — callers
 * branch on `binding`, not on `integrity`, before rendering "from <motebit>".
 *
 * Browser-safe; composes `@motebit/crypto`'s `verifyReceipt` only — no new crypto.
 *
 * Doctrine: `docs/doctrine/self-attesting-system.md`, `docs/doctrine/operator-transparency.md`.
 */

import type { ExecutionReceipt } from "@motebit/protocol";
import { verifyReceipt } from "@motebit/crypto";

/** Identity-binding status of a receipt verification. */
export type ReceiptBindingStatus = "bound" | "integrity-only" | "unverified";

export type ReceiptDocumentFailureReason =
  | "malformed_json"
  | "not_a_receipt"
  | "missing_public_key"
  | "signature_invalid"
  | "delegation_failed"
  | "unknown";

/** Honest, recursive view model for a verified (or rejected) receipt document. */
export interface ReceiptDocumentVerification {
  /**
   * True iff the signature verified (and every delegation verified) — INTEGRITY.
   * A `true` here does NOT mean the key belongs to `motebitId`; read `binding`.
   */
  readonly integrity: boolean;
  /**
   * Identity-binding status. `"bound"` only when the key was resolved from a
   * trusted external anchor; `"integrity-only"` when verified against the
   * receipt's own embedded key (the offline default); `"unverified"` when the
   * signature did not verify. Surfaces MUST NOT render "from <motebit>" unless
   * this is `"bound"`.
   */
  readonly binding: ReceiptBindingStatus;
  /** `did:key:z…` derived from the signing key when integrity holds. */
  readonly signerDid?: string;
  /** The producing `motebit_id` as carried in the receipt body — a claim, not proof. */
  readonly motebitId?: string;
  readonly taskId?: string;
  /** Per-delegation results, recursive — mirrors the delegation chain. */
  readonly delegations?: ReceiptDocumentVerification[];
  /** Typed failure reason when `integrity` is false. */
  readonly reason?: ReceiptDocumentFailureReason;
  /** Free-form detail (e.g. underlying error message). */
  readonly detail?: string;
}

/**
 * Minimal structural guard for user-pasted input. We verify at the boundary
 * (untrusted text) before handing to crypto — a non-receipt object must surface
 * as a typed `not_a_receipt`, never an opaque downstream throw.
 */
function isExecutionReceiptShape(value: unknown): value is ExecutionReceipt {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["motebit_id"] === "string" &&
    typeof r["task_id"] === "string" &&
    typeof r["signature"] === "string" &&
    typeof r["suite"] === "string"
  );
}

type CryptoReceiptResult = Awaited<ReturnType<typeof verifyReceipt>>;

function toView(result: CryptoReceiptResult): ReceiptDocumentVerification {
  const errs = result.errors ?? [];
  const base: {
    integrity: boolean;
    binding: ReceiptBindingStatus;
    signerDid?: string;
    motebitId?: string;
    taskId?: string;
    delegations?: ReceiptDocumentVerification[];
    reason?: ReceiptDocumentFailureReason;
    detail?: string;
  } = {
    integrity: result.valid,
    // `verifyReceipt` resolves the key from the receipt's own embedded
    // `public_key` (its result is typed `keySource: "embedded"`), so a valid
    // offline check is always integrity-only — never "bound". The `"bound"`
    // value is reserved for a future anchor path (verifyReceiptChain against a
    // trusted known-keys map), at which point this projection upgrades.
    binding: result.valid ? "integrity-only" : "unverified",
  };
  if (result.signer !== undefined) base.signerDid = result.signer;
  if (result.receipt) {
    base.motebitId = String(result.receipt.motebit_id);
    base.taskId = result.receipt.task_id;
  }
  if (result.delegations && result.delegations.length > 0) {
    base.delegations = result.delegations.map(toView);
  }
  if (!result.valid) {
    if (errs.some((e) => e.message.includes("No embedded public_key"))) {
      base.reason = "missing_public_key";
    } else if (errs.some((e) => e.path === "delegation_receipts")) {
      base.reason = "delegation_failed";
    } else if (errs.length > 0) {
      base.reason = "signature_invalid";
    } else {
      base.reason = "unknown";
    }
    const detail = errs[0]?.message;
    if (detail !== undefined) base.detail = detail;
  }
  return base;
}

/**
 * Verify a pasted receipt document (JSON text) entirely offline. Returns a typed
 * view model; never throws on bad input or a crypto failure — only `JSON.parse`
 * and shape errors map to `malformed_json` / `not_a_receipt`.
 */
export async function verifyReceiptDocument(
  jsonText: string,
): Promise<ReceiptDocumentVerification> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return {
      integrity: false,
      binding: "unverified",
      reason: "malformed_json",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!isExecutionReceiptShape(parsed)) {
    return {
      integrity: false,
      binding: "unverified",
      reason: "not_a_receipt",
      detail: "input is not an ExecutionReceipt (missing motebit_id / task_id / signature / suite)",
    };
  }
  return toView(await verifyReceipt(parsed));
}
