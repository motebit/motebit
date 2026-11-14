/**
 * `motebit wallet swap` — the owner-invoked SOL → USDC swap signed a
 * Jupiter-built transaction with the identity key, unvalidated. It is now
 * refused through the wallet's own choke point (`refuseJupiterSwap` in the
 * REAL @motebit/wallet-solana, not mocked): the command prints the honest
 * refusal and the next step, exits 1, and never asks for the passphrase,
 * builds a rail, or touches the network.
 *
 * Tamper: packages/wallet-solana/src/__tests__/jupiter-containment.tampers.mjs
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ keyLoads: 0, configLoads: 0 }));

vi.mock("../identity.js", async (orig) => ({
  ...(await orig<typeof import("../identity.js")>()),
  loadActiveSigningKey: async () => {
    calls.keyLoads += 1;
    return { privateKey: new Uint8Array(32).fill(7) };
  },
}));
vi.mock("../config.js", async (orig) => ({
  ...(await orig<typeof import("../config.js")>()),
  loadFullConfig: () => {
    calls.configLoads += 1;
    return { motebit_id: "019df0f4-084e-7910-90a8-3492ced8fb8f" };
  },
}));

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

let errors: string[] = [];
let logs: string[] = [];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls.keyLoads = 0;
  calls.configLoads = 0;
  errors = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new Exit(typeof code === "number" ? code : undefined);
  });
  fetchSpy = vi.fn(async () => {
    throw new Error("network is not allowed in this test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("motebit wallet swap (disabled)", () => {
  it("prints the refusal and the next step, exits 1, and never unlocks the key or touches the network", async () => {
    const { handleWalletSwap } = await import("../subcommands/wallet.js");
    const outcome = await handleWalletSwap("0.01").then(
      () => null,
      (e: unknown) => e,
    );
    expect(outcome).toBeInstanceOf(Exit);
    expect((outcome as Exit).code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Swap unavailable: swaps are disabled until intent-bound transaction validation exists",
    );
    expect(errors.join("\n")).toContain("Fund USDC on the SOLANA network directly");
    expect(calls.keyLoads).toBe(0);
    expect(calls.configLoads).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(logs.join("\n")).not.toMatch(/Swapping|swapped/);
  });

  it("refuses the same way with no amount (the refusal precedes argument parsing)", async () => {
    const { handleWalletSwap } = await import("../subcommands/wallet.js");
    const outcome = await handleWalletSwap(undefined).then(
      () => null,
      (e: unknown) => e,
    );
    expect((outcome as Exit).code).toBe(1);
    expect(errors.join("\n")).toContain("swaps are disabled");
    expect(calls.keyLoads).toBe(0);
  });

  it("the wallet guidance no longer offers a swap or automatic gas", async () => {
    const { WALLET_GUIDANCE_LINES } = await import("../subcommands/wallet.js");
    const text = WALLET_GUIDANCE_LINES.join("\n");
    expect(text).not.toMatch(/wallet swap/);
    expect(text).not.toMatch(/auto-managed/);
    expect(text).toMatch(/0\.005 SOL/);
  });
});
