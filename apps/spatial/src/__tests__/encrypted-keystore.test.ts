import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory IndexedDB shim — smallest useful surface for the keystore
// ---------------------------------------------------------------------------

class MockRequest<T> {
  result: T | undefined;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  succeed(result: T) {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.());
  }
  fail(error: unknown) {
    this.error = error;
    queueMicrotask(() => this.onerror?.());
  }
}

class MockObjectStore {
  data = new Map<string, unknown>();
  put(value: unknown, key: string): MockRequest<unknown> {
    this.data.set(key, value);
    const req = new MockRequest<unknown>();
    req.succeed(undefined);
    return req;
  }
  get(key: string): MockRequest<unknown> {
    const req = new MockRequest<unknown>();
    req.succeed(this.data.get(key));
    return req;
  }
}

class MockTransaction {
  constructor(public store: MockObjectStore) {}
  objectStore(_name: string): MockObjectStore {
    return this.store;
  }
}

class MockIDBDatabase {
  objectStoreNames = {
    contains: (_n: string) => true,
  };
  store = new MockObjectStore();
  transaction(_name: string, _mode: string) {
    return new MockTransaction(this.store);
  }
  close() {}
  createObjectStore(_name: string) {
    return this.store;
  }
}

class MockIDBFactory {
  private db = new MockIDBDatabase();
  open(_name: string, _version: number): MockRequest<MockIDBDatabase> {
    const req = new MockRequest<MockIDBDatabase>();
    // Fire upgradeneeded then success
    queueMicrotask(() => {
      req.result = this.db;
      // upgradeneeded first — real IDB fires it only on new DB, but idempotent here
      req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  }
}

beforeEach(() => {
  // Install mock indexedDB
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new MockIDBFactory();

  // Install a simple localStorage
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = {
    store: new Map<string, string>(),
    getItem(k: string): string | null {
      return (this.store as Map<string, string>).get(k) ?? null;
    },
    setItem(k: string, v: string): void {
      (this.store as Map<string, string>).set(k, v);
    },
    removeItem(k: string): void {
      (this.store as Map<string, string>).delete(k);
    },
  };

  // Ensure location is defined for PBKDF2 path
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).location = { origin: "https://test.example" };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EncryptedKeyStore — WebCrypto + IndexedDB path", () => {
  it("stores and loads hex via WebCrypto + IDB", async () => {
    const { EncryptedKeyStore } = await import("../encrypted-keystore");
    const ks = new EncryptedKeyStore();
    const hex = "deadbeefcafebabe";
    await ks.storePrivateKey(hex);
    const loaded = await ks.loadPrivateKey();
    expect(loaded).toBe(hex);
  });

  it("loadPrivateKey returns null when no record exists", async () => {
    const { EncryptedKeyStore } = await import("../encrypted-keystore");
    const ks = new EncryptedKeyStore();
    const loaded = await ks.loadPrivateKey();
    expect(loaded).toBeNull();
  });
});

describe("EncryptedKeyStore — localStorage fallback path", () => {
  beforeEach(() => {
    // Remove indexedDB to force the fallback
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).indexedDB;
  });

  it("stores and loads hex via PBKDF2 + localStorage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Re-import after deleting indexedDB — the module re-evaluates
    // on dynamic import in a fresh module graph; but because vitest caches
    // module evaluation, we test via a new constructor. The constructor
    // checks `hasIndexedDB()` at construction time, so module-level state
    // stays the same — the runtime check fires on each `new EncryptedKeyStore`.
    const { EncryptedKeyStore } = await import("../encrypted-keystore");
    const ks = new EncryptedKeyStore();
    const hex = "feedface";
    await ks.storePrivateKey(hex);
    expect(warn).toHaveBeenCalled();
    const loaded = await ks.loadPrivateKey();
    expect(loaded).toBe(hex);
    warn.mockRestore();
  });

  it("loadPrivateKey returns null when localStorage is empty", async () => {
    const { EncryptedKeyStore } = await import("../encrypted-keystore");
    const ks = new EncryptedKeyStore();
    const loaded = await ks.loadPrivateKey();
    expect(loaded).toBeNull();
  });
});
