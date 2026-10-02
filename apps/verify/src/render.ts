/**
 * DOM rendering for a verified receipt: CLAIM first (the signed content in plain
 * words), then PROOF (the verdict and one row per rung), then the honesty block
 * (what this proves / does not prove). No logic beyond turning pure view models
 * into nodes — the claim mapping lives in `claim.ts`, the rung mapping in
 * `ladder.ts`, the honesty copy in `honesty.ts`, the verdict words in `labels.ts`
 * (all unit-tested). Every receipt-derived string goes through `textContent`, so
 * pasted content is always shown escaped, never parsed as HTML.
 */

import type { ReceiptDocumentVerification } from "@motebit/state-export-client";
import { resultLabels } from "./labels.js";
import { buildClaim, type ClaimNode, type ClaimTime } from "./claim.js";
import { proofLadder, type RelayContext, type RungState } from "./ladder.js";
import { honesty } from "./honesty.js";

const MARK: Record<RungState, { glyph: string; cls: string; sr: string }> = {
  passed: { glyph: "✓", cls: "ok", sr: "passed" },
  skipped: { glyph: "—", cls: "skip", sr: "not applicable or not checked" },
  failed: { glyph: "✗", cls: "fail", sr: "failed" },
};

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(label: string, value: Node | string, mono = false): HTMLElement {
  const row = el("div", "field");
  const v = el("dd", mono ? "field-value mono" : "field-value");
  if (typeof value === "string") v.textContent = value;
  else v.append(value);
  row.append(el("dt", "field-label", label), v);
  return row;
}

function timeValue(t: ClaimTime): HTMLElement {
  const wrap = el("span", "");
  const time = el("time", "", t.local);
  time.setAttribute("datetime", t.iso);
  wrap.append(time, el("span", "field-sub mono", t.iso));
  return wrap;
}

function resultValue(c: ClaimNode): HTMLElement {
  const wrap = el("div", "result-text");
  if (!c.resultTruncated) {
    wrap.textContent = c.result ?? "";
    return wrap;
  }
  const details = el("details", "result-expand") as HTMLDetailsElement;
  details.append(
    el("summary", "", `${c.resultPreview ?? ""}  (show all ${c.result?.length ?? 0} chars)`),
    el("div", "result-full", c.result),
  );
  wrap.append(details);
  return wrap;
}

function verdictChip(v: ReceiptDocumentVerification | undefined): HTMLElement {
  const ok = v?.integrity === true && v.binding !== "revoked";
  const text = !v?.integrity ? "INVALID" : v.binding === "revoked" ? "REVOKED" : "valid signature";
  return el("span", `chip ${ok ? "chip-ok" : "chip-fail"}`, text);
}

/** The plain-words claim fields for one receipt node. */
function claimFields(c: ClaimNode): HTMLElement {
  const dl = el("dl", "fields");
  if (c.status !== undefined) dl.append(field("status", c.status));
  if (c.result !== undefined) dl.append(field("result", resultValue(c)));
  if (c.submitted) dl.append(field("submitted", timeValue(c.submitted)));
  if (c.completed) dl.append(field("completed", timeValue(c.completed)));
  dl.append(field("tools used", c.toolsUsed.length > 0 ? c.toolsUsed.join(", ") : "none", true));
  if (c.memoriesFormed !== undefined) dl.append(field("memories formed", String(c.memoriesFormed)));
  if (c.delegatedScope !== undefined) dl.append(field("delegated scope", c.delegatedScope, true));
  return dl;
}

function ladderList(view: ReceiptDocumentVerification, ctx: RelayContext): HTMLElement {
  const list = el("ol", "ladder");
  list.setAttribute("aria-label", "Proof, rung by rung");
  for (const rung of proofLadder(view, ctx)) {
    const m = MARK[rung.state];
    const li = el("li", `rung rung-${rung.state}`);
    li.dataset["rung"] = rung.key;
    const mark = el("span", `check-mark ${m.cls}`, m.glyph);
    mark.setAttribute("aria-hidden", "true");
    const body = el("div", "check-body");
    const name = el("div", "check-name", rung.name);
    name.append(el("span", "sr-only", ` — ${m.sr}`));
    body.append(name, el("div", "check-status", rung.summary));
    li.append(mark, body);
    list.append(li);
  }
  return list;
}

