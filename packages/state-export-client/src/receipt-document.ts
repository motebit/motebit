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
import { verifyReceipt, verifyKeyBindingAtTime, type MotebitIdentityFile } from "@motebit/crypto";

/**
 * Identity-binding status — a ladder of increasing trust-minimization, per
 * `docs/doctrine/identity-binding-verification.md`. `"unverified"` (signature
 * failed) < `"integrity-only"` (signed, but checked against the receipt's own
 * embedded key — not bound) < `"pinned"` (the signing key is time-valid for an
 * identity file the caller supplied; sovereign chain verified, no operator
 * anchor). The `"anchored"` and `"sovereign"` rungs add operator non-equivocation
 * and arrive with the relay identity-transparency log.
 */
export type ReceiptBindingStatus = "pinned" | "integrity-only" | "unverified";

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
   * Identity-binding status (the ladder). `"pinned"` when the signing key is
   * time-valid for a caller-supplied identity file; `"integrity-only"` when only
   * the signature is verified against the receipt's own embedded key;
   * `"unverified"` when the signature did not verify. Surfaces MUST NOT render
   * "from <motebit>" below `"pinned"`.
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
    // `verifyReceipt` checks the signature against the receipt's own embedded
    // key, so on its own a valid check is integrity-only. `verifyReceiptDocument`
    // upgrades the root to `"pinned"` when a matching identity file is supplied.
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

export interface VerifyReceiptDocumentOptions {
  /**
   * The producing motebit's identity file (its self-signed succession material).
   * When supplied, and the receipt's signing key is time-valid for it (and the
   * `motebit_id` matches), the result's root upgrades to `binding: "pinned"` —
   * verified against material the caller supplied. The `anchored` / `sovereign`
   * rungs layer operator non-equivocation on top; see
   * `docs/doctrine/identity-binding-verification.md`.
   */
  readonly identity?: MotebitIdentityFile;
}

/**
 * Promote the root to `"pinned"` iff the supplied identity file is for this
 * receipt's motebit and its succession chain makes the signing key valid at the
 * receipt's `completed_at`. Returns `null` (no promotion) otherwise. The chain is
 * verified inside `verifyKeyBindingAtTime`; this is the sovereign-root half of
 * binding (no operator anchor).
 */
async function pinnedBinding(
  receipt: ExecutionReceipt,
  identity: MotebitIdentityFile,
): Promise<"pinned" | null> {
  if (typeof receipt.public_key !== "string") return null;
  if (String(identity.motebit_id) !== String(receipt.motebit_id)) return null;
  const r = await verifyKeyBindingAtTime(identity, receipt.public_key, receipt.completed_at);
  return r.bound ? "pinned" : null;
}

/**
 * Verify a pasted receipt document (JSON text) entirely offline. Returns a typed
 * view model; never throws on bad input or a crypto failure — only `JSON.parse`
 * and shape errors map to `malformed_json` / `not_a_receipt`. Pass
 * `options.identity` to attempt the `"pinned"` binding rung.
 */
export async function verifyReceiptDocument(
  jsonText: string,
  options?: VerifyReceiptDocumentOptions,
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
  const view = toView(await verifyReceipt(parsed));
  if (view.integrity && options?.identity) {
    const pinned = await pinnedBinding(parsed, options.identity);
    if (pinned) return { ...view, binding: pinned };
  }
  return view;
}
