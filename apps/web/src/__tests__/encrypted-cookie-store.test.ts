/**
 * Encrypted cookie store tests — Phase 2 of the persistent
 * user_data_dir arc (cookies-only). fake-indexeddb provides IDB;
 * Node.js crypto.subtle provides WebCrypto. Same harness as
 * encrypted-keystore.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { saveCookies, loadCookies, clearCookies } from "../encrypted-cookie-store.js";
import type { PersistentCookieWire } from "@motebit/runtime";

const MOTEBIT_A = "did:motebit:0xaaaa";
const MOTEBIT_B = "did:motebit:0xbbbb";

const sampleCookies: readonly PersistentCookieWire[] = [
  {
    name: "session_id",
    value: "abc123xyz",
    domain: ".google.com",
    path: "/",
    expires: 1893456000,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  },
  {
    name: "captcha_cleared",
    value: "true",
    domain: ".google.com",
    path: "/search",
    expires: 1893456000,
    httpOnly: false,
    secure: true,
    sameSite: "Strict",
  },
];

beforeEach(() => {
  localStorage.clear();
  indexedDB.deleteDatabase("motebit-cookie-store");
});

describe("encrypted-cookie-store — round-trip persistence", () => {
  it("saves and loads cookies for a motebit", async () => {
    await saveCookies(MOTEBIT_A, sampleCookies);
    const loaded = await loadCookies(MOTEBIT_A);
    expect(loaded).toEqual(sampleCookies);
  });

  it("returns [] when no record exists (cold start)", async () => {
    const loaded = await loadCookies(MOTEBIT_A);
    expect(loaded).toEqual([]);
  });

  it("overwrites prior record on second save", async () => {
    await saveCookies(MOTEBIT_A, sampleCookies);
    const updated: PersistentCookieWire[] = [
      {
        name: "new_session",
        value: "fresh",
        domain: ".motebit.com",
        path: "/",
      },
    ];
    await saveCookies(MOTEBIT_A, updated);
    const loaded = await loadCookies(MOTEBIT_A);
    expect(loaded).toEqual(updated);
    expect(loaded).not.toEqual(sampleCookies);
  });

  it("persists across function-call instances (the cross-tab-restart property)", async () => {
    // Simulate tab restart by saving then loading from "fresh"
    // module state. fake-indexeddb keeps the data; only the
    // in-memory module state would reset, which the static
    // functions don't carry.
    await saveCookies(MOTEBIT_A, sampleCookies);
    // Reload — same data should come back.
    const loaded = await loadCookies(MOTEBIT_A);
    expect(loaded).toEqual(sampleCookies);
  });

  it("preserves the full cookie shape (name, value, domain, path, expires, security flags)", async () => {
    await saveCookies(MOTEBIT_A, sampleCookies);
    const loaded = await loadCookies(MOTEBIT_A);
    const first = loaded[0]!;
    expect(first.name).toBe("session_id");
    expect(first.value).toBe("abc123xyz");
    expect(first.domain).toBe(".google.com");
    expect(first.path).toBe("/");
    expect(first.expires).toBe(1893456000);
    expect(first.httpOnly).toBe(true);
    expect(first.secure).toBe(true);
    expect(first.sameSite).toBe("Lax");
  });
});

describe("encrypted-cookie-store — per-motebit isolation (sovereign-floor invariant)", () => {
  it("motebit A's cookies don't leak to motebit B", async () => {
    await saveCookies(MOTEBIT_A, sampleCookies);
    const loadedB = await loadCookies(MOTEBIT_B);
    expect(loadedB).toEqual([]);
  });

  it("both motebits can save and load independently", async () => {
    const aCookies: PersistentCookieWire[] = [
      { name: "a", value: "aaa", domain: ".a.com", path: "/" },
    ];
    const bCookies: PersistentCookieWire[] = [
      { name: "b", value: "bbb", domain: ".b.com", path: "/" },
      { name: "b2", value: "bbb2", domain: ".b.com", path: "/x" },
    ];
    await saveCookies(MOTEBIT_A, aCookies);
    await saveCookies(MOTEBIT_B, bCookies);

    const loadedA = await loadCookies(MOTEBIT_A);
    const loadedB = await loadCookies(MOTEBIT_B);
    expect(loadedA).toEqual(aCookies);
    expect(loadedB).toEqual(bCookies);
  });

  it("clearing motebit A doesn't affect motebit B", async () => {
    await saveCookies(MOTEBIT_A, sampleCookies);
    await saveCookies(MOTEBIT_B, [{ name: "b", value: "bbb", domain: ".b.com", path: "/" }]);
    await clearCookies(MOTEBIT_A);
    expect(await loadCookies(MOTEBIT_A)).toEqual([]);
    expect(await loadCookies(MOTEBIT_B)).toHaveLength(1);
  });
});

describe("encrypted-cookie-store — fail-soft on edge cases", () => {
  it("saves [] cleanly (empty cookie jar is a valid state)", async () => {
    await saveCookies(MOTEBIT_A, []);
    const loaded = await loadCookies(MOTEBIT_A);
    expect(loaded).toEqual([]);
  });

  it("clearCookies on a never-saved motebit is a no-op", async () => {
    await expect(clearCookies(MOTEBIT_A)).resolves.toBeUndefined();
  });

  it("ciphertext at rest — IDB record value is NOT plaintext JSON", async () => {
    // Load-bearing property of the encrypted-at-rest contract: a
    // snapshot of IndexedDB MUST NOT reveal cookie values to anyone
    // with raw DB access. The CryptoKey is non-extractable, so
    // even with read access to the IDB record an attacker can't
    // decrypt without crypto.subtle (which requires same-origin
    // execution).
    await saveCookies(MOTEBIT_A, sampleCookies);
    // Open the raw IDB record bypass-style. The ciphertext field
    // is an ArrayBuffer of opaque bytes — turning it into a
    // string would not contain readable cookie values.
    const dbReq = indexedDB.open("motebit-cookie-store", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      dbReq.onsuccess = () => resolve(dbReq.result);
      dbReq.onerror = () => reject(dbReq.error ?? new Error("IDB open failed"));
    });
    const txn = db.transaction("cookies", "readonly");
    const store = txn.objectStore("cookies");
    const getReq = store.get(MOTEBIT_A);
    const record = await new Promise<{
      iv: Uint8Array;
      ciphertext: ArrayBuffer;
    }>((resolve, reject) => {
      getReq.onsuccess = () => resolve(getReq.result);
      getReq.onerror = () => reject(getReq.error ?? new Error("IDB get failed"));
    });
    db.close();

    // The ciphertext byte sequence MUST NOT contain the plaintext
    // cookie value as readable bytes.
    const ciphertextBytes = new Uint8Array(record.ciphertext);
    const asString = String.fromCharCode(...ciphertextBytes.slice(0, 200));
    expect(asString).not.toContain("session_id");
    expect(asString).not.toContain("abc123xyz");
    expect(asString).not.toContain("captcha_cleared");
  });
});
