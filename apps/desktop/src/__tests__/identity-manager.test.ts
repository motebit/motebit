import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const mockCtrl = vi.hoisted(() => ({
  bootstrapResult: {
    motebitId: "test-motebit",
    deviceId: "test-device",
    publicKeyHex: "a".repeat(64),
    isFirstLaunch: false,
  },
  generateIdentityFileShouldThrow: false,
  verifyIdentityResult: {
    type: "identity" as const,
    valid: true as boolean,
    identity: null as unknown,
    errors: undefined as Array<{ message: string }> | undefined,
  },
  rotateResult: {
    newPublicKey: new Uint8Array(32),
    newPrivateKey: new Uint8Array(32),
    newPublicKeyHex: "b".repeat(64),
    successionRecord: { new_key: "b" },
  },
  rotateFileContent: "ROTATED",
  identityFileContent: "IDENTITY-FILE",
  parseResult: { frontmatter: { succession: ["one"] } },
  pairingClientImpl: null as unknown,
  keyTransferPayload: {
    identity_pubkey_check: "c".repeat(64),
    ciphertext: "ct",
    nonce: "n",
    ephemeral_pubkey: "ep",
  },
  decryptShouldThrow: false,
  walletHasValue: false,
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@motebit/core-identity", () => ({
  bootstrapIdentity: vi.fn(async () => mockCtrl.bootstrapResult),
  rotateIdentityKeys: vi.fn(async () => mockCtrl.rotateResult),
}));

vi.mock("@motebit/encryption", () => ({
  createSignedToken: vi.fn(async () => "signed-token"),
  hexPublicKeyToDidKey: vi.fn((hex: string) => `did:key:${hex.slice(0, 8)}`),
  secureErase: vi.fn(),
  bytesToHex: vi.fn((bytes: Uint8Array) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
  ),
  generateX25519Keypair: vi.fn(() => ({
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(32),
  })),
  generateKeypair: vi.fn(async () => ({
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(32),
  })),
  buildKeyTransferPayload: vi.fn(async () => mockCtrl.keyTransferPayload),
  decryptKeyTransfer: vi.fn(async () => {
    if (mockCtrl.decryptShouldThrow) throw new Error("decrypt failed");
    return new Uint8Array(32);
  }),
  checkPreTransferBalance: vi.fn(async () => ({
    hasAnyValue: mockCtrl.walletHasValue,
  })),
  formatWalletWarning: vi.fn(() => "wallet has funds — skipping key transfer"),
}));

vi.mock("@motebit/identity-file", () => ({
  generate: vi.fn(async () => {
    if (mockCtrl.generateIdentityFileShouldThrow) throw new Error("generate failed");
    return mockCtrl.identityFileContent;
  }),
  parse: vi.fn(() => mockCtrl.parseResult),
  verify: vi.fn(async () => mockCtrl.verifyIdentityResult),
  rotate: vi.fn(async () => mockCtrl.rotateFileContent),
}));

vi.mock("@motebit/sync-engine", () => {
  class PairingClient {
    constructor(public opts: { relayUrl: string }) {}
    initiate = vi.fn(async (_token: string) => ({
      pairingCode: "ABC123",
      pairingId: "pid-1",
    }));
    getSession = vi.fn(async (_id: string, _token: string) => ({
      pairing_code: "ABC123",
      claiming_x25519_pubkey: "",
    }));
    approve = vi.fn(async () => ({ deviceId: "new-device-id" }));
    deny = vi.fn(async () => undefined);
    claim = vi.fn(async () => ({ pairingId: "pid-2", motebitId: "adopted-id" }));
    pollStatus = vi.fn(async () => ({ status: "approved" as const }));
    updateDeviceKey = vi.fn(async () => undefined);
  }
  return { PairingClient };
});

// Mock ./index to avoid pulling the full DesktopApp class
vi.mock("../index.js", () => ({
  createTauriStorage: vi.fn(() => ({
    identityStorage: {},
    eventStore: {},
  })),
}));

