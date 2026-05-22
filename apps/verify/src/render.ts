/**
 * DOM rendering for a verified receipt — an SSL-Labs-style graded verdict:
 * a "grade" (the binding rung reached), a ladder scale showing where the receipt
 * landed, and an honest per-dimension check breakdown. No logic beyond turning the
 * view model + labels into nodes — honesty decisions live in `labels.ts` (tested),
 * verification in `@motebit/state-export-client` (tested). Browser-exercised.
 */

import type {
  ReceiptDocumentVerification,
  ReceiptBindingStatus,
} from "@motebit/state-export-client";
import { resultLabels } from "./labels.js";

type CheckMark = "ok" | "warn" | "fail" | "skip";
const MARK_GLYPH: Record<CheckMark, string> = { ok: "✓", warn: "≈", fail: "✗", skip: "·" };

/** The positive ladder, weakest → strongest (revoked/unverified are off-ladder). */
const LADDER: ReceiptBindingStatus[] = ["integrity-only", "pinned", "anchored", "sovereign"];
const SCALE_TEXT: Record<string, string> = {
  "integrity-only": "integrity",
  pinned: "pinned",
  anchored: "anchored",
  sovereign: "sovereign",
};

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function checkRow(name: string, status: string, mark: CheckMark): HTMLElement {
  const row = el("div", "check-row");
  const m = el("span", `check-mark ${mark}`, MARK_GLYPH[mark]);
  const body = el("div", "check-body");
  body.append(el("div", "check-name", name), el("div", "check-status", status));
  row.append(m, body);
  return row;
}

function metaRow(label: string, value: string, mono = true): HTMLElement {
  const row = el("div", "meta-row");
  row.append(
    el("span", "meta-label", label),
    el("span", mono ? "meta-value mono" : "meta-value", value),
  );
  return row;
}

/** The ladder scale: each rung, with everything up to the reached one lit. */
function ladderScale(binding: ReceiptBindingStatus): HTMLElement {
  const reachedIdx = LADDER.indexOf(binding);
  const scale = el("div", "ladder-scale");
  LADDER.forEach((rung, i) => {
    if (i > 0) scale.append(el("span", "scale-arrow", "→"));
    let cls = "scale-step";
    if (i < reachedIdx) cls += " reached";
    else if (i === reachedIdx)
      cls += binding === "integrity-only" ? " current integrity" : " current";
    scale.append(el("span", cls, SCALE_TEXT[rung] ?? rung));
  });
  return scale;
}

/** The identity-binding check — one honest row whose status is the rung reached. */
function identityBindingRow(view: ReceiptDocumentVerification): HTMLElement {
  switch (view.binding) {
    case "sovereign":
      return checkRow(
        "Identity binding",
        "sovereign — the motebit_id commits to the genesis key (verified offline, no operator)",
        "ok",
      );
    case "anchored":
      return checkRow("Identity binding", "anchored — the binding is confirmed on-chain", "ok");
    case "pinned":
      return checkRow(
        "Identity binding",
        "pinned — the key is time-valid in the identity chain",
        "ok",
      );
    case "revoked":
      return checkRow(
        "Identity binding",
        view.revokedAt !== undefined
          ? `revoked — the signing key was revoked on-chain at ${new Date(view.revokedAt).toISOString()}`
          : "revoked — the signing key was revoked on-chain",
        "fail",
      );
    default:
      return checkRow(
        "Identity binding",
        "not established — checked against the receipt's own embedded key, not bound to the motebit",
        "skip",
      );
  }
}

export function renderResult(view: ReceiptDocumentVerification): HTMLElement {
  const labels = resultLabels(view);
  const card = el("div", `result-card tone-${labels.tone}`);

  // ── Grade (the verdict headline) ──
  const grade = el("div", "grade");
  const badge = el("span", `grade-badge tone-${labels.tone}`, labels.grade);
  const gradeText = el("div", "grade-text");
  gradeText.append(
    el("div", "grade-headline", labels.headline),
    el("div", "grade-detail", labels.detail),
  );
  grade.append(badge, gradeText);
  card.append(grade);

  // ── Ladder scale (only for the positive rungs) ──
  if (view.integrity && view.binding !== "revoked") {
    card.append(ladderScale(view.binding));
  }

  // ── Checks ──
  const checks = el("div", "checks");
  checks.append(
    checkRow(
      "Signature integrity",
      view.integrity
        ? "verified — the bytes weren't tampered"
        : "failed — altered or not a valid signature",
      view.integrity ? "ok" : "fail",
    ),
  );
  if (view.integrity) {
    checks.append(identityBindingRow(view));
    const kids = view.delegations ?? [];
    if (kids.length > 0) {
      const failed = kids.filter((k) => !k.integrity).length;
      checks.append(
        checkRow(
          "Delegation chain",
          failed === 0
            ? `${kids.length} delegated receipt(s) verified`
            : `${failed} of ${kids.length} failed`,
          failed === 0 ? "ok" : "fail",
        ),
      );
    }
  }
  card.append(checks);

  // ── Receipt fields ──
  if (view.integrity) {
    const meta = el("div", "result-meta");
    if (view.taskId) meta.append(metaRow("task", view.taskId));
    if (view.motebitId) {
      const bound =
        view.binding === "sovereign" || view.binding === "anchored" || view.binding === "pinned";
      meta.append(metaRow(bound ? "motebit" : "claims to be", view.motebitId));
    }
    if (view.signerDid) meta.append(metaRow("signed by", view.signerDid));
    if (view.binding === "anchored" && view.anchorTxHash) {
      meta.append(metaRow("anchored in tx", view.anchorTxHash));
    }
    card.append(meta);

    const kids = view.delegations ?? [];
    if (kids.length > 0) {
      const chain = el("div", "result-chain");
      chain.append(el("h3", "", `delegation chain (${kids.length})`));
      for (const child of kids) chain.append(renderResult(child));
      card.append(chain);
    }
  }

  return card;
}
