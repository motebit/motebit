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

  it("keeps recording through ordinary content that looks secret-ish", () => {
    // The guard used the FULL redaction set, which deliberately includes
    // low-precision patterns — a 40-char token, a bare 9-digit run. A
    // page whose first 512 characters held a commit hash recorded no
    // pointer at all, and the person was told "none recorded". A guard
    // that suppresses honest evidence at that rate empties the record it
    // is meant to protect.
    const { gate, sink, ctx, decision } = setup();
    const realistic =
      "Fixed in commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678. Filing 123456789 was accepted.";
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: realistic,
      source_digest: DIGEST,
      source_ref: "https://example.com/changelog",
    });
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]!.evidence.provenance!.span).toBe(realistic);
  });

  it("does not split a character when it bounds the span", () => {
    // `slice` counts UTF-16 units, so a cut through an astral character
    // leaves a lone surrogate. SQLite stores TEXT as UTF-8 and turns
    // that into U+FFFD, so the span read back is not the span written —
    // and the pointer fails its own law.
    const { gate, sink, ctx, decision } = setup();
    const data = "a".repeat(511) + "😀" + "tail";
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data,
      source_digest: DIGEST,
    });
    const span = sink.entries[0]!.evidence.provenance!.span;
    expect(span).toBe("a".repeat(511));
    // No unpaired surrogate survived the cut, and it is still a
    // substring — which is the whole law.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(span)).toBe(false);
    expect(data.includes(span)).toBe(true);
  });

  it("records NOTHING when the retrieved text carries credential-class content", () => {
    // Redacting the span is not an option: the law is that the span is
    // an exact substring of the bytes, so a redacted span is a pointer
    // asserting something that fails re-verification. A pointer that is
    // both safe and true is unavailable here, so neither is recorded.
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: "authorization: Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\naws_access_key_id = AKIAIOSFODNN7EXAMPLE",
      source_digest: DIGEST,
      source_ref: "https://example.com/secret",
    });
    expect(sink.entries).toEqual([]);
  });

  it("does NOT catch every key format — the residual, stated rather than implied", () => {
    // The credential-class set keys on a shared pattern table whose
    // API_KEY rule allows a single separator, so `sk-proj-…` and `ghp_…`
    // slip past it. Widening that rule changes what is stripped from
    // every outbound message to a cloud provider, so it belongs to that
    // table's own change. This test exists so the gap is a recorded
    // fact rather than something a later reader assumes is covered.
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: "OPENAI_API_KEY=sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      source_digest: DIGEST,
    });
    expect(sink.entries).toHaveLength(1);
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
