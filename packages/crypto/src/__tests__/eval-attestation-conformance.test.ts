/**
 * EvalAttestation conformance — replays every vector in
 * spec/conformance/eval-attestation/corpus.json and asserts each result
 * deep-equals the corpus expectation. The corpus is the cross-implementation
 * contract (motebit/eval-attestation@1.0): a second implementation runs ITS
 * verifier over the same inputs and must emit identical structured results.
 *
 * Roundtrip/tamper unit coverage lives in eval-attestation.test.ts; this
 * file locks the frozen vectors so a verifier behavior change surfaces as a
 * corpus diff, never silently.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyEvalAttestation, type VerifyEvalAttestationResult } from "../index.js";
import type { EvalAttestation } from "@motebit/protocol";

interface CorpusCase {
  name: string;
  description: string;
  input: { attestation: unknown };
  expected: VerifyEvalAttestationResult;
}

interface Corpus {
  schema: string;
  cases: CorpusCase[];
}

const corpusPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../spec/conformance/eval-attestation/corpus.json",
);
const corpus = JSON.parse(readFileSync(corpusPath, "utf-8")) as Corpus;

describe("eval-attestation conformance corpus", () => {
  it("carries the pinned schema id", () => {
    expect(corpus.schema).toBe("motebit.eval-attestation-corpus.v1");
  });

  it("has at least the ten founding vectors", () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const c of corpus.cases) {
    it(`case: ${c.name}`, async () => {
      const result = await verifyEvalAttestation(c.input.attestation as EvalAttestation);
      expect(result).toEqual(c.expected);
    });
  }
});
