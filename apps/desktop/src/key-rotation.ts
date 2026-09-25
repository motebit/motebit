/**
 * Desktop key rotation — a thin adapter over `@motebit/surface-kit`'s
 * `rotateOrThrow` (#709). The state machine lives in the package; this file
 * supplies Tauri's plumbing: the OS keyring (via `invoke`) for the key and
 * the write-ahead, the config file for the published key and the identity
 * file that is re-signed on commit.
 */
import { parseHeldRotation, rotateOrThrow } from "@motebit/surface-kit";
import { parse as parseIdentityFile, rotate as rotateIdentityFile } from "@motebit/identity-file";
import { hexToBytes } from "@motebit/encryption";

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface DesktopRotationDeps {
  invoke: InvokeFn;
  motebitId: string;
  deviceId: string;
  onCommitted: (newPublicKeyHex: string) => void;
  reason?: string;
  fetchImpl?: typeof fetch;
}

const PENDING_KEY = "pending_rotation";

export async function rotateDesktopKey(
  deps: DesktopRotationDeps,
): Promise<{ newPublicKeyHex: string }> {
  const readConfig = async () =>
    JSON.parse(await deps.invoke<string>("read_config")) as Record<string, unknown>;
  const config = await readConfig();
  const configured = config["sync_url"];
  const syncUrl = typeof configured === "string" && configured !== "" ? configured : null;
  const outcome = await rotateOrThrow({
    motebitId: deps.motebitId,
    deviceId: deps.deviceId,
    syncUrl,
    loadPrivateKeyHex: () =>
      deps.invoke<string | null>("keyring_get", { key: "device_private_key" }),
    publishedPublicKeyHex: async () => {
      const c = await readConfig();
      const published = c["device_public_key"];
      return typeof published === "string" ? published : null;
    },
    writeAhead: {
      load: async () => {
        // A keyring read that throws (prompt cancelled, locked) is not an
        // empty slot; it is a slot this run cannot see into.
        let raw: string | null;
        try {
          raw = await deps.invoke<string | null>("keyring_get", { key: PENDING_KEY });
        } catch {
          return "unreadable";
        }
        return parseHeldRotation(raw);
      },
      save: (held) =>
        deps.invoke<void>("keyring_set", { key: PENDING_KEY, value: JSON.stringify(held) }),
      clear: () => deps.invoke<void>("keyring_delete", { key: PENDING_KEY }).catch(() => undefined),
      // The kit's preserve verb (surface-kit `setAside`): the write-ahead's
      // bytes move to a timestamped slot before the active slot is freed,
      // and a failure at either step throws so the kit stops. A minimal
      // implementation over the existing keyring IPC so desktop keeps
      // compiling and never deletes a write-ahead the relay may hold; the
      // desktop lane of key-file build 3 (items 21–27,
      // docs/proposals/key-file-durability-v1.md) owns this adapter and the
      // durability of the store underneath it.
      setAside: async () => {
        const raw = await deps.invoke<string | null>("keyring_get", { key: PENDING_KEY });
        if (raw == null || raw === "") return;
        await deps.invoke<void>("keyring_set", {
          key: `${PENDING_KEY}.set_aside.${Date.now()}`,
          value: raw,
        });
        await deps.invoke<void>("keyring_delete", { key: PENDING_KEY });
      },
    },
    commit: async ({ privateKeyHex, publicKeyHex, record }) => {
      await deps.invoke<void>("keyring_set", { key: "device_private_key", value: privateKeyHex });
      const next = await readConfig();
      const existing = next["_identity_file"];
      if (typeof existing === "string" && existing !== "" && fileKey(existing) !== publicKeyHex) {
        next["_identity_file"] = await rotateIdentityFile({
          existingContent: existing,
          newPublicKey: hexToBytes(publicKeyHex),
          newPrivateKey: hexToBytes(privateKeyHex),
          successionRecord: record,
        });
      }
      next["device_public_key"] = publicKeyHex;
      await deps.invoke<void>("write_config", { json: JSON.stringify(next) });
      deps.onCommitted(publicKeyHex);
    },
    ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return { newPublicKeyHex: outcome.newPublicKeyHex };
}

/** The key an identity file currently names, or null when it cannot be read. */
function fileKey(content: string): string | null {
  try {
    return parseIdentityFile(content).frontmatter.identity.public_key;
  } catch {
    return null;
  }
}
