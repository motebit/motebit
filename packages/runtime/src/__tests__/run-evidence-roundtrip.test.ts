import { describe, it, expect } from "vitest";
import { PolicyGate } from "@motebit/policy";
import { verifyEvidenceProvenance } from "@motebit/crypto";
import type { RunEvidenceEntry, RunEvidenceSink } from "@motebit/protocol";

/**
 * The claim this increment makes is that a returning owner can RE-CHECK
 * what the motebit did, not merely read its account of it. That claim is
 * only worth anything if a pointer this producer writes actually passes
 * the law a stranger would run — so this test runs that law, over the
 * real bytes, rather than asserting the shape of the row.
 */
/** The digest a stranger computes: plain sha-256 over the raw bytes. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class MemorySink implements RunEvidenceSink {
  entries: RunEvidenceEntry[] = [];
  record(e: RunEvidenceEntry): void {
    this.entries.push(e);
  }
  listForRun(runId: string): RunEvidenceEntry[] {
    return this.entries.filter((x) => x.run_id === runId);
  }
}

async function produce(bytesText: string, returned: string) {
  const gate = new PolicyGate();
  const sink = new MemorySink();
  gate.setEvidenceSink(sink);
  const bytes = new TextEncoder().encode(bytesText);
  gate.recordEvidence(
    { turnId: "t1", runId: "r1" },
    { callId: "c1" } as unknown as Parameters<typeof gate.recordEvidence>[1],
    "read_url",
    {
      ok: true,
      data: returned,
      source_digest: { algorithm: "sha-256", value: await sha256Hex(bytes) },
    },
  );
  return { sink, bytes };
}

describe("run evidence re-verifies under the real law", () => {
  it("a pointer this producer wrote passes verifyEvidenceProvenance over the raw bytes", async () => {
    const page = "Quarterly revenue fell 4% year over year, the filing said.";
    const { sink, bytes } = await produce(page, page);

    const provenance = sink.entries[0]!.evidence.provenance!;
    const verdict = await verifyEvidenceProvenance(bytes, provenance);
    expect(verdict).toEqual({ present: true });
  });

  it("a long document still re-verifies after the span is bounded", async () => {
    // The producer keeps a prefix so a pointer never becomes a copy of
    // the document. A prefix of a substring is still a substring, so the
    // law must be indifferent to the bound — this proves it is.
    const page = `HEADER\n${"body line\n".repeat(400)}`;
    const { sink, bytes } = await produce(page, page);

    const provenance = sink.entries[0]!.evidence.provenance!;
    expect(provenance.span.length).toBeLessThan(page.length);
    expect(await verifyEvidenceProvenance(bytes, provenance)).toEqual({ present: true });
  });

  it("tampered bytes fail closed on the digest", async () => {
    const { sink } = await produce("the original record", "the original record");
    const provenance = sink.entries[0]!.evidence.provenance!;
    const other = new TextEncoder().encode("a different record");
    expect(await verifyEvidenceProvenance(other, provenance)).toEqual({
      present: false,
      reason: "digest_mismatch",
    });
  });

  it("a span the bytes do not contain fails closed — model proposes, code disposes", async () => {
    // The producer cannot emit this, because it only ever writes the
    // tool's own returned text. This asserts what the LAW does if some
    // future writer tried, which is the property the arc depends on.
    const page = "revenue fell 4%";
    const { sink, bytes } = await produce(page, page);
    const provenance = sink.entries[0]!.evidence.provenance!;
    const fabricated = { ...provenance, span: "revenue ROSE 40%" };
    expect(await verifyEvidenceProvenance(bytes, fabricated)).toEqual({
      present: false,
      reason: "span_absent",
    });
  });

  it("a recipe span fails closed when the re-verifier has no resolver for it", async () => {
    const gate = new PolicyGate();
    const sink = new MemorySink();
    gate.setEvidenceSink(sink);
    const raw = new TextEncoder().encode("<html><body>extracted text</body></html>");
    gate.recordEvidence(
      { turnId: "t1", runId: "r1" },
      { callId: "c1" } as unknown as Parameters<typeof gate.recordEvidence>[1],
      "read_url",
      {
        ok: true,
        data: "extracted text",
        source_digest: { algorithm: "sha-256", value: await sha256Hex(raw) },
        source_projection: "agency.html-text.v1",
      },
    );
    const provenance = sink.entries[0]!.evidence.provenance!;
    // No resolver injected: the honest answer is "I cannot check this",
    // never a quiet pass.
    expect(await verifyEvidenceProvenance(raw, provenance)).toEqual({
      present: false,
      reason: "projection_unresolved",
    });
    // With the recipe the producer named, it resolves and passes.
    const verdict = await verifyEvidenceProvenance(raw, provenance, {
      resolveProjection: () => "extracted text",
    });
    expect(verdict).toEqual({ present: true });
  });
});
