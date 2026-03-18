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
  const prompt = typeof rlOrPrompt === "string" ? rlOrPrompt : maybePrompt!;
  return new Promise((resolve) => {
    const mutedOutput = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const silentRl = readline.createInterface({
      input: process.stdin,
      output: mutedOutput,
      terminal: true,
    });
    process.stdout.write(prompt);
    silentRl.question("", (answer) => {
      silentRl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
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
