/**
 * Session-passphrase cache (#445 shape: `motebit export` prompted four
 * times in one invocation — once at the top, once per relay-auth header —
 * reading as Enter-not-working). The cache is seeded ONLY at proof
 * points: a successful AES-GCM decrypt of the identity key, or the
 * encrypt call that sets the passphrase. Env still wins; unverified
 * prompts never seed it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  loadActiveSigningKey,
  clearSessionPassphrase,
  rememberSessionPassphrase,
  sessionPassphraseSnapshotForTest,
} from "../identity.js";
import type { FullConfig } from "../config.js";

const PRIV_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PASSPHRASE = "correct horse battery";

async function makeConfig(passphrase: string): Promise<FullConfig> {
  return {
    cli_encrypted_key: await encryptPrivateKey(PRIV_HEX, passphrase),
  } as FullConfig;
}

describe("session passphrase cache", () => {
  const savedEnv = process.env["MOTEBIT_PASSPHRASE"];

  beforeEach(() => {
    delete process.env["MOTEBIT_PASSPHRASE"];
    clearSessionPassphrase();
  });

  afterEach(() => {
    if (savedEnv == null) delete process.env["MOTEBIT_PASSPHRASE"];
    else process.env["MOTEBIT_PASSPHRASE"] = savedEnv;
    clearSessionPassphrase();
  });

  it("a successful decrypt seeds the cache (the proof point)", async () => {
    const config = await makeConfig(PASSPHRASE);
    clearSessionPassphrase(); // encryptPrivateKey seeded it — reset to isolate decrypt
    expect(sessionPassphraseSnapshotForTest()).toBeNull();
    await decryptPrivateKey(config.cli_encrypted_key!, PASSPHRASE);
    expect(sessionPassphraseSnapshotForTest()).toBe(PASSPHRASE);
  });

  it("a FAILED decrypt does not seed the cache (no unverified value ever cached)", async () => {
    const config = await makeConfig(PASSPHRASE);
    clearSessionPassphrase();
    await expect(decryptPrivateKey(config.cli_encrypted_key!, "wrong")).rejects.toThrow();
    expect(sessionPassphraseSnapshotForTest()).toBeNull();
  });

  it("setting a passphrase (encrypt) seeds the cache — set is its own proof", async () => {
    await encryptPrivateKey(PRIV_HEX, "fresh-passphrase");
    expect(sessionPassphraseSnapshotForTest()).toBe("fresh-passphrase");
  });

  it("loadActiveSigningKey resolves silently from the cache — no prompt, no env, no getter", async () => {
    const config = await makeConfig(PASSPHRASE);
    // Cache is seeded (by encrypt above); with no MOTEBIT_PASSPHRASE and no
    // injected getter, a cache miss would fall through to an interactive
    // prompt and hang this test — resolving at all IS the assertion.
    const { privateKey, source } = await loadActiveSigningKey(config);
    expect(source).toBe("encrypted-config");
    expect(privateKey).toHaveLength(32);
  }, 10_000);

  it("MOTEBIT_PASSPHRASE wins over the cache", async () => {
    const config = await makeConfig(PASSPHRASE);
    rememberSessionPassphrase("stale-wrong-value");
    process.env["MOTEBIT_PASSPHRASE"] = PASSPHRASE;
    // If the cache were consulted first, decrypt would fail with the
    // stale value and (per self-heal) re-prompt — env winning means this
    // resolves with no interaction.
    const { privateKey } = await loadActiveSigningKey(config);
    expect(privateKey).toHaveLength(32);
  }, 10_000);

  it("an injected getPassphrase that succeeds re-seeds the cache via the decrypt proof point", async () => {
    const config = await makeConfig(PASSPHRASE);
    clearSessionPassphrase();
    let calls = 0;
    await loadActiveSigningKey(config, {
      getPassphrase: async () => {
        calls += 1;
        return PASSPHRASE;
      },
    });
    expect(calls).toBe(1);
    expect(sessionPassphraseSnapshotForTest()).toBe(PASSPHRASE);
  });

  it("empty string never seeds the cache", () => {
    rememberSessionPassphrase("");
    expect(sessionPassphraseSnapshotForTest()).toBeNull();
  });
});
