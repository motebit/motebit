import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const mockCtrl = vi.hoisted(() => ({
  // Rotation (#709): what the relay says it holds, and what it answers a submission.
  relayState: { state: "current", relayKey: "a".repeat(64), chain: [] } as unknown,
  submitResult: { ok: true, applied: true } as unknown,
  submissions: [] as unknown[],
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
  restoreValidateReason: null as string | null,
  writeRestoredIdentityCalls: [] as Array<{ bornAtMs: number; motebitId: string }>,
  lastBootstrapOpts: null as unknown,
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@motebit/core-identity", () => ({
  bootstrapIdentity: vi.fn(async (opts: unknown) => {
    mockCtrl.lastBootstrapOpts = opts;
    return mockCtrl.bootstrapResult;
  }),
  rotateIdentityKeys: vi.fn(async () => mockCtrl.rotateResult),
  writeRestoredIdentity: vi.fn(async (opts: { bornAtMs: number; motebitId: string }) => {
    mockCtrl.writeRestoredIdentityCalls.push(opts);
  }),
}));

vi.mock("@motebit/encryption", async (importOriginal) => ({
  // The shared rotation controller (@motebit/surface-kit) derives the
  // departing public key from the private key it holds and parses hex; those
  // two stay real so a 32-byte test seed behaves like a key.
  getPublicKeyBySuite: (await importOriginal<typeof import("@motebit/encryption")>())
    .getPublicKeyBySuite,
  hexToBytes: (await importOriginal<typeof import("@motebit/encryption")>()).hexToBytes,
  mintAudienceToken: vi.fn(async () => ({ token: "signed-token", payload: {} })),
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
  importIdentityFile: vi.fn(async () => ({ valid: false, reason: "not-mocked" })),
  parse: vi.fn(() => mockCtrl.parseResult),
  validateRestoreRequest: vi.fn(async () => mockCtrl.restoreValidateReason),
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
  return {
    PairingClient,
    readSuccessionState: vi.fn(async () => mockCtrl.relayState),
    submitSuccessionToRelay: vi.fn(async (req: unknown) => {
      mockCtrl.submissions.push(req);
      return mockCtrl.submitResult;
    }),
  };
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

/**
 * A fake of the Rust IPC with the SAME contract the Rust tests pin
 * (src-tauri/src/{config_file,key_store}.rs): `update_config` merges (null
 * removes), honours `expect`, and refuses `cli_*` fields; key material
 * (`device_private_key`, `pending_rotation`, `pending_identity_switch`) is
 * never destroyed — a different overwrite, a delete and a set-aside keep the
 * old value as `<name>.preserved-<n>`. Keyring entries live in the same map
 * as `__keyring_<name>` so a test can read the whole machine state at once.
 */
const KEY_MATERIAL = ["device_private_key", "pending_rotation", "pending_identity_switch"];
function makeInvoke(config: Record<string, unknown> = {}) {
  let cfg: Record<string, unknown> = { ...config };
  let preservedSeq = 0;
  const kk = (name: string) => `__keyring_${name}`;
  const preserve = (name: string) => {
    const old = cfg[kk(name)];
    if (old !== undefined) cfg[kk(`${name}.preserved-${preservedSeq++}`)] = old;
  };
  return vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "read_config") return JSON.stringify(cfg);
    if (cmd === "write_config") {
      cfg = JSON.parse((args as { json: string }).json);
      return undefined;
    }
    if (cmd === "update_config") {
      const patch = JSON.parse((args as { patch: string }).patch) as Record<string, unknown>;
      const expectRaw = (args as { expect?: string }).expect;
      if (Object.keys(patch).some((k) => k.startsWith("cli_"))) {
        throw new Error("Refusing to update config: cli_* is owned by the motebit CLI");
      }
      if (expectRaw !== undefined) {
        for (const [k, want] of Object.entries(JSON.parse(expectRaw) as Record<string, unknown>)) {
          if (JSON.stringify(cfg[k] ?? null) !== JSON.stringify(want)) {
            throw new Error(`Refusing to update config: ${k} changed since it was read`);
          }
        }
      }
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete cfg[k];
        else cfg[k] = v;
      }
      return undefined;
    }
    if (cmd === "keyring_get") {
      return (cfg as Record<string, unknown>)[kk((args as { key: string }).key)] ?? null;
    }
    if (cmd === "keyring_set") {
      const { key, value } = args as { key: string; value: string };
      if (KEY_MATERIAL.includes(key) && cfg[kk(key)] !== undefined && cfg[kk(key)] !== value) {
        preserve(key);
      }
      cfg[kk(key)] = value;
      return undefined;
    }
    if (cmd === "keyring_delete" || cmd === "keyring_set_aside") {
      const { key } = args as { key: string };
      if (cmd === "keyring_set_aside" || KEY_MATERIAL.includes(key)) preserve(key);
      delete cfg[kk(key)];
      return undefined;
    }
    if (cmd === "db_execute") {
      // No-op stub: tests that assert UPDATE SQL inspect the call
      // arguments via the mock's recorded calls; tests that don't
      // exercise the migration path simply get 0 rows affected.
      return 0;
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
  mockCtrl.restoreValidateReason = null;
  mockCtrl.writeRestoredIdentityCalls = [];
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
// restoreIdentity — side-effecting restore from imported metadata
// ---------------------------------------------------------------------------

describe("IdentityManager.restoreIdentity", () => {
  const sampleMetadata = {
    motebitId: "restored-motebit",
    publicKey: "a".repeat(64),
    ownerId: "restored-owner",
    bornAt: "2025-11-12T00:00:00.000Z",
    devices: [],
    governance: {
      trust_mode: "guarded" as const,
      max_risk_auto: "R1_DRAFT",
      require_approval_above: "R1_DRAFT",
      deny_above: "R4_MONEY",
      operator_mode: false,
    },
    memory: { half_life_days: 7, confidence_threshold: 0.3, per_turn_limit: 5 },
  };

  it("returns the typed reason when validation fails (key_mismatch)", async () => {
    const mgr = new IdentityManager();
    mockCtrl.restoreValidateReason = "key_mismatch";
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.restoreIdentity(invoke as any, {
      privateKeyHex: "b".repeat(64),
      metadata: sampleMetadata,
      preserveMemories: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("key_mismatch");
  });

  it("writes keystore + config, returns ok with needsReload on success", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.restoreIdentity(invoke as any, {
      privateKeyHex: "b".repeat(64),
      metadata: sampleMetadata,
      preserveMemories: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.motebitId).toBe("restored-motebit");
    expect(result.needsReload).toBe(true);

    expect(invoke).toHaveBeenCalledWith("keyring_set", {
      key: "device_private_key",
      value: "b".repeat(64),
    });
    const cfg = JSON.parse((await invoke("read_config")) as string) as Record<string, unknown>;
    expect(cfg.motebit_id).toBe("restored-motebit");
    expect(cfg.device_public_key).toBe("a".repeat(64));
    expect(cfg.device_id).toMatch(/[a-f0-9-]{36}/);
    // The switch write-ahead is gone from the active slot once done.
    expect(cfg.__keyring_pending_identity_switch).toBeUndefined();
  });

  it("preserves originalContent in `_identity_file` when supplied (motebit.md path)", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.restoreIdentity(invoke as any, {
      privateKeyHex: "b".repeat(64),
      metadata: sampleMetadata,
      originalContent: "---SIGNED-MD-CONTENT---",
      preserveMemories: false,
    });
    const cfg = JSON.parse((await invoke("read_config")) as string) as Record<string, unknown>;
    expect(cfg._identity_file).toBe("---SIGNED-MD-CONTENT---");
  });

  it("clears stale `_identity_file` from config when originalContent is omitted (seed-only path)", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({ _identity_file: "OLD-SIGNED-MD" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.restoreIdentity(invoke as any, {
      privateKeyHex: "b".repeat(64),
      metadata: sampleMetadata,
      preserveMemories: false,
    });
    const cfg = JSON.parse((await invoke("read_config")) as string) as Record<string, unknown>;
    expect(cfg._identity_file).toBeUndefined();
  });

  it("returns 'keystore_write_failed' when keyring_set throws", async () => {
    const mgr = new IdentityManager();
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "keyring_set") throw new Error("keyring locked");
      throw new Error(`unexpected: ${cmd}`);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.restoreIdentity(invoke as any, {
      privateKeyHex: "b".repeat(64),
      metadata: sampleMetadata,
      preserveMemories: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("keystore_write_failed");
  });

  it("issues UPDATE SQL for the four memory-shaped tables when preserveMemories=true", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({ motebit_id: "old-motebit-id" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.restoreIdentity(invoke as any, {
      privateKeyHex: "b".repeat(64),
      metadata: sampleMetadata,
      preserveMemories: true,
    });
    expect(result.ok).toBe(true);

    const updateSqls = (invoke as ReturnType<typeof vi.fn>).mock.calls
      .filter(([cmd]) => cmd === "db_execute")
      .map(([, args]) => (args as { sql: string }).sql);
    // The migration touches exactly the four memory-shaped tables.
    expect(updateSqls).toEqual([
      "UPDATE conversations SET motebit_id = ? WHERE motebit_id = ?",
      "UPDATE memory_nodes SET motebit_id = ? WHERE motebit_id = ?",
      "UPDATE plans SET motebit_id = ? WHERE motebit_id = ?",
      "UPDATE agent_trust SET motebit_id = ? WHERE motebit_id = ?",
    ]);
    // The migration uses the OLD motebit_id from config, not the new one.
    const migrationParams = (invoke as ReturnType<typeof vi.fn>).mock.calls
      .filter(([cmd]) => cmd === "db_execute")
      .map(([, args]) => (args as { params: unknown[] }).params);
    expect(migrationParams[0]).toEqual(["restored-motebit", "old-motebit-id"]);
  });

  it("pre-writes the IdentityCreated event with the historical bornAt (born-date fidelity)", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.restoreIdentity(invoke as any, {
      privateKeyHex: "b".repeat(64),
      metadata: { ...sampleMetadata, bornAt: "2024-11-12T08:30:00.000Z" },
      preserveMemories: false,
    });
    expect(mockCtrl.writeRestoredIdentityCalls).toHaveLength(1);
    expect(mockCtrl.writeRestoredIdentityCalls[0]!.motebitId).toBe("restored-motebit");
    expect(mockCtrl.writeRestoredIdentityCalls[0]!.bornAtMs).toBe(
      Date.parse("2024-11-12T08:30:00.000Z"),
    );
  });

  it("skips the bornAt pre-write when bornAt is unparseable (best-effort path)", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.restoreIdentity(invoke as any, {
      privateKeyHex: "b".repeat(64),
      metadata: { ...sampleMetadata, bornAt: "not-a-date" },
      preserveMemories: false,
    });
    expect(result.ok).toBe(true);
    expect(mockCtrl.writeRestoredIdentityCalls).toHaveLength(0);
  });

  it("returns 'memory_migration_failed' when the db UPDATE throws", async () => {
    const mgr = new IdentityManager();
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "read_config") return JSON.stringify({ motebit_id: "old-motebit-id" });
      if (cmd === "db_execute") throw new Error("sqlite error");
      throw new Error(`unexpected: ${cmd}`);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.restoreIdentity(invoke as any, {
      privateKeyHex: "b".repeat(64),
      metadata: sampleMetadata,
      preserveMemories: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("memory_migration_failed");
  });
});

// ---------------------------------------------------------------------------
// rotateKey
// ---------------------------------------------------------------------------

describe("IdentityManager.rotateKey", () => {
  // The state machine lives in @motebit/surface-kit; these pin the desktop
  // adapter's plumbing to it: which key signs, what is written where, and —
  // the inversion of the old tests — that a relay failure REJECTS instead of
  // being swallowed after local state already moved.
  const SEED = "b".repeat(64);
  // The published key must be what SEED derives to: the shared controller
  // reads it as a second witness, and a fixture that contradicts the key
  // it holds is the torn-commit state, not a healthy device.
  let PUB = "";
  beforeAll(async () => {
    const real = await vi.importActual<typeof import("@motebit/encryption")>("@motebit/encryption");
    PUB = real.bytesToHex(
      await real.getPublicKeyBySuite(real.hexToBytes(SEED), "motebit-jcs-ed25519-hex-v1"),
    );
  });
  beforeEach(() => {
    mockCtrl.relayState = { state: "current", relayKey: PUB, chain: [] };
    mockCtrl.submitResult = { ok: true, applied: true };
    mockCtrl.submissions = [];
  });
  function manager(config: Record<string, unknown>) {
    const mgr = new IdentityManager();
    mgr.motebitId = "m1";
    mgr.deviceId = "d1";
    mgr.publicKey = PUB;
    const invoke = makeInvoke({
      device_public_key: PUB,
      __keyring_device_private_key: SEED,
      ...config,
    });
    return { mgr, invoke };
  }
  it("rejects when no private key is held; nothing changes", async () => {
    const mgr = new IdentityManager();
    const invoke = makeInvoke({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(mgr.rotateKey(invoke as any)).rejects.toThrow(/no private key/);
    expect(invoke).not.toHaveBeenCalledWith("keyring_set", expect.anything());
  });
  it("reads the relay, submits signed by the RETIRING key, and commits only after the relay confirms", async () => {
    const { mgr, invoke } = manager({ sync_url: "https://relay", _identity_file: "OLD-IDENTITY" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mgr.rotateKey(invoke as any, "scheduled rotation");
    expect(mockCtrl.submissions).toHaveLength(1);
    const sub = mockCtrl.submissions[0] as { signingKey: Uint8Array; deviceId: string };
    expect(Array.from(sub.signingKey)).toEqual(Array.from(Buffer.from(SEED, "hex")));
    expect(sub.deviceId).toBe("d1");
    expect(result.newKeyFingerprint).toBeTruthy();
    expect(mgr.publicKey).toBe(mockCtrl.rotateResult.newPublicKeyHex);
    // Identity file re-signed on commit; write-ahead cleared.
    const cfg = JSON.parse((await invoke("read_config")) as string) as Record<string, unknown>;
    expect(cfg._identity_file).toBe(mockCtrl.rotateFileContent);
    expect(cfg.__keyring_pending_rotation).toBeUndefined();
    // The commit is a compare-and-swap merge on the identity file it signed
    // over (a CLI rotation that changed it in between is refused, not reverted)…
    expect(invoke).toHaveBeenCalledWith("update_config", {
      patch: expect.any(String),
      expect: JSON.stringify({ _identity_file: "OLD-IDENTITY" }),
    });
    // …and the retired key is kept (founder ruling: erased only after the
    // relay accepted the succession — permitted, never required).
    const kept = Object.entries(cfg)
      .filter(([k]) => k.startsWith("__keyring_device_private_key.preserved-"))
      .map(([, v]) => v);
    expect(kept).toEqual([SEED]);
  });
  it("always mints a succession — an identity without an identity file no longer gets a raw keypair the relay cannot accept", async () => {
    const { mgr, invoke } = manager({ sync_url: "https://relay" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.rotateKey(invoke as any);
    expect(mockCtrl.submissions).toHaveLength(1);
    expect((mockCtrl.submissions[0] as { record: unknown }).record).toEqual(
      mockCtrl.rotateResult.successionRecord,
    );
  });
  it("no relay configured ⇒ rotates locally, reads nothing, submits nothing", async () => {
    const { mgr, invoke } = manager({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.rotateKey(invoke as any);
    expect(mockCtrl.submissions).toHaveLength(0);
    expect(mgr.publicKey).toBe(mockCtrl.rotateResult.newPublicKeyHex);
  });
  it("relay unreachable ⇒ REJECTS and the old key is untouched (the inversion of 'swallows relay failures')", async () => {
    mockCtrl.relayState = { state: "unreachable", reason: "ECONNREFUSED" };
    const { mgr, invoke } = manager({ sync_url: "https://relay" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(mgr.rotateKey(invoke as any)).rejects.toThrow(/could not be read/);
    expect(mgr.publicKey).toBe(PUB);
    const cfg = JSON.parse((await invoke("read_config")) as string) as Record<string, unknown>;
    expect(cfg.__keyring_device_private_key).toBe(SEED);
    expect(cfg.__keyring_pending_rotation).toBeUndefined();
  });
  it("relay refuses ⇒ REJECTS, nothing local changes, the write-ahead is removed", async () => {
    mockCtrl.submitResult = {
      ok: false,
      kind: "refused",
      status: 400,
      reason: "not from current key",
    };
    const { mgr, invoke } = manager({ sync_url: "https://relay" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(mgr.rotateKey(invoke as any)).rejects.toThrow(/refused/);
    const cfg = JSON.parse((await invoke("read_config")) as string) as Record<string, unknown>;
    expect(cfg.__keyring_device_private_key).toBe(SEED);
    expect(cfg.__keyring_pending_rotation).toBeUndefined();
  });
  it("lost answer ⇒ REJECTS as held; the write-ahead stays in the keyring for the next run", async () => {
    mockCtrl.submitResult = { ok: false, kind: "unknown", reason: "socket hang up" };
    const { mgr, invoke } = manager({ sync_url: "https://relay" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(mgr.rotateKey(invoke as any)).rejects.toThrow(/lost/);
    const cfg = JSON.parse((await invoke("read_config")) as string) as Record<string, unknown>;
    expect(cfg.__keyring_device_private_key).toBe(SEED);
    expect(typeof cfg.__keyring_pending_rotation).toBe("string");
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

// ---------------------------------------------------------------------------
// Key-file durability, build 3 (desktop): R1 on the key probe, the CLI's
// identity is never minted over, and identity switches (restore / pairing)
// keep what they replace and cannot be left half-done.
// ---------------------------------------------------------------------------

type Stores = {
  configStore: { write(s: Record<string, string>): Promise<void> };
  keyStore: { hasPrivateKey(): Promise<boolean> };
};
async function storesFor(
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<Stores> {
  const mgr = new IdentityManager();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await mgr.bootstrap(invoke as any);
  return mockCtrl.lastBootstrapOpts as Stores;
}

describe("bootstrap key probe (C1: R1)", () => {
  it("a keyring that cannot be read REJECTS — never 'no key', so nothing is minted over it", async () => {
    const base = makeInvoke({ motebit_id: "m-A", device_public_key: "a".repeat(64) });
    const locked = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "keyring_get" && (args as { key: string }).key === "device_private_key") {
        throw new Error("keychain read of device_private_key failed: locked");
      }
      return base(cmd, args);
    });
    const stores = await storesFor(locked);
    await expect(stores.keyStore.hasPrivateKey()).rejects.toThrow(/locked/);
    // Sanity: the healthy probe answers a true absence as false.
    const healthy = await storesFor(base);
    await expect(healthy.keyStore.hasPrivateKey()).resolves.toBe(false);
  });

  it("refuses to treat the CLI's identity as orphaned when the desktop has no key for it", async () => {
    const invoke = makeInvoke({
      motebit_id: "m-cli",
      device_public_key: "c".repeat(64),
      cli_encrypted_key: { ciphertext: "KEY" },
    });
    const { keyStore, configStore } = await storesFor(invoke);
    await expect(keyStore.hasPrivateKey()).rejects.toThrow(/motebit CLI's identity m-cli/);
    // …and the config writer will not rebind it either.
    await expect(
      configStore.write({ motebit_id: "m-new", device_id: "d", device_public_key: "d".repeat(64) }),
    ).rejects.toThrow(/will not mint a new identity over it/);
    const cfg = JSON.parse((await invoke("read_config")) as string) as Record<string, unknown>;
    expect(cfg.motebit_id).toBe("m-cli");
  });

  it("after a real `motebit migrate-keyring` (#766 F1): refuses, lists the moved-aside keyring, and restore still works", async () => {
    // The whole outcome of the #765 trigger: migrate-keyring wrote
    // cli_encrypted_key into config.json and moved this desktop's
    // dev-keyring.json aside, so the desktop holds no key. Bootstrap stops
    // at the CLI refusal (main re-minted over the CLI's key instead) and
    // names where this desktop's own key went — a listing, no inference.
    const moved = "/home/u/.motebit/dev-keyring.json.migrated-2026-09-25T00-00-00-000Z";
    const base = makeInvoke({
      motebit_id: "m-cli",
      device_id: "d-cli",
      device_public_key: "c".repeat(64),
      cli_encrypted_key: { ciphertext: "KEY" },
    });
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) =>
      cmd === "keyring_retired_copies" ? [moved] : base(cmd, args),
    );
    const { keyStore, configStore } = await storesFor(invoke);
    const refusal = keyStore.hasPrivateKey();
    await expect(refusal).rejects.toThrow(/motebit CLI's identity m-cli/);
    await expect(refusal).rejects.toThrow(moved);
    await expect(refusal).rejects.toThrow(
      /moving that file back to ~\/\.motebit\/dev-keyring\.json/,
    );
    await expect(refusal).rejects.not.toThrow(/keychain/i);
    await expect(
      configStore.write({ motebit_id: "m-new", device_id: "d", device_public_key: "d".repeat(64) }),
    ).rejects.toThrow(moved);

    // Restore (Settings → Identity → Restore) still succeeds on this machine.
    const r = await new IdentityManager().restoreIdentity(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke as any,
      {
        privateKeyHex: "KEY-B",
        metadata: {
          motebitId: "m-B",
          publicKey: "b".repeat(64),
          ownerId: "o",
          bornAt: "not-a-date",
          devices: [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        preserveMemories: false,
      },
    );
    expect(r.ok).toBe(true);
    const cfg = JSON.parse((await invoke("read_config")) as string) as Record<string, unknown>;
    expect(cfg.motebit_id).toBe("m-B");
    expect(cfg.__keyring_device_private_key).toBe("KEY-B");
    expect(cfg.cli_encrypted_key).toEqual({ ciphertext: "KEY" });
  });

  it("the CLI refusal lists nothing when no keyring was moved aside (or the listing fails)", async () => {
    const invoke = makeInvoke({
      motebit_id: "m-cli",
      device_public_key: "c".repeat(64),
      cli_encrypted_key: { ciphertext: "KEY" },
    });
    const { keyStore } = await storesFor(invoke);
    await expect(keyStore.hasPrivateKey()).rejects.not.toThrow(/may be in/);
  });

  it("first-launch config write is a field merge (update_config), never a whole-file write", async () => {
    const invoke = makeInvoke({ theme: "dark" });
    const { configStore } = await storesFor(invoke);
    await configStore.write({ motebit_id: "m-1", device_id: "d-1", device_public_key: "p" });
    const cmds = invoke.mock.calls.map(([c]) => c);
    expect(cmds).toContain("update_config");
    expect(cmds).not.toContain("write_config");
    const cfg = JSON.parse((await invoke("read_config")) as string) as Record<string, unknown>;
    expect(cfg).toMatchObject({ motebit_id: "m-1", theme: "dark" });
  });
});

describe("identity switch (C5 restore, C6 pairing)", () => {
  const meta = {
    motebitId: "m-B",
    publicKey: "b".repeat(64),
    ownerId: "o",
    bornAt: "not-a-date",
    devices: [],
    governance: {
      trust_mode: "guarded" as const,
      max_risk_auto: "R1_DRAFT",
      require_approval_above: "R1_DRAFT",
      deny_above: "R4_MONEY",
      operator_mode: false,
    },
    memory: { half_life_days: 7, confidence_threshold: 0.3, per_turn_limit: 5 },
  };

  it("restore keeps A's key, sets aside A's in-flight rotation, and binds B", async () => {
    const invoke = makeInvoke({
      motebit_id: "m-A",
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "KEY-A",
      __keyring_pending_rotation: '{"new_private_key_hex":"KEY-A-PRIME"}',
    });
    const mgr = new IdentityManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await mgr.restoreIdentity(invoke as any, {
      privateKeyHex: "KEY-B",
      metadata: meta,
      preserveMemories: false,
    });
    expect(r.ok).toBe(true);
    const cfg = JSON.parse((await invoke("read_config")) as string) as Record<string, unknown>;
    expect(cfg.motebit_id).toBe("m-B");
    expect(cfg.__keyring_device_private_key).toBe("KEY-B");
    // A's in-flight rotation (A′'s private key) is out of the active slot —
    // so B's next rotation cannot clear it as stale — and still held.
    expect(cfg.__keyring_pending_rotation).toBeUndefined();
    const kept = Object.entries(cfg)
      .filter(([k]) => k.includes(".preserved-"))
      .map(([, v]) => v);
    expect(kept).toContain('{"new_private_key_hex":"KEY-A-PRIME"}');
    expect(kept).toContain("KEY-A");
    // Order: the rotation is set aside BEFORE the key is replaced.
    const cmds = invoke.mock.calls.map(
      ([c, a]) => `${c}:${(a as { key?: string } | undefined)?.key ?? ""}`,
    );
    expect(cmds.indexOf("keyring_set_aside:pending_rotation")).toBeGreaterThan(-1);
    expect(cmds.indexOf("keyring_set_aside:pending_rotation")).toBeLessThan(
      cmds.indexOf("keyring_set:device_private_key"),
    );
  });

  it("a restore interrupted after the key write is finished at the next launch", async () => {
    const inner = makeInvoke({
      motebit_id: "m-A",
      device_public_key: "a".repeat(64),
      __keyring_device_private_key: "KEY-A",
    });
    let crash = true;
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "update_config" && crash) throw new Error("power lost");
      return inner(cmd, args);
    });
    const mgr = new IdentityManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await mgr.restoreIdentity(invoke as any, {
      privateKeyHex: "KEY-B",
      metadata: meta,
      preserveMemories: false,
    });
    expect(r.ok).toBe(false);
    let cfg = JSON.parse((await inner("read_config")) as string) as Record<string, unknown>;
    // The torn state: key B, config still A — and the write-ahead that names it.
    expect(cfg.__keyring_device_private_key).toBe("KEY-B");
    expect(cfg.motebit_id).toBe("m-A");
    expect(typeof cfg.__keyring_pending_identity_switch).toBe("string");
    // Next launch.
    crash = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await new IdentityManager().bootstrap(invoke as any);
    cfg = JSON.parse((await inner("read_config")) as string) as Record<string, unknown>;
    expect(cfg.motebit_id).toBe("m-B");
    expect(cfg.device_public_key).toBe("b".repeat(64));
    expect(cfg.__keyring_pending_identity_switch).toBeUndefined();
  });

  it("an unreadable switch write-ahead stops bootstrap (R1)", async () => {
    const invoke = makeInvoke({ __keyring_pending_identity_switch: "{ torn" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(new IdentityManager().bootstrap(invoke as any)).rejects.toThrow(/cannot be read/);
  });

  it("pairing with key transfer keeps the replaced key and sets aside the old rotation", async () => {
    const invoke = makeInvoke({
      motebit_id: "m-A",
      __keyring_device_private_key: "b".repeat(64),
      __keyring_pending_rotation: "HELD-A",
    });
    const mgr = new IdentityManager();
    await mgr.completePairing(
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
    const cfg = JSON.parse((await invoke("read_config")) as string) as Record<string, unknown>;
    expect(cfg.motebit_id).toBe("new-mot");
    expect(cfg.device_public_key).toBe(mockCtrl.keyTransferPayload.identity_pubkey_check);
    expect(cfg.__keyring_device_private_key).toBe("0".repeat(64));
    expect(cfg.__keyring_pending_rotation).toBeUndefined();
    const kept = Object.entries(cfg)
      .filter(([k]) => k.includes(".preserved-"))
      .map(([, v]) => v);
    expect(kept).toContain("b".repeat(64));
    expect(kept).toContain("HELD-A");
  });
});
