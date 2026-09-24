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

  it("a withholding is RECORDED, and carries nothing that was retrieved", () => {
    // The guard used to make the evidence vanish, so a refusal and a
    // tool that retrieved nothing both read as "none recorded" — an
    // ambiguous absence, produced by the guard whose justification is
    // that absences must not be ambiguous.
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
      source_digest: DIGEST,
      source_ref: "https://host/data",
    });
    expect(sink.entries).toHaveLength(1);
    const row = sink.entries[0]!;
    expect(row.withheld_reason).toBe("credential_in_span");
    // Nothing retrieved survives: no digest, no span, and the reference
    // is the call rather than the source, because the source is one of
    // the places a credential hides.
    expect(row.evidence.provenance).toBeUndefined();
    expect(row.evidence.ref).toBe("call-1");
    expect(JSON.stringify(row)).not.toContain("AKIA");
    expect(JSON.stringify(row)).not.toContain("host/data");
  });

  it("judges the WHOLE result, not the part it would have stored", () => {
    // The guard ran on the already-bounded span, so a secret whose
    // pattern needs bytes past the cut could never match. A PEM block
    // needs its BEGIN and END delimiters about 1.7KB apart: the span is
    // what gets stored, but the data is what has to be judged, or ~470
    // characters of a private key are kept verbatim and printed on
    // return by the guard that exists to prevent exactly that.
    const { gate, sink, ctx, decision } = setup();
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIEow".repeat(200) +
      "\n-----END RSA PRIVATE KEY-----";
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: pem,
      source_digest: DIGEST,
      source_ref: "https://host/key",
    });
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]!.withheld_reason).toBe("credential_in_span");
    expect(JSON.stringify(sink.entries[0])).not.toContain("MIIEow");
  });

  it("names WHICH of the two hiding places it found", () => {
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: "an ordinary page of text",
      source_digest: DIGEST,
      source_ref: "https://host/export?api_key=sk-live-AAAAAAAAAAAAAAAA",
    });
    expect(sink.entries[0]!.withheld_reason).toBe("credential_in_source");
    expect(JSON.stringify(sink.entries[0])).not.toContain("sk-live");
  });

  it("a tool that retrieved nothing leaves no row at all — the other absence", () => {
    // Still distinct, and deliberately so: there is nothing to refuse,
    // so there is nothing to say.
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "write_file", { ok: true, data: "wrote 3 lines" });
    expect(sink.entries).toEqual([]);
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
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]!.withheld_reason).toBe("credential_in_span");
    expect(sink.entries[0]!.evidence.provenance).toBeUndefined();
  });

  it("guards the SOURCE too, not only the span", () => {
    // A URL carries credentials in query parameters, so a fetch of
    // `…?api_key=…` wrote the key into the pointer's ref, past a guard
    // that only ever looked at the span.
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: "an ordinary page of text with nothing sensitive in it",
      source_digest: DIGEST,
      source_ref: "https://host/export?api_key=sk-live-AAAAAAAAAAAAAAAAAAAA",
    });
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]!.withheld_reason).toBe("credential_in_source");
    expect(sink.entries[0]!.evidence.provenance).toBeUndefined();
  });

  it("a credential hides in more places than a query parameter", () => {
    // Three narrowings, and each gap was somewhere I had not looked
    // rather than a rule that was wrong: the parameter name can carry a
    // vendor prefix (`X-Amz-Signature`), the secret can sit in the path
    // rather than the query, and it can ride in userinfo.
    const { gate, sink, ctx, decision } = setup();
    for (const ref of [
      "https://b.s3.amazonaws.com/x?X-Amz-Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe",
      "https://storage.googleapis.com/b/o?X-Goog-Signature=abcdef0123456789abcdef0123",
      "https://a.blob.core.windows.net/c/b?sv=2021&sig=AAAAAAAAAAAAAAAAAAAA",
      "https://api.example.com/v1/keys/sk_live_AAAAAAAAAAAAAAAAAAAA/data",
      "https://alice:hunter2hunter2@host.example.com/data",
    ]) {
      gate.recordEvidence(ctx, decision, "read_url", {
        ok: true,
        data: "an ordinary page",
        source_digest: DIGEST,
        source_ref: ref,
      });
    }
    // Each one is a RECORDED refusal, not a silent gap.
    expect(sink.entries).toHaveLength(5);
    expect(sink.entries.every((e) => e.withheld_reason === "credential_in_source")).toBe(true);
    expect(JSON.stringify(sink.entries)).not.toContain("X-Amz-Signature");
  });

  it("an ordinary query string is not mistaken for a credential", () => {
    // The rule keys on the parameter NAME and needs a value of real
    // length, so a search term or a page number does not cost anyone
    // their evidence.
    const { gate, sink, ctx, decision } = setup();
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: "results page",
      source_digest: DIGEST,
      source_ref: "https://host/search?q=quarterly+revenue&page=2&session=1",
    });
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: "page two",
      source_digest: DIGEST,
      source_ref: "https://api.example.com/items?cursor=abc123&limit=50",
    });
    gate.recordEvidence(ctx, decision, "read_url", {
      ok: true,
      data: "a filing",
      source_digest: DIGEST,
      source_ref: "https://example.gov/filings/q3-2026",
    });
    expect(sink.entries).toHaveLength(3);
  });

  it("catches vendor key formats the older pattern let through", () => {
    // This once recorded the gap instead: the shared API_KEY rule allows
    // a single separator, so `sk-proj-…` and `ghp_…` walked past it. The
    // replacement keys on the mandatory punctuation separator those
    // formats have and ordinary words do not, which is what makes it
    // safe to run over a stranger's page as well as a user's message.
    const { gate, sink, ctx, decision } = setup();
    for (const key of [
      "OPENAI_API_KEY=sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "xoxb-123456789012-abcdefghijkl",
    ]) {
      gate.recordEvidence(ctx, decision, "read_url", {
        ok: true,
        data: key,
        source_digest: DIGEST,
      });
    }
    expect(sink.entries).toHaveLength(3);
    expect(sink.entries.every((e) => e.withheld_reason === "credential_in_span")).toBe(true);
  });

  it("leaves ordinary page text alone — the guard's cost is measured, not assumed", () => {
    // Every one of these tripped an earlier version of this guard, and
    // the guard's response is to record NOTHING, so each false positive
    // costs an owner the evidence for that fetch and tells them nothing
    // was retrieved.
    const { gate, sink, ctx, decision } = setup();
    const benign = [
      "Reuters, the quick brown fox jumps over some lazy dogs that ran away.",
      "See https://docs.example.com/keyboardshortcutsandmoreinfo for details.",
      "Bearer bonds were phased out in the 1980s, the report notes.",
      "Set DATABASE_URL to postgres://localhost/mydb before running.",
      "Password: required. Username: optional.",
      "Fixed in commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678.",
    ];
    for (const text of benign) {
      gate.recordEvidence(ctx, decision, "read_url", {
        ok: true,
        data: text,
        source_digest: DIGEST,
      });
    }
    expect(sink.entries).toHaveLength(benign.length);
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
    // No locator: it is advisory, and a tool-agnostic gate cannot know
    // where in the projected text a tool's excerpt begins.
    expect(p.locator).toBeUndefined();
  });

  it("reports a store refusal before letting it through", () => {
    // The store raises rather than dropping rows, so the failure has to
    // land somewhere a person can see. Reported AND rethrown: the tool
    // path absorbs it so a pointer cannot take down the work it
    // describes, and this is what stops the absorbing being silence.
    const warned: string[] = [];
    const gate = new PolicyGate(
      {},
      undefined,
      {
        record: () => {
          throw new Error("database is locked");
        },
        listForRun: () => [],
      },
      { warn: (m: string) => warned.push(m) },
    );
    const ctx = { turnId: "t", runId: "r" };
    const decision = { callId: "c" } as unknown as Parameters<typeof gate.recordEvidence>[1];
    expect(() =>
      gate.recordEvidence(ctx, decision, "read_url", {
        ok: true,
        data: "body",
        source_digest: DIGEST,
      }),
    ).toThrow(/database is locked/);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("read_url");
  });

  it("a logger can be swapped in after construction", () => {
    const warned: string[] = [];
    const gate = new PolicyGate({}, undefined, {
      record: () => {
        throw new Error("disk full");
      },
      listForRun: () => [],
    });
    gate.setEvidenceLogger({ warn: (m: string) => warned.push(m) });
    const decision = { callId: "c" } as unknown as Parameters<typeof gate.recordEvidence>[1];
    expect(() =>
      gate.recordEvidence({ turnId: "t" }, decision, "read_url", {
        ok: true,
        data: "body",
        source_digest: DIGEST,
      }),
    ).toThrow(/disk full/);
    expect(warned).toHaveLength(1);
  });

  it("a decision that never went through the gate mints no pointer", () => {
    // No callId means no audit row to sit beside, and a pointer that
    // correlates with nothing is worse than an honest gap.
    const { gate, sink, ctx } = setup();
    gate.recordEvidence(
      ctx,
      {} as unknown as Parameters<typeof gate.recordEvidence>[1],
      "read_url",
      {
        ok: true,
        data: "body",
        source_digest: DIGEST,
      },
    );
    expect(sink.entries).toEqual([]);
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
