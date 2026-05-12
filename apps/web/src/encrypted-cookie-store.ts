/**
 * Encrypted cookie storage for the web surface — Phase 2 of the
 * persistent user_data_dir arc (cookies-only). Persists the cloud-
 * browser cookie jar across tab restarts so the user's accumulated
 * trust (Google CAPTCHA reputation, logged-in account state, session
 * cookies) survives the user closing motebit and reopening it
 * tomorrow.
 *
 * Same primitive shape as `encrypted-keystore.ts` (WebCrypto non-
 * extractable AES-GCM key in IndexedDB), but a separate database +
 * keyed by motebit_id so multiple identities in the same origin
 * don't share cookies (sovereign-floor invariant).
 *
 * Primary path (WebCrypto + IndexedDB):
 *   - Generate a non-extractable AES-GCM wrapping key via
 *     `crypto.subtle.generateKey`. Each motebit gets its own key —
 *     the structured-clone storage of `CryptoKey` in IndexedDB
 *     means the key never round-trips through extractable form.
 *   - Encrypt the JSON-serialized cookie array with that wrapping
 *     key + a fresh 96-bit IV per write.
 *   - Store `{ wrappingKey, iv, ciphertext }` in IndexedDB keyed by
 *     motebit_id. Reads decrypt; writes overwrite the prior record.
 *
 * Dev-only fallback (no WebCrypto or no IndexedDB — jsdom tests,
 * private-mode browsers without IDB):
 *   - Derive an AES key from `location.origin` via PBKDF2 (same as
 *     keystore). Store ciphertext + IV in localStorage keyed by
 *     motebit_id. Gated behind an explicit console.warn — same
 *     security register as the keystore's fallback (weaker than the
 *     primary path but functional).
 *
 * Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md`
 * applied to the cloud-browser surface — Phase 2 of the cookies arc.
 * Phase 3 will add the `/cookies grant` consent gate + revoke UI on
 * top of this storage; this module is the durability primitive.
 */

import type { PersistentCookieWire } from "@motebit/runtime";

const IDB_NAME = "motebit-cookie-store";
const IDB_VERSION = 1;
const IDB_STORE = "cookies";

const LS_PREFIX = "motebit:cookies:";
const LS_SALT_KEY = "motebit:cookies-salt";

interface StoredCookieRecord {
  readonly wrappingKey: CryptoKey;
  readonly iv: Uint8Array;
  readonly ciphertext: ArrayBuffer;
}

// === Capability detection ===

function hasWebCrypto(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
}

function hasIndexedDB(): boolean {
  return typeof indexedDB !== "undefined";
}

// === IndexedDB helpers ===

function openCookieDB(): Promise<IDBDatabase> {
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

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("IDB delete failed"));
  });
}

// === Primary: WebCrypto + IndexedDB ===

async function saveWithWebCrypto(
  motebitId: string,
  cookies: readonly PersistentCookieWire[],
): Promise<void> {
  // Generate a fresh wrapping key for each save. The key is non-
  // extractable and lives inside the IDB record — never serializes
  // through JavaScript memory in raw form after creation. The
  // structured-clone path that IDB uses preserves CryptoKey objects
  // bound to their non-extractable flag.
  const wrappingKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(cookies));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrappingKey, plaintext);

  const db = await openCookieDB();
  await idbPut(db, motebitId, { wrappingKey, iv, ciphertext });
  db.close();
}

async function loadWithWebCrypto(motebitId: string): Promise<readonly PersistentCookieWire[]> {
  const db = await openCookieDB();
  const record = (await idbGet(db, motebitId)) as StoredCookieRecord | undefined;
  db.close();

  if (!record) return [];

  // Reconstruct typed arrays from structured-clone data to satisfy
  // BufferSource — same pattern as encrypted-keystore.ts.
  const iv = new Uint8Array(record.iv);
  const ciphertext = new Uint8Array(record.ciphertext);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    record.wrappingKey,
    ciphertext,
  );

  const json = new TextDecoder().decode(decrypted);
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) return parsed as readonly PersistentCookieWire[];
    return [];
  } catch {
    // Malformed record — treat as empty. The next save overwrites.
    return [];
  }
}

async function clearWithWebCrypto(motebitId: string): Promise<void> {
  const db = await openCookieDB();
  await idbDelete(db, motebitId);
  db.close();
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

async function saveWithFallback(
  motebitId: string,
  cookies: readonly PersistentCookieWire[],
): Promise<void> {
  const { key } = await deriveKeyFromOrigin();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(cookies));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  const record = JSON.stringify({
    iv: btoa(String.fromCharCode(...iv)),
    ct: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  });
  localStorage.setItem(`${LS_PREFIX}${motebitId}`, record);
}

async function loadWithFallback(motebitId: string): Promise<readonly PersistentCookieWire[]> {
  const raw = localStorage.getItem(`${LS_PREFIX}${motebitId}`);
  if (raw == null || raw === "") return [];

  let record: { iv: string; ct: string };
  try {
    record = JSON.parse(raw) as { iv: string; ct: string };
  } catch {
    return [];
  }
  if (typeof record.iv !== "string" || typeof record.ct !== "string") return [];

  const { key } = await deriveKeyFromOrigin();
  try {
    const iv = Uint8Array.from(atob(record.iv), (c) => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(record.ct), (c) => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as unknown;
    if (Array.isArray(parsed)) return parsed as readonly PersistentCookieWire[];
    return [];
  } catch {
    return [];
  }
}

function clearWithFallback(motebitId: string): void {
  localStorage.removeItem(`${LS_PREFIX}${motebitId}`);
}

// === Public API ===

/**
 * Persist the cookie jar for a motebit, encrypted at rest. Fail-soft
 * on environments without crypto primitives — returns without
 * persisting. The cloud-session lifecycle is unaffected if save
 * fails; the user just loses the accumulated trust for next session.
 */
export async function saveCookies(
  motebitId: string,
  cookies: readonly PersistentCookieWire[],
): Promise<void> {
  if (!hasWebCrypto()) return;
  try {
    if (hasIndexedDB()) {
      await saveWithWebCrypto(motebitId, cookies);
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        "[motebit] cookie store using localStorage fallback (no IndexedDB). " +
          "Encrypted-at-rest with a PBKDF2-derived key, but the IDB+CryptoKey path is stronger.",
      );
      await saveWithFallback(motebitId, cookies);
    }
  } catch {
    // Fail-soft — the user's next cloud session just opens cold.
    // Persistence errors don't break the dispose path.
  }
}

/**
 * Load the persisted cookie jar for a motebit. Returns `[]` on:
 *   - cold-start (no prior record),
 *   - environments without crypto primitives (cookies not persisted
 *     there anyway),
 *   - malformed/corrupt records (the next save overwrites).
 */
export async function loadCookies(motebitId: string): Promise<readonly PersistentCookieWire[]> {
  if (!hasWebCrypto()) return [];
  try {
    if (hasIndexedDB()) {
      return await loadWithWebCrypto(motebitId);
    }
    return await loadWithFallback(motebitId);
  } catch {
    // Fail-soft — cold-start on load failure.
    return [];
  }
}

/**
 * Clear the persisted cookie jar for a motebit. Phase 3's `/cookies
 * revoke` slash command will route through here. Idempotent on
 * missing records.
 */
export async function clearCookies(motebitId: string): Promise<void> {
  if (!hasWebCrypto()) return;
  try {
    if (hasIndexedDB()) {
      await clearWithWebCrypto(motebitId);
    } else {
      clearWithFallback(motebitId);
    }
  } catch {
    // Fail-soft.
  }
}
