/**
 * RunEvidenceWithheldReason — the closed vocabulary that keeps a refusal
 * distinguishable from an absence.
 *
 * A pointer that was produced and deliberately not kept, and a tool that
 * retrieved nothing at all, are opposite facts. They read as the same
 * empty section until this existed, which made the guard meant to uphold
 * "an absence must never be ambiguous" the place that produced one.
 */
import { describe, it, expect } from "vitest";
import {
  ALL_RUN_EVIDENCE_WITHHELD_REASONS,
  isRunEvidenceWithheldReason,
  type RunEvidenceWithheldReason,
  type RunEvidenceEntry,
} from "../index";

describe("RunEvidenceWithheldReason closed registry", () => {
  it("names both places a credential is found, and nothing else", () => {
    expect([...ALL_RUN_EVIDENCE_WITHHELD_REASONS].sort()).toEqual([
      "credential_in_source",
      "credential_in_span",
    ]);
  });

  it("the array is frozen — append-only by code change", () => {
    expect(Object.isFrozen(ALL_RUN_EVIDENCE_WITHHELD_REASONS)).toBe(true);
  });

  it("accepts members and rejects everything else", () => {
    for (const r of ALL_RUN_EVIDENCE_WITHHELD_REASONS) {
      expect(isRunEvidenceWithheldReason(r)).toBe(true);
    }
    for (const notAReason of [
      "",
      "credential",
      "CREDENTIAL_IN_SPAN",
      "withheld",
      null,
      undefined,
      0,
      {},
      ["credential_in_span"],
    ]) {
      expect(isRunEvidenceWithheldReason(notAReason)).toBe(false);
    }
  });

  it("a withheld entry is a bare reference — the shape a producer uses when it can back nothing", () => {
    // Typed, so a row carrying both a reason AND retrieved content is not
    // something this vocabulary makes easy to build.
    const withheld: RunEvidenceEntry = {
      evidence_id: "e1",
      turn_id: "t1",
      call_id: "c1",
      tool: "read_url",
      recorded_at: 1,
      evidence: { kind: "tool_result", ref: "c1" },
      withheld_reason: "credential_in_source",
    };
    expect(withheld.evidence.provenance).toBeUndefined();
    expect(isRunEvidenceWithheldReason(withheld.withheld_reason)).toBe(true);
  });

  it("a real pointer carries no reason — the two are exclusive in practice", () => {
    const pointer: RunEvidenceEntry = {
      evidence_id: "e2",
      turn_id: "t1",
      call_id: "c2",
      tool: "read_url",
      recorded_at: 1,
      evidence: {
        kind: "tool_result",
        ref: "https://example.gov/filing",
        provenance: {
          digest: { algorithm: "sha-256", value: "a".repeat(64) },
          span: "revenue fell",
        },
      },
    };
    expect(pointer.withheld_reason).toBeUndefined();
    const reason: RunEvidenceWithheldReason | undefined = pointer.withheld_reason;
    expect(reason).toBeUndefined();
  });
});
