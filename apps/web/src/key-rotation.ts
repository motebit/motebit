/**
 * Web key rotation — a thin adapter over `@motebit/surface-kit`'s
 * `rotateOrThrow` (#709). The state machine, the ordering (read the relay,
 * write ahead, submit signed by the retiring key, commit only on
 * confirmation) and every stop message live in the package; this file
 * supplies the browser's plumbing: the encrypted IndexedDB keystore for the
 * key and the write-ahead, localStorage for the published public key.
 */
import { rotateOrThrow, type HeldRotation } from "@motebit/surface-kit";
import type { EncryptedKeyStore } from "./encrypted-keystore";

export interface WebRotationDeps {
  keyStore: EncryptedKeyStore;
  motebitId: string;
  deviceId: string;
  syncUrl: string | null;
  /** Called after the key is stored, so the app updates its in-memory copy. */
  onCommitted: (newPublicKeyHex: string) => void;
  reason?: string;
  fetchImpl?: typeof fetch;
}

export async function rotateWebKey(deps: WebRotationDeps): Promise<{ newPublicKey: string }> {
  const outcome = await rotateOrThrow({
    motebitId: deps.motebitId,
    deviceId: deps.deviceId,
    syncUrl: deps.syncUrl,
    loadPrivateKeyHex: () => deps.keyStore.loadPrivateKey(),
    writeAhead: {
      load: async () => {
        const raw = await deps.keyStore.loadPendingRotation();
        if (raw == null) return null;
        try {
          return JSON.parse(raw) as HeldRotation;
        } catch {
          return null;
        }
      },
      save: (held) => deps.keyStore.storePendingRotation(JSON.stringify(held)),
      clear: () => deps.keyStore.clearPendingRotation(),
    },
    commit: async ({ privateKeyHex, publicKeyHex }) => {
      await deps.keyStore.storePrivateKey(privateKeyHex);
      localStorage.setItem("motebit:device_public_key", publicKeyHex);
      deps.onCommitted(publicKeyHex);
    },
    ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return { newPublicKey: outcome.newPublicKeyHex };
}
