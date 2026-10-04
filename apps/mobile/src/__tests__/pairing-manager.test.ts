import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockClientDefaults = {
  initiate: vi.fn(() => Promise.resolve({ pairingCode: "ABC123", pairingId: "pid-1" })),
  claim: vi.fn(() => Promise.resolve({ pairingId: "pid-2", motebitId: "m-1" })),
  getSession: vi.fn(() =>
    Promise.resolve({
      pairing_id: "pid-1",
      pairing_code: "ABC123",
      status: "pending",
      claiming_x25519_pubkey: null,
      claiming_device_name: null,
    }),
  ),
  approve: vi.fn(() => Promise.resolve({ deviceId: "d-1" })),
  deny: vi.fn(() => Promise.resolve()),
  pollStatus: vi.fn(() => Promise.resolve({ status: "pending" })),
  updateDeviceKey: vi.fn(() => Promise.resolve()),
  getSuccessionChain: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
};

const clientFactoryConfigs: Array<Record<string, unknown>> = [];

vi.mock("@motebit/sync-engine", () => {
  class PairingClient {
    initiate: ReturnType<typeof vi.fn>;
    claim: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    approve: ReturnType<typeof vi.fn>;
    deny: ReturnType<typeof vi.fn>;
    pollStatus: ReturnType<typeof vi.fn>;
    updateDeviceKey: ReturnType<typeof vi.fn>;
    getSuccessionChain: ReturnType<typeof vi.fn>;
    constructor(config: Record<string, unknown>) {
      clientFactoryConfigs.push(config);
      this.initiate = mockClientDefaults.initiate;
      this.claim = mockClientDefaults.claim;
      this.getSession = mockClientDefaults.getSession;
      this.approve = mockClientDefaults.approve;
      this.deny = mockClientDefaults.deny;
      this.pollStatus = mockClientDefaults.pollStatus;
      this.updateDeviceKey = mockClientDefaults.updateDeviceKey;
      this.getSuccessionChain = mockClientDefaults.getSuccessionChain;
    }
  }
  return { PairingClient };
});

// What Device A sealed inside the key transfer (pairing, rotated identity).
const transferSuccession = vi.hoisted(() => ({ records: [] as unknown[] }));

vi.mock("@motebit/encryption", async (importOriginal) => {
  const real = await importOriginal<typeof import("@motebit/encryption")>();
  const decryptKeyTransfer = vi.fn(() => Promise.resolve(new Uint8Array(32).fill(3)));
  return {
    // Real unless stubbed below — the shared pairing-binding check stays real.
    ...real,
    // The shared acceptance path with decryption stubbed (these payloads are
    // not real ciphertext) — the binding decision itself stays REAL. The real
    // path, decryption included, is exercised end to end by
    // packages/encryption/src/__tests__/pairing-identity-matrix.test.ts.
    openPairingKeyTransfer: vi.fn(
      async (input: {
        motebitId: string;
        keyTransfer: { identity_pubkey_check: string } | null | undefined;
        ephemeralPrivateKey: Uint8Array;
        pairingCode: string;
        fetchSuccessionChain?: () => Promise<readonly unknown[]>;
      }) => {
        if (input.keyTransfer == null) {
          throw new Error("Pairing refused: the approval carried no identity key transfer");
        }
        let identitySeed: Uint8Array;
        try {
          identitySeed = await decryptKeyTransfer();
        } catch (err) {
          throw new Error("Pairing refused: the identity key transfer could not be verified", {
            cause: err,
          });
        }
        const publicKeyHex = input.keyTransfer.identity_pubkey_check.toLowerCase();
        const binding = await real.verifyPairingIdentityBinding(input.motebitId, publicKeyHex, {
          successionSources: [
            transferSuccession.records,
            ...(input.fetchSuccessionChain ? [input.fetchSuccessionChain] : []),
          ],
        });
        if (!binding.accepted) throw new Error(`Pairing refused: ${binding.reason}`);
        return {
          identitySeed,
          publicKeyHex,
          identityBinding: binding.identityBinding,
          succession: binding.lineage ?? [],
        };
      },
    ),
    generateX25519Keypair: vi.fn(() => ({
      publicKey: new Uint8Array(32).fill(1),
      privateKey: new Uint8Array(32).fill(2),
    })),
    buildKeyTransferPayload: vi.fn(() =>
      Promise.resolve({
        identity_pubkey_check: "ff".repeat(32),
        ciphertext: "abc",
        nonce: "def",
        ephemeral_pubkey: "e",
      }),
    ),
    decryptKeyTransfer,
    checkPreTransferBalance: vi.fn(() => Promise.resolve({ hasAnyValue: false })),
    formatWalletWarning: vi.fn(() => "wallet has funds"),
    secureErase: vi.fn(),
    bytesToHex: vi.fn((b: Uint8Array) =>
      Array.from(b, (v: number) => v.toString(16).padStart(2, "0")).join(""),
    ),
    hexToBytes: vi.fn((h: string) => {
      const arr = new Uint8Array(h.length / 2);
      for (let i = 0; i < h.length; i += 2) {
        arr[i / 2] = parseInt(h.slice(i, i + 2), 16);
      }
      return arr;
    }),
  };
});

