/**
 * `motebit migrate-keyring` — re-encrypt a plaintext `dev-keyring.json`
 * private key under a passphrase and write it as `cli_encrypted_key`
 * in `~/.motebit/config.json`.
 *
 * Recovery path for users whose `cli_encrypted_key` is missing from
 * config but who still have a valid private key on disk under
 * `~/.motebit/dev-keyring.json` (written by the desktop Tauri app's
 * Keychain-failure fallback in `apps/desktop/src/identity-manager.ts`,
 * or by older scaffold flows).
 *
 * The alternative — running the interactive setup again — would create
 * a brand new identity, abandoning whatever motebit_id was active and
 * everything signed under it. This subcommand preserves the existing
 * identity by encrypting the existing private key.
 *
 * Doctrine: identity creation is rare and intentional. Recovery flows
 * MUST be explicit, MUST preserve the canonical motebit_id, and MUST
 * fail closed if the key on disk doesn't match the registered public.
 *
 * Operations:
 *   1. Read `~/.motebit/dev-keyring.json` — fail-closed if absent.
 *   2. Verify the private key derives to `config.device_public_key`.
 *      Mismatch is a sign of state drift (multiple identities; the
 *      dev-keyring belongs to a different motebit_id). Fail closed.
 *   3. Prompt for a new passphrase (twice, with confirmation).
 *   4. Encrypt the private key under the new passphrase via the
 *      same `encryptPrivateKey` flow `motebit init` uses.
 *   5. Write `cli_encrypted_key` to config.json.
 *   6. Securely erase + remove `dev-keyring.json` (with confirmation).
 *
 * Idempotent on repeat: if `cli_encrypted_key` already exists, refuses
 * unless --force is passed (the user might be intentionally overwriting
 * after a passphrase change, but the default should preserve).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { secureErase, getPublicKeyBySuite } from "@motebit/encryption";
import type { CliConfig } from "../args.js";
import { CONFIG_DIR, loadFullConfig, saveFullConfig } from "../config.js";
import { encryptPrivateKey, fromHex, toHex, promptPassphrase } from "../identity.js";

interface DevKeyring {
  device_private_key: string;
}

export async function handleMigrateKeyring(config: CliConfig): Promise<void> {
  const force = config.force === true;

  const fullConfig = loadFullConfig();
  if (!fullConfig.motebit_id || !fullConfig.device_public_key) {
    console.error(
      "Error: ~/.motebit/config.json has no identity (no motebit_id / device_public_key). " +
        "Run `motebit` (no args) to create a fresh identity, or restore your config from a backup.",
    );
    process.exit(1);
  }

  if (fullConfig.cli_encrypted_key && !force) {
    console.error(
      "Error: cli_encrypted_key already present in ~/.motebit/config.json. " +
        "Re-running this command would overwrite it. " +
        "If you intend to re-encrypt under a new passphrase, pass --force.",
    );
    process.exit(1);
  }

  const devKeyringPath = path.join(CONFIG_DIR, "dev-keyring.json");
  if (!fs.existsSync(devKeyringPath)) {
    console.error(`Error: no plaintext keyring at ${devKeyringPath}.`);
    console.error(
      "  This subcommand recovers from configs where cli_encrypted_key was lost\n" +
        "  but a plaintext key remains on disk. If you have neither, run\n" +
        "  `motebit` (no args) to create a fresh identity.",
    );
    process.exit(1);
  }

  let devKeyring: DevKeyring;
  try {
    const raw = fs.readFileSync(devKeyringPath, "utf-8");
    devKeyring = JSON.parse(raw) as DevKeyring;
  } catch (err) {
    console.error(
      `Error: dev-keyring.json is malformed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  if (typeof devKeyring.device_private_key !== "string") {
    console.error("Error: dev-keyring.json missing device_private_key field.");
    process.exit(1);
  }

  // Verify the private key derives to the registered public. The same
  // fail-closed defense `loadActiveSigningKey` enforces — the dev-
  // keyring on disk might belong to a different motebit_id.
  let privateKeyBytes: Uint8Array;
  try {
    privateKeyBytes = fromHex(devKeyring.device_private_key);
  } catch (err) {
    console.error(
      `Error: dev-keyring.json device_private_key is not valid hex (${err instanceof Error ? err.message : String(err)}).`,
    );
    process.exit(1);
  }
  if (privateKeyBytes.length !== 32) {
    console.error(
      `Error: dev-keyring.json device_private_key is ${privateKeyBytes.length} bytes; expected 32.`,
    );
    process.exit(1);
  }

  const derivedPubBytes = await getPublicKeyBySuite(privateKeyBytes, "motebit-jcs-ed25519-hex-v1");
  const derivedPubHex = toHex(derivedPubBytes);
  if (derivedPubHex.toLowerCase() !== fullConfig.device_public_key.toLowerCase()) {
    secureErase(privateKeyBytes);
    console.error("Error: dev-keyring private key does NOT derive to config.device_public_key.");
    console.error(`  config.device_public_key: ${fullConfig.device_public_key.slice(0, 12)}...`);
    console.error(`  derived from dev-keyring: ${derivedPubHex.slice(0, 12)}...`);
    console.error(
      "\n  This means dev-keyring.json belongs to a DIFFERENT identity than the one\n" +
        "  in your config. Common cause: identity rotation that left an orphaned\n" +
        "  keyring file behind. The safe move is to NOT migrate this key — it would\n" +
        "  bind a private key for one motebit_id under config claiming another.\n\n" +
        "  Resolve by:\n" +
        "    - removing dev-keyring.json if it's truly orphaned, OR\n" +
        "    - restoring the matching config.json from a backup\n" +
        "      (look for ~/.motebit/config.json.clobbered-* files), OR\n" +
        "    - running `motebit` (no args) to create a fresh identity.",
    );
    process.exit(1);
  }

  // Resolve the new passphrase. Prefer MOTEBIT_PASSPHRASE for
  // unattended / scripted use (matches the convention in
  // _helpers.getRelayAuthHeaders, register, daemon); otherwise prompt
  // twice with confirmation. The env value is treated as both the
  // typed and confirmed passphrase since the user opted in by exporting
  // it explicitly.
  const envPassphrase = process.env["MOTEBIT_PASSPHRASE"];
  let passphrase: string;
  if (envPassphrase != null && envPassphrase !== "") {
    passphrase = envPassphrase;
    console.log("Using passphrase from MOTEBIT_PASSPHRASE env.");
  } else {
    passphrase = await promptPassphrase("Choose a passphrase to encrypt the identity key: ");
    if (passphrase.length === 0) {
      secureErase(privateKeyBytes);
      console.error("Error: passphrase cannot be empty.");
      process.exit(1);
    }
    const confirmation = await promptPassphrase("Confirm passphrase: ");
    if (confirmation !== passphrase) {
      secureErase(privateKeyBytes);
      console.error("Error: passphrases do not match.");
      process.exit(1);
    }
  }

  // Encrypt and persist.
  const encrypted = await encryptPrivateKey(devKeyring.device_private_key, passphrase);
  fullConfig.cli_encrypted_key = encrypted;
  // If a legacy plaintext key happens to be present too, drop it — the
  // encrypted key is now canonical.
  if (fullConfig.cli_private_key != null) {
    delete fullConfig.cli_private_key;
  }
  saveFullConfig(fullConfig);

  // Securely overwrite the in-memory copy and remove the plaintext file
  // from disk. The file is the threat surface; once we're confident the
  // encrypted copy is persisted, the plaintext should not linger.
  secureErase(privateKeyBytes);
  try {
    // Best-effort secure remove: overwrite contents before unlink so a
    // post-deletion recover from disk sectors yields zero bytes
    // (filesystem-dependent; this is harm-reduction, not a guarantee).
    const stat = fs.statSync(devKeyringPath);
    fs.writeFileSync(devKeyringPath, "0".repeat(Math.min(stat.size, 4096)));
    fs.unlinkSync(devKeyringPath);
  } catch (err) {
    console.warn(
      `Warning: could not remove ${devKeyringPath} (${err instanceof Error ? err.message : String(err)}).`,
    );
    console.warn("  Remove it manually — leaving a plaintext private key on disk is unsafe.");
  }

  console.log("\nIdentity key migrated.");
  console.log(`  motebit_id:        ${fullConfig.motebit_id}`);
  console.log(`  device_public_key: ${fullConfig.device_public_key.slice(0, 12)}...`);
  console.log(`  storage:           cli_encrypted_key (passphrase-protected)`);
  console.log("\nNext step: `motebit register` to register this identity with the relay.");
}
