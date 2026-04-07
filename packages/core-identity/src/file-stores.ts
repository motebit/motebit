/**
 * Filesystem-backed bootstrap stores — the service-side analog of the
 * Tauri/SecureStore/IndexedDB adapters every other surface uses.
 *
 * Lives in `@motebit/core-identity` alongside the `BootstrapConfigStore`
 * and `BootstrapKeyStore` interfaces they implement. Fly-deployed
 * services mount a persistent volume at `/data` and point these stores
 * at it — first boot populates the identity, subsequent boots reuse it,
 * the volume survives deploys.
 *
 * Both stores treat missing or malformed files as "absent" (return
 * null) so the bootstrap helper can treat the first-launch case
 * naturally. Errors from permission problems or corrupted files surface
 * as null too — we deliberately don't throw on read. Write errors DO
 * throw (disk full, permissions, etc.) because silent write failure
 * would make the whole identity system latently broken.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import type { BootstrapConfigStore, BootstrapKeyStore } from "./index.js";

/**
 * JSON-file-backed `BootstrapConfigStore`. Stores the motebit_id,
 * device_id, and device_public_key as a tiny JSON document.
 *
 * Writes are atomic: the payload is written to `{path}.tmp` then
 * renamed over the canonical path. On POSIX, `rename(2)` is atomic,
 * so a concurrent reader either sees the old file or the new one,
 * never a half-written blob. A crash between write and rename leaves
 * a stale `.tmp` file that the next read() ignores (it looks for the
 * canonical path, not `.tmp`).
 */
export class FileSystemBootstrapConfigStore implements BootstrapConfigStore {
  constructor(private readonly configPath: string) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async interface
  async read(): Promise<{
    motebit_id: string;
    device_id: string;
    device_public_key: string;
  } | null> {
    if (!existsSync(this.configPath)) return null;
    try {
      const content = readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(content) as {
        motebit_id?: unknown;
        device_id?: unknown;
        device_public_key?: unknown;
      };
      if (
        typeof parsed.motebit_id !== "string" ||
        typeof parsed.device_id !== "string" ||
        typeof parsed.device_public_key !== "string"
      ) {
        return null;
      }
      return {
        motebit_id: parsed.motebit_id,
        device_id: parsed.device_id,
        device_public_key: parsed.device_public_key,
      };
    } catch {
      return null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async interface
  async write(state: {
    motebit_id: string;
    device_id: string;
    device_public_key: string;
  }): Promise<void> {
    const tmp = `${this.configPath}.tmp`;
    const payload = JSON.stringify(state, null, 2);
    writeFileSync(tmp, payload, "utf-8");
    renameSync(tmp, this.configPath);
  }
}

/**
 * File-backed `BootstrapKeyStore`. Stores the Ed25519 private key
 * (as lowercase hex) with mode 0600 so only the service user can read
 * it. The file lives on the same persistent volume as the config
 * store — losing either means losing the agent's identity.
 *
 * `readPrivateKey()` is the one extension beyond the
 * `BootstrapKeyStore` interface: the service needs to load the
 * private key on subsequent boots to sign receipts, and there's no
 * other path for it to come out of storage. This mirrors the CLI's
 * pattern of reading `~/.motebit/device_key` during startup.
 */
export class FileSystemBootstrapKeyStore implements BootstrapKeyStore {
  constructor(private readonly keyPath: string) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async interface
  async storePrivateKey(privKeyHex: string): Promise<void> {
    writeFileSync(this.keyPath, privKeyHex, { encoding: "utf-8", mode: 0o600 });
    // writeFileSync's mode only applies when creating the file. Explicit
    // chmod handles subsequent writes (key rotation) — the file mode
    // would otherwise inherit from the process umask on overwrite.
    chmodSync(this.keyPath, 0o600);
  }

  /** Read the persisted private key hex. Returns null if missing or empty. */
  readPrivateKey(): string | null {
    if (!existsSync(this.keyPath)) return null;
    try {
      const content = readFileSync(this.keyPath, "utf-8").trim();
      return content === "" ? null : content;
    } catch {
      return null;
    }
  }
}
