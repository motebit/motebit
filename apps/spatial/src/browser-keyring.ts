/**
 * Browser keyring adapter — localStorage-backed key storage.
 *
 * The spatial app runs in a browser, not Tauri. There's no OS keyring.
 * localStorage is the best available persistent storage. Keys are prefixed
 * with "motebit:" to avoid collisions.
 *
 * Security note: localStorage is not encrypted. On shared devices, the
 * operator PIN hash is the primary secret stored here. The PIN hash is
 * SHA-256 — not reversible, but visible to other scripts on the same origin.
 * Acceptable for the spatial MVP. A future version could use IndexedDB with
 * the Web Crypto API for encrypted storage.
 */

import type { KeyringAdapter } from "@motebit/runtime";

const PREFIX = "motebit:";

export class LocalStorageKeyringAdapter implements KeyringAdapter {
  async get(key: string): Promise<string | null> {
    return localStorage.getItem(PREFIX + key);
  }

  async set(key: string, value: string): Promise<void> {
    localStorage.setItem(PREFIX + key, value);
  }

  async delete(key: string): Promise<void> {
    localStorage.removeItem(PREFIX + key);
  }
}
