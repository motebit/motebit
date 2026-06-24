/**
 * Cross-implementation conformance for the evidence-provenance byte-determinism
 * guardrail — the make-or-break of the whole arc (docs/doctrine/evidence-provenance.md
 * guardrail 3): a projection recipe is only a real PUBLIC protocol artifact if an
 * independent implementer, working from its SPEC alone, reproduces its fixture
 * byte-for-byte. If two correct implementations can diverge, a span located by one
 * is not confirmable by another and verifiable-locality dies.
 *
 * The recipe under test is `agency.html-text.v1`, published by agency.computer as a
 * frozen, citable spec (the consumer-forces-shape half of the co-design):
 *
 *   repo:    github.com/agency-computer/agency
 *   commit:  096c5de39a09f79513ca38719126dd335c02032d   (pinned — v1 is immutable)
 *   spec:    docs/specs/agency-html-text-v1.md           (the AUTHORITY)
 *   fixture: apps/app/lib/research/fixtures/agency-html-text-v1.json
 *            → vendored verbatim at ./fixtures/agency-html-text-v1.json
 *
 * BOUNDARY (load-bearing): motebit owns the SHAPE + the re-check LAW, NEVER the
 * projection recipe (document-format authority stays with the consumer). The
 * implementation below is NOT a motebit capability and is NEVER imported by the
 * shipped `verifyEvidenceProvenance` (which is domain-blind — it injects the
 * resolver). It exists ONLY here, as motebit acting as the INDEPENDENT second
 * implementer the guardrail requires: written from §2 of the spec ALONE (their
 * reference `projection.ts` was deliberately NOT read), to prove the recipe is
 * byte-deterministic. A divergence would be a spec/impl defect to report upstream,
 * never a tolerance to widen.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { verifyEvidenceProvenance, hash } from "../index.js";

// ── The independent implementation — from agency-html-text-v1.md §2 ONLY ──────
// Input: the raw document bytes, decoded as UTF-8. Output: a string. Five ordered
// total steps.
function projectAgencyHtmlTextV1(bytes: Uint8Array): string {
  let s = new TextDecoder("utf-8").decode(bytes);

  // 1. Remove <script>/<style> blocks (tag AND content), case-insensitive,
  //    non-greedy to the first matching close tag → one U+0020 each.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ");

  // 2. Strip remaining tags — every "<" through the next ">" → one U+0020.
  s = s.replace(/<[^>]*>/g, " ");

  // 3. Decode entities in a SINGLE left-to-right pass over the fixed §2.1 table.
  //    Each match replaced once; the replacement is NOT re-scanned; any entity not
  //    in the table is left verbatim. (The single-pass rule is the determinism crux.)
  const TABLE: ReadonlyArray<readonly [string, string]> = [
    ["&nbsp;", " "],
    ["&#160;", " "],
    ["&#xa0;", " "],
    ["&#xA0;", " "],
    ["&amp;", "&"],
    ["&#38;", "&"],
    ["&lt;", "<"],
    ["&#60;", "<"],
    ["&gt;", ">"],
    ["&#62;", ">"],
    ["&quot;", '"'],
    ["&#34;", '"'],
    ["&apos;", "'"],
    ["&#39;", "'"],
  ];
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "&") {
      let matched: readonly [string, string] | null = null;
      for (const entry of TABLE) {
        if (s.startsWith(entry[0], i)) {
          matched = entry;
          break;
        }
      }
      if (matched) {
        out += matched[1];
        i += matched[0].length;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  s = out;

  // 4. Collapse ASCII whitespace runs [ \t\n\r\f\v] → one U+0020. Non-ASCII
  //    whitespace (e.g. a literal U+00A0 not from an entity) passes through.
  s = s.replace(/[ \t\n\r\f\v]+/g, " ");

  // 5. Trim leading and trailing U+0020.
  s = s.replace(/^ +/, "").replace(/ +$/, "");

  return s;
}

interface Fixture {
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly html: string;
    readonly text: string;
  }>;
}
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/agency-html-text-v1.json", import.meta.url), "utf8"),
) as Fixture;

const enc = new TextEncoder();

describe("evidence-provenance conformance — agency.html-text.v1 (independent impl vs published fixture)", () => {
  // The cross-implementation projection-divergence procedure (spec §4): a second
  // implementation, built only from §2, must reproduce every vector byte-for-byte —
  // no normalization, no trailing-space tolerance, no Unicode folding.
  for (const c of fixture.cases) {
    it(`byte-identical: ${c.name}`, () => {
      expect(projectAgencyHtmlTextV1(enc.encode(c.html))).toBe(c.text);
    });
  }

  it("the determinism canary reproduces exactly (single pass, no re-scan): a&amp;lt;b → a&lt;b", () => {
    // The case the whole guardrail turns on — a sequential per-entity decoder would
    // produce "a<b". The independent impl must produce "a&lt;b".
    expect(projectAgencyHtmlTextV1(enc.encode("a&amp;lt;b"))).toBe("a&lt;b");
  });

  it("round-trips through the real verifyEvidenceProvenance as the injected resolver → present", async () => {
    // The recipe wired through motebit's domain-blind law exactly as a re-verifier
    // would use it: digest over the RAW html bytes, projection = the recipe id, a
    // span that is present in the projected text, resolver = the independent impl.
    const filing = fixture.cases.find((c) => c.text.length > 0)!;
    const bytes = enc.encode(filing.html);
    const span = filing.text.slice(0, Math.min(16, filing.text.length));
    const provenance = {
      digest: { algorithm: "sha-256" as const, value: await hash(bytes) },
      projection: "agency.html-text.v1",
      span,
    };
    const result = await verifyEvidenceProvenance(bytes, provenance, {
      resolveProjection: (_recipeId, b) => projectAgencyHtmlTextV1(b),
    });
    expect(result).toEqual({ present: true });
  });
});
