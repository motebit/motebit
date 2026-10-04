/**
 * Rotation refuses while the old address holds value (unless acknowledged) — `npx create-motebit rotate`'s `rotateKey`.
 *
 * Same table as surface-kit's and the CLI's harnesses: {empty, SOL only,
 * USDC only, another SPL token, balance read failing} × {no acknowledgment,
 * `--abandon-funds`}. `rotateKey` mints the new key; nothing on disk changes
 * until it returns, so a refusal from it is a refusal before any side effect.
 */
import { describe, it, expect } from "vitest";
import { generateIdentity } from "../generate.js";
import { rotateKey } from "../rotate.js";

const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_MINT = "So1aNaOtherTokenMint1111111111111111111111";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
const addressOf = (publicKeyHex: string) =>
  base58(Uint8Array.from(publicKeyHex.match(/../g)!.map((h) => parseInt(h, 16))));

interface Holdings {
  solLamports: bigint;
  tokens: { mint: string; amount: bigint; decimals: number }[];
}

const SCENARIOS: {
  name: string;
  holdings: Holdings | Error;
  refusal: null | { mentions: RegExp[] };
}[] = [
  { name: "empty", holdings: { solLamports: 0n, tokens: [] }, refusal: null },
  {
    name: "SOL only",
    holdings: { solLamports: 1_500_000_000n, tokens: [] },
    refusal: { mentions: [/1\.5 SOL/] },
  },
  {
    name: "USDC only",
    holdings: {
      solLamports: 0n,
      tokens: [{ mint: USDC_MAINNET, amount: 12_500_000n, decimals: 6 }],
    },
    refusal: { mentions: [/12\.5 USDC/] },
  },
  {
    name: "another SPL token",
    holdings: { solLamports: 0n, tokens: [{ mint: OTHER_MINT, amount: 1000n, decimals: 0 }] },
    refusal: { mentions: [/1000/, new RegExp(OTHER_MINT)] },
  },
  {
    name: "balance RPC unreachable / erroring",
    holdings: new Error("fetch failed: ECONNREFUSED"),
    refusal: { mentions: [/could not be read/, /ECONNREFUSED/] },
  },
];

describe("rotation funds preflight — create-motebit rotateKey", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: ${s.refusal ? "refuses before the new key is minted" : "proceeds"}`, async () => {
      const id = await generateIdentity({ name: "t", trustMode: "guarded", passphrase: "pw" });
      const reads: string[] = [];
      const run = rotateKey({
        identityFileContent: id.identityFileContent,
        encryptedOldKey: id.encryptedKey,
        oldPassphrase: "pw",
        newPassphrase: "pw",
        readWalletHoldings: async (address: string) => {
          reads.push(address);
          if (s.holdings instanceof Error) throw s.holdings;
          return s.holdings;
        },
      } as Parameters<typeof rotateKey>[0]);
      if (s.refusal == null) {
        const r = await run;
        expect(r.newPublicKeyHex).not.toBe(id.publicKeyHex);
        expect(reads).toEqual([addressOf(id.publicKeyHex)]);
        return;
      }
      const err = await run.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(reads).toEqual([addressOf(id.publicKeyHex)]);
      const message = (err as Error).message;
      expect(message).toContain(addressOf(id.publicKeyHex));
      for (const m of s.refusal.mentions) expect(message).toMatch(m);
      expect(message).toMatch(/move/i);
      expect(message).toContain("--abandon-funds");
    });

    if (s.refusal != null) {
      it(`${s.name}: --abandon-funds rotates`, async () => {
        const id = await generateIdentity({ name: "t", trustMode: "guarded", passphrase: "pw" });
        const r = await rotateKey({
          identityFileContent: id.identityFileContent,
          encryptedOldKey: id.encryptedKey,
          oldPassphrase: "pw",
          newPassphrase: "pw",
          readWalletHoldings: async () => {
            if (s.holdings instanceof Error) throw s.holdings;
            return s.holdings;
          },
          abandonFunds: true,
        } as Parameters<typeof rotateKey>[0]);
        expect(r.newPublicKeyHex).not.toBe(id.publicKeyHex);
      });
    }
  }
});
