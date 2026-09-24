/**
 * `motebit rotate` — rotate the Ed25519 keypair with a signed succession
 * record, tell the relay, and only then re-sign the identity file and move
 * the local key.
 *
 * The algorithm lives in `../rotation.ts` (`performRotation`), a state
 * machine over what this machine holds and what the relay holds, with every
 * side effect injected so it is driven end-to-end against an in-process
 * relay in tests. This file is the terminal: find the identity file, unlock
 * the key, resolve the relay, print what happened.
 */

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { hexPublicKeyToDidKey } from "@motebit/encryption";
import type { CliConfig } from "../args.js";
import { CONFIG_DIR, loadFullConfig, saveFullConfig } from "../config.js";
import { resolveUnlockPassphrase } from "../identity.js";
import {
  clearPendingRotation,
  loadAnyPendingRotation,
  loadPendingRotation,
  pendingRotationPath,
  savePendingRotation,
} from "../pending-rotation.js";
import { performRotation, RotationUnlockError, type RotationNote } from "../rotation.js";
import { resolveRelayUrl } from "./_helpers.js";

/**
 * Discover motebit.md by searching cwd, parent directories, and ~/.motebit/identity.md.
 * Returns the absolute path to the first found identity file, or null.
 */
function discoverIdentityFile(): string | null {
  let dir = process.cwd();
  const root = path.parse(dir).root;
  let parent = path.dirname(dir);
  while (dir !== parent && dir !== root) {
    const candidate = path.join(dir, "motebit.md");
    if (fs.existsSync(candidate)) return candidate;
    dir = parent;
    parent = path.dirname(dir);
  }
  const rootCandidate = path.join(root, "motebit.md");
  if (fs.existsSync(rootCandidate)) return rootCandidate;

  const homeCandidate = path.join(CONFIG_DIR, "identity.md");
  if (fs.existsSync(homeCandidate)) return homeCandidate;

  return null;
}

function describeNote(note: RotationNote): string {
  switch (note.kind) {
    case "stale-write-ahead-cleared":
      return `Note: a held rotation for ${note.motebitId === "" ? "an unknown identity" : `identity ${note.motebitId.slice(0, 12)}…`} from key ${note.oldPublicKey.slice(0, 12)}… did not belong to this machine's current key and was cleared`;
    case "write-ahead-discarded": {
      const minutes = Math.round(note.ageMs / 60_000);
      return `Note: a held rotation from ${minutes} minute${minutes === 1 ? "" : "s"} ago was never recorded by the relay and was discarded; a fresh one was made`;
    }
    case "interrupted-commit-finished":
      return `Note: the previous rotation was interrupted between its two local writes; finished it — this machine is on ${note.newPublicKeyHex.slice(0, 16)}…`;
  }
}

export async function handleRotate(config: CliConfig): Promise<void> {
  const identityPath = discoverIdentityFile();
  if (!identityPath) {
    console.error("Error: no motebit.md found. Searched cwd/parents and ~/.motebit/identity.md.");
    console.error("  Run `motebit export` first to generate an identity file.");
    process.exit(1);
  }
  console.log(`\nIdentity file: ${identityPath}`);

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
  const passphrase =
    envPassphrase != null && envPassphrase !== ""
      ? envPassphrase
      : await resolveUnlockPassphrase("Passphrase: ", {
          rl,
          encryptedKey: fullConfig.cli_encrypted_key,
        });

  const syncUrl = resolveRelayUrl(config);
  console.log(`  Relay: ${syncUrl}`);

  let outcome;
  try {
    outcome = await performRotation({
      identityPath,
      loadConfig: loadFullConfig,
      saveConfig: saveFullConfig,
      pending: {
        load: loadPendingRotation,
        loadAny: loadAnyPendingRotation,
        save: savePendingRotation,
        clear: clearPendingRotation,
        path: pendingRotationPath(),
      },
      passphrase,
      ...(config.reason !== undefined ? { reason: config.reason } : {}),
      syncUrl,
    });
  } catch (err: unknown) {
    // Classified by TYPE: the unlock step throws its own error, so no
    // message text is pattern-matched (WebCrypto's decrypt failure says
    // nothing about passphrases, and an unrelated error may say "auth").
    const msg =
      err instanceof RotationUnlockError
        ? "incorrect passphrase"
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`Error: ${msg}.`);
    rl.close();
    process.exit(1);
  }
  rl.close();

  for (const note of outcome.notes) console.log(`  ${describeNote(note)}`);

  switch (outcome.kind) {
    case "stopped": {
      console.error(`Error: ${outcome.message}.`);
      process.exit(1);
    }
    // eslint-disable-next-line no-fallthrough -- process.exit never returns
    case "held": {
      console.error(`  Relay: outcome unknown — ${outcome.reason}.`);
      console.error(
        "  Your current key still works; nothing local was changed. The new key is held, encrypted, in",
      );
      console.error(`  ${pendingRotationPath()}.`);
      console.error(
        "  Run `motebit rotate` again: it reads the relay and finishes this rotation if the relay recorded it, or starts a fresh one if not.",
      );
      process.exit(1);
    }
    // eslint-disable-next-line no-fallthrough -- process.exit never returns
    case "rotated": {
      const relayLine =
        outcome.relay === "recorded"
          ? "recorded the rotation"
          : outcome.relay === "already-held"
            ? "already held it — finished the rotation this machine started earlier"
            : "holds no key for this identity; nothing to record there (a later `motebit up` registers the new key)";
      console.log(`  Relay: ${relayLine}`);
      console.log("  Identity file: updated and re-signed");
      console.log("  Config: new key encrypted and saved; old key erased");
      console.log();
      console.log("Key rotation complete.");
      console.log(`  motebit_id   ${outcome.motebitId}`);
      console.log(`  did          ${hexPublicKeyToDidKey(outcome.newPublicKeyHex)}`);
      console.log(`  public_key   ${outcome.newPublicKeyHex.slice(0, 16)}...`);
      console.log(`  rotations    ${outcome.rotations}`);
      if (config.reason) console.log(`  reason       ${config.reason}`);
      console.log();
    }
  }
}
