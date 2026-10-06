/**
 * Parity lock, encryption side: `checkRotationFunds` over the SHARED
 * rotation-funds vectors (`fixtures/rotation-funds-vectors.json`).
 *
 * create-motebit is a zero-dep bin and inlines its own sibling
 * (`preflightRotationFunds` in packages/create-motebit/src/rotate.ts); its
 * `rotate-funds-parity.test.ts` runs the SAME file. Either implementation
 * drifting on a decision (clear / holds-value / unknown), the address, the
 * holdings summary or the read-failure reason turns one of the two red.
 *
 * Adapter: the vectors carry the key as hex (accepted directly here) and
 * amounts as decimal strings (→ bigint).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { checkRotationFunds, type WalletHoldings } from "../index.js";

interface Vector {
  id: string;
  publicKeyHex: string;
  read:
    | {
        holdings: {
          solLamports: string;
          tokens: { mint: string; amount: string; decimals: number }[];
        };
      }
    | { throwsError: string }
    | { throwsValue: string };
  expected: {
    kind: "clear" | "holds-value" | "unknown";
    address: string;
    summary?: string;
    reason?: string;
  };
}

const { vectors } = JSON.parse(
  readFileSync(new URL("./fixtures/rotation-funds-vectors.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };

function readerFor(v: Vector, seen: string[]) {
  return async (address: string): Promise<WalletHoldings> => {
    seen.push(address);
    if ("throwsError" in v.read) throw new Error(v.read.throwsError);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- vector exercises a non-Error throw
    if ("throwsValue" in v.read) throw v.read.throwsValue;
    return {
      solLamports: BigInt(v.read.holdings.solLamports),
      tokens: v.read.holdings.tokens.map((t) => ({ ...t, amount: BigInt(t.amount) })),
    };
  };
}

describe("checkRotationFunds — shared rotation-funds parity vectors", () => {
  it("the vector file covers every verdict kind", () => {
    const kinds = new Set(vectors.map((v) => v.expected.kind));
    expect([...kinds].sort()).toEqual(["clear", "holds-value", "unknown"]);
  });

  for (const v of vectors) {
    it(v.id, async () => {
      const seen: string[] = [];
      const verdict = await checkRotationFunds({
        publicKey: v.publicKeyHex,
        readHoldings: readerFor(v, seen),
      });
      expect(seen).toEqual([v.expected.address]);
      const observed: Vector["expected"] = { kind: verdict.kind, address: verdict.address };
      if (verdict.kind === "holds-value") observed.summary = verdict.summary;
      if (verdict.kind === "unknown") observed.reason = verdict.reason;
      expect(observed).toEqual(v.expected);
    });
  }
});
