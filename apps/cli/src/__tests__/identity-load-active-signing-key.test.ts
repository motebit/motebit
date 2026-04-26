/**
 * Unit tests for `loadActiveSigningKey` — the single read site for the
 * CLI's active Ed25519 signing key. Replaces five inline
 * `if (config.cli_encrypted_key) { try / catch passphrase decrypt }`
 * blocks (register, daemon × 2, _helpers, wallet); the test surface
 * covers each failure mode each former call site silently swallowed.
 *
 * Coverage targets: happy path (encrypted), legacy plaintext path,
 * missing key, decrypt failure, malformed bytes, public-key mismatch
 * (fail-closed). The mismatch case is the load-bearing one — it's the
 * defense the inline copies didn't have.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { encryptPrivateKey, loadActiveSigningKey, IdentityKeyError, toHex } from "../identity.js";
import { getPublicKeyBySuite, generateKeypair } from "@motebit/encryption";
import type { FullConfig } from "../config.js";

async function freshKeypair(): Promise<{
  privateKeyHex: string;
  publicKeyHex: string;
}> {
  const { privateKey, publicKey } = await generateKeypair();
  return {
    privateKeyHex: toHex(privateKey),
    publicKeyHex: toHex(publicKey),
  };
}

const passphraseGetter = (pass: string) => async () => pass;

describe("loadActiveSigningKey", () => {
  afterEach(() => {
    delete process.env["MOTEBIT_PASSPHRASE"];
  });

  it("decrypts cli_encrypted_key and returns the raw seed", async () => {
    const { privateKeyHex, publicKeyHex } = await freshKeypair();
    const passphrase = "test-passphrase-123";
    const encrypted = await encryptPrivateKey(privateKeyHex, passphrase);
    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: publicKeyHex,
      cli_encrypted_key: encrypted,
    };

    const result = await loadActiveSigningKey(config, {
      getPassphrase: passphraseGetter(passphrase),
    });

    expect(result.source).toBe("encrypted-config");
    expect(result.publicKey.toLowerCase()).toBe(publicKeyHex.toLowerCase());
    expect(result.privateKey.length).toBe(32);
    // Verify the returned bytes are the same seed by re-deriving the
    // public key and comparing.
    const rederivedPub = await getPublicKeyBySuite(result.privateKey, "motebit-jcs-ed25519-hex-v1");
    expect(toHex(rederivedPub).toLowerCase()).toBe(publicKeyHex.toLowerCase());
  });

  it("prefers MOTEBIT_PASSPHRASE env over the interactive prompt", async () => {
    const { privateKeyHex, publicKeyHex } = await freshKeypair();
    const passphrase = "env-passphrase";
    const encrypted = await encryptPrivateKey(privateKeyHex, passphrase);
    process.env["MOTEBIT_PASSPHRASE"] = passphrase;

    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: publicKeyHex,
      cli_encrypted_key: encrypted,
    };

    // No getPassphrase override — should read env.
    const result = await loadActiveSigningKey(config);
    expect(result.source).toBe("encrypted-config");
  });

  it("reads cli_private_key (legacy plaintext) when cli_encrypted_key absent, and warns", async () => {
    const { privateKeyHex, publicKeyHex } = await freshKeypair();
    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: publicKeyHex,
      cli_private_key: privateKeyHex,
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await loadActiveSigningKey(config);
      expect(result.source).toBe("plaintext-config-legacy");
      expect(result.publicKey.toLowerCase()).toBe(publicKeyHex.toLowerCase());
      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
      expect(warnMsg).toContain("deprecated");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("throws IdentityKeyError(missing) when no key in config", async () => {
    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: "abc",
    };
    await expect(loadActiveSigningKey(config)).rejects.toThrow(IdentityKeyError);
    try {
      await loadActiveSigningKey(config);
    } catch (err) {
      expect(err).toBeInstanceOf(IdentityKeyError);
      expect((err as IdentityKeyError).kind).toBe("missing");
      expect((err as IdentityKeyError).remedy).toContain("motebit init");
    }
  });

  it("throws IdentityKeyError(decrypt-failed) on wrong passphrase", async () => {
    const { privateKeyHex, publicKeyHex } = await freshKeypair();
    const encrypted = await encryptPrivateKey(privateKeyHex, "right-passphrase");
    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: publicKeyHex,
      cli_encrypted_key: encrypted,
    };
    await expect(
      loadActiveSigningKey(config, { getPassphrase: passphraseGetter("WRONG") }),
    ).rejects.toMatchObject({
      kind: "decrypt-failed",
    });
  });

  it("throws IdentityKeyError(public-key-mismatch) when derived public ≠ config.device_public_key — fail-closed", async () => {
    // The load-bearing test: a private key from a DIFFERENT keypair than
    // the one config.device_public_key claims. Inline call sites would
    // have happily signed under the wrong identity. The helper refuses.
    const a = await freshKeypair();
    const b = await freshKeypair();
    const passphrase = "p";
    const encrypted = await encryptPrivateKey(a.privateKeyHex, passphrase);
    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: b.publicKeyHex, // wrong public for a's private
      cli_encrypted_key: encrypted,
    };
    await expect(
      loadActiveSigningKey(config, { getPassphrase: passphraseGetter(passphrase) }),
    ).rejects.toMatchObject({
      kind: "public-key-mismatch",
    });
  });

  it("skips the public-key check when skipPublicKeyVerification: true", async () => {
    // Future-use escape hatch (mid-rotation). Verify it works so the
    // contract holds when a caller eventually needs it.
    const a = await freshKeypair();
    const b = await freshKeypair();
    const passphrase = "p";
    const encrypted = await encryptPrivateKey(a.privateKeyHex, passphrase);
    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: b.publicKeyHex,
      cli_encrypted_key: encrypted,
    };
    const result = await loadActiveSigningKey(config, {
      getPassphrase: passphraseGetter(passphrase),
      skipPublicKeyVerification: true,
    });
    expect(result.privateKey.length).toBe(32);
  });

  it("throws IdentityKeyError(malformed-private-key) on corrupted plaintext", async () => {
    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      device_public_key: "a".repeat(64),
      cli_private_key: "not-hex-bytes",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(loadActiveSigningKey(config)).rejects.toMatchObject({
        kind: "malformed-private-key",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("succeeds even when device_public_key is missing (no check to run)", async () => {
    // Edge case: partial config with key but no public. Helper still
    // returns; doctor's separate "Public key" probe catches the missing
    // device_public_key case.
    const { privateKeyHex } = await freshKeypair();
    const passphrase = "p";
    const encrypted = await encryptPrivateKey(privateKeyHex, passphrase);
    const config: FullConfig = {
      motebit_id: "m-1",
      device_id: "d-1",
      cli_encrypted_key: encrypted,
    };
    const result = await loadActiveSigningKey(config, {
      getPassphrase: passphraseGetter(passphrase),
    });
    expect(result.privateKey.length).toBe(32);
  });
});
