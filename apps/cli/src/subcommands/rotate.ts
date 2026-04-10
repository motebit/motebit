/**
 * `motebit rotate` — rotate the Ed25519 keypair with a signed
 * succession record, re-sign the identity file, and submit the
 * succession to the relay.
 *
 * The private `discoverIdentityFile` helper walks cwd + parent
 * directories + `~/.motebit/identity.md` looking for an existing
 * motebit.md to rotate. Rotation is all-or-nothing: if the new
 * identity file fails self-verification, the old key is kept and
 * nothing is written.
 */

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { verifyIdentityFile, rotate as rotateIdentityFile } from "@motebit/identity-file";
import { rotateIdentityKeys } from "@motebit/core-identity";
import {
  hexPublicKeyToDidKey,
  createSignedToken,
  secureErase,
  bytesToHex,
} from "@motebit/encryption";
import type { CliConfig } from "../args.js";
import { CONFIG_DIR, loadFullConfig, saveFullConfig } from "../config.js";
import { fromHex, promptPassphrase, encryptPrivateKey, decryptPrivateKey } from "../identity.js";

/**
 * Discover motebit.md by searching cwd, parent directories, and ~/.motebit/identity.md.
 * Returns the absolute path to the first found identity file, or null.
 */
function discoverIdentityFile(): string | null {
  // 1. Walk up from cwd looking for motebit.md
  let dir = process.cwd();
  const root = path.parse(dir).root;
  let parent = path.dirname(dir);
  while (dir !== parent && dir !== root) {
    const candidate = path.join(dir, "motebit.md");
    if (fs.existsSync(candidate)) return candidate;
    dir = parent;
    parent = path.dirname(dir);
  }
  // Check root itself
  const rootCandidate = path.join(root, "motebit.md");
  if (fs.existsSync(rootCandidate)) return rootCandidate;

  // 2. Check ~/.motebit/identity.md
  const homeCandidate = path.join(CONFIG_DIR, "identity.md");
  if (fs.existsSync(homeCandidate)) return homeCandidate;

  return null;
}

