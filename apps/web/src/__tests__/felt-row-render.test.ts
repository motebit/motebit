/**
 * @vitest-environment jsdom
 */
// Render regression for the web felt row: proves the evidence-state → DOM
// contract — a verified record gets the native <button> disclosure with detail
// + "Verified"; a receipt-only record is a plain div with no button, no
// detail, no "Verified". The honesty is compile-enforced (the discriminated
// evidence union narrows `evidence.mutations` into the verified branch only);
// this locks the render keying as well.
import { describe, it, expect } from "vitest";
import { SensitivityLevel } from "@motebit/protocol";
import type { FeltConsolidationRecord } from "@motebit/panels";
import { buildFeltRow } from "../ui/felt-row";

const fmt = (_ts: number): string => "2h ago";

const verified: FeltConsolidationRecord = {
  cycleId: "c1",
  finishedAt: 1_700_000_000_000,
  assurance: "signed",
  receiptSummary: { consolidated: 2, pruned: 1 },
  evidence: {
    status: "verified",
    manifestId: "m1",
    mutations: [
      {
        nodeId: "a",
        kind: "formed",
        disclosure: "prefers structured answers",
        sensitivity: SensitivityLevel.Personal,
      },
    ],
  },
};

const receiptOnly: FeltConsolidationRecord = {
  cycleId: "c2",
  finishedAt: 1_700_000_000_000,
  assurance: "signed",
  receiptSummary: { consolidated: 3, pruned: 2 },
  evidence: { status: "receipt_only" },
};

describe("buildFeltRow — evidence-state render regression", () => {
  it("a verified record produces the native button disclosure with details + Verified", () => {
    const el = buildFeltRow(verified, fmt);
    const head = el.querySelector(".mem-felt-row");
    expect(head?.tagName).toBe("BUTTON");
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    expect(head?.getAttribute("aria-controls")).toBeTruthy();
    expect(el.querySelectorAll(".mem-felt-line")).toHaveLength(1);
    expect(el.querySelector(".mem-felt-line")?.textContent).toContain("prefers structured answers");
    expect(el.querySelector(".mem-felt-note")?.textContent).toBe("Verified");
  });

  it("a receipt_only record produces NO button, NO details, NO Verified", () => {
    const el = buildFeltRow(receiptOnly, fmt);
    const head = el.querySelector(".mem-felt-row");
    expect(head?.tagName).toBe("DIV"); // not a <button>
    expect(head?.getAttribute("aria-expanded")).toBeNull();
    expect(el.querySelectorAll(".mem-felt-line")).toHaveLength(0);
    expect(el.querySelector(".mem-felt-note")).toBeNull();
    expect(el.textContent ?? "").not.toContain("Verified");
    // The headline is the signed receipt aggregate, never mutation-derived.
    expect(el.querySelector(".mem-felt-headline")?.textContent).toBe("3 consolidated · 2 faded");
    // The receipt glyph is still shown (the cycle IS signed), but its
    // accessible label must not claim displayed changes — there are none.
    const glyph = el.querySelector(".mem-felt-glyph");
    expect(glyph?.textContent).toBe("✓");
    const glyphLabel = glyph?.getAttribute("aria-label") ?? "";
    expect(glyphLabel).toContain("signed receipt");
    expect(glyphLabel).not.toContain("changes shown");
    expect(glyphLabel).not.toContain("verified separately");
    expect(glyphLabel).toContain("unavailable without a verified mutation manifest");
  });

  it("a verified record's glyph label references the verified changes", () => {
    const el = buildFeltRow(verified, fmt);
    const glyphLabel = el.querySelector(".mem-felt-glyph")?.getAttribute("aria-label") ?? "";
    expect(glyphLabel).toContain("verified separately");
    expect(glyphLabel).not.toContain("unavailable");
  });
});
