/**
 * Receipt artifact — the signed delegation chain rendered as a satellite
 * around the creature. The "oh" beat of the motebit protocol: agents paid
 * agents, with local cryptographic proof.
 *
 * The DOM is built once per receipt; `verifyReceiptChain` runs in-browser
 * via `@motebit/crypto` (pure-JS Ed25519, zero monorepo deps). No server
 * roundtrip, no trust in this page — the user can open devtools and see
 * zero verify-side network traffic.
 */

import type { ExecutionReceipt } from "@motebit/sdk";
import { verifyReceiptChain } from "@motebit/encryption";

// Known per-capability unit costs, USD. Mirrors the pricing in the relay's
// Discover endpoint. A follow-up can swap this for a live lookup from the
// same cache the Discover panel uses — for now, the numbers are fixed by
// each atom/molecule's published `getServiceListing()` pricing.
const CAPABILITY_PRICES_USD: Record<string, number> = {
  review_pr: 0.01,
  research: 0.25,
  read_url: 0.003,
  web_search: 0.005,
  summarize: 0.002,
  connection_search: 0.03,
};

function formatUsd(amount: number): string {
  // Three-decimal precision for sub-cent atom pricing; drops trailing zeros
  // past the cent place for readability (0.010 → "$0.01", 0.003 → "$0.003").
  if (amount >= 0.01) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(3)}`;
}

function priceFor(receipt: ExecutionReceipt): string {
  for (const cap of receipt.tools_used) {
    const p = CAPABILITY_PRICES_USD[cap];
    if (p != null) return formatUsd(p);
  }
  return "—";
}

function displayName(receipt: ExecutionReceipt): string {
  // Prefer the capability name (tools_used[0]); falls back to a motebit_id
  // prefix if the capability is unknown to the price table.
  const cap = receipt.tools_used[0];
  if (cap) return cap.replace(/_/g, "-");
  return receipt.motebit_id.slice(0, 10);
}

/**
 * Build the `knownKeys` map from public_key fields embedded in the receipt
 * tree. Each motebit's public key is included in its own receipt — no
 * external registry lookup needed for local verification.
 */
function collectKnownKeys(receipt: ExecutionReceipt): Map<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  const visit = (r: ExecutionReceipt): void => {
    if (typeof r.public_key === "string" && r.public_key.length > 0) {
      try {
        const bytes = hexToBytes(r.public_key);
        keys.set(r.motebit_id, bytes);
      } catch {
        // Ignore malformed keys — verify will fail-closed on this receipt.
      }
    }
    const nested = r.delegation_receipts ?? [];
    for (const child of nested) visit(child);
  };
  visit(receipt);
  return keys;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function shortHash(hex: string, n = 8): string {
  const clean = hex.replace(/^0x/, "");
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

/**
 * Build the receipt artifact DOM. The caller owns the element lifecycle
 * (add to ArtifactManager, dismiss via the close button).
 */
export function buildReceiptArtifact(
  receipt: ExecutionReceipt,
  onDismiss: () => void,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "spatial-artifact artifact-receipt";

  const title = document.createElement("div");
  title.className = "spatial-artifact-title";
  title.textContent = "receipt";
  root.appendChild(title);

  const body = document.createElement("div");
  body.className = "spatial-artifact-body";
  root.appendChild(body);

  // Chain rendering — molecule at the root, atoms indented. One line per
  // receipt; tree glyph clarifies the hierarchy at a glance.
  const chain = document.createElement("div");
  chain.className = "receipt-chain";

  chain.appendChild(renderRow(receipt, 0, true));
  const children = receipt.delegation_receipts ?? [];
  for (let i = 0; i < children.length; i++) {
    const last = i === children.length - 1;
    chain.appendChild(renderRow(children[i]!, 1, last));
  }

  body.appendChild(chain);

  // Expanded details — hidden by default, toggled by clicking the body.
  const details = document.createElement("div");
  details.className = "receipt-details";
  details.appendChild(renderDetail("signed by", shortHash(receipt.motebit_id, 12)));
  details.appendChild(renderDetail("task_id", shortHash(receipt.task_id, 12)));
  details.appendChild(renderDetail("signature", shortHash(receipt.signature ?? "", 16)));
  details.appendChild(renderDetail("suite", receipt.suite ?? "—"));
  body.appendChild(details);

  // Verify state — starts in "verifying…" and transitions to verified on
  // promise resolution. No user action required; the cryptographic check
  // is the bubble's reason for being.
  const verify = document.createElement("div");
  verify.className = "receipt-verify";
  const dot = document.createElement("span");
  dot.className = "receipt-verify-dot";
  const label = document.createElement("span");
  label.className = "receipt-verify-label";
  label.textContent = "verifying locally…";
  verify.appendChild(dot);
  verify.appendChild(label);
  body.appendChild(verify);

  // Body tap toggles expanded details (doesn't conflict with the close
  // button, which lives outside .spatial-artifact-body).
  body.addEventListener("click", () => {
    root.classList.toggle("is-expanded");
  });

  // Close — dismiss via the artifact manager.
  const close = document.createElement("button");
  close.className = "spatial-artifact-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss receipt");
  close.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onDismiss();
  });
  root.appendChild(close);

  // Initial state — replaced below by one of is-verified / is-unverified /
  // is-failed once the chain verify completes. The pending pulse is the
  // calm-software signal that local verification is in flight.
  root.classList.add("is-pending");

  // Verify the full chain locally. Ed25519 over JCS canonical JSON via
  // @noble/ed25519 — zero network traffic, fail-closed on any error.
  const knownKeys = collectKnownKeys(receipt);
  void verifyReceiptChain(receipt, knownKeys)
    .then((tree) => {
      root.classList.remove("is-pending");
      if (!tree.verified) {
        root.classList.add("is-unverified");
        label.textContent = "verification failed";
        return;
      }
      // Verified, but the task itself may have failed. The receipt's
      // status is meaningful evidence — emerge it in is-failed state so
      // the user sees "the delegation happened, the agent reported
      // failure," not a silent-hide.
      if (receipt.status === "failed") {
        root.classList.add("is-failed");
        label.textContent = "verified · completed: failed";
        return;
      }
      root.classList.add("is-verified");
      label.textContent = "verified locally · chain intact";
    })
    .catch(() => {
      root.classList.remove("is-pending");
      root.classList.add("is-unverified");
      label.textContent = "verification failed";
    });

  return root;
}

function renderRow(receipt: ExecutionReceipt, depth: number, _last: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = depth === 0 ? "receipt-row receipt-root" : "receipt-row receipt-child";

  const glyph = document.createElement("span");
  glyph.className = "receipt-tree";
  // Simple indented glyph — tree drawing at depth 1 uses a corner mark.
  glyph.textContent = depth === 0 ? "" : "└";
  row.appendChild(glyph);

  const name = document.createElement("span");
  name.className = "receipt-name";
  name.textContent = displayName(receipt);
  row.appendChild(name);

  const cost = document.createElement("span");
  cost.className = "receipt-cost";
  cost.textContent = priceFor(receipt);
  row.appendChild(cost);

  return row;
}

function renderDetail(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "receipt-detail-row";
  const l = document.createElement("span");
  l.className = "receipt-detail-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "receipt-detail-value";
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(v);
  return row;
}
