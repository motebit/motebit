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
    // Absent because the TOOL declared nothing, not because this
    // producer chose a default. Absence means spec-reproducible, the
    // strong rung, so a default here would claim it on behalf of a
    // recipe that may meet only the weaker one.
    expect(p.projectionClass).toBeUndefined();
  });

  it("carries the weaker assurance rung when the tool declares it", () => {
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "read_pdf", {
      ok: true,
      data: "extracted text",
      source_digest: DIGEST,
      source_projection: "some.pdf-text.v1",
      source_projection_class: "tool-pinned",
    });
    expect(sink.entries[0]!.evidence.provenance!.projectionClass).toBe("tool-pinned");
  });

  it("names what was read, so the pointer can actually be re-fetched", () => {
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: "body text",
      source_digest: DIGEST,
      source_ref: "https://example.gov/filing",
    });
    expect(sink.entries[0]!.evidence.ref).toBe("https://example.gov/filing");
  });

  it("records NOTHING when the retrieved text carries credential-class content", () => {
    // Redacting the span is not an option: the law is that the span is
    // an exact substring of the bytes, so a redacted span is a pointer
    // asserting something that fails re-verification. A pointer that is
    // both safe and true is unavailable here, so neither is recorded.
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: "token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      source_digest: DIGEST,
      source_ref: "https://example.com/secret",
    });
    expect(sink.entries).toEqual([]);
  });

  it("survives a policy-config change — the sink travels with the swap", () => {
    // It did not, and the loss was silent: a user changing any policy
    // setting produced a fresh gate with no sink, after which every run
    // reported "none recorded" — indistinguishable from an honest
    // absence, which is the one thing this record must never be.
    const sink = new MemorySink();
    const gate = new PolicyGate({}, undefined, sink);
    const ctx = { turnId: "t", runId: "r" };
    const decision = { callId: "c" } as unknown as Parameters<typeof gate.recordEvidence>[1];
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: "body",
      source_digest: DIGEST,
    });
    expect(sink.entries).toHaveLength(1);
  });

  it("bounds the span, and a bounded prefix is still a substring", () => {
    const { gate, sink, ctx, decision } = setup();
    // Realistic document text. A long run of one character reads as an
    // encoded secret to the redaction engine and is withheld — correctly,
    // but it makes a poor stand-in for a document.
    const long = "Quarterly revenue fell four percent year over year. ".repeat(120);
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
