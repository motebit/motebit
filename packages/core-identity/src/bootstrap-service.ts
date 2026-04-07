/**
 * `bootstrapServiceIdentity()` — filesystem-driven variant of the
 * shared bootstrap protocol for services running on persistent-volume
 * infrastructure (Fly.io volumes, a local data dir, or any writable
 * directory).
 *
 * ### Why it's here
 *
 * Every other surface in the monorepo bootstraps its identity through
 * `bootstrapIdentity()` with a surface-specific storage pair:
 *
 *   - desktop   → Tauri JSON config + OS keyring
 *   - mobile    → SecureStore
 *   - web/spatial → IndexedDB + EncryptedKeyStore
 *   - cli       → ~/.motebit/config.json + encrypted file
 *
 * Services historically did NOT use this path — each one read a
 * pre-generated `motebit.md` file that had to be present at build time
 * (gitignored, baked into the image by the operator's first local
 * deploy). That forced an out-of-band ceremony and diverged services
 * from the shared identity protocol.
 *
 * This helper closes the gap. A service calls `bootstrapServiceIdentity`
 * with a data directory. On first boot it generates a fresh Ed25519
 * keypair, registers the device, persists everything to the data dir
 * via file-backed stores, and returns the full identity material
 * including the private key hex (for signing receipts). On subsequent
 * boots it reloads the existing identity. Same protocol as every other
 * surface — just with a filesystem adapter.
 *
 * ### Scope boundary
 *
 * This helper does NOT emit the canonical signed `motebit.md` file —
 * that requires `@motebit/identity-file`'s `generate()` which lives in
 * a sibling Layer 2 package and would create a circular/same-layer
 * dependency if imported here. Services that need a signed motebit.md
 * (all of them today) call `generate()` themselves as a one-liner
 * after this helper returns — the helper gives them everything they
 * need (motebitId, publicKey, privateKey hex).
 *
 * The filesystem layout written by this helper:
 *
 *     {dataDir}/motebit.json   — bootstrap config (motebit_id, device_id, public key)
 *     {dataDir}/motebit.key    — Ed25519 private key (hex, mode 0600)
 *
 * The service layer adds `{dataDir}/motebit.md` by calling `generate()`
 * after this returns.
 */

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FileSystemBootstrapConfigStore, FileSystemBootstrapKeyStore } from "./file-stores.js";
import { bootstrapIdentity, InMemoryIdentityStorage } from "./index.js";
// `@motebit/event-log` is a Layer 1 dep already declared by this
// package; InMemoryEventStore lets us run the bootstrap against a
// zero-persistence event store (the filesystem IS the persistence
// layer for services — the event log is just a transient buffer).
import { InMemoryEventStore } from "@motebit/event-log";

export interface BootstrapServiceIdentityOptions {
  /**
   * Directory where identity state is persisted. For Fly-deployed
   * services this is typically `/data` — a mounted persistent volume.
   * For local development, any writable directory works.
   */
  dataDir: string;
  /**
   * Human-readable service name — embedded as the owner_id and device
   * name. Use the Fly app name or package name
   * (e.g. `"motebit-code-review"`).
   */
  serviceName: string;
}

export interface BootstrapServiceIdentityResult {
  /** Canonical motebit_id (UUID v7). Survives redeploys as long as the volume survives. */
  motebitId: string;
  /** Device ID registered to this service instance. */
  deviceId: string;
  /** Ed25519 public key (hex). */
  publicKeyHex: string;
  /**
   * Ed25519 private key (hex). The caller signs receipts with this.
   * Do not log, export, or transmit — it's the only thing that proves
   * this identity is the one that generated this instance.
   */
  privateKeyHex: string;
  /** True if this boot generated a fresh identity; false if loaded from the volume. */
  isFirstLaunch: boolean;
  /** Absolute path to `{dataDir}/motebit.md` — the location a downstream emitter should use. */
  suggestedIdentityPath: string;
  /** Absolute path to `{dataDir}/motebit.json`. */
  configPath: string;
  /** Absolute path to `{dataDir}/motebit.key`. */
  keyPath: string;
}

/**
 * Bootstrap a service's motebit identity from a data directory.
 *
 * On first boot, generates a fresh Ed25519 keypair, creates a motebit_id,
 * and persists the identity to `{dataDir}/motebit.json` and
 * `{dataDir}/motebit.key`. On subsequent boots, loads the existing
 * state from the same files. Returns everything the service needs
 * (motebit_id, device_id, public key, private key hex, first-launch
 * flag) in one call.
 *
 * Services that need a signed `motebit.md` file (the canonical
 * identity format consumed by the relay and verification tools) call
 * `generate()` from `@motebit/identity-file` after this helper
 * returns, passing the result's publicKeyHex + privateKeyHex.
 */
export async function bootstrapServiceIdentity(
  opts: BootstrapServiceIdentityOptions,
): Promise<BootstrapServiceIdentityResult> {
  const { dataDir, serviceName } = opts;

  // Ensure the data directory exists. On Fly the mount point is
  // created by the volume config in fly.toml; local dev may point at
  // a scratch dir that doesn't exist yet.
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const configPath = join(dataDir, "motebit.json");
  const keyPath = join(dataDir, "motebit.key");

  const configStore = new FileSystemBootstrapConfigStore(configPath);
  const keyStore = new FileSystemBootstrapKeyStore(keyPath);
  const identityStorage = new InMemoryIdentityStorage();
  const eventStoreAdapter = new InMemoryEventStore();

  const result = await bootstrapIdentity({
    surfaceName: serviceName,
    identityStorage,
    eventStoreAdapter,
    configStore,
    keyStore,
  });

  // Read the private key back. On first launch it was just written
  // by bootstrapIdentity()'s call to keyStore.storePrivateKey(); on
  // subsequent launches it was persisted by a previous run.
  const privateKeyHex = keyStore.readPrivateKey();
  if (privateKeyHex == null) {
    throw new Error(
      `bootstrapServiceIdentity: private key missing at ${keyPath} after bootstrap — filesystem write failed or the volume is not writable`,
    );
  }

  return {
    motebitId: result.motebitId,
    deviceId: result.deviceId,
    publicKeyHex: result.publicKeyHex,
    privateKeyHex,
    isFirstLaunch: result.isFirstLaunch,
    suggestedIdentityPath: join(dataDir, "motebit.md"),
    configPath,
    keyPath,
  };
}
