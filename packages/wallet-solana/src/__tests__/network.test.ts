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