/** One nested receipt: collapsible, with its own verdict and its own ladder. */
function delegationNode(c: ClaimNode): HTMLElement {
  const details = el("details", "delegation") as HTMLDetailsElement;
  const summary = el("summary", "delegation-summary");
  summary.append(
    verdictChip(c.view),
    el("span", "mono delegation-id", c.taskId ? `task ${c.taskId}` : "receipt"),
  );
  details.append(summary, claimFields(c));
  if (c.view) details.append(ladderList(c.view, { kind: "nested" }));
  if (c.delegations.length > 0) details.append(delegationTree(c));
  return details;
}

function delegationTree(c: ClaimNode): HTMLElement {
  const wrap = el("div", "delegations");
  for (const kid of c.delegations) wrap.append(delegationNode(kid));
  return wrap;
}

export interface RenderOptions {
  /** The parsed receipt JSON (untrusted) — the source of the plain-words claim. */
  readonly receipt?: unknown;
  /** What the page did about relay context — feeds the ladder's reasons. */
  readonly ctx: RelayContext;
}

export function renderResult(view: ReceiptDocumentVerification, opts: RenderOptions): HTMLElement {
  const labels = resultLabels(view);
  const card = el("div", `result-card tone-${labels.tone}`);
  const claim = buildClaim(opts.receipt, view);

  // ── Claim (first) ──
  if (claim) {
    const sec = el("section", "claim");
    sec.setAttribute("aria-labelledby", "claim-h");
    const head = el("div", "section-head");
    const h = el("h2", "section-title", "Claim");
    h.id = "claim-h";
    head.append(h, verdictChip(view));
    sec.append(head);
    if (!view.integrity) {
      sec.append(
        el("p", "unsigned-note", "The signature does not verify — these fields are unsigned text."),
      );
    }
    sec.append(claimFields(claim));
    if (claim.delegationCount > 0) {
      const sub = el("div", "delegation-block");
      sub.append(el("h3", "sub-title", `delegated receipts (${claim.delegationCount})`));
      sub.append(delegationTree(claim));
      sec.append(sub);
    }
    card.append(sec);
  }

  // ── Proof ──
  const proof = el("section", "proof");
  proof.setAttribute("aria-labelledby", "proof-h");
  const ph = el("h2", "section-title", "Proof");
  ph.id = "proof-h";
  proof.append(ph);
  const grade = el("div", "grade");
  grade.append(
    el("span", `grade-badge tone-${labels.tone}`, labels.grade),
    (() => {
      const t = el("div", "grade-text");
      t.append(
        el("div", "grade-headline", labels.headline),
        el("div", "grade-detail", labels.detail),
      );
      return t;
    })(),
  );
  proof.append(grade, ladderList(view, opts.ctx));
  if (view.integrity) {
    const meta = el("dl", "fields result-meta");
    const bound =
      view.binding === "sovereign" || view.binding === "anchored" || view.binding === "pinned";
    if (view.motebitId)
      meta.append(field(bound ? "motebit" : "claims to be", view.motebitId, true));
    if (view.signerDid) meta.append(field("signed by", view.signerDid, true));
    if (view.taskId) meta.append(field("task", view.taskId, true));
    proof.append(meta);
  }
  card.append(proof);

  // ── What this proves / does not prove ──
  const h = honesty(view);
  const hon = el("section", "honesty");
  hon.setAttribute("aria-label", "What this proves and does not prove");
  const col = (title: string, items: readonly string[], cls: string): HTMLElement => {
    const c = el("div", `honesty-col ${cls}`);
    const ul = el("ul", "");
    for (const i of items) ul.append(el("li", "", i));
    c.append(el("h3", "sub-title", title), ul);
    return c;
  };
  hon.append(
    col("What this proves", h.proves, "proves"),
    col("What this does not prove", h.doesNotProve, "not-proves"),
  );
  card.append(hon);

  return card;
}
