/**
 * Signed-revocation-evidence conformance corpus
 * (spec/standing-delegation-v1.md §5.2–§5.3). Every corpus case's expected
 * result must reproduce against this package's law. Regenerate the corpus
 * with `npx tsx scripts/gen-delegation-revocation-set-attestation-corpus.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DelegationRevocation,
  DelegationRevocationSetAttestation,
  DelegationRevocationInclusionReceipt,
} from "@motebit/protocol";
import {
  verifyRevocationSetAttestation,
  verifyRevocationInclusionReceipt,
  verifyRevocationOmissionProof,
  verifyRevocationEquivocationProof,
  type VerifyRevocationSetAttestationExpectations,
} from "../delegation-revocation-set-attestation.js";

const CORPUS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../spec/conformance/delegation-revocation-set-attestation/corpus.json",
);

interface CorpusCase {
  name: string;
  check: "attestation" | "receipt" | "omission" | "equivocation";
  input: Record<string, unknown>;
  expected: unknown;
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as {
  schema: string;
  cases: CorpusCase[];
};

describe("delegation-revocation-set-attestation conformance corpus", () => {
  it("carries the expected schema and a case for every family", () => {
    expect(corpus.schema).toBe("motebit.delegation-revocation-set-attestation-corpus.v1");
    for (const family of ["attestation", "receipt", "omission", "equivocation"]) {
      expect(corpus.cases.some((c) => c.check === family)).toBe(true);
    }
  });

  for (const c of corpus.cases) {
    it(`case: ${c.name}`, async () => {
      let got: unknown;
      if (c.check === "attestation") {
        got = await verifyRevocationSetAttestation(
          c.input.attestation as DelegationRevocationSetAttestation,
          c.input.expectations as VerifyRevocationSetAttestationExpectations,
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
        got = await verifyRevocationOmissionProof(
          c.input.receipt as DelegationRevocationInclusionReceipt,
          c.input.attestation as DelegationRevocationSetAttestation,
        );
      } else {
        got = await verifyRevocationEquivocationProof(
          c.input.attestationA as DelegationRevocationSetAttestation,
          c.input.attestationB as DelegationRevocationSetAttestation,
        );
      }
      expect(got).toEqual(c.expected);
    });
  }
});
