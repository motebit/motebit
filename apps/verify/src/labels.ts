/**
 * Display logic for a verified receipt — maps the honest view model to the
 * words and tone the page shows. Kept pure and separate from `render.ts` (DOM)
 * so the one thing that MUST stay honest — never calling an integrity-only
 * result "verified identity" — is unit-tested.
 */

import type {
  ReceiptDocumentVerification,
  ReceiptDocumentFailureReason,
} from "@motebit/state-export-client";

/** Drives the result card's color treatment. */
export type ResultTone = "bound" | "integrity" | "failed";

export interface ResultLabels {
  readonly tone: ResultTone;
  readonly headline: string;
  readonly detail: string;
}

const FAILURE_DETAIL: Record<ReceiptDocumentFailureReason, string> = {
  malformed_json: "That isn't valid JSON. Paste the full receipt object.",
  not_a_receipt:
    "Valid JSON, but not an execution receipt (missing motebit_id / task_id / signature / suite).",
  missing_public_key: "No embedded public key — this receipt can't be verified offline.",
  signature_invalid: "The signature does not match the receipt body — it was altered or forged.",
  delegation_failed: "A delegated receipt in the chain failed verification.",
  unknown: "Verification failed.",
};

export function resultLabels(v: ReceiptDocumentVerification): ResultLabels {
  if (!v.integrity) {
    return {
      tone: "failed",
      headline: "Verification failed",
      detail: FAILURE_DETAIL[v.reason ?? "unknown"] ?? FAILURE_DETAIL.unknown,
    };
  }
  if (v.binding === "anchored") {
    return {
      tone: "bound",
      headline: "Verified — anchored on-chain",
      detail:
        "The signature is valid, the signing key is bound to this motebit's identity chain, and that binding is committed in the operator's transparency log whose root is confirmed on-chain. The operator cannot show two verifiers different chains without leaving on-chain-detectable evidence.",
    };
  }
  if (v.binding === "pinned") {
    return {
      tone: "bound",
      headline: "Verified — identity pinned",
      detail:
        "The signature is valid and the signing key is time-valid in the identity chain you supplied. That binds the key to this motebit's chain — it does not yet prove the chain is the operator's current, non-equivocable record (the anchored rung).",
    };
  }
  // integrity-only: the honest default. Signature is valid, but it was checked
  // against the receipt's OWN embedded key — that proves the bytes weren't
  // tampered, NOT that the key belongs to this motebit.
  return {
    tone: "integrity",
    headline: "Signature verified — identity not anchored",
    detail:
      "The signature is valid and the receipt is untampered, but it was checked against the receipt's own embedded key. That proves integrity, not that the key belongs to this motebit. No trust anchor was provided.",
  };
}
