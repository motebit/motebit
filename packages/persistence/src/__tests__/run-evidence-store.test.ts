import { describe, it, expect, beforeEach } from "vitest";
import { createMotebitDatabase, type MotebitDatabase } from "../index.js";
import type { RunEvidenceEntry } from "@motebit/sdk";

function entry(over: Partial<RunEvidenceEntry> & { evidence_id: string }): RunEvidenceEntry {
  return {
    run_id: "run-1",
    turn_id: "turn-1",
    call_id: "call-1",
    tool: "read_url",
    recorded_at: 1_000,
    evidence: {
      kind: "tool_result",
      ref: "https://example.gov/filing",
      provenance: {
        digest: { algorithm: "sha-256", value: "a".repeat(64) },
        span: "revenue fell four percent",
      },
    },
    ...over,
  };
}

describe("SqliteRunEvidenceStore", () => {
  let db: MotebitDatabase;
  beforeEach(() => {
    db = createMotebitDatabase(":memory:");
  });

  it("round-trips a pointer, including what was read", () => {
    db.runEvidenceStore.record(entry({ evidence_id: "e1" }));
    const [got] = db.runEvidenceStore.listForRun("run-1");
    expect(got?.evidence.ref).toBe("https://example.gov/filing");
    expect(got?.evidence.provenance?.span).toBe("revenue fell four percent");
    expect(got?.evidence.provenance?.digest.value).toBe("a".repeat(64));
  });

  it("carries the projection recipe when one is named, and omits it otherwise", () => {
    db.runEvidenceStore.record(entry({ evidence_id: "e1" }));
    db.runEvidenceStore.record(
      entry({
        evidence_id: "e2",
        evidence: {
          kind: "tool_result",
          ref: "https://example.com/page",
          provenance: {
            digest: { algorithm: "sha-256", value: "b".repeat(64) },
            projection: "agency.html-text.v1",
            span: "extracted",
          },
        },
      }),
    );
    const got = db.runEvidenceStore.listForRun("run-1");
    expect(got[0]?.evidence.provenance?.projection).toBeUndefined();
    expect(got[1]?.evidence.provenance?.projection).toBe("agency.html-text.v1");
  });

  it("REFUSES an entry with no provenance rather than dropping it", () => {
    // Silence about evidence that was produced is the failure this
    // record exists to prevent, so the store raises instead.
    expect(() =>
      db.runEvidenceStore.record(
        entry({ evidence_id: "e1", evidence: { kind: "tool_result", ref: "x" } }),
      ),
    ).toThrow(/no provenance/i);
  });

  it("erases every pointer beside one call — including rows from no run at all", () => {
    // A row written outside a goal run has a null run_id and can never
    // be returned by listForRun, so this is the only path that reaches
    // it. It still sits beside an audit row, so it still dies with it.
    db.runEvidenceStore.record(entry({ evidence_id: "e1" }));
    db.runEvidenceStore.record(entry({ evidence_id: "e2", run_id: undefined }));
    db.runEvidenceStore.eraseForCall("call-1");
    expect(db.runEvidenceStore.listForRun("run-1")).toEqual([]);
    expect(db.runEvidenceStore.enumerateStale(Date.now())).toEqual([]);
  });

  it("reports stale calls by the horizon, and not the fresh ones", () => {
    db.runEvidenceStore.record(entry({ evidence_id: "old", call_id: "c-old", recorded_at: 1_000 }));
    db.runEvidenceStore.record(entry({ evidence_id: "new", call_id: "c-new", recorded_at: 9_000 }));
    expect(db.runEvidenceStore.enumerateStale(5_000)).toEqual(["c-old"]);
  });
});
