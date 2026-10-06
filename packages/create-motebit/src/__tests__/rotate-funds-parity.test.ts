/**
 * Parity lock, create-motebit side: the inlined `preflightRotationFunds`
 * (an "inlined sibling of @motebit/encryption's checkRotationFunds" — this
 * package is a zero-dep bin, so it cannot import it at runtime) over the
 * SAME shared vectors @motebit/encryption's `rotation-funds-vectors.test.ts`
 * runs: packages/encryption/src/__tests__/fixtures/rotation-funds-vectors.json.
 * Either side drifting on a decision, the address, the holdings summary or
 * the read-failure reason turns one of the two red.
 *
 * Adapter (the two shapes differ): the inlined preflight takes raw key bytes
 * (the vector's hex is decoded here) and signals by throwing
 * `RotationFundsRefused` instead of returning a verdict. Resolve ⇒ `clear`;
 * a refusal is mapped back to the verdict by the summary / reason it embeds
 * (`… holds <summary>. Rotating …` / `… could not be read (<reason>). Rotating …`).
 * The surrounding prose is deliberately NOT compared — the two surfaces word
 * the consequence differently.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { preflightRotationFunds, RotationFundsRefused, type WalletHoldings } from "../rotate.js";

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
  readFileSync(
    new URL(
      "../../../encryption/src/__tests__/fixtures/rotation-funds-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { vectors: Vector[] };

const hexToBytes = (hex: string) =>
  Uint8Array.from((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

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

const HOLDS =
  /^rotation refused before anything changed: this identity's wallet (\S+) holds (.*)\. Rotating retires this key;/s;
const UNREAD =
  /^rotation refused before anything changed: the balance of this identity's wallet (\S+) could not be read \((.*)\)\. Rotating retires this key;/s;

describe("preflightRotationFunds — shared rotation-funds parity vectors", () => {
  it("the vector file covers every verdict kind", () => {
    const kinds = new Set(vectors.map((v) => v.expected.kind));
    expect([...kinds].sort()).toEqual(["clear", "holds-value", "unknown"]);
  });

  for (const v of vectors) {
    it(v.id, async () => {
      const seen: string[] = [];
      let observed: Vector["expected"];
      try {
        await preflightRotationFunds(hexToBytes(v.publicKeyHex), readerFor(v, seen));
        observed = { kind: "clear", address: seen[0] ?? "" };
      } catch (err) {
        expect(err).toBeInstanceOf(RotationFundsRefused);
        const e = err as RotationFundsRefused;
        const holds = HOLDS.exec(e.message);
        const unread = UNREAD.exec(e.message);
        if (holds) {
          expect(holds[1]).toBe(e.address);
          observed = { kind: "holds-value", address: e.address, summary: holds[2] };
        } else if (unread) {
          expect(unread[1]).toBe(e.address);
          observed = { kind: "unknown", address: e.address, reason: unread[2] };
        } else {
          throw new Error(`unrecognised refusal: ${e.message}`, { cause: err });
        }
      }
      expect(seen).toEqual([v.expected.address]);
      expect(observed).toEqual(v.expected);
    });
  }
});