import {
  deriveSovereignMotebitId,
  generateKeypair,
  bytesToHex as realBytesToHex,
  signKeySuccession,
} from "@motebit/crypto";
import { MobilePairingManager } from "../pairing-manager";
import type { PairingManagerDeps } from "../pairing-manager";

function makeKeyring() {
  const data = new Map<string, string>();
  return {
    get: vi.fn((k: string) => Promise.resolve(data.get(k) ?? null)),
    set: vi.fn((k: string, v: string) => {
      data.set(k, v);
      return Promise.resolve();
    }),
    delete: vi.fn((k: string) => {
      data.delete(k);
      return Promise.resolve();
    }),
    _data: data,
  };
}

function makeDeps(overrides?: Partial<PairingManagerDeps>): PairingManagerDeps & {
  keyring: ReturnType<typeof makeKeyring>;
} {
  const keyring = makeKeyring();
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getKeyring: () => keyring as any,
    getPublicKey: () => "aa".repeat(32),
    getPrivKeyHex: () => Promise.resolve("bb".repeat(32)),
    createSyncToken: () => Promise.resolve("auth-token"),
    setIdentity: vi.fn(),
    setPublicKey: vi.fn(),
    setSyncUrl: vi.fn(() => Promise.resolve()),
    keyring,
    ...overrides,
  };
}

