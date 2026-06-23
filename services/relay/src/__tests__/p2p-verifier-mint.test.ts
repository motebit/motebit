/**
 * Regression test for the verifier-mint threading bug.
 *
 * Before the fix, `startP2pVerifierLoop` constructed its
 * `Web3JsRpcAdapter` with only `{ rpcUrl, identitySeed }` — silently
 * defaulting to the MAINNET USDC mint. On any non-mainnet deployment
 * (devnet/testnet) the verifier would then walk the mainnet mint's
 * token accounts, find none of the delegator's legs, and fail-verify +
 * trust-downgrade every P2P settlement. The sibling `OperatorSolanaTransfer`
 * and the Solana treasury reconciler already honor `SOLANA_USDC_MINT`;
 * the verifier must too.
 *
 * This exercises the internal adapter-construction path (no `adapter`
 * override) which the network-free unit tests otherwise never reach.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatabaseDriver } from "@motebit/persistence";

const { ctorCalls } = vi.hoisted(() => ({ ctorCalls: [] as Array<{ usdcMint?: string }> }));

vi.mock("@motebit/wallet-solana", async (importActual) => {
  const actual = await importActual<typeof import("@motebit/wallet-solana")>();
  return {
    ...actual,
    Web3JsRpcAdapter: class {
      constructor(config: { usdcMint?: string }) {
        ctorCalls.push(config);
      }
      getTransaction = vi.fn().mockResolvedValue({ status: "rpc_error", reason: "stub" });
    },
  };
});

import { startP2pVerifierLoop } from "../p2p-verifier.js";

// The loop only touches the db inside its interval callback; the adapter
// is constructed synchronously at loop start, before any tick. A no-op
// stub db is enough — we assert on the constructor args, then clear the
// (never-firing) interval immediately.
const stubDb = {
  prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
} as unknown as DatabaseDriver;

describe("p2p-verifier mint threading", () => {
  beforeEach(() => {
    ctorCalls.length = 0;
  });

  it("threads config.usdcMint into the internally-constructed adapter", () => {
    const handle = startP2pVerifierLoop(stubDb, {
      rpcUrl: "http://stub",
      relayTreasuryAddress: "TreasuryAddr",
      usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      intervalMs: 1_000_000,
    });
    clearInterval(handle);
    expect(ctorCalls).toHaveLength(1);
    expect(ctorCalls[0]?.usdcMint).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });

  it("omits usdcMint when unconfigured, letting the adapter default to mainnet", () => {
    const handle = startP2pVerifierLoop(stubDb, {
      rpcUrl: "http://stub",
      relayTreasuryAddress: "TreasuryAddr",
      intervalMs: 1_000_000,
    });
    clearInterval(handle);
    expect(ctorCalls).toHaveLength(1);
    expect(ctorCalls[0]?.usdcMint).toBeUndefined();
  });

  it("does not construct an adapter when one is injected (test override path)", () => {
    const injected = {
      ownAddress: "stub",
      getUsdcBalance: vi.fn(),
      getUsdcBalanceOf: vi.fn(),
      getSolBalance: vi.fn(),
      sendUsdc: vi.fn(),
      sendUsdcBatch: vi.fn(),
      isReachable: vi.fn(),
      getTransaction: vi.fn().mockResolvedValue({ status: "rpc_error", reason: "stub" }),
    };
    const handle = startP2pVerifierLoop(stubDb, {
      rpcUrl: "http://stub",
      relayTreasuryAddress: "TreasuryAddr",
      usdcMint: "ignored-when-adapter-present",
      adapter: injected,
      intervalMs: 1_000_000,
    });
    clearInterval(handle);
    expect(ctorCalls).toHaveLength(0);
  });
});
