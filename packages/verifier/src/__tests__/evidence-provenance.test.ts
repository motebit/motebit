/**
 * Evidence provenance is re-checkable through `@motebit/verifier` — the package
 * an external consumer (e.g. agency.computer) already pins. A `VerificationVerdict`
 * carries `evidenceBasis: EvidenceRef[]`, each optionally with `provenance`; the
 * law that re-checks that provenance (`verifyEvidenceProvenance`) must be reachable
 * from the SAME surface, so a consumer never reaches past the aggregator into
 * `@motebit/crypto` (the agency-proof-integration contract: consume the verifier,
 * never fork it). See docs/doctrine/evidence-provenance.md.
 *
 * Producing the digest stays on `@motebit/crypto` (`hash` — a content digest the
 * producer computes); re-verification flows through `@motebit/verifier` (the
 * import under test).
 */
import { describe, it, expect } from "vitest";
import { hash } from "@motebit/crypto";

// The imports under test: the re-check law + its types, from the verifier surface.
import { verifyEvidenceProvenance } from "../index.js";
import type { EvidenceProvenance, EvidenceProvenanceResult, DigestRef } from "../index.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

async function provFor(
  bytes: Uint8Array,
  span: string,
  extra?: Partial<EvidenceProvenance>,
): Promise<EvidenceProvenance> {
  const digest: DigestRef = { algorithm: "sha-256", value: await hash(bytes) };
  return { digest, span, ...extra };
}

describe("@motebit/verifier — evidence-provenance re-check law", () => {
  const raw = enc("…Total revenue for the quarter was Revenue $ 81,615 million…");
  const span = "Revenue $ 81,615";

  it("re-checks a raw-byte span present + matching digest → present (no @motebit/crypto dep needed)", async () => {
    const result: EvidenceProvenanceResult = await verifyEvidenceProvenance(
      raw,
      await provFor(raw, span),
    );
    expect(result).toEqual({ present: true });
  });

  it("fails closed on a digest mismatch (digest_mismatch) even when the span is present", async () => {
    const prov = {
      ...(await provFor(raw, span)),
      digest: { algorithm: "sha-256" as const, value: "00".repeat(32) },
    };
    expect(await verifyEvidenceProvenance(raw, prov)).toEqual({
      present: false,
      reason: "digest_mismatch",
    });
  });

  it("rejects a fabricated span (span_absent) — model proposes, the law disposes", async () => {
    const prov = await provFor(raw, "Revenue $ 99,999"); // never appears in raw
    expect(await verifyEvidenceProvenance(raw, prov)).toEqual({
      present: false,
      reason: "span_absent",
    });
  });

  it("fails closed when a projection is named but no resolver is injected (projection_unresolved)", async () => {
    const prov = await provFor(raw, span, { projection: "agency.html-text.v1" });
    expect(await verifyEvidenceProvenance(raw, prov)).toEqual({
      present: false,
      reason: "projection_unresolved",
    });
  });

  it("applies a consumer-injected projection recipe, then confirms the span → present", async () => {
    const htmlish = enc("<td>Revenue</td><td>$&nbsp;81,615</td>"); // raw bytes, digest over these
    const prov = await provFor(htmlish, span, { projection: "agency.html-text.v1" });
    const result = await verifyEvidenceProvenance(htmlish, prov, {
      resolveProjection: () => "Revenue $ 81,615",
    });
    expect(result).toEqual({ present: true });
  });
});