// A key transfer whose identity_pubkey_check is the given key (decryption is stubbed).
function transferOpts(identityPubkeyCheck = "ff".repeat(32)) {
  return {
    keyTransfer: {
      identity_pubkey_check: identityPubkeyCheck,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    ephemeralPrivateKey: new Uint8Array(32),
    pairingCode: "ABC123",
    pairingId: "pid-1",
  };
}

// A sovereign identity that has rotated once: id = commitment to the genesis
// key, current key = the rotated one, chain = the genuine succession record.
async function rotatedSovereign() {
  const genesis = await generateKeypair();
  const next = await generateKeypair();
  return {
    id: await deriveSovereignMotebitId(realBytesToHex(genesis.publicKey)),
    current: realBytesToHex(next.publicKey),
    chain: [
      await signKeySuccession(
        genesis.privateKey,
        next.privateKey,
        next.publicKey,
        genesis.publicKey,
      ),
    ],
  };
}

beforeEach(() => {
  clientFactoryConfigs.length = 0;
  transferSuccession.records = [];
  for (const v of Object.values(mockClientDefaults)) {
    if (typeof (v as { mockClear?: () => void }).mockClear === "function") {
      (v as { mockClear: () => void }).mockClear();
    }
  }
});

describe("MobilePairingManager Device A (initiator) flow", () => {
  it("initiatePairing returns code and id", async () => {
    const mgr = new MobilePairingManager(makeDeps());
    const result = await mgr.initiatePairing("https://relay.test");
    expect(result.pairingCode).toBe("ABC123");
    expect(result.pairingId).toBe("pid-1");
    expect(clientFactoryConfigs[0]?.relayUrl).toBe("https://relay.test");
  });

  it("getPairingSession forwards to client", async () => {
    const mgr = new MobilePairingManager(makeDeps());
    const sess = await mgr.getPairingSession("https://relay.test", "pid-1");
    expect(sess.status).toBe("pending");
  });

  it("approvePairing without key transfer", async () => {
    const mgr = new MobilePairingManager(makeDeps());
    const result = await mgr.approvePairing("https://relay.test", "pid-1");
    expect(result.deviceId).toBe("d-1");
    expect(mockClientDefaults.approve).toHaveBeenCalled();
  });

  it("approvePairing with key transfer builds payload", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockClientDefaults.getSession as any).mockResolvedValueOnce({
      pairing_id: "pid-1",
      pairing_code: "ABC123",
      status: "claimed",
      claiming_x25519_pubkey: "cc".repeat(32),
    });
    const deps = makeDeps();
    const mgr = new MobilePairingManager(deps);
    await mgr.approvePairing("https://relay.test", "pid-1");
    const { buildKeyTransferPayload } = await import("@motebit/encryption");
    expect(buildKeyTransferPayload).toHaveBeenCalled();
  });

  it("approvePairing seals this device's own succession records into the key transfer", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockClientDefaults.getSession as any).mockResolvedValueOnce({
      pairing_id: "pid-1",
      pairing_code: "ABC123",
      status: "claimed",
      claiming_x25519_pubkey: "cc".repeat(32),
    });
    const r = await rotatedSovereign();
    const deps = makeDeps({ loadOwnSuccessionRecords: () => Promise.resolve(r.chain) });
    const { buildKeyTransferPayload } = await import("@motebit/encryption");
    vi.mocked(buildKeyTransferPayload).mockClear();
    await new MobilePairingManager(deps).approvePairing("https://relay.test", "pid-1");
    expect(vi.mocked(buildKeyTransferPayload).mock.calls[0]![4]).toEqual({
      successionRecords: r.chain,
    });
  });

  it("approvePairing still approves when its own records cannot be read (none sent)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockClientDefaults.getSession as any).mockResolvedValueOnce({
      pairing_id: "pid-1",
      pairing_code: "ABC123",
      status: "claimed",
      claiming_x25519_pubkey: "cc".repeat(32),
    });
    const deps = makeDeps({ loadOwnSuccessionRecords: () => Promise.reject(new Error("io")) });
    const { buildKeyTransferPayload } = await import("@motebit/encryption");
    vi.mocked(buildKeyTransferPayload).mockClear();
    await new MobilePairingManager(deps).approvePairing("https://relay.test", "pid-1");
    expect(vi.mocked(buildKeyTransferPayload).mock.calls[0]![4]).toEqual({
      successionRecords: [],
    });
  });

  it("denyPairing forwards to client", async () => {
    const mgr = new MobilePairingManager(makeDeps());
    await mgr.denyPairing("https://relay.test", "pid-1");
    expect(mockClientDefaults.deny).toHaveBeenCalled();
  });
});

