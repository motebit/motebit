/**
 * Encrypted private key storage for the spatial (browser) surface.
 *
 * The spatial app runs in a browser — there is no OS keyring. Storing raw
 * Ed25519 private key hex in localStorage is unacceptable: any script on the
 * same origin can read it.
 *
 * Primary path (WebCrypto + IndexedDB):
 *   - Generate a non-extractable AES-GCM wrapping key via crypto.subtle
 *   - Encrypt the private key hex with that wrapping key
 *   - Store both the CryptoKey (structured-cloneable) and the ciphertext
 *     in a dedicated IndexedDB object store
 *
 * Dev-only fallback (no WebCrypto or no IndexedDB):
 *   - Derive an AES key from location.origin via PBKDF2
 *   - Encrypt and store in localStorage
 *   - Gated behind an explicit console.warn
 *
 * Implements BootstrapKeyStore from @motebit/core-identity.
 */

import type { BootstrapKeyStore } from "@motebit/core-identity";

const IDB_NAME = "motebit-keystore";
const IDB_VERSION = 1;
const IDB_STORE = "keys";
const IDB_KEY = "device_private_key";

const LS_CIPHER_KEY = "motebit:encrypted_private_key";
const LS_SALT_KEY = "motebit:key_salt";
const LS_IV_KEY = "motebit:key_iv";

// === Helpers ===

function openKeystoreDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("IDB put failed"));
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IDB get failed"));
  });
}

function hasWebCrypto(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
}

function hasIndexedDB(): boolean {
  return typeof indexedDB !== "undefined";
}

// === Primary: WebCrypto + IndexedDB ===

async function storeWithWebCrypto(hex: string): Promise<void> {
  const wrappingKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(hex);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrappingKey, encoded);

  const db = await openKeystoreDB();
  await idbPut(db, IDB_KEY, { wrappingKey, iv, ciphertext });
  db.close();
}

async function loadWithWebCrypto(): Promise<string | null> {
  const db = await openKeystoreDB();
  const record = (await idbGet(db, IDB_KEY)) as
    | {
        wrappingKey: CryptoKey;
        iv: Uint8Array;
        ciphertext: ArrayBuffer;
      }
    | undefined;
  db.close();

  if (!record) return null;

  // Reconstruct typed arrays from structured-clone data to satisfy BufferSource
  const iv = new Uint8Array(record.iv);
  const ciphertext = new Uint8Array(record.ciphertext);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    record.wrappingKey,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}

// === Dev-only fallback: PBKDF2 + localStorage ===

async function deriveKeyFromOrigin(): Promise<{ key: CryptoKey; salt: Uint8Array }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const existingSalt = localStorage.getItem(LS_SALT_KEY);
  const useSalt =
    existingSalt != null && existingSalt !== ""
      ? Uint8Array.from(atob(existingSalt), (c) => c.charCodeAt(0))
      : salt;

  if (existingSalt == null || existingSalt === "") {
    localStorage.setItem(LS_SALT_KEY, btoa(String.fromCharCode(...useSalt)));
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(typeof location !== "undefined" ? location.origin : "motebit-dev"),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: useSalt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return { key, salt: useSalt };
}

async function storeWithFallback(hex: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.warn(
    "[motebit] Using localStorage fallback for private key storage. " +
      "This is less secure than IndexedDB + WebCrypto. Only use in development.",
  );

  const { key } = await deriveKeyFromOrigin();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(hex);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  localStorage.setItem(LS_CIPHER_KEY, btoa(String.fromCharCode(...new Uint8Array(ciphertext))));
  localStorage.setItem(LS_IV_KEY, btoa(String.fromCharCode(...iv)));
}

async function loadWithFallback(): Promise<string | null> {
  const cipherB64 = localStorage.getItem(LS_CIPHER_KEY);
  const ivB64 = localStorage.getItem(LS_IV_KEY);
  if (cipherB64 == null || cipherB64 === "" || ivB64 == null || ivB64 === "") return null;

  const { key } = await deriveKeyFromOrigin();
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(cipherB64), (c) => c.charCodeAt(0));

  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

// === EncryptedKeyStore ===

export class EncryptedKeyStore implements BootstrapKeyStore {
  private useIndexedDB: boolean;

  constructor() {
    this.useIndexedDB = hasWebCrypto() && hasIndexedDB();
  }

  async storePrivateKey(hex: string): Promise<void> {
    if (this.useIndexedDB) {
      await storeWithWebCrypto(hex);
    } else {
      await storeWithFallback(hex);
    }
  }

  async loadPrivateKey(): Promise<string | null> {
    if (this.useIndexedDB) {
      return loadWithWebCrypto();
    }
    return loadWithFallback();
  }
}
