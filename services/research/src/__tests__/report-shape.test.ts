import { describe, it, expect } from "vitest";
import { REPORT_MIN_CHARS, reportShapeIssues } from "../report-shape.js";

const CLEAN_REPORT = [
  "**Question** — what is being asked, restated.",
  "",
  "**Findings**",
  "",
  "The synthesized answer, specific and cited inline [1]. This paragraph",
  "carries enough substance to clear the contract's minimum-length floor,",
  "standing in for the real findings of a live research turn.",
  "",
  "**Sources**",
  "",
  "[1] Example source — https://example.com/source",
].join("\n");

function codes(report: string, sourcesRead: boolean): string[] {
  return reportShapeIssues(report, { sourcesRead }).map((i) => i.code);
}

describe("reportShapeIssues — v1 shape contract (#504)", () => {
  it("a clean sourced report has no issues", () => {
    expect(codes(CLEAN_REPORT, true)).toEqual([]);
  });

  it("empty is the only issue reported for an empty body, sources or not", () => {
    expect(codes("", true)).toEqual(["empty"]);
    expect(codes("   \n  ", false)).toEqual(["empty"]);
  });

  it("a source-free direct answer owes only non-emptiness — no section scaffolding demanded", () => {
    expect(codes("2 + 2 = 4.", false)).toEqual([]);
  });

  it("the witnessed failure mode — notes plus snippets, no structure — fails on all three axes", () => {
    const notes = "Searched for X. Found some pages. Snippet: lorem ipsum.";
    expect(codes(notes, true)).toEqual(["missing_findings", "missing_sources", "too_short"]);
  });

  it("missing Sources alone is reported when Findings exist", () => {
    const report = `**Findings**\n\n${"substantive text ".repeat(20)}`;
    expect(codes(report, true)).toEqual(["missing_sources"]);
  });

  it("missing Findings alone is reported when Sources exist", () => {
    const report = `${"substantive text ".repeat(20)}\n\n**Sources**\n[1] x — https://x.example`;
    expect(codes(report, true)).toEqual(["missing_findings"]);
  });

  it("too_short fires when both sections exist but the body is under the floor", () => {
    const report = "**Findings**\nYes.\n**Sources**\n[1] x";
    expect(report.length).toBeLessThan(REPORT_MIN_CHARS);
    expect(codes(report, true)).toEqual(["too_short"]);
  });

  it("accepts the heading variants the prompt and markdown produce", () => {
    const pad = "substantive text ".repeat(20);
    for (const [f, s] of [
      ["## Findings", "## Sources"],
      ["Findings:", "Sources:"],
      ["**Findings**", "**Sources**"],
    ] as const) {
      expect(codes(`${f}\n\n${pad}\n\n${s}\n[1] x`, true)).toEqual([]);
    }
  });

  it("pasted recall_self tool-result formatting is flagged regardless of sourcesRead", () => {
    const pasted = `1. [README · Droplet · score=0.83]\nraw chunk text here`;
    expect(codes(pasted, false)).toEqual(["raw_tool_markers"]);
    expect(codes(`${CLEAN_REPORT}\n\n[doc · x · score=0.42]`, true)).toEqual(["raw_tool_markers"]);
  });
});
