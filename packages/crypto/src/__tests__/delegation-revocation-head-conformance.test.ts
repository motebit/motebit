/**
 * Signed-revocation-evidence conformance corpus
 * (spec/standing-delegation-v1.md §5.2–§5.3). Every corpus case's expected
 * result must reproduce against this package's law. Regenerate the corpus
 * with `npx tsx scripts/gen-delegation-revocation-head-corpus.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DelegationRevocation,
  DelegationRevocationHead,
  DelegationRevocationInclusionReceipt,
} from "@motebit/protocol";
import {
  verifyRevocationHead,
  verifyRevocationInclusionReceipt,
  detectRevocationOmission,
  detectRevocationEquivocation,
  type VerifyRevocationHeadExpectations,
} from "../delegation-revocation-head.js";

const CORPUS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../spec/conformance/delegation-revocation-head/corpus.json",
);

interface CorpusCase {
  name: string;
  check: "head" | "receipt" | "omission" | "equivocation";
  input: Record<string, unknown>;
  expected: unknown;
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as {
  schema: string;
  cases: CorpusCase[];
};

describe("delegation-revocation-head conformance corpus", () => {
  it("carries the expected schema and a case for every family", () => {
    expect(corpus.schema).toBe("motebit.delegation-revocation-head-corpus.v1");
    for (const family of ["head", "receipt", "omission", "equivocation"]) {
      expect(corpus.cases.some((c) => c.check === family)).toBe(true);
    }
  });

  for (const c of corpus.cases) {
    it(`case: ${c.name}`, async () => {
      let got: unknown;
      if (c.check === "head") {
        got = await verifyRevocationHead(
          c.input.head as DelegationRevocationHead,
          c.input.expectations as VerifyRevocationHeadExpectations,
        );
      } else if (c.check === "receipt") {
        got = await verifyRevocationInclusionReceipt(
          c.input.receipt as DelegationRevocationInclusionReceipt,
          c.input.expectations as {
            pinnedRelayPublicKey: string;
            revocation: DelegationRevocation;
          },
        );
      } else if (c.check === "omission") {
        got = await detectRevocationOmission(
          c.input.receipt as DelegationRevocationInclusionReceipt,
          c.input.head as DelegationRevocationHead,
        );
      } else {
        got = await detectRevocationEquivocation(
          c.input.headA as DelegationRevocationHead,
          c.input.headB as DelegationRevocationHead,
        );
      }
      expect(got).toEqual(c.expected);
    });
  }
});
