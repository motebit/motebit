/**
 * #887 — sovereign pay-forward is OFF until a worker's admission mode is
 * discoverable. The runtime entry point refuses before any discovery or
 * payment, even with keys and a funded wallet configured.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  SOVEREIGN_PAY_FORWARD_ENABLED,
  SOVEREIGN_PAY_FORWARD_DISABLED_MESSAGE,
  SovereignPayForwardDisabledError,
} from "../index.js";
import type { SovereignWalletRail } from "@motebit/sdk";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#887 sovereign pay-forward gate", () => {
  it("is off", () => {
    expect(SOVEREIGN_PAY_FORWARD_ENABLED).toBe(false);
  });

  it("createSovereignDelegationAdapter refuses before any discovery or payment", async () => {
    const send = vi.fn().mockResolvedValue({ signature: "sig" });
    const wallet = {
      custody: "agent",
      name: "solana-wallet",
      chain: "solana",
      asset: "USDC",
      address: "PayerAddr",
      getBalance: vi.fn().mockResolvedValue(10_000_000n),
      send,
      buildP2pPayment: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as SovereignWalletRail;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { generateKeypair } = await import("@motebit/encryption");
    const runtime = new MotebitRuntime(
      {
        motebitId: "delegator",
        tickRateHz: 0,
        signingKeys: await generateKeypair(),
        solanaWallet: wallet,
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );

    let thrown: unknown;
    try {
      runtime.createSovereignDelegationAdapter("https://relay.test");
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SovereignPayForwardDisabledError);
    expect((thrown as Error).message).toBe(SOVEREIGN_PAY_FORWARD_DISABLED_MESSAGE);
    expect(SOVEREIGN_PAY_FORWARD_DISABLED_MESSAGE).toMatch(
      /^Sovereign pay-forward is disabled: a worker's admission mode isn't discoverable yet/,
    );
    expect(send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
