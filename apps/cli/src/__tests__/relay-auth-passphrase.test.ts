import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression: gap #6 from the 2026-04-25 first-time-user walkthrough.
 *
 * `getRelayAuthHeaders()` mints a signed device token for relay auth
 * when no MOTEBIT_API_TOKEN master token is present. The first-run UX
 * fix moved the passphrase / encrypted-key handling into the canonical
 * `loadActiveSigningKey` helper (`apps/cli/src/identity.ts`), so the
 * env-vs-prompt routing is tested at the helper level
 * (`identity-load-active-signing-key.test.ts`). What this file guards
 * is the contract `getRelayAuthHeaders` upholds at its boundary:
 *
 *   1. With MOTEBIT_API_TOKEN set, the passphrase / decrypt path is
 *      not exercised at all — master token shortcuts it.
 *   2. Without MOTEBIT_API_TOKEN, the helper is invoked, the returned
 *      private key signs the bearer token, and the token lands in the
 *      Authorization header.
 *   3. When the helper throws (key missing, decrypt failed, public-key
 *      mismatch), the request proceeds unauthenticated rather than
 *      crashing the command — preserving the prior posture for read-
 *      only flows that the relay accepts unauthenticated.
 */

const { TEST_CONFIG_DIR } = await vi.hoisted(async () => {
  // A config directory of this file's own: the operator token record is read
  // from it, never from the developer's ~/.motebit or a shared /tmp path.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  return { TEST_CONFIG_DIR: fs.mkdtempSync(p.join(os.tmpdir(), "motebit-relay-auth-cfg-")) };
});

vi.mock("../config.js", () => ({
  CONFIG_DIR: TEST_CONFIG_DIR,
  loadFullConfig: vi.fn().mockReturnValue({
    motebit_id: "test-mote-id",
    device_id: "test-device-id",
    cli_encrypted_key: { ciphertext: "x", nonce: "y", tag: "z", salt: "s" },
  }),
  saveFullConfig: vi.fn(),
}));

vi.mock("../identity.js", () => ({
  loadActiveSigningKey: vi.fn().mockResolvedValue({
    source: "encrypted-config",
    privateKey: new Uint8Array(32),
    publicKey: "a".repeat(64),
  }),
  IdentityKeyError: class IdentityKeyError extends Error {
    readonly kind: string;
    readonly remedy: string;
    constructor(kind: string, message: string, remedy: string) {
      super(message);
      this.name = "IdentityKeyError";
      this.kind = kind;
      this.remedy = remedy;
    }
  },
}));

vi.mock("@motebit/encryption", () => ({
  mintAudienceToken: vi.fn().mockResolvedValue({ token: "fake.signed.token", payload: {} }),
  secureErase: vi.fn(),
}));

import { getRelayAuthHeaders } from "../subcommands/_helpers.js";
import { bindOperatorTokenForTest } from "./bind-operator-token-for-test.js";

const RELAY = "https://relay.test";
import { loadActiveSigningKey } from "../identity.js";
import type { CliConfig } from "../args.js";

const loadActiveSigningKeyMock = vi.mocked(loadActiveSigningKey);

const baseConfig: CliConfig = {
  command: "credentials",
  args: [],
  syncToken: undefined,
  syncUrl: "https://relay.test",
} as unknown as CliConfig;

describe("getRelayAuthHeaders — boundary contract", () => {
  beforeEach(() => {
    loadActiveSigningKeyMock.mockClear();
    loadActiveSigningKeyMock.mockResolvedValue({
      source: "encrypted-config",
      privateKey: new Uint8Array(32),
      publicKey: "a".repeat(64),
    });
    delete process.env["MOTEBIT_PASSPHRASE"];
    delete process.env["MOTEBIT_API_TOKEN"];
    delete process.env["MOTEBIT_SYNC_TOKEN"];
  });

  afterEach(() => {
    delete process.env["MOTEBIT_PASSPHRASE"];
  });

  it("invokes loadActiveSigningKey and signs the bearer token when no master token is set", async () => {
    const headers = await getRelayAuthHeaders(baseConfig, RELAY);
    expect(loadActiveSigningKeyMock).toHaveBeenCalledOnce();
    expect(loadActiveSigningKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({ motebit_id: "test-mote-id" }),
      expect.objectContaining({ promptLabel: "Passphrase: " }),
    );
    expect(headers["Authorization"]).toBe("Bearer fake.signed.token");
  });

  it("a master token bound to the relay shortcuts the passphrase / signing path entirely", async () => {
    process.env["MOTEBIT_API_TOKEN"] = "master-token-value";
    bindOperatorTokenForTest(TEST_CONFIG_DIR, RELAY, "master-token-value");
    // Even with MOTEBIT_PASSPHRASE set, master token takes precedence
    // and the resolver is never called.
    process.env["MOTEBIT_PASSPHRASE"] = "would-have-been-used";

    const headers = await getRelayAuthHeaders(baseConfig, RELAY);

    expect(loadActiveSigningKeyMock).not.toHaveBeenCalled();
    expect(headers["Authorization"]).toBe("Bearer master-token-value");
  });

  it("downgrades to unauthenticated when the resolver throws (preserves read-only flows)", async () => {
    loadActiveSigningKeyMock.mockRejectedValueOnce(new Error("decrypt failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const headers = await getRelayAuthHeaders(baseConfig, RELAY);
      expect(headers["Authorization"]).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
