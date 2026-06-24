import { describe, it, expect } from "vitest";
import { verifyEvidenceProvenance, hash } from "../index.js";
import type { EvidenceProvenance } from "../index.js";

/**
 * The evidence-provenance law (agency.computer co-design): a verdict's evidence
 * axis becomes re-verifiable down to the primary record. The law is "span is an
 * exact substring of projection(bytes), where bytes hash to digest" — re-checkable
 * PRESENCE, never truth, no oracle. This is the hostile corpus that locks it (the
 * same role the verdict conformance corpus played): the cases either side must
 * agree on. The projection-divergence case here uses an in-test recipe stub; the
 * real cross-impl divergence fixture rides agency's published `agency.html-text.vN`.
 */
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

async function provFor(
  bytes: Uint8Array,
  span: string,
  extra?: Partial<EvidenceProvenance>,
): Promise<EvidenceProvenance> {
  return { digest: { algorithm: "sha-256", value: await hash(bytes) }, span, ...extra };
}

describe("verifyEvidenceProvenance — law + hostile corpus", () => {
  const raw = enc("…Total revenue for the quarter was Revenue $ 81,615 million…");
  const span = "Revenue $ 81,615";

  it("raw-byte span present + digest matches → present (re-verifiable by construction)", async () => {
    expect(await verifyEvidenceProvenance(raw, await provFor(raw, span))).toEqual({
      present: true,
    });
  });

  it("digest mismatch → not present (digest_mismatch), even if the span is there", async () => {
    const prov = {
      ...(await provFor(raw, span)),
      digest: { algorithm: "sha-256" as const, value: "00".repeat(32) },
    };
    expect(await verifyEvidenceProvenance(raw, prov)).toEqual({
      present: false,
      reason: "digest_mismatch",
    });
  });

  it("span absent from the bytes → not present (span_absent) — a fabricated figure cannot be placed", async () => {
    const prov = await provFor(raw, "Revenue $ 99,999"); // never appears in raw
    expect(await verifyEvidenceProvenance(raw, prov)).toEqual({
      present: false,
      reason: "span_absent",
    });
  });

  it("projection present + NO resolver → FAIL CLOSED (projection_unresolved) — domain-blind", async () => {
    const prov = await provFor(raw, span, { projection: "agency.html-text.v1" });
    expect(await verifyEvidenceProvenance(raw, prov)).toEqual({
      present: false,
      reason: "projection_unresolved",
    });
  });

  it("projection present + resolver yields text containing the span → present (the HTML→text case)", async () => {
    // Raw bytes are tag-split garbage that does NOT contain the clean span; the
    // injected recipe projects to clean text that does. Digest is over the RAW bytes.
    const htmlish = enc("<td>Revenue</td><td>$&nbsp;81,615</td>");
    const prov = await provFor(htmlish, span, { projection: "agency.html-text.v1" });
    const resolve = () => "Revenue $ 81,615"; // the recipe's deterministic output
    expect(await verifyEvidenceProvenance(htmlish, prov, { resolveProjection: resolve })).toEqual({
      present: true,
    });
  });

  it("projection-divergence: a resolver that drops the span → span_absent (the canary)", async () => {
    const htmlish = enc("<td>Revenue</td><td>$&nbsp;81,615</td>");
    const prov = await provFor(htmlish, span, { projection: "agency.html-text.v1" });
    const wrongRecipe = () => "Revenue 81615"; // diverges → span no longer an exact substring
    expect(
      await verifyEvidenceProvenance(htmlish, prov, { resolveProjection: wrongRecipe }),
    ).toEqual({
      present: false,
      reason: "span_absent",
    });
  });

  it("a resolver that THROWS propagates — a resolver fault is a caller bug, never a false present:false", async () => {
    // Contract (agency.computer adoption): the injected resolver is assumed total
    // for recipes it accepts; a throw is NOT mapped to a reason (that would let a
    // broken recipe masquerade as "evidence absent" and hide the bug). It propagates.
    const prov = await provFor(raw, span, { projection: "agency.html-text.v1" });
    const faulty = () => {
      throw new Error("recipe blew up");
    };
    await expect(
      verifyEvidenceProvenance(raw, prov, { resolveProjection: faulty }),
    ).rejects.toThrow("recipe blew up");
  });

  it("the correct 'cannot resolve this recipe' signal is to OMIT the resolver → projection_unresolved (not a throwing resolver)", async () => {
    // The paired half of the contract above: a consumer whose resolver doesn't own
    // a recipe lets it fall through to the no-resolver path, which fails closed —
    // never injects a throwing resolver as a not-supported signal.
    const prov = await provFor(raw, span, { projection: "some.other-recipe.v9" });
    expect(await verifyEvidenceProvenance(raw, prov)).toEqual({
      present: false,
      reason: "projection_unresolved",
    });
  });

  it("binding is carried but NOT verified by the law (issuer authority is app-layer)", async () => {
    const bound = await provFor(raw, span, { binding: "did:example:not-checked-here" });
    // Same present result regardless of binding value — the law is domain-blind on it.
    expect(await verifyEvidenceProvenance(raw, bound)).toEqual({ present: true });
  });

  it("locator is advisory — a stale/absent locator does not change the substring verdict", async () => {
    const prov = await provFor(raw, span, { locator: { start: 0, end: 3 } }); // wrong span coords
    expect(await verifyEvidenceProvenance(raw, prov)).toEqual({ present: true });
  });
});
