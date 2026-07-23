/**
 * Relay-key pinning (trust-on-first-use) — the trust root of the P2P
 * fee leg. Born 2026-07-07 wiring the rail: the CLI had no pinned
 * relay key, so the P2P delegation path was unreachable from the REPL
 * and the treasury address had no verified source. Three outcomes,
 * deliberately asymmetric: pin-on-first-verify / fail-loud-on-mismatch /
 * warn-only-on-fetch-failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { saveFullConfigMock, verifyMock } = vi.hoisted(() => ({
  saveFullConfigMock: vi.fn(),
  verifyMock: vi.fn(),
}));
vi.mock("../config.js", () => ({
  loadFullConfig: vi.fn(),
  saveFullConfig: saveFullConfigMock,
}));
vi.mock("@motebit/state-export-client", () => ({
  verifyTransparencyDeclaration: verifyMock,
}));
vi.mock("@motebit/encryption", () => ({
  mintAudienceToken: vi.fn(async () => ({ token: "mock-token", payload: {} })),
  secureErase: vi.fn(),
}));
vi.mock("../identity.js", () => ({
  loadActiveSigningKey: vi.fn(),
  IdentityKeyError: class extends Error {},
}));

import { pinRelayKey } from "../subcommands/register.js";

const DECLARATION = {
  relay_public_key: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
  signature: "sig",
  hash: "h",
  suite: "ed25519-jcs-sha256-v1",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => DECLARATION }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("pinRelayKey", () => {
  it("pins on first verified contact and persists to config", async () => {
    verifyMock.mockResolvedValue({ ok: true, anchor: {} });
    const cfg = {} as never;
    await pinRelayKey("https://relay.example", cfg);
    expect((cfg as { relay_public_key?: string }).relay_public_key).toBe(
      DECLARATION.relay_public_key,
    );
    expect(saveFullConfigMock).toHaveBeenCalledWith(cfg);
  });

  it("FAILS LOUD on pin mismatch — a relay that changed identity is never silently re-trusted", async () => {
    verifyMock.mockResolvedValue({ ok: true, anchor: {} });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit-called");
    }) as never);
    const cfg = { relay_public_key: "1111111111111111111111111111111111111111" } as never;
    await expect(pinRelayKey("https://relay.example", cfg)).rejects.toThrow("exit-called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(saveFullConfigMock).not.toHaveBeenCalled();
  });

  it("does NOT pin when the declaration fails verification", async () => {
    verifyMock.mockResolvedValue({ ok: false, reason: "signature_invalid" });
    const cfg = {} as never;
    await pinRelayKey("https://relay.example", cfg);
    expect((cfg as { relay_public_key?: string }).relay_public_key).toBeUndefined();
    expect(saveFullConfigMock).not.toHaveBeenCalled();
  });

  it("warns without failing when the declaration is unreachable (registration already succeeded)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const cfg = {} as never;
    await expect(pinRelayKey("https://relay.example", cfg)).resolves.toBeUndefined();
    expect(saveFullConfigMock).not.toHaveBeenCalled();
  });

  it("re-verified same pin is a quiet no-op (no rewrite)", async () => {
    verifyMock.mockResolvedValue({ ok: true, anchor: {} });
    const cfg = { relay_public_key: DECLARATION.relay_public_key } as never;
    await pinRelayKey("https://relay.example", cfg);
    expect(saveFullConfigMock).not.toHaveBeenCalled();
  });
});