export async function handleRotate(config: CliConfig): Promise<void> {
  const reason = config.reason;

  // 1. Find identity file
  const identityPath = discoverIdentityFile();
  if (!identityPath) {
    console.error("Error: no motebit.md found. Searched cwd/parents and ~/.motebit/identity.md.");
    console.error("  Run `motebit export` first to generate an identity file.");
    process.exit(1);
  }

  console.log(`\nIdentity file: ${identityPath}`);

  // 2. Read and verify existing identity file
  let existingContent: string;
  try {
    existingContent = fs.readFileSync(identityPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: cannot read identity file: ${msg}`);
    process.exit(1);
  }

  const verifyResult = await verifyIdentityFile(existingContent);
  if (!verifyResult.valid || !verifyResult.identity) {
    console.error("Error: identity file verification failed.");
    if (verifyResult.error) console.error(`  ${verifyResult.error}`);
    process.exit(1);
  }
  console.log("  Verified: signature valid");

  const identity = verifyResult.identity;
  const motebitId = identity.motebit_id;
  const oldPublicKeyHex = identity.identity.public_key;

  // 3. Load config and decrypt old private key
  const fullConfig = loadFullConfig();
  if (!fullConfig.cli_encrypted_key) {
    console.error("Error: no encrypted key found in config. Cannot rotate without the old key.");
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    escapeCodeTimeout: 50,
  });
  const envPassphrase = process.env["MOTEBIT_PASSPHRASE"];
  let passphrase: string;
  if (envPassphrase != null && envPassphrase !== "") {
    passphrase = envPassphrase;
  } else {
    passphrase = await promptPassphrase(rl, "Passphrase: ");
  }

  let oldPrivKeyHex: string;
  try {
    oldPrivKeyHex = await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
  } catch {
    console.error("Error: incorrect passphrase.");
    rl.close();
    process.exit(1);
  }

  const oldPrivateKey = fromHex(oldPrivKeyHex);
  const oldPublicKey = fromHex(oldPublicKeyHex);

  // 4. Generate new keypair and sign succession record
  const rotateResult = await rotateIdentityKeys({
    oldPrivateKey,
    oldPublicKey,
    reason,
  });
  console.log(`  Old public key: ${oldPublicKeyHex.slice(0, 16)}...`);
  console.log(`  New public key: ${rotateResult.newPublicKeyHex.slice(0, 16)}...`);
  console.log("  Succession record: created (dual-signed)");

  // 5. Rotate identity file and verify before writing
  const rotatedContent = await rotateIdentityFile({
    existingContent,
    newPublicKey: rotateResult.newPublicKey,
    newPrivateKey: rotateResult.newPrivateKey,
    successionRecord: rotateResult.successionRecord,
  });
  const rotatedVerify = await verifyIdentityFile(rotatedContent);
  if (!rotatedVerify.valid) {
    console.error("Error: rotated identity file failed self-verification. Aborting.");
    if (rotatedVerify.error) console.error(`  ${rotatedVerify.error}`);
    secureErase(oldPrivateKey);
    secureErase(rotateResult.newPrivateKey);
    rl.close();
    process.exit(1);
  }

  fs.writeFileSync(identityPath, rotatedContent, "utf-8");
  console.log("  Identity file: updated and re-signed");

  // 6. Encrypt new private key and update config
  fullConfig.cli_encrypted_key = await encryptPrivateKey(
    bytesToHex(rotateResult.newPrivateKey),
    passphrase,
  );
  fullConfig.device_public_key = rotateResult.newPublicKeyHex;
  saveFullConfig(fullConfig);
  console.log("  Config: new key encrypted and saved");

  // Securely erase old key material
  secureErase(oldPrivateKey);
  secureErase(rotateResult.newPrivateKey);

  // 8. Submit succession record to relay if configured
  const syncUrl = fullConfig.sync_url ?? process.env["MOTEBIT_SYNC_URL"];
  if (syncUrl) {
    const baseUrl = syncUrl.replace(/\/+$/, "");
    try {
      // Re-decrypt new key for signing the relay request
      if (!fullConfig.cli_encrypted_key) throw new Error("No encrypted key in config");
      const newPrivKeyHex = await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
      const newPrivKey = fromHex(newPrivKeyHex);
      const deviceId = fullConfig.device_id ?? "";

      const token = await createSignedToken(
        {
          mid: motebitId,
          did: deviceId,
          iat: Date.now(),
          exp: Date.now() + 5 * 60 * 1000,
          jti: crypto.randomUUID(),
          aud: "rotate-key",
        },
        newPrivKey,
      );
      secureErase(newPrivKey);

      const relayResp = await fetch(`${baseUrl}/api/v1/agents/${motebitId}/rotate-key`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(rotateResult.successionRecord),
      });

      if (relayResp.ok) {
        console.log("  Relay: succession record submitted");
      } else {
        const text = await relayResp.text();
        console.warn(`  Relay: submission failed (${relayResp.status}): ${text.slice(0, 200)}`);
        console.warn("  The local rotation is complete. Re-register with the relay manually.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Relay: could not reach ${baseUrl}: ${msg}`);
      console.warn("  The local rotation is complete. Re-register with the relay manually.");
    }
  } else {
    console.log("  Relay: not configured (skipped)");
  }

  // 9. Summary
  console.log();
  console.log("Key rotation complete.");
  console.log(`  motebit_id   ${motebitId}`);
  console.log(`  did          ${hexPublicKeyToDidKey(rotateResult.newPublicKeyHex)}`);
  console.log(`  public_key   ${rotateResult.newPublicKeyHex.slice(0, 16)}...`);
  const chainLength = (identity.succession?.length ?? 0) + 1;
  console.log(`  rotations    ${chainLength}`);
  if (reason) {
    console.log(`  reason       ${reason}`);
  }
  console.log();

  rl.close();
}
