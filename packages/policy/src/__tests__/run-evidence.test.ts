import { describe, it, expect } from "vitest";
import type { RunEvidenceEntry, RunEvidenceSink, ToolResult } from "@motebit/protocol";
import { PolicyGate } from "../policy-gate.js";

class MemorySink implements RunEvidenceSink {
  entries: RunEvidenceEntry[] = [];
  record(entry: RunEvidenceEntry): void {
    this.entries.push(entry);
  }
  listForRun(runId: string): RunEvidenceEntry[] {
    return this.entries.filter((e) => e.run_id === runId);
  }
}

function setup() {
  const gate = new PolicyGate();
  const sink = new MemorySink();
  gate.setEvidenceSink(sink);
  const ctx = { turnId: "turn-1", runId: "run-1" };
  const decision = { callId: "call-1" } as unknown as Parameters<typeof gate.recordEvidence>[1];
  return { gate, sink, ctx, decision };
}

const DIGEST = { algorithm: "sha-256" as const, value: "a".repeat(64) };

describe("PolicyGate.recordEvidence — the sibling artifact recordResult names", () => {
  it("records a pointer whose span is the tool's OWN returned text", () => {
    const { gate, sink, ctx, decision } = setup();
    const result: ToolResult = {
      ok: true,
      data: "the filing says revenue fell",
      source_digest: DIGEST,
    };
    gate.recordEvidence(ctx, decision, "read_url", result);

    expect(sink.entries).toHaveLength(1);
    const p = sink.entries[0]!.evidence.provenance!;
    expect(p.digest).toEqual(DIGEST);
    expect(p.span).toBe("the filing says revenue fell");
    expect(sink.entries[0]!.run_id).toBe("run-1");
    expect(sink.entries[0]!.call_id).toBe("call-1");
  });

  it("records NOTHING when the tool did not content-address what it read", () => {
    // Back-compat by absence, and the honesty rule underneath it: a
    // pointer the producer cannot back is worse than no pointer. A tool
    // that retrieved nothing leaves nothing to re-check.
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "write_file", { ok: true, data: "wrote 3 lines" });
    expect(sink.entries).toEqual([]);
  });

  it("records nothing for a failed call", () => {
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: false,
      data: "partial",
      source_digest: DIGEST,
    });
    expect(sink.entries).toEqual([]);
  });

  it("carries the projection recipe when the data is a transform, not the raw bytes", () => {
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: "extracted text",
      source_digest: DIGEST,
      source_projection: "agency.html-text.v1",
    });
    const p = sink.entries[0]!.evidence.provenance!;
    expect(p.projection).toBe("agency.html-text.v1");
    // Absent projectionClass means spec-reproducible — the strong rung.
    // The weak one is opt-in and must never be claimed by omission.
    expect(p.projectionClass).toBeUndefined();
  });

  it("bounds the span, and a bounded prefix is still a substring", () => {
    const { gate, sink, ctx, decision } = setup();
    const long = "x".repeat(5000);
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: long,
      source_digest: DIGEST,
    });
    const p = sink.entries[0]!.evidence.provenance!;
    expect(p.span.length).toBeLessThan(long.length);
    // The law is substring presence, so the bound cannot break it.
    expect(long.includes(p.span)).toBe(true);
    expect(p.locator).toEqual({ start: 0, end: p.span.length });
  });

  it("records nothing when no sink is wired — silence, never a fabricated row", () => {
    const gate = new PolicyGate();
    const ctx = { turnId: "t", runId: "r" };
    const decision = { callId: "c" } as unknown as Parameters<typeof gate.recordEvidence>[1];
    expect(() =>
      gate.recordEvidence(ctx, decision, "read_url", {
        ok: true,
        data: "x",
        source_digest: DIGEST,
      }),
    ).not.toThrow();
  });
});
