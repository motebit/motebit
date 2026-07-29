/**
 * macOS login-Keychain passphrase enrollment (#438) — the third leg of
 * the recovery-UX arc (#428): "remember a passphrase" stops being a
 * single point of identity loss, with zero operator involvement.
 *
 * v1 is DELIBERATELY macOS-only via `/usr/bin/security` (the
 * native-module route — keytar lineage — adds a gyp build to the
 * published CLI, the exact failure class the README's troubleshooting
 * section exists for). Other platforms report `unsupported` honestly.
 *
 * Honest security framing (load-bearing — repeat it at every surface):
 * - The item lives in the LOGIN KEYCHAIN, unlocked when the user logs
 *   in. This is NOT per-use Touch-ID gating (that needs Secure Enclave
 *   ACLs `/usr/bin/security` cannot create). Never promise biometrics.
 * - Any process running as the user can read the item (the `security`
 *   binary is on the item's ACL because it created it). Surface-authority
 *   decision (#438, recorded in docs/doctrine/surface-authority-model.md):
 *   ACCEPTED as an OPT-IN convenience — the CLI already trusts the user
 *   account (config.json, the encrypted key, and the process's memory all
 *   live under it), but enrollment DOES weaken "passphrase in your head"
 *   to "passphrase on this machine", so it is never a default.
 * - Enrollment does NOT replace the recovery seed: keychain + disk die
 *   with the machine. The seed nudge is structurally independent
 *   (`seedBackupStatus` never reads enrollment state) and must stay so.
 *
 * The passphrase passes to `security` as an argv element — briefly
 * visible in the process table to the SAME user (and root). That is the
 * same principal who can read the finished keychain item without a
 * prompt, so it widens nothing; noted for honesty.
 */

import { spawnSync } from "node:child_process";

const SERVICE = "motebit-cli";

/** Injectable exec seam so tests never touch a real keychain. */
export type RunSecurity = (args: string[]) => { status: number | null; stdout: string };

const defaultRunSecurity: RunSecurity = (args) => {
  const res = spawnSync("/usr/bin/security", args, { encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "" };
};

export function isKeychainSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/** Read the enrolled passphrase; null = not enrolled / locked / any failure (fail-open to prompt). */
export function readKeychainPassphrase(
  account: string,
  run: RunSecurity = defaultRunSecurity,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!isKeychainSupported(platform)) return null;
  try {
    const res = run(["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
    if (res.status !== 0) return null;
    // `security -w` prints the secret followed by a newline.
    const value = res.stdout.replace(/\n$/, "");
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** Create or update the enrollment item (`-U` = update in place). */
export function writeKeychainPassphrase(
  account: string,
  passphrase: string,
  run: RunSecurity = defaultRunSecurity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isKeychainSupported(platform)) return false;
  try {
    const res = run([
      "add-generic-password",
      "-U",
      "-s",
      SERVICE,
      "-a",
      account,
      "-l",
      "motebit identity passphrase",
      "-w",
      passphrase,
    ]);
    return res.status === 0;
  } catch {
    return false;
  }
}

export function deleteKeychainPassphrase(
  account: string,
  run: RunSecurity = defaultRunSecurity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isKeychainSupported(platform)) return false;
  try {
    const res = run(["delete-generic-password", "-s", SERVICE, "-a", account]);
    return res.status === 0;
  } catch {
    return false;
  }
}

export type KeychainEnrollment = "enrolled" | "not_enrolled" | "unsupported";

export function keychainEnrollmentStatus(
  account: string,
  run: RunSecurity = defaultRunSecurity,
  platform: NodeJS.Platform = process.platform,
): KeychainEnrollment {
  if (!isKeychainSupported(platform)) return "unsupported";
  return readKeychainPassphrase(account, run, platform) != null ? "enrolled" : "not_enrolled";
}
