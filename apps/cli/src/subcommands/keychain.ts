/**
 * `motebit keychain` — opt-in passphrase enrollment in the macOS login
 * Keychain (#438, the third leg of the recovery-UX arc #428).
 *
 *   motebit keychain           — enrollment status + what it does/doesn't do
 *   motebit keychain enroll    — validate the passphrase, store it
 *   motebit keychain remove    — delete the enrollment
 *
 * Honesty rules (the copy below is load-bearing — see keychain.ts):
 * - "login Keychain, protected by your macOS account" — never "Touch ID".
 * - Enrollment weakens "passphrase in your head" to "passphrase on this
 *   machine": any process running as your user can read it. Opt-in only.
 * - It does NOT replace the recovery seed (keychain and disk die with the
 *   machine) — the seed nudge stays visible until a seed backup is
 *   acknowledged, enrolled or not.
 * - `motebit seed reveal` ALWAYS asks interactively — enrollment must not
 *   turn a reveal-once secret into a zero-interaction dump for whoever is
 *   at an unlocked terminal.
 */

import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { decryptPrivateKey, promptPassphrase } from "../identity.js";
import {
  isKeychainSupported,
  keychainEnrollmentStatus,
  readKeychainPassphrase,
  writeKeychainPassphrase,
  deleteKeychainPassphrase,
} from "../keychain.js";
import { seedBackupStatus } from "./seed.js";
import { bold, dim, success, warn } from "../colors.js";

export async function handleKeychain(config: CliConfig): Promise<void> {
  const sub = config.positionals[1];
  const full = loadFullConfig();

  if (!isKeychainSupported()) {
    console.log("\n  Keychain enrollment is macOS-only in v1 (login Keychain via `security`).");
    console.log(dim("  On this platform, use MOTEBIT_PASSPHRASE or the interactive prompt."));
    process.exit(sub === "enroll" ? 1 : 0);
  }

  if (full.motebit_id == null || full.cli_encrypted_key == null) {
    console.log("\n  No identity on this machine. Run `motebit init` or `motebit restore`.");
    process.exit(1);
  }
  const motebitId = full.motebit_id;

  if (sub === "enroll") {
    const passphrase = await promptPassphrase("  Passphrase: ");
    try {
      await decryptPrivateKey(full.cli_encrypted_key, passphrase);
    } catch {
      console.error("\n  Incorrect passphrase — nothing was stored.");
      process.exit(1);
    }
    if (!writeKeychainPassphrase(motebitId, passphrase)) {
      console.error("\n  Keychain write failed — nothing was stored.");
      process.exit(1);
    }
    console.log(`\n  ${success("Enrolled.")} Commands unlock without a prompt on this machine.`);
    console.log(dim("  Stored in your macOS login Keychain, protected by your macOS account —"));
    console.log(dim("  this is convenience, not biometrics: any process running as your user"));
    console.log(dim("  can read it. Undo anytime: motebit keychain remove"));
    console.log(dim("  `motebit seed reveal` still always asks for the passphrase."));
    if (seedBackupStatus(full) === "not_backed_up") {
      console.log(
        `\n  ${warn("Your recovery seed is still not backed up.")} The keychain dies with`,
      );
      console.log(
        `  this machine — the seed is the recovery that survives it: ${bold("motebit seed reveal")}`,
      );
    }
    process.exit(0);
  }

  if (sub === "remove") {
    if (readKeychainPassphrase(motebitId) == null) {
      console.log("\n  Nothing enrolled.");
      process.exit(0);
    }
    if (!deleteKeychainPassphrase(motebitId)) {
      console.error("\n  Keychain delete failed.");
      process.exit(1);
    }
    console.log(`\n  ${success("Removed.")} Commands prompt for the passphrase again.`);
    process.exit(0);
  }

  // ── Status ──
  const status = keychainEnrollmentStatus(motebitId);
  console.log(`\n  Identity   ${motebitId}`);
  console.log(
    `  Keychain   ${status === "enrolled" ? success("enrolled (login Keychain)") : "not enrolled"}`,
  );
  if (status === "enrolled") {
    console.log(dim("  Commands unlock without a prompt; `motebit seed reveal` always asks."));
    console.log(dim("  Undo: motebit keychain remove"));
  } else {
    console.log(dim("  Enroll to stop typing the passphrase on this machine:"));
    console.log(`  ${bold("motebit keychain enroll")}`);
    console.log(dim("  Stored in your login Keychain (your macOS account is the protection —"));
    console.log(dim("  not biometrics). It does not replace your recovery seed."));
  }
  process.exit(0);
}
