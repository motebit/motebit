/**
 * Report-shape contract (v1) — the deterministic half of #504.
 *
 * Witnessed 2026-07-30 on a live paid hire: the Researcher's report body
 * passed #479's non-empty guard but was "mid-work notes plus source
 * snippets — not a finished synthesis" (the delegator's model said so to
 * the founder, honestly). The purchased artifact is a REPORT; the
 * SYSTEM_PROMPT already contracts its format (Question / Findings /
 * Sources). This module checks that contract mechanically so both the
 * producer (one re-synthesis retry before delivering) and the scheduled
 * conformance probe (red-flag a notes-dump) grade against the SAME rule —
 * one canonical function, no drift.
 *
 * Deliberately a SHAPE check, never an LLM judge: deterministic, cheap,
 * offline. Quality beyond shape is the archetype's earned record
 * (agent-archetypes doctrine — curation, not registry), so this is not a
 * relay-side admission gate and must never become one.
 */

export interface ReportShapeIssue {
  /** Closed issue code — stable across producer log lines and probe output. */
  code: "empty" | "missing_findings" | "missing_sources" | "too_short" | "raw_tool_markers";
  detail: string;
}

/**
 * Findings floor: below this many characters a "report" cannot be carrying
 * a synthesis (a terse-but-legitimate answer still clears it once the
 * required sections are present). Kept deliberately modest — the floor
 * catches notes-dumps and truncations, it does not enforce depth.
 */
export const REPORT_MIN_CHARS = 200;

/** Section heading matcher: `**Findings**`, `## Findings`, `Findings:` — the
 * format the SYSTEM_PROMPT asks for plus the obvious markdown variants. */
function hasSection(report: string, name: string): boolean {
  const re = new RegExp(`(^|\\n)\\s{0,3}(#{1,4}\\s*)?\\**\\s*${name}\\b`, "i");
  return re.test(report);
}

/**
 * Check a report body against the v1 shape contract. Returns an empty
 * array when the report is a structurally plausible deliverable.
 *
 * `sourcesRead` — the scoping rule of the contract: when the turn READ
 * sources (any recall/fetch produced source material), the purchased
 * artifact must be a structured report (Findings + Sources + floor). When
 * nothing was read, a direct answer is a legitimate deliverable and only
 * owes non-emptiness — requiring section scaffolding around "2+2 = 4"
 * would manufacture filler, not quality. Both the producer's retry and
 * the conformance probe apply this same rule.
 */
export function reportShapeIssues(
  report: string,
  opts: { sourcesRead: boolean },
): ReportShapeIssue[] {
  const issues: ReportShapeIssue[] = [];
  const trimmed = report.trim();

  if (trimmed === "") {
    return [{ code: "empty", detail: "report body is empty" }];
  }

  if (opts.sourcesRead) {
    if (!hasSection(trimmed, "Findings")) {
      issues.push({
        code: "missing_findings",
        detail: "no Findings section — the substantive answer has no home",
      });
    }

    if (!hasSection(trimmed, "Sources")) {
      issues.push({
        code: "missing_sources",
        detail: "sources were read but the report lists none",
      });
    }

    if (trimmed.length < REPORT_MIN_CHARS) {
      issues.push({
        code: "too_short",
        detail: `${trimmed.length} chars < ${REPORT_MIN_CHARS} floor`,
      });
    }
  }

  // The one tool-output marker this service mints itself: the recall_self
  // tool_result formats hits as `[source · title · score=0.42]`. That string
  // appearing in the REPORT means raw tool output was pasted instead of
  // synthesized. Web-page text is arbitrary and deliberately not
  // fingerprinted. Checked regardless of `sourcesRead` — a pasted recall
  // block can appear even when the report cites nothing.
  if (/·\s*score=\d/.test(trimmed)) {
    issues.push({
      code: "raw_tool_markers",
      detail: "recall_self tool-result formatting pasted verbatim into the report",
    });
  }

  return issues;
}
