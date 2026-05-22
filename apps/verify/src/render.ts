/**
 * DOM rendering for a verified receipt. No logic beyond turning the view model
 * + labels into nodes — the honesty decisions live in `labels.ts` (tested) and
 * the verification in `@motebit/state-export-client` (tested). Excluded from
 * coverage; exercised in the browser.
 */

import type { ReceiptDocumentVerification } from "@motebit/state-export-client";
import { resultLabels, type ResultTone } from "./labels.js";

const ICON: Record<ResultTone, string> = { bound: "✓", integrity: "≈", failed: "✗" };

type TierMark = "ok" | "warn" | "fail";
const TIER_GLYPH: Record<TierMark, string> = { ok: "✓", warn: "⚠", fail: "✗" };

// One labelled row of the two-tier breakdown: integrity / identity binding /
// delegation chain. The whole point is that these read as SEPARATE facts.
function tierRow(label: string, status: string, mark: TierMark): HTMLElement {
  const el = document.createElement("div");
  el.className = "tier-row";
  const l = document.createElement("span");
  l.className = "tier-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = `tier-status tier-${mark}`;
  v.textContent = `${TIER_GLYPH[mark]} ${status}`;
  el.append(l, v);
  return el;
}

function row(label: string, value: string, mono = true): HTMLElement {
  const el = document.createElement("div");
  el.className = "meta-row";
  const l = document.createElement("span");
  l.className = "meta-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = mono ? "meta-value mono" : "meta-value";
  v.textContent = value;
  el.append(l, v);
  return el;
}

export function renderResult(view: ReceiptDocumentVerification): HTMLElement {
  const labels = resultLabels(view);

  const card = document.createElement("div");
  card.className = `result-card tone-${labels.tone}`;

  const badge = document.createElement("div");
  badge.className = "result-badge";
  badge.innerHTML = `<span class="result-icon">${ICON[labels.tone]}</span><span>${labels.headline}</span>`;
  card.appendChild(badge);

  const detail = document.createElement("p");
  detail.className = "result-detail";
  detail.textContent = labels.detail;
  card.appendChild(detail);

  // Two-tier breakdown — the honesty payload, as scannable labelled rows.
  const tiers = document.createElement("div");
  tiers.className = "result-tiers";
  tiers.appendChild(
    tierRow(
      "signature integrity",
      view.integrity ? "verified" : "failed",
      view.integrity ? "ok" : "fail",
    ),
  );
  if (view.integrity) {
    const bound = view.binding === "anchored" || view.binding === "pinned";
    const bindingStatus =
      view.binding === "revoked"
        ? "revoked"
        : view.binding === "anchored"
          ? "anchored on-chain"
          : view.binding === "pinned"
            ? "pinned"
            : "not anchored";
    const bindingMark = view.binding === "revoked" ? "fail" : bound ? "ok" : "warn";
    tiers.appendChild(tierRow("identity binding", bindingStatus, bindingMark));
    const kids = view.delegations ?? [];
    if (kids.length > 0) {
      const failed = kids.filter((k) => !k.integrity).length;
      tiers.appendChild(
        tierRow(
          "delegation chain",
          failed === 0 ? `${kids.length} verified` : `${failed} of ${kids.length} failed`,
          failed === 0 ? "ok" : "fail",
        ),
      );
    }
  }
  card.appendChild(tiers);

  if (view.integrity) {
    const meta = document.createElement("div");
    meta.className = "result-meta";
    if (view.taskId) meta.appendChild(row("task", view.taskId));
    // motebit_id is the receipt's CLAIM about who produced it — labelled as such
    // so the page never conflates it with proven identity on the integrity path.
    if (view.motebitId) {
      const bound = view.binding === "anchored" || view.binding === "pinned";
      meta.appendChild(row(bound ? "motebit" : "claims to be", view.motebitId));
    }
    if (view.signerDid) meta.appendChild(row("signed by", view.signerDid));
    // Provenance for the anchored rung: the Solana tx that posted the log root.
    if (view.binding === "anchored" && view.anchorTxHash) {
      meta.appendChild(row("anchored in tx", view.anchorTxHash));
    }
    // Revoked: when the key was revoked on-chain.
    if (view.binding === "revoked" && view.revokedAt !== undefined) {
      meta.appendChild(row("key revoked at", new Date(view.revokedAt).toISOString(), false));
    }
    card.appendChild(meta);

    const kids = view.delegations ?? [];
    if (kids.length > 0) {
      const chain = document.createElement("div");
      chain.className = "result-chain";
      const h = document.createElement("h3");
      h.textContent = `delegation chain (${kids.length})`;
      chain.appendChild(h);
      for (const child of kids) chain.appendChild(renderResult(child));
      card.appendChild(chain);
    }
  }

  return card;
}
