/**
 * Solana network identity from the RPC's genesis hash (#954).
 *
 * The law: a CAIP-2 id is derived from the cluster the RPC serves — never
 * defaulted, never taken on a declaration alone.
 */
import { describe, it, expect, vi } from "vitest";
import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_GENESIS_HASH,
  SOLANA_TESTNET_CAIP2,
  SOLANA_TESTNET_GENESIS_HASH,
  isSolanaCaip2,
  resolveSolanaNetwork,
  solanaCaip2FromGenesisHash,
  SolanaNetworkResolver,
} from "../network.js";

const noSleep = () => Promise.resolve();

describe("solanaCaip2FromGenesisHash", () => {
  it("is `solana:` + the first 32 characters of the genesis hash, for every known cluster", () => {
    expect(solanaCaip2FromGenesisHash(SOLANA_MAINNET_GENESIS_HASH)).toBe(SOLANA_MAINNET_CAIP2);
    expect(solanaCaip2FromGenesisHash(SOLANA_DEVNET_GENESIS_HASH)).toBe(SOLANA_DEVNET_CAIP2);
    expect(solanaCaip2FromGenesisHash(SOLANA_TESTNET_GENESIS_HASH)).toBe(SOLANA_TESTNET_CAIP2);
    // The constants agree with the brief's literal values.
    expect(SOLANA_MAINNET_CAIP2).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(SOLANA_DEVNET_CAIP2).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });

  it("refuses anything that is not a base58 hash", () => {
    for (const bad of ["", "short", "0OIl".repeat(10), "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]) {
      expect(() => solanaCaip2FromGenesisHash(bad)).toThrow(/genesis hash/);
    }
  });

  it("isSolanaCaip2 accepts derived ids and rejects shorthands", () => {
    expect(isSolanaCaip2(SOLANA_DEVNET_CAIP2)).toBe(true);
    expect(isSolanaCaip2("solana:mainnet")).toBe(false);
    expect(isSolanaCaip2("eip155:8453")).toBe(false);
  });
});

describe("resolveSolanaNetwork", () => {
  for (const [genesis, caip2] of [
    [SOLANA_MAINNET_GENESIS_HASH, SOLANA_MAINNET_CAIP2],
    [SOLANA_DEVNET_GENESIS_HASH, SOLANA_DEVNET_CAIP2],
    [SOLANA_TESTNET_GENESIS_HASH, SOLANA_TESTNET_CAIP2],
  ] as const) {
    it(`derives ${caip2} from a fake RPC answering ${genesis.slice(0, 8)}…`, async () => {
      const out = await resolveSolanaNetwork(async () => genesis);
      expect(out).toEqual({ status: "resolved", network: caip2, genesisHash: genesis });
    });
  }

  it("accepts a declared network the RPC agrees with", async () => {
    const out = await resolveSolanaNetwork(async () => SOLANA_DEVNET_GENESIS_HASH, {
      expected: SOLANA_DEVNET_CAIP2,
    });
    expect(out.status).toBe("resolved");
  });

  it("a declared network the RPC contradicts is a mismatch — it never wins over the chain", async () => {
    const out = await resolveSolanaNetwork(async () => SOLANA_DEVNET_GENESIS_HASH, {
      expected: SOLANA_MAINNET_CAIP2,
    });
    expect(out).toEqual({
      status: "mismatch",
      expected: SOLANA_MAINNET_CAIP2,
      network: SOLANA_DEVNET_CAIP2,
      genesisHash: SOLANA_DEVNET_GENESIS_HASH,
    });
  });

  it("a shorthand declaration can never match", async () => {
    const out = await resolveSolanaNetwork(async () => SOLANA_MAINNET_GENESIS_HASH, {
      expected: "solana:mainnet",
    });
    expect(out.status).toBe("mismatch");
  });

  it("a failed read is unavailable — never a mainnet label, even with a mainnet declaration", async () => {
    const read = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const out = await resolveSolanaNetwork(read, {
      expected: SOLANA_MAINNET_CAIP2,
      retryDelaysMs: [10, 20],
      sleep: noSleep,
    });
    expect(out).toEqual({ status: "unavailable", reason: "rpc down", attempts: 3 });
    expect(read).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(out)).not.toContain("5eykt4Us");
  });

  it("retries with the given backoff and resolves once the RPC answers", async () => {
    const sleeps: number[] = [];
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(SOLANA_DEVNET_GENESIS_HASH);
    const out = await resolveSolanaNetwork(read, {
      retryDelaysMs: [500, 1000],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(out.status).toBe("resolved");
    expect(sleeps).toEqual([500]);
  });

  it("a garbage answer is treated as a failed read, not a label", async () => {
    const out = await resolveSolanaNetwork(async () => "garbage", { sleep: noSleep });
    expect(out.status).toBe("unavailable");
  });
});

describe("resolveSolanaNetwork — every read is time-bounded", () => {
  it("a read that never answers is unavailable after the timeout, not a wait without end", async () => {
    const out = await resolveSolanaNetwork(() => new Promise<string>(() => {}), { timeoutMs: 20 });
    expect(out).toEqual({
      status: "unavailable",
      reason: "getGenesisHash timed out after 20ms",
      attempts: 1,
    });
  });
});

describe("SolanaNetworkResolver — lazy, cached, never a boot gate (#954 round 2)", () => {
  it("constructing it reads nothing", () => {
    const read = vi.fn(async () => SOLANA_DEVNET_GENESIS_HASH);
    const r = new SolanaNetworkResolver(read);
    expect(read).not.toHaveBeenCalled();
    expect(r.state).toEqual({ status: "pending" });
    expect(r.network).toBeUndefined();
  });

  it("a transient outage heals on a later resolve: 4 failures, then the cluster — no restart", async () => {
    let calls = 0;
    const r = new SolanaNetworkResolver(async () => {
      calls++;
      if (calls <= 4) throw new Error("503 Service Unavailable");
      return SOLANA_DEVNET_GENESIS_HASH;
    });
    for (let i = 1; i <= 4; i++) {
      expect((await r.resolve()).status).toBe("unavailable");
      expect(r.state).toMatchObject({ status: "unavailable", failures: i });
    }
    expect(await r.resolve()).toMatchObject({ status: "resolved", network: SOLANA_DEVNET_CAIP2 });
    expect(r.network).toBe(SOLANA_DEVNET_CAIP2);
    await r.resolve();
    expect(calls, "resolved is cached").toBe(5);
  });

  it("an RPC that ALTERNATES clusters: after one mismatch it is never trusted again", async () => {
    let calls = 0;
    const r = new SolanaNetworkResolver(
      async () => (calls++ % 2 === 0 ? SOLANA_DEVNET_GENESIS_HASH : SOLANA_MAINNET_GENESIS_HASH),
      { expected: SOLANA_MAINNET_CAIP2 },
    );
    expect((await r.resolve()).status).toBe("mismatch");
    for (let i = 0; i < 5; i++) expect((await r.resolve()).status).toBe("mismatch");
    expect(calls, "a mismatch is terminal: no re-read can turn it into a pass").toBe(1);
    expect(r.network).toBeUndefined();
  });

  it("concurrent callers share one read", async () => {
    let release: (v: string) => void = () => {};
    const read = vi.fn(() => new Promise<string>((res) => (release = res)));
    const r = new SolanaNetworkResolver(read);
    const a = r.resolve();
    const b = r.resolve();
    release(SOLANA_TESTNET_GENESIS_HASH);
    expect((await a).status).toBe("resolved");
    expect((await b).status).toBe("resolved");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reports every state change", async () => {
    const seen: string[] = [];
    const r = new SolanaNetworkResolver(async () => SOLANA_DEVNET_GENESIS_HASH, {
      onChange: (st) => seen.push(st.status),
    });
    await r.resolve();
    expect(seen).toEqual(["resolved"]);
  });
});

describe("resolveSolanaNetwork — default sleep and non-Error failures", () => {
  it("retries through the real (default) sleep and resolves", async () => {
    let calls = 0;
    const out = await resolveSolanaNetwork(
      async () => {
        calls++;
        if (calls === 1) throw new Error("first read fails");
        return SOLANA_DEVNET_GENESIS_HASH;
      },
      { retryDelaysMs: [1] },
    );
    expect(out.status).toBe("resolved");
    expect(calls).toBe(2);
  });

  it("a read that rejects with a non-Error is unavailable with its string form", async () => {
    // A non-Error rejection is the case under test (an RPC client may reject with anything).
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const out = await resolveSolanaNetwork(() => Promise.reject("plain string failure"));
    expect(out).toEqual({ status: "unavailable", reason: "plain string failure", attempts: 1 });
  });
});

describe("createSolanaGenesisHashReader — the production reader", () => {
  it("asks the RPC at rpcUrl for its genesis hash (JSON-RPC getGenesisHash)", async () => {
    const { createServer } = await import("node:http");
    const { createSolanaGenesisHashReader } = await import("../web3js-adapter.js");
    const methods: string[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const msg = JSON.parse(raw) as { id: unknown; method: string };
        methods.push(msg.method);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: SOLANA_TESTNET_GENESIS_HASH }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as { port: number };
      const read = createSolanaGenesisHashReader(`http://127.0.0.1:${port}`);
      expect(await read()).toBe(SOLANA_TESTNET_GENESIS_HASH);
      expect(methods).toEqual(["getGenesisHash"]);
      const out = await resolveSolanaNetwork(read);
      expect(out).toMatchObject({ status: "resolved", network: SOLANA_TESTNET_CAIP2 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
