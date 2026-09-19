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
import { verify, rotate as rotateIdentityFile } from "@motebit/identity-file";
import { rotateIdentityKeys } from "@motebit/core-identity";
import { submitSuccessionToRelay } from "@motebit/sync-engine";
import { resolveRelayUrl } from "./_helpers.js";
import {
  clearPendingRotation,
  loadPendingRotation,
  savePendingRotation,
} from "../pending-rotation.js";
import { hexPublicKeyToDidKey, secureErase, bytesToHex } from "@motebit/encryption";
import type { CliConfig } from "../args.js";
import { CONFIG_DIR, loadFullConfig, saveFullConfig } from "../config.js";
import {
  fromHex,
  resolveUnlockPassphrase,
  encryptPrivateKey,
  decryptPrivateKey,
} from "../identity.js";

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

  const verifyResult = await verify(existingContent, { expectedType: "identity" });
  if (verifyResult.type !== "identity" || !verifyResult.valid || !verifyResult.identity) {
    console.error("Error: identity file verification failed.");
    const msg = verifyResult.errors?.[0]?.message;
    if (msg) console.error(`  ${msg}`);
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
    passphrase = await resolveUnlockPassphrase("Passphrase: ", {
      rl,
      encryptedKey: fullConfig.cli_encrypted_key,
    });
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

  // 4. Generate new keypair and sign succession record — unless one is
  // already held. A rotation whose submission outcome was unknown left its
  // record behind; finishing THAT one is what lets the relay recognise it
  // ("already recorded"). Minting a fresh keypair here would present a
  // record departing from a key the relay may already have retired, which
  // it refuses for good.
  const held = loadPendingRotation(motebitId, oldPublicKeyHex);
  if (held != null) {
    console.log("  Held rotation found — finishing it rather than starting a new one.");
  }
  const rotateResult =
    held != null
      ? {
          newPrivateKey: fromHex(await decryptPrivateKey(held.encrypted_new_key, passphrase)),
          newPublicKeyHex: held.new_public_key,
          newPublicKey: fromHex(held.new_public_key),
          successionRecord: held.record,
        }
      : await rotateIdentityKeys({
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
  const rotatedVerify = await verify(rotatedContent, { expectedType: "identity" });
  if (!rotatedVerify.valid) {
    console.error("Error: rotated identity file failed self-verification. Aborting.");
    const msg = rotatedVerify.errors?.[0]?.message;
    if (msg) console.error(`  ${msg}`);
    secureErase(oldPrivateKey);
    secureErase(rotateResult.newPrivateKey);
    rl.close();
    process.exit(1);
  }

  // 5b. Tell the relay BEFORE committing anything locally.
  //
  // This used to run last, best-effort, after the old key was erased — so a
  // relay that was down, rate-limited or unreachable left local state on the
  // new key while the relay still served the old one. Nothing could repair
  // that: the record cannot be re-presented (the relay verifies the token
  // against the key it holds, which is now the wrong one), and the identity
  // endpoint third parties read (`spec/identity-v1.md` §7.6) went on serving
  // the retired key, so every receipt signed afterwards failed to verify —
  // silently, and for good. This file's own contract is all-or-nothing.
  // Resolved the same way every other subcommand resolves it — flag, env,
  // persisted, then the default relay. Reading only the persisted value
  // told an identity registered against the default relay that no relay
  // was configured, and rotated it locally into the split state this
  // whole path exists to prevent.
  const syncUrl = resolveRelayUrl(config);
  {
    // Written BEFORE the request goes out, so a response that is lost or
    // times out is recoverable rather than terminal. Without it the next
    // run mints a FRESH keypair and a record departing from a key the
    // relay may already have retired — which it refuses, for good. Holding
    // the pending record is what lets the next run re-present the SAME one
    // and meet the relay's "already recorded" answer.
    if (held == null) {
      const encryptedNewKey = await encryptPrivateKey(
        bytesToHex(rotateResult.newPrivateKey),
        passphrase,
      );
      if (encryptedNewKey == null) {
        console.error("Error: could not encrypt the new key. Nothing was changed.");
        secureErase(oldPrivateKey);
        secureErase(rotateResult.newPrivateKey);
        rl.close();
        process.exit(1);
      }
      savePendingRotation({
        motebit_id: motebitId,
        old_public_key: oldPublicKeyHex,
        new_public_key: rotateResult.newPublicKeyHex,
        record: rotateResult.successionRecord,
        encrypted_new_key: encryptedNewKey,
      });
    }
    const submitted = await submitSuccessionToRelay({
      syncUrl,
      motebitId,
      deviceId: fullConfig.device_id ?? "",
      // Signed with the key being RETIRED: it is the only one the relay
      // can verify at this moment. That makes the request authentic, not
      // safe — a thief holding the same key can sign one too, and whoever
      // arrives first wins. Rotation does not adjudicate that race.
      signingKey: oldPrivateKey,
      record: rotateResult.successionRecord,
    });
    if (!submitted.ok) {
      console.error(`Error: the relay did not record the rotation — ${submitted.reason}`);
      console.error("  Your current key still works; nothing local was changed.");
      console.error(
        "  This rotation is held, and `motebit rotate` will finish it rather than start a new one.",
      );
      console.error(
        "  If the relay holds a key this machine no longer has, it cannot be reached from here:",
      );
      console.error("  recover through the identity's guardian, or ask the relay operator.");
      secureErase(oldPrivateKey);
      secureErase(rotateResult.newPrivateKey);
      rl.close();
      process.exit(1);
    }
    console.log(
      submitted.applied
        ? "  Relay: rotation recorded"
        : "  Relay: rotation already recorded (no change)",
    );
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

  // Local state now agrees with the relay, so the held rotation is done.
  clearPendingRotation();

  // Securely erase old key material
  secureErase(oldPrivateKey);
  secureErase(rotateResult.newPrivateKey);

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
