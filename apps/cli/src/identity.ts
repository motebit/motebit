// --- Identity bootstrap and key management ---

import * as readline from "node:readline";
import { Writable } from "node:stream";
import {
  deriveKey,
  encrypt,
  decrypt,
  generateSalt,
  getPublicKeyBySuite,
} from "@motebit/encryption";
import type { EncryptedPayload } from "@motebit/encryption";
import {
  bootstrapIdentity as sharedBootstrapIdentity,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import type { MotebitDatabase } from "@motebit/persistence";
import type { FullConfig } from "./config.js";
import { saveFullConfig } from "./config.js";

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function promptPassphrase(_rl: readline.Interface, prompt: string): Promise<string>;
export function promptPassphrase(prompt: string): Promise<string>;
export function promptPassphrase(
  rlOrPrompt: readline.Interface | string,
  maybePrompt?: string,
): Promise<string> {
  const promptText = typeof rlOrPrompt === "string" ? rlOrPrompt : maybePrompt!;
  const stdin = process.stdin;
  const stdout = process.stdout;

  // Non-TTY fallback (piped input) — read one line without masking
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const mutedOutput = new Writable({ write: (_c, _e, cb) => cb() });
      const silentRl = readline.createInterface({
        input: stdin,
        output: mutedOutput,
        terminal: false,
      });
      stdout.write(promptText);
      silentRl.once("line", (answer) => {
        silentRl.close();
        resolve(answer);
      });
    });
  }

  // TTY: use raw mode directly instead of creating a second readline.
  // Creating and closing a second readline.createInterface on process.stdin
  // closes stdin itself, killing the REPL that uses the original rl.
  return new Promise((resolve) => {
    stdout.write(promptText + "\x1b[2m(Tab to show/hide)\x1b[22m ");

    // Pause the caller's rl if provided (prevents it from consuming stdin)
    const callerRl = typeof rlOrPrompt !== "string" ? rlOrPrompt : null;
    callerRl?.pause();

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    let visible = false;

    /** Redraw the current input as masked or plaintext. */
    const redraw = () => {
      // Move cursor back to start of input, clear to end of line, rewrite
      if (value.length > 0) {
        stdout.write(`\x1b[${value.length}D`); // move back
      }
      stdout.write("\x1b[K"); // clear to end of line
      stdout.write(visible ? value : "*".repeat(value.length));
    };

    const onData = (ch: string) => {
      const c = ch.toString();

      // Skip escape sequences (e.g. bracketed paste markers, arrow keys).
      // In raw mode, these arrive as multi-byte strings starting with \x1b.
      if (c.length > 1 && c.charCodeAt(0) === 0x1b) {
        return;
      }

      if (c === "\n" || c === "\r" || c === "\u0004") {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        // Always mask before newline — prevents plaintext from staying in scroll history
        // even if user toggled to visible mode while typing
        if (visible && value.length > 0) {
          stdout.write(`\x1b[${value.length}D`);
          stdout.write("\x1b[K");
          stdout.write("*".repeat(value.length));
        }
        stdout.write("\n");
        callerRl?.resume();
        resolve(value);
      } else if (c === "\u0003") {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdout.write("\n");
        process.exit(130);
      } else if (c === "\t") {
        // Tab toggles visibility
        visible = !visible;
        redraw();
      } else if (c === "\u007F" || c === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write("\x1b[1D \x1b[1D");
        }
      } else if (c.length === 1 && c.charCodeAt(0) >= 32) {
        value += c;
        stdout.write(visible ? c : "*");
      } else if (c.length > 1 && c.charCodeAt(0) >= 32) {
        // Pasted multi-character chunk — process each character
        for (const char of c) {
          if (char.charCodeAt(0) >= 32) {
            value += char;
            stdout.write(visible ? char : "*");
          }
        }
      }
    };

    stdin.on("data", onData);
  });
}

