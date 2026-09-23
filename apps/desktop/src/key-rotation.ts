/**
 * Desktop key rotation — a thin adapter over `@motebit/surface-kit`'s
 * `rotateOrThrow` (#709). The state machine lives in the package; this file
 * supplies Tauri's plumbing: the OS keyring (via `invoke`) for the key and
 * the write-ahead, the config file for the published key and the identity
 * file that is re-signed on commit.
 */
import { rotateOrThrow, type HeldRotation } from "@motebit/surface-kit";
import { rotate as rotateIdentityFile } from "@motebit/identity-file";
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
    writeAhead: {
      load: async () => {
        const raw = await deps
          .invoke<string | null>("keyring_get", { key: PENDING_KEY })
          .catch(() => null);
        if (raw == null || raw === "") return null;
        try {
          return JSON.parse(raw) as HeldRotation;
        } catch {
          return null;
        }
      },
      save: (held) =>
        deps.invoke<void>("keyring_set", { key: PENDING_KEY, value: JSON.stringify(held) }),
      clear: () => deps.invoke<void>("keyring_delete", { key: PENDING_KEY }).catch(() => undefined),
    },
    commit: async ({ privateKeyHex, publicKeyHex, record }) => {
      await deps.invoke<void>("keyring_set", { key: "device_private_key", value: privateKeyHex });
      const next = await readConfig();
      const existing = next["_identity_file"];
      if (typeof existing === "string" && existing !== "") {
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
