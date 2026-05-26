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
  it("returns null from every Solana method when no wallet AND no signing keys are configured", async () => {
    const runtime = new MotebitRuntime({ motebitId: "bare-mote", tickRateHz: 0 }, createAdapters());

    expect(runtime.getSolanaAddress()).toBeNull();
    expect(await runtime.getSolanaBalance()).toBeNull();
    expect(await runtime.sendUsdc("any-address", 1n)).toBeNull();
    expect(await runtime.isSolanaAvailable()).toBeNull();
  });

  it("derives the address from signing keys even when no rail is configured", async () => {
    // Fallback shape — the deposit destination should resolve whenever the
    // public key is known, independent of RPC/rail state. Lets the Stripe
    // onramp + the Sovereign panel's Fund button work before (or when)
    // the rail's RPC adapter isn't instantiated.
    const { generateKeypair } = await import("@motebit/encryption");
    const kp = await generateKeypair();
    const runtime = new MotebitRuntime(
      { motebitId: "key-only-mote", tickRateHz: 0, signingKeys: kp },
      createAdapters(),
    );

    const address = runtime.getSolanaAddress();
    expect(address).not.toBeNull();
    // base58 Solana addresses are 32–44 chars, never containing 0 / O / I / l.
    expect(address!).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    // Balance + send still return null — those need the full rail.
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

  it("uses the injected rail's address when a rail is configured", async () => {
    const rail = await makeMockRail({ ownAddress: "InjectedRailAddr" });
    const runtime = new MotebitRuntime(
      { motebitId: "wallet-mote", tickRateHz: 0, solanaWallet: rail },
      createAdapters(),
    );

    expect(runtime.getSolanaAddress()).toBe("InjectedRailAddr");
  });
});

describe("MotebitRuntime — sovereign address (no-rail fallback)", () => {
  // Post-#110 the runtime no longer constructs rails; surfaces inject
  // `solanaWallet`. But the sovereign address is still knowable from the
  // identity key alone (Solana address = base58 of the Ed25519 pubkey), so
  // `getSolanaAddress()` derives it via `@motebit/protocol`'s base58Encode
  // when no rail is configured — no wallet-solana dependency in the runtime.
  it("returns null when neither a rail nor signing keys are configured", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "no-keys-mote", tickRateHz: 0 },
      createAdapters(),
    );

    expect(runtime.getSolanaAddress()).toBeNull();
  });

  it("derives the sovereign address from signing keys alone when no rail is configured", async () => {
    const { generateKeypair } = await import("@motebit/encryption");
    // eslint-disable-next-line no-restricted-imports -- test asserts derivation parity
    const { deriveSolanaAddress } = await import("@motebit/wallet-solana");
    const kp = await generateKeypair();

    const runtime = new MotebitRuntime(
      {
        motebitId: "keyed-mote",
        tickRateHz: 0,
        signingKeys: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
      createAdapters(),
    );

    // No rail injected → fallback path. The result must equal the canonical
    // wallet-solana derivation (which is itself byte-compat with web3.js).
    const addr = runtime.getSolanaAddress();
    expect(addr).not.toBeNull();
    expect(addr).toBe(deriveSolanaAddress(kp.publicKey));
    expect(addr!).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });
});