export async function encryptPrivateKey(
  privKeyHex: string,
  passphrase: string,
): Promise<FullConfig["cli_encrypted_key"]> {
  const salt = generateSalt(); // 16 bytes (NIST SP 800-132)
  const key = await deriveKey(passphrase, salt);
  const payload: EncryptedPayload = await encrypt(new TextEncoder().encode(privKeyHex), key);
  return {
    ciphertext: toHex(payload.ciphertext),
    nonce: toHex(payload.nonce),
    tag: toHex(payload.tag),
    salt: toHex(salt),
  };
}

export async function decryptPrivateKey(
  encKey: NonNullable<FullConfig["cli_encrypted_key"]>,
  passphrase: string,
): Promise<string> {
  const salt = fromHex(encKey.salt);
  const key = await deriveKey(passphrase, salt);
  const payload: EncryptedPayload = {
    ciphertext: fromHex(encKey.ciphertext),
    nonce: fromHex(encKey.nonce),
    tag: fromHex(encKey.tag),
  };
  const decrypted = await decrypt(payload, key);
  return new TextDecoder().decode(decrypted);
}

export async function bootstrapIdentity(
  moteDb: MotebitDatabase,
  fullConfig: FullConfig,
  passphrase: string,
): Promise<{ motebitId: string; isFirstLaunch: boolean }> {
  const configStore: BootstrapConfigStore = {
    read() {
      if (fullConfig.motebit_id == null || fullConfig.motebit_id === "")
        return Promise.resolve(null);
      return Promise.resolve({
        motebit_id: fullConfig.motebit_id,
        device_id: fullConfig.device_id ?? "",
        device_public_key: fullConfig.device_public_key ?? "",
      });
    },
    write(state): Promise<void> {
      fullConfig.motebit_id = state.motebit_id;
      fullConfig.device_id = state.device_id;
      fullConfig.device_public_key = state.device_public_key;
      saveFullConfig(fullConfig);
      return Promise.resolve();
    },
  };

  const keyStore: BootstrapKeyStore = {
    async storePrivateKey(privKeyHex) {
      fullConfig.cli_encrypted_key = await encryptPrivateKey(privKeyHex, passphrase);
      delete fullConfig.cli_private_key;
      saveFullConfig(fullConfig);
    },
  };

  const result = await sharedBootstrapIdentity({
    surfaceName: "cli",
    identityStorage: moteDb.identityStorage,
    eventStoreAdapter: moteDb.eventStore,
    configStore,
    keyStore,
  });

  return { motebitId: result.motebitId, isFirstLaunch: result.isFirstLaunch };
}

// ---------------------------------------------------------------------------
// loadActiveSigningKey — single source of truth for "decrypt the CLI's
// active Ed25519 identity key from `~/.motebit/config.json`."
//
// Replaces five inline `if (config.cli_encrypted_key) { ... try/catch
// passphrase decrypt ... }` blocks (register, daemon × 2, _helpers,
// wallet) with one structured resolver. Single read site means:
//
//   - One UX for passphrase prompts (env > interactive)
//   - One place that does the public-key derivation match against
//     `config.device_public_key`. The check fails closed — a private key
//     that doesn't match the registered public is a sign of partial
//     state corruption (clobber, mismatched scaffold, copied config), and
//     proceeding silently with it would sign artifacts under the wrong
//     identity.
//   - One place future migrations (post-quantum SuiteId, hardware-rooted
//     storage adapter, OS-keyring backends) plug in.
//
// Resolution sources, in order:
//
//   1. `config.cli_encrypted_key` — the canonical current shape. AES-GCM
//      ciphertext + nonce + tag + salt; decrypted with passphrase from
//      `MOTEBIT_PASSPHRASE` env (preferred, scriptable) or the
//      `getPassphrase` callback (interactive prompt by default).
//   2. `config.cli_private_key` — legacy plaintext (deprecated since
//      1.0.0, removed at 2.0.0; see `config.ts:50`). Read only when
//      `cli_encrypted_key` is absent. Emits a deprecation warning.
//
// Sources NOT supported (deliberate):
//
//   - `~/.motebit/dev-keyring.json` — written by the desktop Tauri app's
//     Keychain-failure fallback (`apps/desktop/src/identity-manager.ts`).
//     Cross-surface keystore unification is a real architectural pass; a
//     silent fallback chain is the wrong shape for it. The right shape is
//     an explicit `IdentityKeyAdapter` per surface, same family as the
//     storage adapter pattern. That's a separate commit.
//   - Raw private-key bytes from environment variables. `MOTEBIT_PRIVATE_KEY_HEX`
//     would be a security regression — env leaks through shell history,
//     CI logs, process inspection, debug dumps. Sovereign identity is
//     not an env-friendly secret. The passphrase env IS supported because
//     the on-disk ciphertext is the actual secret; the passphrase is a
//     scrypt-stretching factor.
//
// Returns a structured `ActiveSigningKey` with the source recorded so
// callers (notably `motebit doctor`) can surface "you are on legacy
// plaintext, run `motebit migrate`" when applicable.
// ---------------------------------------------------------------------------

