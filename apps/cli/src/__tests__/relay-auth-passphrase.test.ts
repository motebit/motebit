import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression: gap #6 from the 2026-04-25 first-time-user walkthrough.
 *
 * `getRelayAuthHeaders()` (the function that mints a signed device token
 * for relay auth when no MOTEBIT_API_TOKEN master token is present) used
 * to call `promptPassphrase()` unconditionally — it didn't honor
 * MOTEBIT_PASSPHRASE the way every other unlock prompt in the CLI does.
 * Result: any scripted use of `motebit credentials`, `motebit export`,
 * etc. silently hung waiting on a hidden TTY prompt that wasn't there.
 *
 * The fix routes MOTEBIT_PASSPHRASE through the auth path, matching
 * the pattern in apps/cli/src/index.ts:401, subcommands/rotate.ts:104,
 * subcommands/export.ts:44, subcommands/attest.ts:97. This test guards
 * the routing so it cannot silently regress.
 */

vi.mock("../config.js", () => ({
  CONFIG_DIR: "/tmp/motebit-test",
  loadFullConfig: vi.fn().mockReturnValue({
    motebit_id: "test-mote-id",
    device_id: "test-device-id",
    cli_encrypted_key: { ciphertext: "x", nonce: "y", tag: "z", salt: "s" },
  }),
  saveFullConfig: vi.fn(),
}));

vi.mock("../identity.js", () => ({
  fromHex: vi.fn().mockReturnValue(new Uint8Array(32)),
  promptPassphrase: vi.fn().mockResolvedValue("interactive-passphrase"),
  decryptPrivateKey: vi.fn().mockResolvedValue("a".repeat(64)),
}));

vi.mock("@motebit/encryption", () => ({
  createSignedToken: vi.fn().mockResolvedValue("fake.signed.token"),
  secureErase: vi.fn(),
}));

import { getRelayAuthHeaders } from "../subcommands/_helpers.js";
import { promptPassphrase } from "../identity.js";
import type { CliConfig } from "../args.js";

const promptPassphraseMock = vi.mocked(promptPassphrase);

const baseConfig: CliConfig = {
  command: "credentials",
  args: [],
  syncToken: undefined,
  syncUrl: "https://relay.test",
} as unknown as CliConfig;

describe("getRelayAuthHeaders — MOTEBIT_PASSPHRASE env routing", () => {
  beforeEach(() => {
    promptPassphraseMock.mockClear();
    delete process.env["MOTEBIT_PASSPHRASE"];
    delete process.env["MOTEBIT_API_TOKEN"];
    delete process.env["MOTEBIT_SYNC_TOKEN"];
  });

  afterEach(() => {
    delete process.env["MOTEBIT_PASSPHRASE"];
  });

  it("uses MOTEBIT_PASSPHRASE without prompting when env var is set", async () => {
    process.env["MOTEBIT_PASSPHRASE"] = "from-env";

    const headers = await getRelayAuthHeaders(baseConfig);

    expect(promptPassphraseMock).not.toHaveBeenCalled();
    expect(headers["Authorization"]).toBe("Bearer fake.signed.token");
  });

  it("falls back to interactive prompt when MOTEBIT_PASSPHRASE is not set", async () => {
    const headers = await getRelayAuthHeaders(baseConfig);

    expect(promptPassphraseMock).toHaveBeenCalledOnce();
    // Critical: the prompt label is "Passphrase: " — not "Passphrase
    // (for relay auth): ". The previous label implied a separate
    // passphrase concept that doesn't exist; the same encrypted key
    // unlocks every CLI auth path.
    expect(promptPassphraseMock).toHaveBeenCalledWith("Passphrase: ");
    expect(headers["Authorization"]).toBe("Bearer fake.signed.token");
  });

  it("master token shortcuts the passphrase path entirely", async () => {
    process.env["MOTEBIT_API_TOKEN"] = "master-token-value";
    // Even with MOTEBIT_PASSPHRASE set, master token takes precedence
    // and no decrypt-and-sign happens.
    process.env["MOTEBIT_PASSPHRASE"] = "would-have-been-used";

    const headers = await getRelayAuthHeaders(baseConfig);

    expect(promptPassphraseMock).not.toHaveBeenCalled();
    expect(headers["Authorization"]).toBe("Bearer master-token-value");
  });
});
