/**
 * Web key rotation — a thin adapter over `@motebit/surface-kit`'s
 * `rotateOrThrow` (#709). The state machine, the ordering (read the relay,
 * write ahead, submit signed by the retiring key, commit only on
 * confirmation) and every stop message live in the package; this file
 * supplies the browser's plumbing: the encrypted IndexedDB keystore for the
 * key and the write-ahead, localStorage for the published public key.
 */
import { parseHeldRotation, rotateOrThrow } from "@motebit/surface-kit";
import type { KeySuccessionRecord } from "@motebit/sdk";
import type { EncryptedKeyStore } from "./encrypted-keystore";

export interface WebRotationDeps {
  keyStore: EncryptedKeyStore;
  motebitId: string;
  deviceId: string;
  syncUrl: string | null;
  /** Called after the key is stored, so the app updates its in-memory copy. */
  onCommitted: (newPublicKeyHex: string) => void;
  /**
   * The machine roster's commit step (machine-roster-surfaces-v1 F7):
   * append the rotation link to the replica. Must
   * be idempotent and must not throw (the key is already committed).
   */
  afterCommit?: (next: { publicKeyHex: string; record: KeySuccessionRecord }) => Promise<void>;
  reason?: string;
  fetchImpl?: typeof fetch;
}

export async function rotateWebKey(deps: WebRotationDeps): Promise<{ newPublicKey: string }> {
  const outcome = await rotateOrThrow({
    motebitId: deps.motebitId,
    deviceId: deps.deviceId,
    syncUrl: deps.syncUrl,
    loadPrivateKeyHex: () => deps.keyStore.loadPrivateKey(),
    publishedPublicKeyHex: () => Promise.resolve(localStorage.getItem("motebit:device_public_key")),
    writeAhead: {
      load: async () => {
        // `loadPendingRotation` answers null for an empty slot and throws for
        // a slot it cannot open; those are different states.
        let raw: string | null;
        try {
          raw = await deps.keyStore.loadPendingRotation();
        } catch {
          return "unreadable";
        }
        return parseHeldRotation(raw);
      },
      save: (held) => deps.keyStore.storePendingRotation(JSON.stringify(held)),
      clear: () => deps.keyStore.clearPendingRotation(),
      // The kit's preserve verb: kept (same wrapping as the key) under a
      // timestamped slot before the active slot is freed. Web keystores are
      // outside key-file build 3's scope; this only keeps the bytes.
      setAside: () => deps.keyStore.setAsidePendingRotation(),
    },
    commit: async ({ privateKeyHex, publicKeyHex, record }) => {
      await deps.keyStore.storePrivateKey(privateKeyHex);
      localStorage.setItem("motebit:device_public_key", publicKeyHex);
      deps.onCommitted(publicKeyHex);
      // After the key is stored: the link names the key now in the slot.
      await deps.afterCommit?.({ publicKeyHex, record });
    },
    ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return { newPublicKey: outcome.newPublicKeyHex };
}