import { IdentityManager } from "../identity-manager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvoke(config: Record<string, unknown> = {}) {
  let cfg: Record<string, unknown> = { ...config };
  return vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "read_config") return JSON.stringify(cfg);
    if (cmd === "write_config") {
      cfg = JSON.parse((args as { json: string }).json);
      return undefined;
    }
    if (cmd === "keyring_get") {
      return (cfg as Record<string, unknown>)[`__keyring_${(args as { key: string }).key}`] ?? null;
    }
    if (cmd === "keyring_set") {
      cfg[`__keyring_${(args as { key: string; value: string }).key}`] = (
        args as { key: string; value: string }
      ).value;
      return undefined;
    }
    if (cmd === "keyring_delete") {
      delete cfg[`__keyring_${(args as { key: string }).key}`];
      return undefined;
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  });
}

beforeEach(() => {
  mockCtrl.generateIdentityFileShouldThrow = false;
  mockCtrl.verifyIdentityResult = {
    type: "identity" as const,
    valid: true,
    identity: null,
    errors: undefined,
  };
  mockCtrl.decryptShouldThrow = false;
  mockCtrl.walletHasValue = false;
  mockCtrl.bootstrapResult = {
    motebitId: "test-motebit",
    deviceId: "test-device",
    publicKeyHex: "a".repeat(64),
    isFirstLaunch: false,
  };
});

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

describe("IdentityManager.bootstrap", () => {
  it("loads existing identity (not first launch)", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.bootstrap(invoke as any);
    expect(result.isFirstLaunch).toBe(false);
    expect(mgr.motebitId).toBe("test-motebit");
    expect(mgr.deviceId).toBe("test-device");
    expect(mgr.publicKey).toBe("a".repeat(64));
  });

  it("on first launch generates identity file (best-effort)", async () => {
    mockCtrl.bootstrapResult = { ...mockCtrl.bootstrapResult, isFirstLaunch: true };
    const mgr = new IdentityManager();
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.bootstrap(invoke as any);
    expect(result.isFirstLaunch).toBe(true);
  });

  it("first launch swallows identity-file generation errors", async () => {
    mockCtrl.bootstrapResult = { ...mockCtrl.bootstrapResult, isFirstLaunch: true };
    mockCtrl.generateIdentityFileShouldThrow = true;
    const mgr = new IdentityManager();
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.bootstrap(invoke as any);
    expect(result.isFirstLaunch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getDeviceKeypair
// ---------------------------------------------------------------------------

describe("IdentityManager.getDeviceKeypair", () => {
  it("returns null when no device_public_key", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kp = await mgr.getDeviceKeypair(invoke as any);
    expect(kp).toBeNull();
  });

  it("returns null when no private key in keyring", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({ device_public_key: "aa" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kp = await mgr.getDeviceKeypair(invoke as any);
    expect(kp).toBeNull();
  });

  it("returns null when keyring throws", async () => {
    const mgr = new IdentityManager();
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "read_config") return JSON.stringify({ device_public_key: "aa" });
      if (cmd === "keyring_get") throw new Error("keychain denied");
      throw new Error("unexpected");
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kp = await mgr.getDeviceKeypair(invoke as any);
    expect(kp).toBeNull();
  });

  it("returns keypair when both parts present", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kp = await mgr.getDeviceKeypair(invoke as any);
    expect(kp?.publicKey).toBe("a".repeat(64));
    expect(kp?.privateKey).toBe("b".repeat(64));
  });
});

// ---------------------------------------------------------------------------
// registerWithRelay
// ---------------------------------------------------------------------------

describe("IdentityManager.registerWithRelay", () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (_url: unknown, _init?: unknown) => ({
      ok: true,
      status: 200,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
  });

  it("returns null when no keypair", async () => {
    const mgr = new IdentityManager();
    mgr.motebitId = "m";
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = await mgr.registerWithRelay(invoke as any, "https://relay", "master");
    expect(token).toBeNull();
    globalThis.fetch = origFetch;
  });

  it("creates identity when not found, then registers device, returns token", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 }) // identity check
      .mockResolvedValueOnce({ ok: true, status: 200 }) // create identity
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce({ ok: true, status: 200 }) as any;
    const mgr = new IdentityManager();
    mgr.motebitId = "mot";
    mgr.deviceId = "dev";
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = await mgr.registerWithRelay(invoke as any, "https://r", "tok");
    expect(token).toBe("signed-token");
    globalThis.fetch = origFetch;
  });

  it("skips identity create when it already exists", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce({ ok: true, status: 200 }) as any;
    const mgr = new IdentityManager();
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = await mgr.registerWithRelay(invoke as any, "https://r", "tok");
    expect(token).toBe("signed-token");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // check + register, no create
    globalThis.fetch = origFetch;
  });
});

