/**
 * `buildComputerSessionReceiptArtifact` — the DOM form of a v1.5
 * `ComputerSessionReceipt` emergence.
 *
 * A computer-use session ends, the runtime signs a session-summary
 * receipt under `motebit-jcs-ed25519-b64-v1`, the audit log captures
 * `ComputerSessionSummarized`, and this card emerges in the scene as
 * a verifiable artifact. Sibling of `buildReceiptArtifact`
 * (delegation/execution chains) — same shape, same verify-locally
 * contract, same `.spatial-artifact.artifact-receipt` CSS hook so
 * surfaces style both uniformly without duplicating styles.
 *
 * What's surfaced. Header line ("computer session" + embodiment
 * mode). One-line summary: action count, success/failure split,
 * was-halted indicator. Collapsible detail block: receipt_id,
 * session_id, motebit_id, signature, suite, public_key,
 * opened/closed times, max_sensitivity, actions_hash, full
 * failure-reason breakdown.
 *
 * Privacy invariant. The receipt itself commits to *structural facts
 * only* — counts, timing, hashes, never targets, args, or
 * observation bytes (see `@motebit/protocol`'s
 * `SignableComputerSessionReceipt`). The card surfaces every signed
 * field; nothing can leak through the artifact that wasn't already
 * in the wire-format, by construction.
 *
 * Verification. `verifyComputerSessionReceipt` (re-exported from
 * `@motebit/encryption` via `@motebit/crypto`) runs locally — JCS
 * canonicalize the body, recompute, Ed25519 verify with the
 * embedded `public_key`. The card transitions through three
 * verify states (pending → verified → unverified) the same way
 * `buildReceiptArtifact` does, so consumers' CSS can match the
 * shared `is-pending` / `is-verified` / `is-unverified` rules.
 */

import type { ComputerSessionReceipt } from "@motebit/sdk";
import { verifyComputerSessionReceipt, hexToBytes } from "@motebit/encryption";
import { shortHash } from "./receipt-summary.js";

/**
 * Build the computer-session receipt artifact DOM. The caller owns the
 * element lifecycle (add to ArtifactManager, dismiss via the close
 * button).
 */
export function buildComputerSessionReceiptArtifact(
  receipt: ComputerSessionReceipt,
  onDismiss: () => void,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "spatial-artifact artifact-receipt artifact-computer-session";

  const title = document.createElement("div");
  title.className = "spatial-artifact-title";
  // Title carries the embodiment so a glance distinguishes a cloud-
  // browser session from a desktop_drive session — same card shape,
  // different scope.
  title.textContent = `computer session · ${receipt.embodiment_mode}`;
  root.appendChild(title);

  const body = document.createElement("div");
  body.className = "spatial-artifact-body";
  root.appendChild(body);

  // One-line chain row — sibling of `receipt-row receipt-root` from
  // the delegation receipt artifact. Reuses `.receipt-chain` so the
  // surface CSS pulls the same indent + glyph styling.
  const chain = document.createElement("div");
  chain.className = "receipt-chain";

  const row = document.createElement("div");
  row.className = "receipt-row receipt-root";

  const glyph = document.createElement("span");
  glyph.className = "receipt-tree";
  glyph.textContent = "";
  row.appendChild(glyph);

  const name = document.createElement("span");
  name.className = "receipt-name";
  // Compact summary line. Halt marker comes first when present so a
  // user pausing the session sees that fact prominently in the
  // emerged card.
  const haltMarker = receipt.was_halted ? "halted · " : "";
  const successCount = receipt.outcomes_summary.success;
  const failureCount = receipt.outcomes_summary.failure;
  name.textContent = `${haltMarker}${receipt.action_count} action${receipt.action_count === 1 ? "" : "s"} · ${successCount} ok · ${failureCount} fail`;
  row.appendChild(name);

  const cost = document.createElement("span");
  cost.className = "receipt-cost";
  // Sensitivity tier as the trailing micro-label, mirrors how
  // `buildReceiptArtifact` puts price/cost in the trailing slot.
  // None ≡ unmarked stays terse; anything elevated reads in-line.
  cost.textContent = receipt.max_sensitivity === "none" ? "" : `· ${receipt.max_sensitivity}`;
  row.appendChild(cost);

  chain.appendChild(row);
  body.appendChild(chain);

  // Collapsible detail block — every signed field surfaces here so
  // a third party clicking through to the artifact can audit the
  // exact bytes that were signed.
  const details = document.createElement("div");
  details.className = "receipt-details";
  details.appendChild(renderDetail("receipt_id", shortHash(receipt.receipt_id, 12)));
  details.appendChild(renderDetail("session_id", shortHash(receipt.session_id, 12)));
  details.appendChild(renderDetail("signed by", shortHash(receipt.motebit_id, 12)));
  details.appendChild(renderDetail("signature", shortHash(receipt.signature, 16)));
  details.appendChild(renderDetail("suite", receipt.suite));
  if (receipt.public_key) {
    details.appendChild(renderDetail("public_key", shortHash(receipt.public_key, 16)));
  }
  details.appendChild(
    renderDetail(
      "display",
      `${receipt.display_width}×${receipt.display_height}@${receipt.scaling_factor}x`,
    ),
  );
  details.appendChild(renderDetail("opened", formatTime(receipt.opened_at)));
  details.appendChild(renderDetail("closed", formatTime(receipt.closed_at)));
  if (receipt.close_reason) {
    details.appendChild(renderDetail("close_reason", receipt.close_reason));
  }
  details.appendChild(renderDetail("actions_hash", shortHash(receipt.actions_hash, 16)));
  // Failure breakdown, when non-empty — one line per reason. The
  // structured hash above commits to the full list; the breakdown
  // surfaces it for human reading without re-deriving from the hash.
  const failureReasons = Object.entries(receipt.failure_breakdown);
  if (failureReasons.length > 0) {
    for (const [reason, count] of failureReasons) {
      details.appendChild(renderDetail(`failure: ${reason}`, String(count)));
    }
  }
  body.appendChild(details);

  // Verify state — pending pulse → verified-locally / unverified.
  // Same DOM shape and CSS classes as `buildReceiptArtifact` so
  // surface stylesheets style both uniformly.
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

  const close = document.createElement("button");
  close.className = "spatial-artifact-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss receipt");
  close.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onDismiss();
  });
  root.appendChild(close);

  root.classList.add("is-pending");

  // Local Ed25519 verify. Verifier needs the public key — embedded
  // in the receipt at sign time. Without an embedded key, mark
  // unverified (the receipt is malformed for self-verification).
  if (!receipt.public_key) {
    root.classList.remove("is-pending");
    root.classList.add("is-unverified");
    label.textContent = "verification failed · no public key";
    return root;
  }
  const publicKeyBytes = hexToBytes(receipt.public_key);
  void verifyComputerSessionReceipt(receipt, publicKeyBytes)
    .then((valid) => {
      root.classList.remove("is-pending");
      if (!valid) {
        root.classList.add("is-unverified");
        label.textContent = "verification failed";
        return;
      }
      root.classList.add("is-verified");
      label.textContent = "verified locally · session signed";
    })
    .catch(() => {
      root.classList.remove("is-pending");
      root.classList.add("is-unverified");
      label.textContent = "verification failed";
    });

  return root;
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

function formatTime(unixMs: number): string {
  // Compact ISO seconds — auditable, locale-free. Surfaces that want
  // a friendlier format can re-render from `receipt.opened_at`.
  return new Date(unixMs).toISOString().slice(0, 19) + "Z";
}
