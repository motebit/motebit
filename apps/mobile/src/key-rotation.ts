/**
 * Mobile key rotation — a thin adapter over `@motebit/surface-kit`'s
 * `rotateOrThrow` (#709). The state machine lives in the package; this file
 * supplies Expo's plumbing: SecureStore for the key and the write-ahead,
 * AsyncStorage for the identity file that is re-signed on commit.
 */
import { parseHeldRotation, rotateOrThrow } from "@motebit/surface-kit";
import { parse as parseIdentityFile, rotate as rotateIdentityFile } from "@motebit/identity-file";
import { hexToBytes } from "@motebit/encryption";

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
    publishedPublicKeyHex: () => deps.keyring.get("device_public_key"),
    writeAhead: {
      load: async () => {
        let raw: string | null;
        try {
          raw = await deps.keyring.get(PENDING_KEY);
        } catch {
          return "unreadable";
        }
        return parseHeldRotation(raw);
      },
      save: (held) => deps.keyring.set(PENDING_KEY, JSON.stringify(held)),
      clear: () => deps.keyring.delete(PENDING_KEY),
    },
    commit: async ({ privateKeyHex, publicKeyHex, record }) => {
      // Key first (the recoverable half), then the published key, then the
      // identity file — and idempotent: a file already on the new key is not
      // re-signed, so finishing an interrupted commit appends no second link.
      await deps.keyring.set("device_private_key", privateKeyHex);
      await deps.keyring.set("device_public_key", publicKeyHex);
      const existing = await deps.identityFile.load();
      if (existing != null && existing !== "" && fileKey(existing) !== publicKeyHex) {
        const rotated = await rotateIdentityFile({
          existingContent: existing,
          newPublicKey: hexToBytes(publicKeyHex),
          newPrivateKey: hexToBytes(privateKeyHex),
          successionRecord: record,
        });
        await deps.identityFile.save(rotated);
      }
      deps.onCommitted(publicKeyHex);
    },
    ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return { newPublicKey: outcome.newPublicKeyHex };
}

/** The key an identity file currently names, or null when it cannot be read. */
function fileKey(content: string): string | null {
  try {
    return parseIdentityFile(content).frontmatter.identity.public_key;
  } catch {
    return null;
  }
}
