/**
 * #887 — `motebit delegate --plan --sovereign` (settlement §9.1 pay-forward)
 * is disabled until a worker's admission mode is discoverable. It refuses
 * before the runtime-host election, the key unlock, discovery, or any
 * payment. Single-step `delegate --sovereign` (relay-mediated P2P) is a
 * different path and is covered by `delegate-sovereign-ledger.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliConfig } from "../args.js";

const spies = vi.hoisted(() => ({
  elect: vi.fn(),
  loadFullConfig: vi.fn(() => ({ motebit_id: "019df0f4-084e-7910-90a8-3492ced8fb8f" })),
  unlock: vi.fn(),
}));

vi.mock("../runtime-host.js", () => ({ electCoordinatorRole: spies.elect }));
vi.mock("../config.js", async (orig) => ({
  ...(await orig<typeof import("../config.js")>()),
  loadFullConfig: spies.loadFullConfig,
}));
vi.mock("../identity.js", async (orig) => ({
  ...(await orig<typeof import("../identity.js")>()),
  resolveUnlockPassphrase: spies.unlock,
}));
vi.mock("../subcommands/_helpers.js", async (orig) => ({
  ...(await orig<typeof import("../subcommands/_helpers.js")>()),
  requireMotebitId: () => "019df0f4-084e-7910-90a8-3492ced8fb8f",
  getRelayUrl: () => "https://relay.test",
  getRelayAuthHeaders: async () => ({ Authorization: "Bearer t" }),
}));

describe("motebit delegate --plan --sovereign is disabled (#887)", () => {
  const original = globalThis.fetch;
  const fetchSpy = vi.fn();
  let errors: string[];
  beforeEach(() => {
    errors = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
    vi.restoreAllMocks();
    fetchSpy.mockReset();
    spies.elect.mockReset();
    spies.unlock.mockReset();
  });

  it("refuses with the disabled message before election, key unlock, discovery or payment", async () => {
    const { handleDelegate } = await import("../subcommands/delegate.js");
    const config = {
      positionals: ["delegate", "research", "X"],
      plan: true,
      sovereign: true,
    } as unknown as CliConfig;

    await expect(handleDelegate(config)).rejects.toThrow("exit 1");

    expect(errors).toContain(
      "Sovereign pay-forward is disabled: a worker's admission mode isn't discoverable yet, and " +
        "relay-admitted workers refuse pay-forward after payment. Use relay-mediated P2P delegation " +
        "(the default).",
    );
    expect(spies.elect).not.toHaveBeenCalled();
    expect(spies.unlock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