/**
 * Where the active signing key was resolved from. `motebit doctor` reads
 * this to surface migration prompts.
 */
export type ActiveSigningKeySource = "encrypted-config" | "plaintext-config-legacy";

export interface ActiveSigningKey {
  readonly source: ActiveSigningKeySource;
  /**
   * Raw 32-byte Ed25519 seed. The caller is responsible for
   * `secureErase`-ing this after use.
   */
  readonly privateKey: Uint8Array;
  /** Hex-encoded public key, byte-equal to `config.device_public_key`. */
  readonly publicKey: string;
}

export type IdentityKeyErrorKind =
  | "missing"
  | "decrypt-failed"
  | "malformed-private-key"
  | "public-key-mismatch";

/**
 * Structured failure for `loadActiveSigningKey`. Each kind carries an
 * actionable `remedy` string suitable for `motebit doctor` output and
 * console.error messages at call sites.
 */
export class IdentityKeyError extends Error {
  readonly kind: IdentityKeyErrorKind;
  readonly remedy: string;
  constructor(kind: IdentityKeyErrorKind, message: string, remedy: string) {
    super(message);
    this.name = "IdentityKeyError";
    this.kind = kind;
    this.remedy = remedy;
  }
}

export interface LoadActiveSigningKeyOptions {
  /**
   * Label shown to the user when prompting for the passphrase. Each
   * call site uses its own ("for agent signing", "to read wallet", "to
   * sign registration", etc.) so the user sees the action's purpose.
   * Default: "Passphrase: ".
   */
  readonly promptLabel?: string;
  /**
   * Override the passphrase resolution strategy. Default checks
   * `MOTEBIT_PASSPHRASE` first, then falls back to an interactive prompt.
   * Tests inject a deterministic getter.
   */
  readonly getPassphrase?: (label: string) => Promise<string>;
  /**
   * Skip the derived-public-key match against `config.device_public_key`.
   * The mismatch check is fail-closed by default — set this only when
   * the caller is explicitly working with a key that's expected to
   * differ (e.g. mid-rotation; today no caller needs this, included for
   * future use).
   */
  readonly skipPublicKeyVerification?: boolean;
}

const DEFAULT_PASSPHRASE_GETTER = async (label: string): Promise<string> => {
  const env = process.env["MOTEBIT_PASSPHRASE"];
  if (env != null && env !== "") return env;
  return promptPassphrase(label);
};

/**
 * Decrypt the CLI's active Ed25519 signing key from config and verify
 * its derived public key matches the registered device public key.
 *
 * The single read site for `cli_encrypted_key` and `cli_private_key`.
 * Throws `IdentityKeyError` for every failure mode (missing, decrypt
 * failed, malformed bytes, public-key mismatch). Callers decide
 * whether to fail-hard (`process.exit`) or downgrade to unauthenticated
 * mode (current `_helpers.ts` posture).
 *
 * The returned `privateKey` MUST be `secureErase`-d by the caller after
 * use. Holding it alive longer than necessary is a security
 * regression.
 */
