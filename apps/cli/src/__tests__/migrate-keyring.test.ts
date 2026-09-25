/**
 * Unit tests for `motebit migrate-keyring` — the recovery path that
 * re-encrypts a plaintext `~/.motebit/dev-keyring.json` private key
 * under a passphrase and writes it as `cli_encrypted_key` in
 * `~/.motebit/config.json`.
 *
 * Coverage: happy path (migrates + removes plaintext file), refuses on
 * pre-existing encrypted key without --force, fail-closed on key/public
 * mismatch (the load-bearing defense — preserves the existing identity
 * by refusing to bind a different identity's private key under it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// vi.hoisted runs before vi.mock factories, so the tmp dir is reachable
// from inside the mock without the "cannot access before initialization"
// hoisting trap.
const { tmpDir } = vi.hoisted(() => {
  // vi.hoisted runs before ES module imports resolve, so require() is the
  // only way to reach Node built-ins here. This is the documented vitest
  // pattern for hoisted setup.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsMod = require("node:fs") as typeof fs;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require("node:path") as typeof path;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osMod = require("node:os") as typeof os;
  return {
    tmpDir: fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "motebit-migrate-keyring-")),
  };
});

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  return {
    ...actual,
    CONFIG_DIR: tmpDir,
    loadFullConfig: vi.fn(),
    saveFullConfig: vi.fn(),
  };
});

vi.mock("../identity.js", async () => {
  const actual = await vi.importActual<typeof import("../identity.js")>("../identity.js");
  return {
    ...actual,
    promptPassphrase: vi.fn(),
  };
});

import { handleMigrateKeyring } from "../subcommands/migrate-keyring.js";
import * as configModule from "../config.js";
import * as identityModule from "../identity.js";
import { generateKeypair, getPublicKeyBySuite } from "@motebit/encryption";
import type { CliConfig } from "../args.js";
import type { FullConfig } from "../config.js";

const loadFullConfigMock = vi.mocked(configModule.loadFullConfig);
const saveFullConfigMock = vi.mocked(configModule.saveFullConfig);
const promptPassphraseMock = vi.mocked(identityModule.promptPassphrase);

const baseCliConfig: CliConfig = {
  positionals: ["migrate-keyring"],
} as unknown as CliConfig;

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

describe("handleMigrateKeyring", () => {
  beforeEach(() => {
    loadFullConfigMock.mockReset();
    saveFullConfigMock.mockReset();
    promptPassphraseMock.mockReset();
    // Clean tmpDir
    for (const f of fs.readdirSync(tmpDir)) {
      try {
        fs.unlinkSync(path.join(tmpDir, f));
      } catch {
        /* ignore */
      }
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("encrypts dev-keyring private key, writes cli_encrypted_key, removes plaintext file", async () => {
    const { privateKey, publicKey } = await generateKeypair();
    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: toHex(publicKey),
    };
    loadFullConfigMock.mockReturnValue(config);
    promptPassphraseMock
      .mockResolvedValueOnce("new-passphrase")
      .mockResolvedValueOnce("new-passphrase");

    const devKeyringPath = path.join(tmpDir, "dev-keyring.json");
    fs.writeFileSync(devKeyringPath, JSON.stringify({ device_private_key: toHex(privateKey) }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleMigrateKeyring(baseCliConfig);
    } finally {
      logSpy.mockRestore();
    }

    expect(saveFullConfigMock).toHaveBeenCalledOnce();
    const saved = saveFullConfigMock.mock.calls[0]?.[0] as FullConfig;
    expect(saved.cli_encrypted_key).toBeDefined();
    expect(saved.cli_encrypted_key?.ciphertext).toBeTruthy();
    expect(fs.existsSync(devKeyringPath)).toBe(false);
  });

  it("fails closed when dev-keyring private key derives to a DIFFERENT public than config.device_public_key", async () => {
    // The load-bearing test. Refusing this case prevents binding an
    // orphaned key (from a previous identity) under the current config —
    // the precise drift that produced the multi-identity situation
    // documented in this commit's prose.
    const a = await generateKeypair();
    const b = await generateKeypair();
    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: toHex(b.publicKey), // current identity is B
    };
    loadFullConfigMock.mockReturnValue(config);

    const devKeyringPath = path.join(tmpDir, "dev-keyring.json");
    fs.writeFileSync(
      devKeyringPath,
      JSON.stringify({ device_private_key: toHex(a.privateKey) }), // but key is A's
    );

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("PROCESS_EXIT_CALLED");
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(handleMigrateKeyring(baseCliConfig)).rejects.toThrow("PROCESS_EXIT_CALLED");
      // No save happened — config preserved.
      expect(saveFullConfigMock).not.toHaveBeenCalled();
      // dev-keyring.json was not removed (we don't destroy a key we can't bind).
      expect(fs.existsSync(devKeyringPath)).toBe(true);
      // Verify the error explains the orphaned-key situation.
      const errOutput = errorSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(errOutput).toContain("does NOT derive to config.device_public_key");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("refuses to overwrite an existing cli_encrypted_key without --force", async () => {
    const { publicKey } = await generateKeypair();
    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: toHex(publicKey),
      cli_encrypted_key: {
        ciphertext: "x",
        nonce: "y",
        tag: "z",
        salt: "s",
      },
    };
    loadFullConfigMock.mockReturnValue(config);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("PROCESS_EXIT_CALLED");
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(handleMigrateKeyring(baseCliConfig)).rejects.toThrow("PROCESS_EXIT_CALLED");
      expect(saveFullConfigMock).not.toHaveBeenCalled();
      const errOutput = errorSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(errOutput).toContain("--force");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("requires identity in config (motebit_id + device_public_key)", async () => {
    loadFullConfigMock.mockReturnValue({});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("PROCESS_EXIT_CALLED");
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(handleMigrateKeyring(baseCliConfig)).rejects.toThrow("PROCESS_EXIT_CALLED");
      const errOutput = errorSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(errOutput).toContain("no identity");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("refuses on passphrase mismatch", async () => {
    const { privateKey, publicKey } = await generateKeypair();
    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: toHex(publicKey),
    };
    loadFullConfigMock.mockReturnValue(config);
    promptPassphraseMock.mockResolvedValueOnce("new-passphrase").mockResolvedValueOnce("DIFFERENT");

    const devKeyringPath = path.join(tmpDir, "dev-keyring.json");
    fs.writeFileSync(devKeyringPath, JSON.stringify({ device_private_key: toHex(privateKey) }));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("PROCESS_EXIT_CALLED");
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(handleMigrateKeyring(baseCliConfig)).rejects.toThrow("PROCESS_EXIT_CALLED");
      expect(saveFullConfigMock).not.toHaveBeenCalled();
      // dev-keyring preserved on mismatch.
      expect(fs.existsSync(devKeyringPath)).toBe(true);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  async function migrate(devKeyring: Record<string, unknown>, force = false): Promise<string> {
    const { privateKey, publicKey } = await generateKeypair();
    loadFullConfigMock.mockReturnValue({
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: toHex(publicKey),
      ...(force
        ? { cli_encrypted_key: { ciphertext: "OLD", nonce: "n", tag: "t", salt: "s" } }
        : {}),
    });
    promptPassphraseMock.mockResolvedValueOnce("p").mockResolvedValueOnce("p");
    const devKeyringPath = path.join(tmpDir, "dev-keyring.json");
    fs.writeFileSync(
      devKeyringPath,
      JSON.stringify({ device_private_key: toHex(privateKey), ...devKeyring }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await handleMigrateKeyring({ ...baseCliConfig, force } as CliConfig);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
    return devKeyringPath;
  }

  it("item 10: --force over an existing cli_encrypted_key declares an identity change that KEEPS the replaced key", async () => {
    await migrate({}, true);
    expect(saveFullConfigMock).toHaveBeenCalledOnce();
    expect(saveFullConfigMock.mock.calls[0]?.[1]).toEqual({ identityChange: "preserve-replaced" });
  });

  it("item 11: a keyring that holds MORE than the migrated key (the desktop's rotation write-ahead) is left in place, owner-only", async () => {
    const p = await migrate({ pending_rotation: '{"new_private_key_hex":"ab"}' });
    expect(fs.existsSync(p)).toBe(true);
    expect(JSON.parse(fs.readFileSync(p, "utf-8")).pending_rotation).toBeTruthy();
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it("item 11: a SYMLINKED keyring is unlinked, its target never zeroed", async () => {
    const target = path.join(tmpDir, "elsewhere.json");
    const { privateKey, publicKey } = await generateKeypair();
    const body = JSON.stringify({ device_private_key: toHex(privateKey) });
    fs.writeFileSync(target, body);
    const devKeyringPath = path.join(tmpDir, "dev-keyring.json");
    fs.symlinkSync(target, devKeyringPath);
    loadFullConfigMock.mockReturnValue({
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: toHex(publicKey),
    });
    promptPassphraseMock.mockResolvedValueOnce("p").mockResolvedValueOnce("p");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleMigrateKeyring(baseCliConfig);
    } finally {
      logSpy.mockRestore();
    }
    expect(fs.existsSync(devKeyringPath)).toBe(false);
    expect(fs.readFileSync(target, "utf-8")).toBe(body);
  });

  it("item 11: a dangling-symlink keyring is not 'no keyring' (R1)", async () => {
    const { publicKey } = await generateKeypair();
    loadFullConfigMock.mockReturnValue({
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: toHex(publicKey),
    });
    fs.symlinkSync(path.join(tmpDir, "gone.json"), path.join(tmpDir, "dev-keyring.json"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("PROCESS_EXIT_CALLED");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(handleMigrateKeyring(baseCliConfig)).rejects.toThrow("PROCESS_EXIT_CALLED");
      const said = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).toMatch(/malformed/);
      expect(said).not.toMatch(/no plaintext keyring/);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("a keyring the desktop already moved into the OS keychain is reported as such, not as 'no keyring'", async () => {
    const { publicKey } = await generateKeypair();
    loadFullConfigMock.mockReturnValue({
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: toHex(publicKey),
    });
    fs.writeFileSync(path.join(tmpDir, "dev-keyring.json.migrated-2026-01-01T00-00-00-000Z"), "{}");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("PROCESS_EXIT_CALLED");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(handleMigrateKeyring(baseCliConfig)).rejects.toThrow("PROCESS_EXIT_CALLED");
      const said = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).toMatch(/OS keychain/);
      expect(fs.existsSync(path.join(tmpDir, "dev-keyring.json"))).toBe(false);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("derives the same public key the helper would (sanity check on encryption layer)", async () => {
    // Verify getPublicKeyBySuite (the @motebit/encryption export) matches
    // what we'd get by re-encrypting + re-decrypting in a round trip. This
    // catches accidental algorithm changes in @motebit/crypto's suite-
    // dispatch that would silently break migrate-keyring's match check.
    const { privateKey, publicKey } = await generateKeypair();
    const derived = await getPublicKeyBySuite(privateKey, "motebit-jcs-ed25519-hex-v1");
    expect(toHex(derived).toLowerCase()).toBe(toHex(publicKey).toLowerCase());
  });
});
