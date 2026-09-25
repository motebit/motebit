/**
 * `motebit migrate-keyring` — re-encrypt a plaintext `dev-keyring.json`
 * private key under a passphrase and write it as `cli_encrypted_key`
 * in `~/.motebit/config.json`.
 *
 * Recovery path for users whose `cli_encrypted_key` is missing from
 * config but who still have a valid private key on disk under
 * `~/.motebit/dev-keyring.json` (the desktop Tauri app's key store — every
 * shipped desktop keeps its keys there, no OS keychain — or written by
 * older scaffold flows).
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
 *   6. Move `dev-keyring.json` aside to `dev-keyring.json.migrated-<time>` (0600, never
 *      erased) — or leave it in place when it holds entries beyond the migrated key.
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
import { isTrulyAbsent, moveAside, narrowOnLoad } from "../durable-file.js";
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
  // Rule R1: only ENOENT of the name itself is "no keyring". A dangling
  // symlink or an unreadable directory is something there, not nothing.
  if (isTrulyAbsent(devKeyringPath)) {
    // A previous run of this command retired the plaintext keyring whole to
    // dev-keyring.json.migrated-<t> (owner-only, kept, never erased). That
    // is not "no keyring" — say where it went. (No shipped desktop uses the
    // OS keychain; a keychain-index.json is left only by a pre-release
    // desktop build. This command never recreates a plaintext keyring.)
    const migrated = migratedKeyringEvidence();
    if (migrated.length > 0) {
      console.error(
        `Error: ${devKeyringPath} is gone because a previous \`motebit migrate-keyring\` run retired it (${migrated.join(", ")}).`,
      );
      console.error(
        "  A `.migrated-*` copy is that run's retired plaintext keyring, kept owner-only; this command\n" +
          "  does not read it back. Recover the CLI identity with `motebit restore` (recovery seed), or\n" +
          "  move that copy back to dev-keyring.json yourself and run this command again.",
      );
      process.exit(1);
    }
    console.error(`Error: no plaintext keyring at ${devKeyringPath}.`);
    console.error(
      "  This subcommand recovers from configs where cli_encrypted_key was lost\n" +
        "  but a plaintext key remains on disk. If you have neither, run\n" +
        "  `motebit` (no args) to create a fresh identity.",
    );
    process.exit(1);
  }

  // It holds a PLAINTEXT private key: narrowed to owner-only on load, before
  // anything else can fail (R3).
  narrowOnLoad(devKeyringPath);
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
  // An identity change, declared. With --force an existing
  // `cli_encrypted_key` is REPLACED — and it may encrypt a different key than
  // the one this keyring holds (it cannot be checked without its own
  // passphrase), so the config it was in is kept as
  // `config.json.clobbered-<time>` first. Refused if another process changed
  // the identity while the passphrase was being typed.
  const keptConfig = saveFullConfig(fullConfig, { identityChange: "preserve-replaced" });
  if (keptConfig != null) {
    console.log(`The replaced config (and its key) was kept as ${keptConfig}.`);
  }

  // Securely overwrite the in-memory copy and remove the plaintext file
  // from disk. The file is the threat surface; once we're confident the
  // encrypted copy is persisted, the plaintext should not linger.
  secureErase(privateKeyBytes);
  // The keyring may hold MORE than this key — the desktop keeps a rotation
  // write-ahead (`pending_rotation`, a new private key) and other secrets in
  // the same file. Destroying those would destroy a key (R2), so the file is
  // removed only when the migrated key is all it holds.
  const otherEntries = Object.keys(devKeyring).filter((k) => k !== "device_private_key");
  if (otherEntries.length > 0) {
    console.warn(
      `Warning: ${devKeyringPath} also holds ${otherEntries.join(", ")}; it was left in place (owner-only).`,
    );
    console.warn(
      "  The identity key is now encrypted in config.json. Remove the plaintext copy from that file",
    );
    console.warn("  only once nothing else (the desktop app) still needs the other entries.");
  } else {
    const kept = retirePlaintextKeyring(devKeyringPath);
    if (kept != null) {
      console.log(
        `The plaintext keyring was moved aside to ${kept} (owner-only, not erased). Delete it yourself once you have confirmed the migration.`,
      );
    }
  }
  console.log("\nIdentity key migrated.");
  console.log(`  motebit_id:        ${fullConfig.motebit_id}`);
  console.log(`  device_public_key: ${fullConfig.device_public_key.slice(0, 12)}...`);
  console.log(`  storage:           cli_encrypted_key (passphrase-protected)`);
  console.log("\nNext step: `motebit register` to register this identity with the relay.");
}

/**
 * Retire the migrated plaintext keyring from its active name WITHOUT
 * destroying it (R2): the whole file moves to `dev-keyring.json.migrated-<time>`
 * (owner-only). (The desktop's keychain migration — arc-only, #764 — keeps
 * its copy under a different name, `dev-keyring.json.keychain-migrated-<t>`,
 * so the two never read as each other.) A SYMLINK's target is never touched: its
 * bytes are copied aside and only the link is removed. Nothing is zeroed —
 * this command never erases key bytes, migrated or not. Returns the kept
 * path, or null (with a warning) when it could not be moved.
 */
function retirePlaintextKeyring(devKeyringPath: string): string | null {
  try {
    return moveAside(devKeyringPath, ".migrated-");
  } catch (err) {
    console.warn(
      `Warning: could not move ${devKeyringPath} aside (${err instanceof Error ? err.message : String(err)}); it was left in place (owner-only).`,
    );
    return null;
  }
}

/**
 * Evidence that the plaintext keyring was retired on purpose: a previous
 * run's kept copy (`dev-keyring.json.migrated-<time>`), or a pre-release
 * desktop build's `keychain-index.json`. Never throws.
 */
function migratedKeyringEvidence(): string[] {
  try {
    return fs
      .readdirSync(CONFIG_DIR)
      .filter((f) => f.startsWith("dev-keyring.json.migrated-") || f === "keychain-index.json")
      .map((f) => path.join(CONFIG_DIR, f));
  } catch {
    return [];
  }
}