export async function loadActiveSigningKey(
  config: FullConfig,
  options?: LoadActiveSigningKeyOptions,
): Promise<ActiveSigningKey> {
  const promptLabel = options?.promptLabel ?? "Passphrase: ";
  const getPassphrase = options?.getPassphrase ?? DEFAULT_PASSPHRASE_GETTER;

  let privateKeyHex: string;
  let source: ActiveSigningKeySource;

  if (config.cli_encrypted_key) {
    let passphrase: string;
    try {
      passphrase = await getPassphrase(promptLabel);
    } catch (err) {
      throw new IdentityKeyError(
        "decrypt-failed",
        `passphrase prompt aborted: ${err instanceof Error ? err.message : String(err)}`,
        "re-run the command and enter the passphrase, or set MOTEBIT_PASSPHRASE",
      );
    }
    try {
      privateKeyHex = await decryptPrivateKey(config.cli_encrypted_key, passphrase);
    } catch (err) {
      throw new IdentityKeyError(
        "decrypt-failed",
        `could not decrypt cli_encrypted_key: ${err instanceof Error ? err.message : String(err)}`,
        "the passphrase is wrong, or the encrypted blob is corrupted",
      );
    }
    source = "encrypted-config";
  } else if (config.cli_private_key != null && config.cli_private_key !== "") {
    // Legacy plaintext path. Per `config.ts:50`'s deprecation contract,
    // remove at 2.0.0 — until then, accept it but warn so the user
    // migrates to the encrypted shape.
    console.warn(
      "Warning: reading legacy plaintext private key (cli_private_key). This shape is deprecated and will be removed at motebit@2.0.0. Run `motebit init` (passphrase-prompt) to re-encrypt.",
    );
    privateKeyHex = config.cli_private_key;
    source = "plaintext-config-legacy";
  } else {
    throw new IdentityKeyError(
      "missing",
      "no identity key in ~/.motebit/config.json (neither cli_encrypted_key nor cli_private_key)",
      "run `motebit init` to create a new identity, or restore from `~/.motebit/config.json.clobbered-*` if a backup is present",
    );
  }

  // Decode the hex bytes.
  let privateKey: Uint8Array;
  try {
    privateKey = fromHex(privateKeyHex);
    if (privateKey.length !== 32) {
      throw new Error(`expected 32-byte seed, got ${privateKey.length}`);
    }
  } catch (err) {
    throw new IdentityKeyError(
      "malformed-private-key",
      `decoded private key is not a valid 32-byte Ed25519 seed: ${err instanceof Error ? err.message : String(err)}`,
      "the config has a corrupted or wrong-shape key — restore from backup or re-run `motebit init`",
    );
  }

  // Derive public via the canonical suite-dispatch path (the only place
  // permitted to call `@noble/ed25519` primitives directly per
  // packages/crypto/CLAUDE.md rule 1).
  const derivedPublicBytes = await getPublicKeyBySuite(privateKey, "motebit-jcs-ed25519-hex-v1");
  const derivedPublicHex = toHex(derivedPublicBytes);

  if (
    !options?.skipPublicKeyVerification &&
    config.device_public_key != null &&
    config.device_public_key !== "" &&
    derivedPublicHex.toLowerCase() !== config.device_public_key.toLowerCase()
  ) {
    // Fail-closed. Signing under the wrong identity is worse than
    // refusing to sign — a downstream verifier rejecting our signature
    // is an obvious failure; signing as someone else is a silent one.
    // Wipe before throwing so the bad key doesn't sit on the heap.
    privateKey.fill(0);
    throw new IdentityKeyError(
      "public-key-mismatch",
      `derived public key ${derivedPublicHex.slice(0, 12)}... does not match config.device_public_key ${config.device_public_key.slice(0, 12)}...`,
      "config has inconsistent identity state (private key from one identity, public from another). Restore from backup or re-run `motebit init` to start fresh",
    );
  }

  return { source, privateKey, publicKey: derivedPublicHex };
}
