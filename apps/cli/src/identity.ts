// --- Identity bootstrap and key management ---

import * as readline from "node:readline";
import { Writable } from "node:stream";
import { deriveKey, encrypt, decrypt, generateSalt } from "@motebit/crypto";
import type { EncryptedPayload } from "@motebit/crypto";
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
      } else if (c.charCodeAt(0) >= 32) {
        value += c;
        stdout.write(visible ? c : "*");
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
