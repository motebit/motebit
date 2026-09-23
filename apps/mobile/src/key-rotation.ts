/**
 * Mobile key rotation — a thin adapter over `@motebit/surface-kit`'s
 * `rotateOrThrow` (#709). The state machine lives in the package; this file
 * supplies Expo's plumbing: SecureStore for the key and the write-ahead,
 * AsyncStorage for the identity file that is re-signed on commit.
 */
import { rotateOrThrow, type HeldRotation } from "@motebit/surface-kit";
import { rotate as rotateIdentityFile } from "@motebit/identity-file";

interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface MobileRotationDeps {
  keyring: SecureStore;
  motebitId: string;
  deviceId: string;
  syncUrl: string | null;
  identityFile: { load(): Promise<string | null>; save(content: string): Promise<void> };
  onCommitted: (newPublicKeyHex: string) => void;
  reason?: string;
  fetchImpl?: typeof fetch;
}

const PENDING_KEY = "pending_rotation";

export async function rotateMobileKey(deps: MobileRotationDeps): Promise<{ newPublicKey: string }> {
  const outcome = await rotateOrThrow({
    motebitId: deps.motebitId,
    deviceId: deps.deviceId,
    syncUrl: deps.syncUrl,
    loadPrivateKeyHex: () => deps.keyring.get("device_private_key"),
    writeAhead: {
      load: async () => {
        const raw = await deps.keyring.get(PENDING_KEY);
        if (raw == null || raw === "") return null;
        try {
          return JSON.parse(raw) as HeldRotation;
        } catch {
          return null;
        }
      },
      save: (held) => deps.keyring.set(PENDING_KEY, JSON.stringify(held)),
      clear: () => deps.keyring.delete(PENDING_KEY),
    },
    commit: async ({ privateKeyHex, publicKeyHex, record }) => {
      const existing = await deps.identityFile.load();
      if (existing != null && existing !== "") {
        const rotated = await rotateIdentityFile({
          existingContent: existing,
          newPublicKey: hexToBytes(publicKeyHex),
          newPrivateKey: hexToBytes(privateKeyHex),
          successionRecord: record,
        });
        await deps.identityFile.save(rotated);
      }
      await deps.keyring.set("device_private_key", privateKeyHex);
      await deps.keyring.set("device_public_key", publicKeyHex);
      deps.onCommitted(publicKeyHex);
    },
    ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return { newPublicKey: outcome.newPublicKeyHex };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}
