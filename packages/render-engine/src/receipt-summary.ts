/**
 * Pure helpers for summarizing an `ExecutionReceipt` for rendering.
 *
 * Zero DOM, zero React, zero Three — just the display math that every
 * surface (web, desktop, mobile, spatial, CLI) computes identically.
 * Centralizing these here stops each surface from drifting its own copy
 * of the price table or `displayName` rules.
 *
 * The pricing table is a product-layer concern; if pricing becomes
 * relay-driven (fetched from each agent's `getServiceListing()`), the
 * fallback remains here so offline receipts still render a price.
 */

import type { ExecutionReceipt } from "@motebit/sdk";

/**
 * Known per-capability unit costs in USD. Mirrors each shipping agent's
 * `getServiceListing()` output; update when a new capability ships.
 * Surfaces fall back to "—" for unknown capabilities rather than
 * guessing.
 */
export const CAPABILITY_PRICES_USD: Record<string, number> = {
  review_pr: 0.01,
  research: 0.25,
  read_url: 0.003,
  web_search: 0.005,
  summarize: 0.002,
  connection_search: 0.03,
};

/**
 * Format a USD amount with three-decimal precision for sub-cent atom
 * pricing. Drops trailing zeros past the cent place so receipts render
 * "$0.01" for review_pr and "$0.003" for read_url.
 */
export function formatUsd(amount: number): string {
  if (amount >= 0.01) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(3)}`;
}

/** Pick the first known capability's price from a receipt. "—" if none match. */
export function priceFor(receipt: ExecutionReceipt): string {
  for (const cap of receipt.tools_used) {
    const p = CAPABILITY_PRICES_USD[cap];
    if (p != null) return formatUsd(p);
  }
  return "—";
}

/**
 * Human-readable label for a receipt row: the first capability
 * (dash-case) or the first 10 chars of the motebit_id if no tools
 * were used.
 */
export function displayName(receipt: ExecutionReceipt): string {
  const cap = receipt.tools_used[0];
  if (cap) return cap.replace(/_/g, "-");
  return receipt.motebit_id.slice(0, 10);
}

/**
 * Walk a receipt tree and collect every embedded public_key as bytes.
 * Used by `verifyReceiptChain` as the `knownKeys` map — each motebit's
 * key travels with its own receipt, so chain verification needs no
 * external registry lookup.
 */
export function collectKnownKeys(receipt: ExecutionReceipt): Map<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  const visit = (r: ExecutionReceipt): void => {
    if (typeof r.public_key === "string" && r.public_key.length > 0) {
      try {
        const bytes = hexToBytes(r.public_key);
        keys.set(r.motebit_id, bytes);
      } catch {
        // Malformed key — verify will fail-closed on this receipt.
      }
    }
    const nested = r.delegation_receipts ?? [];
    for (const child of nested) visit(child);
  };
  visit(receipt);
  return keys;
}

/** Parse a hex string (optional 0x prefix) to bytes. Throws on invalid input. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Short-form display of a hex hash: first `n` chars + ellipsis. */
export function shortHash(hex: string, n = 8): string {
  const clean = hex.replace(/^0x/, "");
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

/**
 * Summarize a receipt's surface properties for any renderer (DOM card,
 * RN component, satellite, terminal). Pre-computes every derived field
 * so renderers don't duplicate the math.
 */
export interface ReceiptSummary {
  readonly rootName: string;
  readonly rootPrice: string;
  readonly chainDepth: number;
  readonly toolCount: number;
  readonly signer: string;
  readonly taskIdShort: string;
  readonly signatureShort: string;
  readonly suite: string;
  readonly status: string;
}

export function receiptSummary(receipt: ExecutionReceipt): ReceiptSummary {
  const children = receipt.delegation_receipts ?? [];
  return {
    rootName: displayName(receipt),
    rootPrice: priceFor(receipt),
    chainDepth: children.length,
    toolCount: receipt.tools_used.length,
    signer: shortHash(receipt.motebit_id, 12),
    taskIdShort: shortHash(receipt.task_id, 12),
    signatureShort: shortHash(receipt.signature ?? "", 16),
    suite: receipt.suite ?? "—",
    status: receipt.status,
  };
}
