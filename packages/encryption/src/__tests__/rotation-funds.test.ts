/**
 * The rotation funds preflight's primitives: the FAIL-CLOSED Solana holdings
 * reader (unlike `checkPreTransferBalance`, a failed read is never "empty"),
 * the verdict, and the refusal an owner reads. The RPC is always a stub.
 */
import { describe, it, expect } from "vitest";
import {
  base58btcEncode,
  bytesToHex,
  checkRotationFunds,
  createSolanaHoldingsReader,
  describeWalletHoldings,
  generateKeypair,
  rotationFundsRefusal,
} from "../index.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function rpc(
  answer: (reqs: { id: number; method: string; params: unknown[] }[]) => unknown,
  status = 200,
) {
  const seen: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const reqs = JSON.parse(init!.body as string) as {
      id: number;
      method: string;
      params: unknown[];
    }[];
    seen.push({ url, body: reqs });
    return new Response(JSON.stringify(answer(reqs)), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const tokenAccount = (mint: string, amount: string, decimals: number) => ({
  account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } },
});

describe("createSolanaHoldingsReader", () => {
  it("reads SOL and token accounts under BOTH SPL token programs in one batch", async () => {
    const { fetchImpl, seen } = rpc((reqs) =>
      reqs.map((r) => ({
        jsonrpc: "2.0",
        id: r.id,
        result: {
          value:
            r.method === "getBalance"
              ? 7
              : r.id === 2
                ? [tokenAccount(USDC, "12500000", 6)]
                : [tokenAccount("Mint2022", "3", 0)],
        },
      })),
    );
    const h = await createSolanaHoldingsReader({ rpcUrl: "http://rpc", fetchImpl })("Addr");
    expect(h).toEqual({
      solLamports: 7n,
      tokens: [
        { mint: USDC, amount: 12_500_000n, decimals: 6 },
        { mint: "Mint2022", amount: 3n, decimals: 0 },
      ],
    });
    const body = seen[0]!.body as { method: string; params: unknown[] }[];
    expect(seen[0]!.url).toBe("http://rpc");
    expect(body.map((b) => b.method)).toEqual([
      "getBalance",
      "getTokenAccountsByOwner",
      "getTokenAccountsByOwner",
    ]);
    expect(body.every((b) => b.params[0] === "Addr")).toBe(true);
  });

  const FAILURES: [string, ReturnType<typeof rpc>["fetchImpl"]][] = [
    ["non-2xx", rpc(() => ({}), 500).fetchImpl],
    ["non-batch body", rpc(() => ({ result: 1 })).fetchImpl],
    [
      "JSON-RPC error",
      rpc((reqs) => reqs.map((r) => ({ id: r.id, error: { message: "rate limited" } }))).fetchImpl,
    ],
    [
      "a missing result",
      rpc((reqs) => reqs.slice(0, 2).map((r) => ({ id: r.id, result: { value: 0 } }))).fetchImpl,
    ],
    [
      "a malformed balance",
      rpc((reqs) => reqs.map((r) => ({ id: r.id, result: { value: r.id === 1 ? "lots" : [] } })))
        .fetchImpl,
    ],
    [
      "an unparsed token account",
      rpc((reqs) =>
        reqs.map((r) => ({
          id: r.id,
          result: { value: r.id === 1 ? 0 : [{ account: { data: "base64" } }] },
        })),
      ).fetchImpl,
    ],
    [
      "a transport failure",
      (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    ],
  ];
  for (const [name, fetchImpl] of FAILURES) {
    it(`THROWS on ${name} — never answers empty`, async () => {
      await expect(createSolanaHoldingsReader({ fetchImpl })("Addr")).rejects.toThrow();
    });
  }
});

describe("checkRotationFunds", () => {
  it("clear / holds-value / unknown, always naming the retiring key's address", async () => {
    const kp = await generateKeypair();
    const address = base58btcEncode(kp.publicKey);
    expect(
      await checkRotationFunds({
        publicKey: kp.publicKey,
        readHoldings: async () => ({
          solLamports: 0n,
          tokens: [{ mint: USDC, amount: 0n, decimals: 6 }],
        }),
      }),
    ).toEqual({ kind: "clear", address });
    const held = await checkRotationFunds({
      publicKey: bytesToHex(kp.publicKey),
      readHoldings: async () => ({ solLamports: 1n, tokens: [] }),
    });
    expect(held).toMatchObject({ kind: "holds-value", address, summary: "0.000000001 SOL" });
    const unknown = await checkRotationFunds({
      publicKey: kp.publicKey,
      readHoldings: async () => {
        throw new Error("HTTP 403");
      },
    });
    expect(unknown).toEqual({ kind: "unknown", address, reason: "HTTP 403" });
  });

  it("the refusal names the address, the holdings, both ways forward and the acknowledgment", () => {
    const msg = rotationFundsRefusal(
      {
        kind: "holds-value",
        address: "Addr",
        holdings: { solLamports: 0n, tokens: [] },
        summary: "12.5 USDC",
      },
      "--abandon-funds",
    );
    expect(msg).toContain("Addr holds 12.5 USDC");
    expect(msg).toMatch(/move the funds off Addr first/);
    expect(msg).toContain("--abandon-funds");
    const down = rotationFundsRefusal(
      { kind: "unknown", address: "Addr", reason: "HTTP 403" },
      "X",
    );
    expect(down).toContain("could not be read (HTTP 403)");
    expect(down).toMatch(/compromised/);
  });
});

describe("describeWalletHoldings", () => {
  it("formats without floats and skips zero balances", () => {
    expect(
      describeWalletHoldings({
        solLamports: 1_500_000_000n,
        tokens: [
          { mint: USDC, amount: 12_500_000n, decimals: 6 },
          { mint: "Other", amount: 1000n, decimals: 0 },
          { mint: "Empty", amount: 0n, decimals: 6 },
        ],
      }),
    ).toBe("1.5 SOL, 12.5 USDC, 1000 of token Other");
    expect(describeWalletHoldings({ solLamports: 0n, tokens: [] })).toBe("");
  });
});