// ---------------------------------------------------------------------------
// createSyncToken
// ---------------------------------------------------------------------------

describe("IdentityManager.createSyncToken", () => {
  it("creates a signed token with default audience 'sync'", async () => {
    const mgr = new IdentityManager();
    const token = await mgr.createSyncToken("cc".repeat(32));
    expect(token).toBe("signed-token");
  });

  it("supports custom audience", async () => {
    const mgr = new IdentityManager();
    const token = await mgr.createSyncToken("cc".repeat(32), "task:submit");
    expect(token).toBe("signed-token");
  });
});

// ---------------------------------------------------------------------------
// getIdentityInfo
// ---------------------------------------------------------------------------

describe("IdentityManager.getIdentityInfo", () => {
  it("returns snapshot + did:key", () => {
    const mgr = new IdentityManager();
    mgr.motebitId = "m1";
    mgr.deviceId = "d1";
    mgr.publicKey = "abcd";
    const info = mgr.getIdentityInfo();
    expect(info.motebitId).toBe("m1");
    expect(info.deviceId).toBe("d1");
    expect(info.publicKey).toBe("abcd");
    expect(info.did).toBe("did:key:abcd");
  });

  it("returns empty did when publicKey is empty", () => {
    const mgr = new IdentityManager();
    const info = mgr.getIdentityInfo();
    expect(info.did).toBe("");
  });
});

// ---------------------------------------------------------------------------
// exportIdentityFile
// ---------------------------------------------------------------------------

describe("IdentityManager.exportIdentityFile", () => {
  it("returns null when no keypair", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.exportIdentityFile(invoke as any);
    expect(result).toBeNull();
  });

  it("returns identity file content with default governance", async () => {
    const mgr = new IdentityManager();
    mgr.motebitId = "m1";
    mgr.publicKey = "a".repeat(64);
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.exportIdentityFile(invoke as any);
    expect(result).toBe("IDENTITY-FILE");
  });

  it("supports cautious preset", async () => {
    const mgr = new IdentityManager();
    mgr.motebitId = "m1";
    mgr.publicKey = "a".repeat(64);
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
      approval_preset: "cautious",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.exportIdentityFile(invoke as any);
    expect(result).toBe("IDENTITY-FILE");
  });

  it("supports autonomous preset", async () => {
    const mgr = new IdentityManager();
    mgr.motebitId = "m1";
    mgr.publicKey = "a".repeat(64);
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
      approval_preset: "autonomous",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.exportIdentityFile(invoke as any);
    expect(result).toBe("IDENTITY-FILE");
  });

  it("supports custom memory_governance", async () => {
    const mgr = new IdentityManager();
    mgr.motebitId = "m1";
    mgr.publicKey = "a".repeat(64);
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
      memory_governance: { persistence_threshold: 0.5, reject_secrets: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.exportIdentityFile(invoke as any);
    expect(result).toBe("IDENTITY-FILE");
  });
});

