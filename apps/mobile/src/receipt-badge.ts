/**
 * Mobile's receipt badge — the same verdict ladder every other surface uses
 * (`verifyReceiptVerdict` in `@motebit/render-engine`: failed / task-failed /
 * task-failed-unanchored / verified / integrity-only), projected onto RN colors.
 *
 * Mobile previously verified against `collectKnownKeys(receipt)` — the
 * receipt's OWN embedded keys passed back in as the trust anchor — and showed
 * two states, so a forged self-keyed receipt badged "verified locally · chain
 * intact". Identity binding is claimed only when every signer resolved from an
 * independently-trusted `trustedAnchor`; without one the honest rung is
 * integrity-only ("signature verified · identity not anchored").
 *
 * Pure (no React) so it is unit-testable in node and runnable by the
 * cross-surface receipt-vector test.
 */
import type { ExecutionReceipt } from "@motebit/sdk";
import {
  RECEIPT_VERDICT_LABELS,
  verifyReceiptVerdict,
  type ReceiptVerdict,
} from "@motebit/render-engine";

export type ReceiptBadgeTone =
  "accent" | "muted" | "integrity" | "warn" | "warn-unanchored" | "error";

export interface ReceiptBadge {
  readonly verdict: ReceiptVerdict | "pending";
  readonly label: string;
  readonly tone: ReceiptBadgeTone;
}

export const PENDING_RECEIPT_BADGE: ReceiptBadge = {
  verdict: "pending",
  label: "verifying locally…",
  tone: "muted",
};

const TONE: Readonly<Record<ReceiptVerdict, ReceiptBadgeTone>> = {
  verified: "accent",
  "integrity-only": "integrity",
  "task-failed": "warn",
  "task-failed-unanchored": "warn-unanchored",
  failed: "error",
};

export function receiptBadgeForVerdict(verdict: ReceiptVerdict): ReceiptBadge {
  return { verdict, label: RECEIPT_VERDICT_LABELS[verdict], tone: TONE[verdict] };
}

/** Verify locally and derive the badge. Never throws (errors → "failed"). */
export async function deriveReceiptBadge(
  receipt: ExecutionReceipt,
  trustedAnchor?: ReadonlyMap<string, Uint8Array>,
): Promise<ReceiptBadge> {
  return receiptBadgeForVerdict(await verifyReceiptVerdict(receipt, trustedAnchor));
}
