import "fake-indexeddb/auto";

// `@motebit/crypto/dist` bundles its own copy of `@noble/ed25519`,
// whose `sha512Async` falls through to `crypto.subtle.digest("SHA-512",
// uint8.buffer)`. Inside vitest workers (Node + jsdom alike), the
// underlying-buffer slice can land cross-realm and Node's WebCrypto
// rejects it with "2nd argument is not instance of ArrayBuffer, Buffer,
// TypedArray, or DataView." Wrapping `digest` so any ArrayBuffer input
// is coerced into a fresh same-realm Uint8Array unblocks the path
// without changing observable semantics. Required by any test that
// invokes `signSkillEnvelope` / `signSkillManifest` / `getPublicKeyAsync`
// from `@motebit/crypto`.
{
  const subtle = globalThis.crypto?.subtle;
  if (subtle !== undefined) {
    const origDigest = subtle.digest.bind(subtle);
    (
      subtle as unknown as {
        digest: (alg: string, data: BufferSource) => Promise<ArrayBuffer>;
      }
    ).digest = function digest(algorithm, data) {
      const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      return origDigest(algorithm, view as BufferSource);
    };
  }
}

// Minimal localStorage/sessionStorage polyfill for vitest (Node.js)
function makeStoragePolyfill(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: makeStoragePolyfill(),
    writable: true,
  });
}

if (typeof globalThis.sessionStorage === "undefined") {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: makeStoragePolyfill(),
    writable: true,
  });
}