describe("MobilePairingManager Device B (claimer) flow", () => {
  it("claimPairing generates ephemeral key and calls client", async () => {
    const mgr = new MobilePairingManager(makeDeps());
    const result = await mgr.claimPairing("https://relay.test", "abc123");
    expect(result.pairingId).toBe("pid-2");
    expect(result.motebitId).toBe("m-1");
    expect(result.ephemeralPrivateKey).toBeInstanceOf(Uint8Array);
    // Code uppercased before sending
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockClientDefaults.claim as any).mock.calls[0]?.[0]).toBe("ABC123");
  });

  it("claimPairing throws if no public key", async () => {
    const mgr = new MobilePairingManager(makeDeps({ getPublicKey: () => "" }));
    await expect(mgr.claimPairing("https://relay.test", "abc123")).rejects.toThrow(/No public key/);
  });

  it("pollPairingStatus forwards to client", async () => {
    const mgr = new MobilePairingManager(makeDeps());
    const status = await mgr.pollPairingStatus("https://relay.test", "pid-2");
    expect(status.status).toBe("pending");
  });

  it("completePairing persists identity and sets via setIdentity", async () => {
    const deps = makeDeps();
    const mgr = new MobilePairingManager(deps);
    const result = await mgr.completePairing(
      { motebitId: "019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb", deviceId: "d-X" },
      "https://relay.test",
      transferOpts(),
    );
    expect(result).toBeUndefined(); // no wallet warning
    expect(deps.setIdentity).toHaveBeenCalledWith("019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb", "d-X");
    expect(deps.setSyncUrl).toHaveBeenCalledWith("https://relay.test");
    expect(deps.keyring._data.get("motebit_id")).toBe("019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb");
    expect(deps.keyring._data.get("device_id")).toBe("d-X");
  });

  it("completePairing without syncUrl skips setSyncUrl", async () => {
    const deps = makeDeps();
    const mgr = new MobilePairingManager(deps);
    await mgr.completePairing(
      { motebitId: "019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb", deviceId: "d-X" },
      undefined,
      transferOpts(),
    );
    expect(deps.setSyncUrl).not.toHaveBeenCalled();
  });

  it("completePairing with key transfer installs new identity key", async () => {
    const deps = makeDeps();
    const mgr = new MobilePairingManager(deps);
    await mgr.completePairing(
      { motebitId: "019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb", deviceId: "d-X" },
      "https://relay.test",
      {
        keyTransfer: {
          identity_pubkey_check: "ff".repeat(32),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        ephemeralPrivateKey: new Uint8Array(32),
        pairingCode: "ABC123",
        pairingId: "pid-1",
      },
    );
    expect(deps.setPublicKey).toHaveBeenCalledWith("ff".repeat(32));
    expect(deps.keyring._data.get("device_private_key")).toBeTruthy();
    expect(mockClientDefaults.updateDeviceKey).toHaveBeenCalled();
  });

  it("completePairing with key transfer warns when old wallet has funds", async () => {
    const deps = makeDeps();
    // pre-seed an existing private key
    await deps.keyring.set("device_private_key", "cc".repeat(32));
    const encryption = await import("@motebit/encryption");
    (
      encryption.checkPreTransferBalance as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ hasAnyValue: true, balance: 1.5 });

    const mgr = new MobilePairingManager(deps);
    const warning = await mgr.completePairing(
      { motebitId: "019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb", deviceId: "d-X" },
      "https://relay.test",
      {
        keyTransfer: {
          identity_pubkey_check: "ff".repeat(32),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        ephemeralPrivateKey: new Uint8Array(32),
        pairingCode: "ABC123",
        pairingId: "pid-1",
      },
    );
    expect(warning).toBeTruthy();
    // Key is NOT replaced when warning is set
    expect(deps.setPublicKey).not.toHaveBeenCalled();
  });

  it("completePairing REFUSES when the key transfer fails to decrypt — nothing written", async () => {
    const deps = makeDeps();
    await deps.keyring.set("motebit_id", "m-OLD");
    deps.keyring.set.mockClear();
    const encryption = await import("@motebit/encryption");
    (encryption.decryptKeyTransfer as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("bad key"),
    );
    const mgr = new MobilePairingManager(deps);
    await expect(
      mgr.completePairing(
        { motebitId: "019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb", deviceId: "d-X" },
        "https://relay.test",
        transferOpts(),
      ),
    ).rejects.toThrow(/Pairing refused/);
    expect(deps.keyring.set).not.toHaveBeenCalled();
    expect(deps.keyring._data.get("motebit_id")).toBe("m-OLD");
    expect(deps.setIdentity).not.toHaveBeenCalled();
    expect(deps.setSyncUrl).not.toHaveBeenCalled();
  });

  it("completePairing REFUSES an approval that carries no key transfer (dropped by the relay) — nothing written", async () => {
    const deps = makeDeps();
    const mgr = new MobilePairingManager(deps);
    await expect(
      mgr.completePairing(
        { motebitId: "019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb", deviceId: "d-X" },
        "https://relay.test",
      ),
    ).rejects.toThrow(/Pairing refused/);
    expect(deps.keyring.set).not.toHaveBeenCalled();
    expect(deps.setIdentity).not.toHaveBeenCalled();
    expect(deps.setSyncUrl).not.toHaveBeenCalled();
  });

  it("completePairing adopts a ROTATED sovereign identity through the relay-served succession chain", async () => {
    const deps = makeDeps();
    const r = await rotatedSovereign();
    mockClientDefaults.getSuccessionChain.mockResolvedValueOnce(r.chain);
    const mgr = new MobilePairingManager(deps);
    await mgr.completePairing(
      { motebitId: r.id, deviceId: "d-X" },
      "https://relay.test",
      transferOpts(r.current),
    );
    expect(mockClientDefaults.getSuccessionChain).toHaveBeenCalledWith(r.id);
    expect(deps.keyring._data.get("motebit_id")).toBe(r.id);
    expect(deps.setIdentity).toHaveBeenCalledWith(r.id, "d-X");
    expect(deps.setPublicKey).toHaveBeenCalledWith(r.current);
  });

  it("completePairing adopts a sovereign identity rotated OFFLINE through the chain sealed in the transfer — no relay at all", async () => {
    const deps = makeDeps();
    const r = await rotatedSovereign();
    transferSuccession.records = r.chain;
    const mgr = new MobilePairingManager(deps);
    await mgr.completePairing(
      { motebitId: r.id, deviceId: "d-X" },
      undefined,
      transferOpts(r.current),
    );
    expect(mockClientDefaults.getSuccessionChain).not.toHaveBeenCalled();
    expect(deps.keyring._data.get("motebit_id")).toBe(r.id);
    expect(deps.setPublicKey).toHaveBeenCalledWith(r.current);
  });

  it("completePairing refuses a rotated sovereign identity whose served chain is forged — nothing written", async () => {
    const deps = makeDeps();
    const r = await rotatedSovereign();
    mockClientDefaults.getSuccessionChain.mockResolvedValueOnce([
      { ...r.chain[0]!, old_key_signature: "00".repeat(64) },
    ]);
    const mgr = new MobilePairingManager(deps);
    await expect(
      mgr.completePairing(
        { motebitId: r.id, deviceId: "d-X" },
        "https://relay.test",
        transferOpts(r.current),
      ),
    ).rejects.toThrow(/does not bind/);
    expect(deps.keyring.set).not.toHaveBeenCalled();
    expect(deps.setIdentity).not.toHaveBeenCalled();
  });

  it("completePairing refuses a relay-supplied motebit_id that does not bind to the transferred key — nothing written", async () => {
    const deps = makeDeps();
    await deps.keyring.set("motebit_id", "m-OLD");
    await deps.keyring.set("device_id", "d-OLD");
    await deps.keyring.set("device_private_key", "cc".repeat(32));
    deps.keyring.set.mockClear();
    // A self-certifying id — but the commitment of a DIFFERENT key than the
    // one the pairing transferred ("ff" * 32).
    const wrongId = await deriveSovereignMotebitId("ee".repeat(32));
    const mgr = new MobilePairingManager(deps);
    await expect(
      mgr.completePairing({ motebitId: wrongId, deviceId: "d-X" }, "https://relay.test", {
        keyTransfer: {
          identity_pubkey_check: "ff".repeat(32),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        ephemeralPrivateKey: new Uint8Array(32),
        pairingCode: "ABC123",
        pairingId: "pid-1",
      }),
    ).rejects.toThrow(/does not bind/);
    expect(deps.keyring.set).not.toHaveBeenCalled();
    expect(deps.keyring._data.get("motebit_id")).toBe("m-OLD");
    expect(deps.keyring._data.get("device_id")).toBe("d-OLD");
    expect(deps.keyring._data.get("device_private_key")).toBe("cc".repeat(32));
    expect(deps.setIdentity).not.toHaveBeenCalled();
    expect(deps.setPublicKey).not.toHaveBeenCalled();
    expect(deps.setSyncUrl).not.toHaveBeenCalled();
    expect(mockClientDefaults.updateDeviceKey).not.toHaveBeenCalled();
  });

  it("completePairing adopts a motebit_id that is the commitment to the transferred key", async () => {
    const deps = makeDeps();
    const boundId = await deriveSovereignMotebitId("ff".repeat(32));
    const mgr = new MobilePairingManager(deps);
    await mgr.completePairing({ motebitId: boundId, deviceId: "d-X" }, "https://relay.test", {
      keyTransfer: {
        identity_pubkey_check: "ff".repeat(32),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      ephemeralPrivateKey: new Uint8Array(32),
      pairingCode: "ABC123",
      pairingId: "pid-1",
    });
    expect(deps.keyring._data.get("motebit_id")).toBe(boundId);
    expect(deps.setIdentity).toHaveBeenCalledWith(boundId, "d-X");
    expect(deps.setPublicKey).toHaveBeenCalledWith("ff".repeat(32));
  });
});
