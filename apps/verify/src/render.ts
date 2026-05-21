/**
 * DOM rendering for a verified receipt. No logic beyond turning the view model
 * + labels into nodes — the honesty decisions live in `labels.ts` (tested) and
 * the verification in `@motebit/state-export-client` (tested). Excluded from
 * coverage; exercised in the browser.
 */

import type { ReceiptDocumentVerification } from "@motebit/state-export-client";
import { resultLabels, type ResultTone } from "./labels.js";

const ICON: Record<ResultTone, string> = { bound: "✓", integrity: "≈", failed: "✗" };

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

  if (view.integrity) {
    const meta = document.createElement("div");
    meta.className = "result-meta";
    if (view.taskId) meta.appendChild(row("task", view.taskId));
    // motebit_id is the receipt's CLAIM about who produced it — labelled as such
    // so the page never conflates it with proven identity on the integrity path.
    if (view.motebitId) {
      meta.appendChild(row(view.binding === "bound" ? "motebit" : "claims to be", view.motebitId));
    }
    if (view.signerDid) meta.appendChild(row("signed by", view.signerDid));
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
