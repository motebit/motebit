/**
 * Browser keyring adapter — localStorage-backed key storage.
 *
 * The web app runs in a browser, not Tauri. There's no OS keyring.
 * localStorage is the best available persistent storage. Keys are prefixed
 * with "motebit:" to avoid collisions.
 */

import type { KeyringAdapter } from "@motebit/runtime";

const PREFIX = "motebit:";

export class LocalStorageKeyringAdapter implements KeyringAdapter {
  get(key: string): Promise<string | null> {
    return Promise.resolve(localStorage.getItem(PREFIX + key));
  }

  set(key: string, value: string): Promise<void> {
    localStorage.setItem(PREFIX + key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    localStorage.removeItem(PREFIX + key);
    return Promise.resolve();
  }
}
