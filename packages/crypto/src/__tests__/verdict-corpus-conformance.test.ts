/**
 * VerificationVerdict — committed-corpus conformance.
 *
 * Runs the producers over the versioned, pinnable corpus at
 * spec/conformance/verification-verdict/corpus.json and asserts each result
 * deep-equals the committed `expected`. This is the drift gate against OUR
 * implementation: change a producer's output and this fails. A second
 * implementation (consumer #2) runs ITS verifiers over the same `input` vectors
 * and asserts the same `expected` — "done" is both sides emitting identical
 * verdicts with neither in the room.
 *
 * Regenerate the corpus (deliberately, on a reviewed producer change):
 *   npx tsx scripts/gen-verdict-corpus.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyReceiptVerdict,
  verifyDelegationTokenVerdict,
  type SignableReceipt,
  type DelegationToken,
  type StandingDelegation,
  type VerificationVerdict,
} from "../index.js";

interface ReceiptCase {
  name: string;
  kind: "receipt";
  input: { receipt: SignableReceipt };
  expected: VerificationVerdict;
}
interface TokenCase {
  name: string;
  kind: "delegation_token";
  input: { token: DelegationToken; grant: StandingDelegation; options?: unknown };
  expected: VerificationVerdict;
}
type Case = ReceiptCase | TokenCase;

const corpusPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../spec/conformance/verification-verdict/corpus.json",
);
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as { cases: Case[] };

describe("VerificationVerdict committed-corpus conformance", () => {
  it("the corpus is non-empty and covers both producers", () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
    const kinds = new Set(corpus.cases.map((c) => c.kind));
    expect(kinds.has("receipt")).toBe(true);
    expect(kinds.has("delegation_token")).toBe(true);
  });

  for (const c of corpus.cases) {
    it(`${c.name}: producer output deep-equals the committed verdict`, async () => {
      const actual =
        c.kind === "receipt"
          ? await verifyReceiptVerdict(c.input.receipt)
          : await verifyDelegationTokenVerdict(
              c.input.token,
              c.input.grant,
              c.input.options as Parameters<typeof verifyDelegationTokenVerdict>[2],
            );
      expect(actual).toEqual(c.expected);
    });
  }
});