// ---------------------------------------------------------------------------
// verifyIdentityFile
// ---------------------------------------------------------------------------

describe("IdentityManager.verifyIdentityFile", () => {
  it("passes through validity + error", async () => {
    const mgr = new IdentityManager();
    const r1 = await mgr.verifyIdentityFile("valid");
    expect(r1.valid).toBe(true);

    mockCtrl.verifyIdentityResult = {
      type: "identity" as const,
      valid: false,
      identity: null,
      errors: [{ message: "bad sig" }],
    };
    const r2 = await mgr.verifyIdentityFile("invalid");
    expect(r2.valid).toBe(false);
    expect(r2.error).toBe("bad sig");
  });
});

// ---------------------------------------------------------------------------
// rotateKey
// ---------------------------------------------------------------------------

describe("IdentityManager.rotateKey", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({ ok: true })) as never;
  });

  it("throws when no keypair", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(mgr.rotateKey(invoke as any)).rejects.toThrow(/No device keypair/);
    globalThis.fetch = origFetch;
  });

  it("rotates with existing identity file (succession path)", async () => {
    const mgr = new IdentityManager();
    mgr.motebitId = "m1";
    mgr.publicKey = "a".repeat(64);
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
      _identity_file: "OLD-IDENTITY",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.rotateKey(invoke as any, "scheduled rotation");
    expect(result.newKeyFingerprint).toBeTruthy();
    expect(result.rotationCount).toBe(1);
    expect(mgr.publicKey).toBe("b".repeat(64));
    globalThis.fetch = origFetch;
  });

  it("rotates without identity file (raw keypair path)", async () => {
    const mgr = new IdentityManager();
    mgr.motebitId = "m1";
    mgr.publicKey = "a".repeat(64);
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.rotateKey(invoke as any);
    expect(result.newKeyFingerprint).toBeTruthy();
    globalThis.fetch = origFetch;
  });

  it("best-effort relay update after rotation", async () => {
    const mgr = new IdentityManager();
    mgr.motebitId = "m1";
    mgr.publicKey = "a".repeat(64);
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
      sync_url: "https://relay",
      sync_master_token: "mtok",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.rotateKey(invoke as any);
    expect(globalThis.fetch).toHaveBeenCalled();
    globalThis.fetch = origFetch;
  });

  it("swallows relay update failures", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("relay down");
    }) as never;
    const mgr = new IdentityManager();
    mgr.motebitId = "m1";
    mgr.publicKey = "a".repeat(64);
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
      sync_url: "https://relay",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(mgr.rotateKey(invoke as any)).resolves.toBeDefined();
    globalThis.fetch = origFetch;
  });
});

// ---------------------------------------------------------------------------
// Pairing (Device A)
// ---------------------------------------------------------------------------

describe("IdentityManager.initiatePairing", () => {
  it("throws when no keypair", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(mgr.initiatePairing(invoke as any, "https://relay")).rejects.toThrow(
      /No device keypair/,
    );
  });

  it("returns pairingCode + pairingId from client", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.initiatePairing(invoke as any, "https://relay");
    expect(result.pairingCode).toBe("ABC123");
    expect(result.pairingId).toBe("pid-1");
  });
});

describe("IdentityManager.getPairingSession", () => {
  it("throws when no keypair", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mgr.getPairingSession(invoke as any, "https://relay", "pid-1"),
    ).rejects.toThrow(/No device keypair/);
  });

  it("returns session", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await mgr.getPairingSession(invoke as any, "https://relay", "pid-1");
    expect(session).toBeDefined();
  });
});

describe("IdentityManager.approvePairing", () => {
  it("throws when no keypair", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(mgr.approvePairing(invoke as any, "https://relay", "pid-1")).rejects.toThrow();
  });

  it("approves without key transfer when no claiming_x25519_pubkey", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.approvePairing(invoke as any, "https://relay", "pid-1");
    expect(result.deviceId).toBe("new-device-id");
  });
});

