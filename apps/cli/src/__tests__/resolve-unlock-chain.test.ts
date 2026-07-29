/**
 * The unlock-passphrase resolution chain (#438): env → session cache →
 * enrolled keychain (validated) → interactive prompt. The keychain module
 * is mocked wholesale; MOTEBIT_CONFIG_DIR is pinned BEFORE any import so
 * the config module can never bind to a real ~/.motebit.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin the config dir before identity.js (→ config.js) can load — CONFIG_DIR
// is computed at module load, so this MUST precede the dynamic imports.
const tmpRoot = mkdtempSync(join(tmpdir(), "motebit-unlock-chain-test-"));
process.env["MOTEBIT_CONFIG_DIR"] = tmpRoot;

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../keychain.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../keychain.js")>();
  return { ...original, readKeychainPassphrase: vi.fn(() => null) };
});

const { readKeychainPassphrase: mockedRead } = await import("../keychain.js");
const {
  encryptPrivateKey,
  resolveUnlockPassphrase,
  clearSessionPassphrase,
  resetKeychainResolutionForTest,
  rememberSessionPassphrase,
} = await import("../identity.js");

const PRIV_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const savedEnv = process.env["MOTEBIT_PASSPHRASE"];

describe("resolveUnlockPassphrase chain (env → session → keychain → prompt)", () => {
  beforeEach(() => {
    writeFileSync(
      join(tmpRoot, "config.json"),
      JSON.stringify({ motebit_id: "mid-test" }),
      "utf-8",
    );
    delete process.env["MOTEBIT_PASSPHRASE"];
    clearSessionPassphrase();
    resetKeychainResolutionForTest();
    vi.mocked(mockedRead).mockReset().mockReturnValue(null);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env["MOTEBIT_CONFIG_DIR"];
    if (savedEnv == null) delete process.env["MOTEBIT_PASSPHRASE"];
    else process.env["MOTEBIT_PASSPHRASE"] = savedEnv;
    clearSessionPassphrase();
    resetKeychainResolutionForTest();
  });

  it("env wins over an enrolled keychain", async () => {
    process.env["MOTEBIT_PASSPHRASE"] = "from-env";
    vi.mocked(mockedRead).mockReturnValue("from-keychain");
    expect(await resolveUnlockPassphrase("p: ")).toBe("from-env");
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it("session cache wins over the keychain (one read per invocation)", async () => {
    rememberSessionPassphrase("from-session");
    vi.mocked(mockedRead).mockReturnValue("from-keychain");
    expect(await resolveUnlockPassphrase("p: ")).toBe("from-session");
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it("an enrolled keychain resolves without a prompt, keyed on this identity's motebit_id", async () => {
    vi.mocked(mockedRead).mockReturnValue("from-keychain");
    expect(await resolveUnlockPassphrase("p: ")).toBe("from-keychain");
    expect(mockedRead).toHaveBeenCalledWith("mid-test");
  });

  it("a VALID enrolled passphrase passes encryptedKey validation and seeds the session", async () => {
    const enc = await encryptPrivateKey(PRIV_HEX, "correct-pw");
    clearSessionPassphrase(); // encrypt seeded it — isolate the keychain leg
    vi.mocked(mockedRead).mockReturnValue("correct-pw");
    expect(await resolveUnlockPassphrase("p: ", { encryptedKey: enc })).toBe("correct-pw");
    // The validating decrypt seeded the session — the next unlock is silent
    // without another keychain read.
    vi.mocked(mockedRead).mockClear();
    expect(await resolveUnlockPassphrase("p: ")).toBe("correct-pw");
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it("a STALE enrolled passphrase falls through to the prompt — and is never consulted again this process", async () => {
    const enc = await encryptPrivateKey(PRIV_HEX, "new-pw");
    clearSessionPassphrase();
    vi.mocked(mockedRead).mockReturnValue("old-stale-pw");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prompted = vi.fn(async () => "typed-pw");
    const resolved = await resolveUnlockPassphrase("p: ", {
      encryptedKey: enc,
      promptOverrideForTest: prompted,
    });
    // Stale value refused; the user was asked instead of hard-failed.
    expect(resolved).toBe("typed-pw");
    expect(prompted).toHaveBeenCalledTimes(1);
    // The stale-keychain note taught the remedy (assert BEFORE restore —
    // mockRestore clears call history).
    expect(errSpy.mock.calls.flat().join(" ")).toContain("keychain entry is stale");
    errSpy.mockRestore();
    // The keychain is disabled for the rest of the process: a later resolve
    // (session empty) goes STRAIGHT to the prompt without a keychain read.
    clearSessionPassphrase();
    vi.mocked(mockedRead).mockClear();
    const prompted2 = vi.fn(async () => "typed-again");
    expect(await resolveUnlockPassphrase("p: ", { promptOverrideForTest: prompted2 })).toBe(
      "typed-again",
    );
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it("no identity in config ⇒ keychain leg is skipped entirely", async () => {
    writeFileSync(join(tmpRoot, "config.json"), JSON.stringify({}), "utf-8");
    vi.mocked(mockedRead).mockReturnValue("from-keychain");
    const prompted = vi.fn(async () => "typed-pw");
    expect(await resolveUnlockPassphrase("p: ", { promptOverrideForTest: prompted })).toBe(
      "typed-pw",
    );
    expect(mockedRead).not.toHaveBeenCalled();
  });
});
