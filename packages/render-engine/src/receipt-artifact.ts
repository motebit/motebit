/**
 * `buildReceiptArtifact` — the DOM form of the receipt emergence.
 *
 * A delegation completes, a signed chain arrives, and the receipt card
 * fades into the scene: signer, task id, chain, tools, verify state.
 * Every check runs locally — `verifyReceiptChain` is pure-JS Ed25519
 * over JCS canonical JSON from `@motebit/encryption`. No server round
 * trip, no trust in the page; the user can open devtools and confirm
 * zero verify-side network traffic.
 *
 * Shape invariant: the returned element is `.spatial-artifact.artifact-receipt`
 * so surface CSS (web, desktop) can style it uniformly. The caller owns
 * lifecycle — pass the element to `ArtifactManager.addArtifact(...)` and
 * call the `onDismiss` callback from your close handler.
 *
 * Extracted from apps/web/src/ui/receipt-artifact.ts on 2026-04-19 so
 * desktop can consume the same renderer (web + desktop are both DOM
 * surfaces; mobile gets its own RN component; spatial renders as a 3D
 * satellite). One-pass-delivery.
 */

import type { ExecutionReceipt } from "@motebit/sdk";
import { verifyReceiptChain } from "@motebit/encryption";
import { collectKnownKeys, displayName, priceFor, shortHash } from "./receipt-summary.js";

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

  body.addEventListener("click", () => {
    root.classList.toggle("is-expanded");
  });

  // Close — dismiss via the caller-provided handler.
  const close = document.createElement("button");
  close.className = "spatial-artifact-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss receipt");
  close.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onDismiss();
  });
  root.appendChild(close);

  // Initial state — replaced below once verification settles. Pending
  // pulse is the calm-software signal that a check is in flight.
  root.classList.add("is-pending");

  const knownKeys = collectKnownKeys(receipt);
  void verifyReceiptChain(receipt, knownKeys)
    .then((tree) => {
      root.classList.remove("is-pending");
      if (!tree.verified) {
        root.classList.add("is-unverified");
        label.textContent = "verification failed";
        return;
      }
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