describe("IdentityManager.denyPairing", () => {
  it("throws when no keypair", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(mgr.denyPairing(invoke as any, "https://relay", "pid-1")).rejects.toThrow();
  });

  it("calls client.deny", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "b".repeat(64),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(mgr.denyPairing(invoke as any, "https://relay", "pid-1")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pairing (Device B)
// ---------------------------------------------------------------------------

describe("IdentityManager.claimPairing", () => {
  it("throws when public key is missing", async () => {
    const mgr = new IdentityManager();
    mgr.publicKey = "";
    await expect(mgr.claimPairing("https://relay", "code123")).rejects.toThrow(/bootstrap first/);
  });

  it("returns pairing info + ephemeral key", async () => {
    const mgr = new IdentityManager();
    mgr.publicKey = "a".repeat(64);
    const result = await mgr.claimPairing("https://relay", "code");
    expect(result.pairingId).toBe("pid-2");
    expect(result.motebitId).toBe("adopted-id");
    expect(result.ephemeralPrivateKey).toBeInstanceOf(Uint8Array);
  });
});

describe("IdentityManager.pollPairingStatus", () => {
  it("returns status from client", async () => {
    const mgr = new IdentityManager();
    const status = await mgr.pollPairingStatus("https://relay", "pid-1");
    expect(status.status).toBe("approved");
  });
});

describe("IdentityManager.completePairing", () => {
  it("stores motebitId + deviceId without key transfer", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    const result = await mgr.completePairing(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke as any,
      { motebitId: "new-mot", deviceId: "new-dev" },
    );
    expect(result).toBeUndefined();
    expect(mgr.motebitId).toBe("new-mot");
    expect(mgr.deviceId).toBe("new-dev");
  });

  it("installs identity key when no existing wallet balance", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({
      __keyring_device_private_key: "b".repeat(64),
    });
    const result = await mgr.completePairing(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke as any,
      { motebitId: "new-mot", deviceId: "new-dev" },
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        keyTransfer: mockCtrl.keyTransferPayload as any,
        ephemeralPrivateKey: new Uint8Array(32),
        pairingCode: "ABC",
        syncUrl: "https://relay",
        pairingId: "pid-1",
      },
    );
    expect(result).toBeUndefined(); // No warning — wallet empty
    expect(mgr.publicKey).toBe(mockCtrl.keyTransferPayload.identity_pubkey_check);
  });

  it("returns wallet warning and skips key install when old wallet has funds", async () => {
    mockCtrl.walletHasValue = true;
    const mgr = new IdentityManager();
    const invoke = makeInvoke({
      __keyring_device_private_key: "b".repeat(64),
    });
    const result = await mgr.completePairing(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke as any,
      { motebitId: "new-mot", deviceId: "new-dev" },
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        keyTransfer: mockCtrl.keyTransferPayload as any,
        ephemeralPrivateKey: new Uint8Array(32),
        pairingCode: "ABC",
        syncUrl: "https://relay",
        pairingId: "pid-1",
      },
    );
    expect(result).toBe("wallet has funds — skipping key transfer");
  });

  it("swallows decrypt failure", async () => {
    mockCtrl.decryptShouldThrow = true;
    const mgr = new IdentityManager();
    const invoke = makeInvoke({
      __keyring_device_private_key: "b".repeat(64),
    });
    const result = await mgr.completePairing(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke as any,
      { motebitId: "new-mot", deviceId: "new-dev" },
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        keyTransfer: mockCtrl.keyTransferPayload as any,
        ephemeralPrivateKey: new Uint8Array(32),
        pairingCode: "ABC",
        syncUrl: "https://relay",
        pairingId: "pid-1",
      },
    );
    // Best-effort — completes without crashing
    expect(mgr.motebitId).toBe("new-mot");
    expect(result).toBeUndefined();
  });
});
