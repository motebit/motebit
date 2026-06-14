// Web render for one felt consolidation row. Isolated in its own module (only
// @motebit/panels + the DOM) so the render regression test can import it
// without pulling in the whole gated-panels dependency tree. Time formatting
// is injected (panels rule 6 — time stays per-surface).
//
// Honesty is compile-enforced: the discriminated evidence union narrows
// `evidence.mutations` into the verified branch ONLY, so a receipt-only record
// structurally cannot render detail. This module locks the render keying too —
// verified ⟺ a native <button> disclosure with detail + "Verified"; receipt-
// only ⟺ a plain div, no reveal, no coverage label.
import {
  feltHeadline,
  feltMutationLine,
  feltVerifiedAssurance,
  feltAssuranceGlyph,
  feltReceiptScope,
  type FeltConsolidationRecord,
} from "@motebit/panels";

export function buildFeltRow(
  rec: FeltConsolidationRecord,
  formatTime: (ts: number) => string,
): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "mem-felt-wrap";

  const expandable = rec.evidence.status === "verified";
  const detailId = `felt-detail-${rec.cycleId || "x"}-${rec.finishedAt}`;

  const head = document.createElement(expandable ? "button" : "div");
  head.className = "mem-felt-row";
  if (expandable) {
    const btn = head as HTMLButtonElement;
    btn.type = "button";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", detailId);
  }

  const summary = document.createElement("span");
  summary.className = "mem-felt-headline";
  summary.textContent = feltHeadline(rec);
  head.appendChild(summary);

  const glyph = feltAssuranceGlyph(rec.assurance);
  if (glyph) {
    const badge = document.createElement("span");
    badge.className = "mem-felt-glyph";
    badge.textContent = glyph;
    const scope = feltReceiptScope(rec.assurance, rec.evidence.status);
    const glyphLabel = rec.cycleId ? `${scope} (cycle ${rec.cycleId})` : scope;
    badge.title = glyphLabel;
    badge.setAttribute("aria-label", glyphLabel);
    head.appendChild(badge);
  }

  const time = document.createElement("span");
  time.className = "mem-felt-time";
  time.textContent = formatTime(rec.finishedAt);
  head.appendChild(time);

  wrap.appendChild(head);

  if (rec.evidence.status === "verified") {
    const detail = document.createElement("div");
    detail.className = "mem-felt-detail";
    detail.id = detailId;
    detail.style.display = "none";
    for (const m of rec.evidence.mutations) {
      const line = document.createElement("div");
      line.className = "mem-felt-line";
      line.textContent = feltMutationLine(m);
      detail.appendChild(line);
    }
    const status = feltVerifiedAssurance();
    const note = document.createElement("div");
    note.className = "mem-felt-note";
    note.textContent = status.label;
    note.title = status.detail;
    note.setAttribute("aria-label", status.detail);
    detail.appendChild(note);
    wrap.appendChild(detail);

    head.addEventListener("click", () => {
      const open = detail.style.display === "none";
      detail.style.display = open ? "block" : "none";
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  return wrap;
}
