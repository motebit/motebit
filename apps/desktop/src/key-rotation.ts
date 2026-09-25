/**
 * Desktop key rotation — a thin adapter over `@motebit/surface-kit`'s
 * `rotateOrThrow` (#709). The state machine lives in the package; this file
 * supplies Tauri's plumbing: the key store (via `invoke`) for the key and
 * the write-ahead, the config file for the published key and the identity
 * file that is re-signed on commit.
 */
import { parseHeldRotation, rotateOrThrow, type KeyRotationPorts } from "@motebit/surface-kit";
import { parse as parseIdentityFile, rotate as rotateIdentityFile } from "@motebit/identity-file";
import { hexToBytes } from "@motebit/encryption";
import { updateConfig } from "./config-update";

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
    writeAhead: desktopWriteAhead(deps.invoke),
    commit: async ({ privateKeyHex, publicKeyHex, record }) => {
      // The retiring key is kept by keyring_set as
      // `device_private_key.preserved-<time>` (R2) whatever the kit's `relay`
      // outcome says (ignored here): erasing it is permitted, never required.
      await deps.invoke<void>("keyring_set", { key: "device_private_key", value: privateKeyHex });
      const current = await readConfig();
      const existing = current["_identity_file"];
      const patch: Record<string, unknown> = { device_public_key: publicKeyHex };
      if (typeof existing === "string" && existing !== "" && fileKey(existing) !== publicKeyHex) {
        patch["_identity_file"] = await rotateIdentityFile({
          existingContent: existing,
          newPublicKey: hexToBytes(publicKeyHex),
          newPrivateKey: hexToBytes(privateKeyHex),
          successionRecord: record,
        });
      }
      // Compare-and-swap on the identity file the new one was signed over:
      // another writer (a CLI rotation, a restore) that changed it since the
      // read above makes this refuse instead of reverting it.
      await updateConfig(deps.invoke, patch, { _identity_file: existing ?? null });
      deps.onCommitted(publicKeyHex);
    },
    ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return { newPublicKeyHex: outcome.newPublicKeyHex };
}

/**
 * The desktop's write-ahead port. `setAside` is the surface-kit port's
 * set-aside verb ("move the current write-ahead out of the active slot
 * WITHOUT destroying its bytes; resolves when durable; throws on failure").
 * Declared on this object (not a fresh literal inside the ports) so it
 * satisfies the port both before and after the kit gains the member.
 */
export function desktopWriteAhead(
  invoke: InvokeFn,
): KeyRotationPorts["writeAhead"] & { setAside(): Promise<void> } {
  return {
    load: async () => {
      // A key-store read that throws (a damaged or unreadable
      // dev-keyring.json — Rust's keyring_get no longer folds those
      // into "none") is not an empty slot; it is one this run cannot see into.
      let raw: string | null;
      try {
        raw = await invoke<string | null>("keyring_get", { key: PENDING_KEY });
      } catch {
        return "unreadable";
      }
      return parseHeldRotation(raw);
    },
    save: (held) => invoke<void>("keyring_set", { key: PENDING_KEY, value: JSON.stringify(held) }),
    // Rust's keyring_delete keeps key material as `.preserved-<time>` first (R2).
    // A failure leaves the entry in place and is SURFACED: pre-mint clears must stop.
    clear: async () => {
      try {
        await invoke<void>("keyring_delete", { key: PENDING_KEY });
      } catch (err) {
        throw new Error(
          `the rotation write-ahead could not be set aside (${err instanceof Error ? err.message : String(err)}); it is still held and nothing was lost`,
          { cause: err },
        );
      }
    },
    // Move the write-ahead out of the active slot WITHOUT destroying its
    // bytes: resolves only once the preserved copy is verified; rejects
    // (the caller must stop) otherwise.
    setAside: () => invoke<void>("keyring_set_aside", { key: PENDING_KEY }),
  };
}

/** The key an identity file currently names, or null when it cannot be read. */
function fileKey(content: string): string | null {
  try {
    return parseIdentityFile(content).frontmatter.identity.public_key;
  } catch {
    return null;
  }
}
