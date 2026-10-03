/**
 * The receipt verdict ladder — ONE derivation every surface's receipt badge
 * routes through (web + desktop DOM card, spatial satellite orb, mobile RN
 * card). Before this module each surface re-derived its own badge from a
 * `verifyReceiptChain` tree, and they drifted: mobile fed the receipt's OWN
 * embedded keys back in as `knownKeys` and badged a forged self-keyed receipt
 * "verified locally · chain intact"; the DOM card judged the root only and
 * missed a tampered delegation child.
 *
 * The ladder (worst wins, evaluated over the WHOLE delegation chain):
 *
 *   failed          — any receipt in the chain failed signature verification
 *                     (or verification threw). Fail-closed.
 *   task-failed     — every signature checks AND every signer is bound (as
 *                     `verified` below), but the task itself reported
 *                     `status: "failed"`.
 *   task-failed-unanchored
 *                   — every signature checks, the task reported
 *                     `status: "failed"`, but at least one signer's key is the
 *                     receipt's own embedded key. Status never outranks
 *                     binding: an attacker can self-sign a failed receipt
 *                     claiming any `motebit_id`, so this rung makes no
 *                     identity claim.
 *   verified        — every signature checks AND every signer's key came from
 *                     the caller's independently-trusted anchor
 *                     (`keySource === "external"`): identity is bound.
 *   integrity-only  — every signature checks, but at least one was checked
 *                     against the receipt's own embedded `public_key`. The
 *                     bytes are intact; the key → `motebit_id` binding is NOT
 *                     established. Never rendered as "verified".
 *
 * `trustedAnchor` MUST be an independent source (pinned transparency key /
 * known-keys registry). Never pass `collectKnownKeys(receipt)` — that launders
 * the receipt's self-declared keys into a false identity binding.
 */

import type { ExecutionReceipt } from "@motebit/sdk";
import { verifyReceiptChain } from "@motebit/encryption";

export type ReceiptVerdict =
  "verified" | "integrity-only" | "task-failed" | "task-failed-unanchored" | "failed";

/** Structural slice of `ReceiptVerification` the ladder reads. */
export interface ReceiptVerifyTreeLike {
  readonly verified: boolean;
  readonly keySource?: "external" | "embedded";
  readonly delegations?: readonly ReceiptVerifyTreeLike[];
}

/** Canonical badge copy per verdict — one string per rung, every surface. */
export const RECEIPT_VERDICT_LABELS: Readonly<Record<ReceiptVerdict, string>> = {
  verified: "verified locally · chain intact",
  "integrity-only": "signature verified · identity not anchored",
  "task-failed": "verified · completed: failed",
  "task-failed-unanchored": "signature verified · identity not anchored · completed: failed",
  failed: "verification failed",
};

function chainVerified(tree: ReceiptVerifyTreeLike): boolean {
  if (!tree.verified) return false;
  for (const child of tree.delegations ?? []) {
    if (!chainVerified(child)) return false;
  }
  return true;
}

function chainBound(tree: ReceiptVerifyTreeLike): boolean {
  if (tree.keySource !== "external") return false;
  for (const child of tree.delegations ?? []) {
    if (!chainBound(child)) return false;
  }
  return true;
}

/** Pure: a settled verification tree → the verdict rung. */
export function receiptVerdictFor(
  receipt: Pick<ExecutionReceipt, "status">,
  tree: ReceiptVerifyTreeLike,
): ReceiptVerdict {
  if (!chainVerified(tree)) return "failed";
  const bound = chainBound(tree);
  if (receipt.status === "failed") return bound ? "task-failed" : "task-failed-unanchored";
  return bound ? "verified" : "integrity-only";
}

/**
 * Verify a receipt chain locally and project it onto the ladder. Never throws:
 * a verification error is the `failed` rung.
 */
export async function verifyReceiptVerdict(
  receipt: ExecutionReceipt,
  trustedAnchor?: ReadonlyMap<string, Uint8Array>,
): Promise<ReceiptVerdict> {
  try {
    const anchor = new Map<string, Uint8Array>(trustedAnchor ?? []);
    const tree = await verifyReceiptChain(receipt, anchor);
    return receiptVerdictFor(receipt, tree);
  } catch {
    return "failed";
  }
}
