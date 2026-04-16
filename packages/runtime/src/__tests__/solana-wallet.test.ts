/**
 * MotebitRuntime sovereign Solana wallet wiring.
 *
 * Proves the runtime exposes the motebit's sovereign wallet as a first-
 * class primitive when a `SolanaWalletRail` is configured, and gracefully
 * returns null for every method when no rail is configured. Tests inject
 * a mock rail via `config.solanaWallet` so no real Solana RPC is touched.
 *
 * This is the first test where a motebit is proven to be an economic
 * actor at the runtime layer — not just the package layer. The spec
 * justification lives in `spec/settlement-v1.md` §6 (default reference
 * implementation) and §7 (sovereign payment receipt format).
 */

import { describe, it, expect, vi } from "vitest";
import type { SolanaWalletRail, SolanaRpcAdapter, SendUsdcArgs } from "@motebit/wallet-solana";

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index.js";
import type { PlatformAdapters } from "../index.js";

// ── Mock rail construction ────────────────────────────────────────────

function makeMockAdapter(overrides: Partial<SolanaRpcAdapter> = {}): SolanaRpcAdapter {
  return {
    ownAddress: "MockDerivedAddressBase58",
    getUsdcBalance: vi.fn().mockResolvedValue(1_250_000n),
    getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
    sendUsdc: vi.fn(async (_args: SendUsdcArgs) => ({
      signature: "mockTxSignature5JxYz",
      slot: 42,
      confirmed: true,
    })),
    sendUsdcBatch: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
    isReachable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

// Construct a SolanaWalletRail wrapping a mock adapter. We import the real
// class (the rail itself is trivial — it's just delegation) so the test
// exercises the runtime's wiring, not a fake of the rail wrapper.
async function makeMockRail(
  adapterOverrides?: Partial<SolanaRpcAdapter>,
): Promise<SolanaWalletRail> {
  const { SolanaWalletRail: RailClass } = await import("@motebit/wallet-solana");
  return new RailClass(makeMockAdapter(adapterOverrides));
}

function createAdapters(): PlatformAdapters {
  return {
    storage: createInMemoryStorage(),
    renderer: new NullRenderer(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("MotebitRuntime — sovereign Solana wallet (no rail configured)", () => {
  it("returns null from every Solana method when no wallet is configured", async () => {
    const runtime = new MotebitRuntime({ motebitId: "bare-mote", tickRateHz: 0 }, createAdapters());

    expect(runtime.getSolanaAddress()).toBeNull();
    expect(await runtime.getSolanaBalance()).toBeNull();
    expect(await runtime.sendUsdc("any-address", 1n)).toBeNull();
    expect(await runtime.isSolanaAvailable()).toBeNull();
  });
});

describe("MotebitRuntime — sovereign Solana wallet (pre-built rail injected)", () => {
  it("exposes the rail's address through getSolanaAddress", async () => {
    const rail = await makeMockRail({ ownAddress: "DanielsMotebitSolanaAddr" });
    const runtime = new MotebitRuntime(
      { motebitId: "wallet-mote", tickRateHz: 0, solanaWallet: rail },
      createAdapters(),
    );

    expect(runtime.getSolanaAddress()).toBe("DanielsMotebitSolanaAddr");
  });

  it("delegates getSolanaBalance to the rail", async () => {
    const getUsdcBalance = vi.fn().mockResolvedValue(5_430_000n);
    const rail = await makeMockRail({ getUsdcBalance });
    const runtime = new MotebitRuntime(
      { motebitId: "wallet-mote", tickRateHz: 0, solanaWallet: rail },
      createAdapters(),
    );

    const balance = await runtime.getSolanaBalance();
    expect(balance).toBe(5_430_000n);
    expect(getUsdcBalance).toHaveBeenCalledOnce();
  });

  it("delegates sendUsdc to the rail with toAddress and microAmount", async () => {
    const sendUsdc = vi.fn(async (_args: SendUsdcArgs) => ({
      signature: "realTxSig",
      slot: 999,
      confirmed: true,
    }));
    const rail = await makeMockRail({ sendUsdc });
    const runtime = new MotebitRuntime(
      { motebitId: "wallet-mote", tickRateHz: 0, solanaWallet: rail },
      createAdapters(),
    );

    const result = await runtime.sendUsdc("CounterpartyAddress", 430_000n);

    expect(sendUsdc).toHaveBeenCalledWith({
      toAddress: "CounterpartyAddress",
      microAmount: 430_000n,
    });
    expect(result).toEqual({ signature: "realTxSig", slot: 999, confirmed: true });
  });

  it("delegates isSolanaAvailable to the rail reachability check", async () => {
    const isReachable = vi.fn().mockResolvedValue(false);
    const rail = await makeMockRail({ isReachable });
    const runtime = new MotebitRuntime(
      { motebitId: "wallet-mote", tickRateHz: 0, solanaWallet: rail },
      createAdapters(),
    );

    expect(await runtime.isSolanaAvailable()).toBe(false);
    expect(isReachable).toHaveBeenCalledOnce();
  });

  it("ignores the inline `solana` config when `solanaWallet` is pre-built", async () => {
    // solana config would require signing keys, which we don't provide here.
    // If the runtime accidentally tried to build the rail from the config,
    // it would fail. The pre-built rail path must take priority.
    const rail = await makeMockRail({ ownAddress: "PrebuiltWins" });
    const runtime = new MotebitRuntime(
      {
        motebitId: "wallet-mote",
        tickRateHz: 0,
        solanaWallet: rail,
        solana: { rpcUrl: "https://should-be-ignored.example.com" },
      },
      createAdapters(),
    );

    expect(runtime.getSolanaAddress()).toBe("PrebuiltWins");
  });
});

describe("MotebitRuntime — sovereign Solana wallet (inline config path)", () => {
  it("does NOT build a rail when `solana` is set but signing keys are absent", async () => {
    // The rail requires the identity Ed25519 seed to derive the Solana
    // keypair. Without signing keys, the inline config path cannot
    // construct a rail; the runtime falls back to the no-wallet state.
    const runtime = new MotebitRuntime(
      {
        motebitId: "no-keys-mote",
        tickRateHz: 0,
        solana: { rpcUrl: "https://api.devnet.solana.com" },
      },
      createAdapters(),
    );

    expect(runtime.getSolanaAddress()).toBeNull();
  });

  it("builds a rail from inline config when signing keys are present", async () => {
    const { generateKeypair } = await import("@motebit/encryption");
    const kp = await generateKeypair();

    const runtime = new MotebitRuntime(
      {
        motebitId: "keyed-mote",
        tickRateHz: 0,
        signingKeys: { privateKey: kp.privateKey, publicKey: kp.publicKey },
        solana: { rpcUrl: "https://api.devnet.solana.com" },
      },
      createAdapters(),
    );

    // Address is the base58 encoding of the Ed25519 public key — deterministic
    // and matches what `@solana/web3.js` derives via Keypair.fromSeed. We don't
    // pin the exact value because it depends on the random key; we just
    // verify it's a non-empty base58-shaped string of plausible length.
    const addr = runtime.getSolanaAddress();
    expect(addr).not.toBeNull();
    expect(addr!).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(addr!.length).toBeGreaterThanOrEqual(32);
    expect(addr!.length).toBeLessThanOrEqual(44);
  });
});
