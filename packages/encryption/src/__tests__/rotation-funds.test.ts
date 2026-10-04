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
      rpc((reqs) =>
        reqs.slice(0, 2).map((r) => ({ id: r.id, result: { value: r.id === 1 ? 0 : [] } })),
      ).fetchImpl,
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

describe("createSolanaHoldingsReader — every fail-closed edge", () => {
  const ok = (overrides: Record<number, unknown> = {}) =>
    rpc((reqs) =>
      reqs.map((r) =>
        r.id in overrides
          ? overrides[r.id]
          : { jsonrpc: "2.0", id: r.id, result: { value: r.method === "getBalance" ? 0 : [] } },
      ),
    ).fetchImpl;
  const read = (fetchImpl: typeof fetch) => createSolanaHoldingsReader({ fetchImpl })("Addr");

  it("an empty wallet under both programs reads as exactly empty", async () => {
    await expect(read(ok())).resolves.toEqual({ solLamports: 0n, tokens: [] });
  });

  it("names the HTTP status on a non-2xx", async () => {
    await expect(read(rpc(() => [], 429).fetchImpl)).rejects.toThrow("HTTP 429");
  });

  it("a request the RPC never answered (the Token-2022 query dropped) is a refusal, not zero", async () => {
    const fetchImpl = rpc((reqs) =>
      reqs
        .filter((r) => r.id !== 3)
        .map((r) => ({ id: r.id, result: { value: r.method === "getBalance" ? 0 : [] } })),
    ).fetchImpl;
    await expect(read(fetchImpl)).rejects.toThrow("no result for request 3");
  });

  it("ignores batch entries without a numeric id, so they cannot stand in for a real answer", async () => {
    const fetchImpl = rpc((reqs) => [
      { id: "1", result: { value: 5 } },
      null,
      ...reqs.filter((r) => r.id !== 1).map((r) => ({ id: r.id, result: { value: [] } })),
    ]).fetchImpl;
    await expect(read(fetchImpl)).rejects.toThrow("no result for request 1");
  });

  it("a JSON-RPC error carries its message, or 'unknown' when it has none", async () => {
    await expect(read(ok({ 2: { id: 2, error: { message: "rate limited" } } }))).rejects.toThrow(
      "Solana RPC error: rate limited",
    );
    await expect(read(ok({ 3: { id: 3, error: {} } }))).rejects.toThrow(
      "Solana RPC error: unknown",
    );
  });

  it("a null result is a refusal, not an empty wallet", async () => {
    await expect(read(ok({ 1: { id: 1, result: null } }))).rejects.toThrow(
      "empty result for request 1",
    );
  });

  for (const [name, value] of [
    ["negative", -1],
    ["missing", undefined],
    ["string", "7"],
  ] as const) {
    it(`a ${name} balance is malformed`, async () => {
      await expect(read(ok({ 1: { id: 1, result: { value } } }))).rejects.toThrow(
        "malformed balance",
      );
    });
  }

  it("a fractional lamport balance never resolves", async () => {
    await expect(read(ok({ 1: { id: 1, result: { value: 1.5 } } }))).rejects.toThrow();
  });

  it("a non-array token-account list under either program is malformed", async () => {
    await expect(read(ok({ 2: { id: 2, result: { value: {} } } }))).rejects.toThrow(
      "malformed token accounts",
    );
    await expect(read(ok({ 3: { id: 3, result: {} } }))).rejects.toThrow(
      "malformed token accounts",
    );
  });

  for (const [name, acct] of [
    [
      "a missing mint",
      { account: { data: { parsed: { info: { tokenAmount: { amount: "1" } } } } } },
    ],
    ["a numeric amount", tokenAccount("M", 5 as unknown as string, 0)],
    ["a negative amount", tokenAccount("M", "-5", 0)],
    ["a decimal amount", tokenAccount("M", "1.5", 0)],
  ] as const) {
    it(`a Token-2022 account with ${name} is refused, never skipped`, async () => {
      await expect(read(ok({ 3: { id: 3, result: { value: [acct] } } }))).rejects.toThrow(
        "did not parse",
      );
    });
  }

  it("keeps zero-amount accounts from both programs and treats missing decimals as 0", async () => {
    const h = await read(
      ok({
        2: { id: 2, result: { value: [tokenAccount(USDC, "0", 6)] } },
        3: {
          id: 3,
          result: {
            value: [
              tokenAccount("Mint2022", "0", 9),
              {
                account: {
                  data: { parsed: { info: { mint: "NoDec", tokenAmount: { amount: "42" } } } },
                },
              },
            ],
          },
        },
      }),
    );
    expect(h.tokens).toEqual([
      { mint: USDC, amount: 0n, decimals: 6 },
      { mint: "Mint2022", amount: 0n, decimals: 9 },
      { mint: "NoDec", amount: 42n, decimals: 0 },
    ]);
    // Zero accounts alone are clear; the undecimalled Token-2022 holding still refuses.
    expect(describeWalletHoldings({ solLamports: 0n, tokens: h.tokens.slice(0, 2) })).toBe("");
    expect(describeWalletHoldings(h)).toBe("42 of token NoDec");
  });

  it("defaults to the mainnet RPC and the global fetch", async () => {
    const original = globalThis.fetch;
    const { fetchImpl, seen } = rpc((reqs) =>
      reqs.map((r) => ({ id: r.id, result: { value: r.method === "getBalance" ? 2 : [] } })),
    );
    globalThis.fetch = fetchImpl;
    try {
      await expect(createSolanaHoldingsReader()("Addr")).resolves.toEqual({
        solLamports: 2n,
        tokens: [],
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(seen[0]!.url).toMatch(/^https:\/\/.*solana/);
  });
});

describe("checkRotationFunds — Token-2022 and non-Error failures", () => {
  it("a nonzero Token-2022 holding alone blocks the rotation", async () => {
    const kp = await generateKeypair();
    const { fetchImpl } = rpc((reqs) =>
      reqs.map((r) => ({
        id: r.id,
        result: {
          value: r.method === "getBalance" ? 0 : r.id === 3 ? [tokenAccount("T22", "1", 2)] : [],
        },
      })),
    );
    const v = await checkRotationFunds({
      publicKey: kp.publicKey,
      readHoldings: createSolanaHoldingsReader({ fetchImpl }),
    });
    expect(v).toMatchObject({ kind: "holds-value", summary: "0.01 of token T22" });
  });

  it("a reader that throws a non-Error is still unknown (fail-closed), its value stringified", async () => {
    const kp = await generateKeypair();
    const v = await checkRotationFunds({
      publicKey: kp.publicKey,
      readHoldings: async () => {
        // A non-Error throw, as some transports do.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "socket hang up";
      },
    });
    expect(v).toMatchObject({ kind: "unknown", reason: "socket hang up" });
    expect(rotationFundsRefusal(v as Exclude<typeof v, { kind: "clear" }>, "--force")).toContain(
      "rotate with --force",
    );
  });

  it("a reader failure over the real RPC reader surfaces the RPC's reason in the refusal", async () => {
    const kp = await generateKeypair();
    const v = await checkRotationFunds({
      publicKey: kp.publicKey,
      readHoldings: createSolanaHoldingsReader({ fetchImpl: rpc(() => [], 503).fetchImpl }),
    });
    expect(v.kind).toBe("unknown");
    const msg = rotationFundsRefusal(v as Exclude<typeof v, { kind: "clear" }>, "--abandon-funds");
    expect(msg).toContain("could not be read (Solana RPC answered HTTP 503)");
    expect(msg).toContain(`move any funds off ${(v as { address: string }).address} first`);
    expect(msg).not.toContain("holds");
  });
});

describe("describeWalletHoldings — whole amounts and devnet USDC", () => {
  it("prints whole amounts without a trailing point and names devnet USDC", () => {
    expect(
      describeWalletHoldings({
        solLamports: 2_000_000_000n,
        tokens: [
          { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", amount: 5_000_000n, decimals: 6 },
        ],
      }),
    ).toBe("2 SOL, 5 USDC (devnet)");
    expect(
      describeWalletHoldings({
        solLamports: 0n,
        tokens: [{ mint: USDC, amount: 1n, decimals: 6 }],
      }),
    ).toBe("0.000001 USDC");
  });
});
