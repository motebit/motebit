/**
 * HKDF-SHA256 without WebCrypto (device-verified 2026-10-11): on iPhone,
 * react-native-quick-crypto 0.7.17 has no HKDF in `crypto.subtle`, so
 * `subtle.importKey(..., "HKDF", ...)` threw and mobile relay sync never
 * started. Both HKDF sites now compute it in pure JS (@noble/hashes).
 *
 * The derived keys MUST stay byte-identical to the WebCrypto output —
 * existing devices keep their sync key — so each site is pinned against
 * Node's WebCrypto across several fixed inputs, plus a fixed hex vector.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { webcrypto } from "node:crypto";
import { deriveSyncEncryptionKey, deriveKeyTransferKey } from "../index.js";

const subtle = webcrypto.subtle;

async function webcryptoHkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function fixedKey(seed: number): Uint8Array {
  return new Uint8Array(32).map((_, i) => (i * 31 + seed * 17 + 5) & 0xff);
}

const KEYS = [
  new Uint8Array(32),
  new Uint8Array(32).fill(0xff),
  new Uint8Array(32).map((_, i) => i),
  fixedKey(1),
  fixedKey(2),
  fixedKey(3),
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deriveSyncEncryptionKey — noble HKDF == WebCrypto HKDF", () => {
  it("matches a fixed hex vector", async () => {
    const key = await deriveSyncEncryptionKey(new Uint8Array(32).map((_, i) => i));
    expect(toHex(key)).toBe("e7e7b639d68e1e0e450ae07a716598aa1a9d7135a237064a8adbbb5084c4ead1");
  });

  it.each(KEYS.map((k, i) => [i, k] as const))(
    "is byte-identical to WebCrypto for fixed key #%i",
    async (_i, ikm) => {
      const expected = await webcryptoHkdf(ikm, new Uint8Array(0), "motebit-sync-encryption-v1");
      expect(toHex(await deriveSyncEncryptionKey(ikm))).toBe(toHex(expected));
    },
  );

  it("never touches crypto.subtle HKDF (absent on React Native)", async () => {
    const importKey = vi
      .spyOn(globalThis.crypto.subtle, "importKey")
      .mockRejectedValue(new Error("subtle.importKey() is not implemented for HKDF"));
    const key = await deriveSyncEncryptionKey(new Uint8Array(32).map((_, i) => i));
    expect(toHex(key)).toBe("e7e7b639d68e1e0e450ae07a716598aa1a9d7135a237064a8adbbb5084c4ead1");
    expect(importKey).not.toHaveBeenCalled();
  });
});

describe("deriveKeyTransferKey — noble HKDF == WebCrypto HKDF", () => {
  async function webcryptoTransferKey(secret: Uint8Array, code: string): Promise<Uint8Array> {
    const salt = new Uint8Array(
      await subtle.digest("SHA-256", new TextEncoder().encode(code.toUpperCase())),
    );
    return webcryptoHkdf(secret, salt, "motebit-key-transfer-v1");
  }

  it("matches a fixed hex vector", async () => {
    const key = await deriveKeyTransferKey(new Uint8Array(32).fill(7), "abc123");
    expect(toHex(key)).toBe("2215226f2767132df3b428aa12075f7c731d8bd443dbe904578bf31615c9635b");
  });

  it.each(KEYS.flatMap((k, i) => ["ABC123", "zz9-QQ", ""].map((code) => [i, code, k] as const)))(
    "is byte-identical to WebCrypto for fixed secret #%i, code %j",
    async (_i, code, secret) => {
      const expected = await webcryptoTransferKey(secret, code);
      expect(toHex(await deriveKeyTransferKey(secret, code))).toBe(toHex(expected));
    },
  );

  it("never touches crypto.subtle HKDF (absent on React Native)", async () => {
    const importKey = vi
      .spyOn(globalThis.crypto.subtle, "importKey")
      .mockRejectedValue(new Error("subtle.importKey() is not implemented for HKDF"));
    const key = await deriveKeyTransferKey(new Uint8Array(32).fill(7), "ABC123");
    expect(toHex(key)).toBe("2215226f2767132df3b428aa12075f7c731d8bd443dbe904578bf31615c9635b");
    expect(importKey).not.toHaveBeenCalled();
  });
});
