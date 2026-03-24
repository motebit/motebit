import type { MotebitIdentity } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";
import { EventStore } from "@motebit/event-log";
import { generateKeypair, signKeySuccession, bytesToHex } from "@motebit/crypto";
import type { KeySuccessionRecord } from "@motebit/crypto";

// === UUID v7 Generation ===

function generateUUIDv7(): string {
  const timestamp = Date.now();
  const timeHex = timestamp.toString(16).padStart(12, "0");

  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);

  // Set version (7) and variant (10xx)
  randomBytes[0] = (randomBytes[0]! & 0x0f) | 0x70; // version 7
  randomBytes[2] = (randomBytes[2]! & 0x3f) | 0x80; // variant 10xx

  const randHex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return [
    timeHex.slice(0, 8),
    timeHex.slice(8, 12),
    randHex.slice(0, 4),
    randHex.slice(4, 8),
    randHex.slice(8, 20),
  ].join("-");
}

// === Device Registration & Identity Storage ===

export type { DeviceRegistration, IdentityStorage } from "@motebit/sdk";
import type { DeviceRegistration, IdentityStorage } from "@motebit/sdk";

// === In-Memory Storage (for testing) ===

export class InMemoryIdentityStorage implements IdentityStorage {
  private identities = new Map<string, MotebitIdentity>();
  private devices = new Map<string, DeviceRegistration>();
  private devicesByToken = new Map<string, DeviceRegistration>();

  save(identity: MotebitIdentity): Promise<void> {
    this.identities.set(identity.motebit_id, { ...identity });
    return Promise.resolve();
  }

  load(motebitId: string): Promise<MotebitIdentity | null> {
    return Promise.resolve(this.identities.get(motebitId) ?? null);
  }

  loadByOwner(ownerId: string): Promise<MotebitIdentity | null> {
    for (const identity of this.identities.values()) {
      if (identity.owner_id === ownerId) {
        return Promise.resolve(identity);
      }
    }
    return Promise.resolve(null);
  }

  saveDevice(device: DeviceRegistration): Promise<void> {
    this.devices.set(device.device_id, { ...device });
    this.devicesByToken.set(device.device_token, { ...device });
    return Promise.resolve();
  }

  loadDevice(deviceId: string): Promise<DeviceRegistration | null> {
    return Promise.resolve(this.devices.get(deviceId) ?? null);
  }

  loadDeviceByToken(token: string): Promise<DeviceRegistration | null> {
    return Promise.resolve(this.devicesByToken.get(token) ?? null);
  }

  listDevices(motebitId: string): Promise<DeviceRegistration[]> {
    return Promise.resolve([...this.devices.values()].filter((d) => d.motebit_id === motebitId));
  }
}

// === Identity Manager ===

export class IdentityManager {
  private deviceFallback: InMemoryDeviceStore | null = null;

  constructor(
    private storage: IdentityStorage,
    private eventStore: EventStore,
  ) {}

  /** Returns the device-capable storage, falling back to an in-memory store. */
  private get deviceStore(): Required<
    Pick<IdentityStorage, "saveDevice" | "loadDevice" | "loadDeviceByToken" | "listDevices">
  > {
    if (
      this.storage.saveDevice &&
      this.storage.loadDevice &&
      this.storage.loadDeviceByToken &&
      this.storage.listDevices
    ) {
      return this.storage as Required<
        Pick<IdentityStorage, "saveDevice" | "loadDevice" | "loadDeviceByToken" | "listDevices">
      >;
    }
    if (!this.deviceFallback) {
      this.deviceFallback = new InMemoryDeviceStore();
    }
    return this.deviceFallback;
  }

  /**
   * Create a new Motebit identity. The motebit_id is immutable once created.
   */
  async create(ownerId: string): Promise<MotebitIdentity> {
    const identity: MotebitIdentity = {
      motebit_id: generateUUIDv7(),
      created_at: Date.now(),
      owner_id: ownerId,
      version_clock: 0,
    };

    await this.storage.save(identity);

    await this.eventStore.appendWithClock({
      event_id: generateUUIDv7(),
      motebit_id: identity.motebit_id,
      timestamp: identity.created_at,
      event_type: EventType.IdentityCreated,
      payload: {
        owner_id: ownerId,
      },
      tombstoned: false,
    });
    return identity;
  }

  /**
   * Load an existing identity. Returns null if not found.
   */
  async load(motebitId: string): Promise<MotebitIdentity | null> {
    return this.storage.load(motebitId);
  }

  /**
   * Load identity by owner. Returns null if not found.
   */
  async loadByOwner(ownerId: string): Promise<MotebitIdentity | null> {
    return this.storage.loadByOwner(ownerId);
  }

  /**
   * Increment the version clock and persist.
   */
  async incrementClock(motebitId: string): Promise<number> {
    const identity = await this.storage.load(motebitId);
    if (identity === null) {
      throw new Error(`Identity not found: ${motebitId}`);
    }
    identity.version_clock += 1;
    await this.storage.save(identity);
    return identity.version_clock;
  }

  /**
   * Export identity as a plain JSON-serializable object.
   */
  async export(motebitId: string): Promise<MotebitIdentity | null> {
    return this.storage.load(motebitId);
  }

  /**
   * Register a new device for a motebit identity. Returns the device
   * registration including a unique device_token for authentication.
   */
  async registerDevice(
    motebitId: string,
    deviceName?: string,
    publicKey?: string,
    deviceId?: string,
  ): Promise<DeviceRegistration> {
    const device: DeviceRegistration = {
      device_id: deviceId ?? crypto.randomUUID(),
      motebit_id: motebitId,
      device_token: crypto.randomUUID(),
      public_key: publicKey ?? "",
      registered_at: Date.now(),
      device_name: deviceName,
    };
    await this.deviceStore.saveDevice(device);
    return device;
  }

  /**
   * Validate a device token for a specific motebitId. Returns the device
   * registration if valid, null otherwise.
   */
  async validateDeviceToken(token: string, motebitId: string): Promise<DeviceRegistration | null> {
    const device = await this.deviceStore.loadDeviceByToken(token);
    if (!device || device.motebit_id !== motebitId) return null;
    return device;
  }

  /**
   * Load a device by token (alias for token-based lookup). Returns the device
   * registration if found and matches motebitId, null otherwise.
   */
  async loadDeviceByToken(token: string, motebitId: string): Promise<DeviceRegistration | null> {
    const device = await this.deviceStore.loadDeviceByToken(token);
    if (!device || device.motebit_id !== motebitId) return null;
    return device;
  }

  /**
   * Load a device by its device_id and motebit_id.
   */
  async loadDeviceById(deviceId: string, motebitId: string): Promise<DeviceRegistration | null> {
    const device = await this.deviceStore.loadDevice(deviceId);
    if (!device || device.motebit_id !== motebitId) return null;
    return device;
  }

  /**
   * List all devices registered to a motebit identity.
   */
  async listDevices(motebitId: string): Promise<DeviceRegistration[]> {
    return this.deviceStore.listDevices(motebitId);
  }

  /**
   * Rotate the identity's primary public key.
   * Updates the public key on the specified device (or all devices for the identity)
   * and logs a key rotation event.
   */
  async rotateKey(newPublicKeyHex: string, newDeviceId?: string): Promise<void> {
    if (newDeviceId) {
      const device = await this.deviceStore.loadDevice(newDeviceId);
      if (!device) {
        throw new Error(`Device not found: ${newDeviceId}`);
      }

      const updated: DeviceRegistration = { ...device, public_key: newPublicKeyHex };
      await this.deviceStore.saveDevice(updated);

      // Log the rotation event
      await this.eventStore.appendWithClock({
        event_id: generateUUIDv7(),
        motebit_id: device.motebit_id,
        timestamp: Date.now(),
        event_type: EventType.KeyRotated,
        payload: {
          device_id: device.device_id,
          action: "key_rotated",
          new_public_key: newPublicKeyHex,
        },
        tombstoned: false,
      });
    }
  }

  /**
   * Update a specific device's public key.
   */
  async updateDevicePublicKey(deviceId: string, newPublicKeyHex: string): Promise<void> {
    const device = await this.deviceStore.loadDevice(deviceId);
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    const updated: DeviceRegistration = { ...device, public_key: newPublicKeyHex };
    await this.deviceStore.saveDevice(updated);

    // Log the update event
    await this.eventStore.appendWithClock({
      event_id: generateUUIDv7(),
      motebit_id: device.motebit_id,
      timestamp: Date.now(),
      event_type: EventType.KeyRotated,
      payload: {
        device_id: deviceId,
        action: "public_key_updated",
        new_public_key: newPublicKeyHex,
      },
      tombstoned: false,
    });
  }
}

// === Bootstrap: shared identity bootstrap protocol ===

export interface BootstrapConfigStore {
  read(): Promise<{ motebit_id: string; device_id: string; device_public_key: string } | null>;
  write(state: { motebit_id: string; device_id: string; device_public_key: string }): Promise<void>;
}

export interface BootstrapKeyStore {
  storePrivateKey(privKeyHex: string): Promise<void>;
}

export interface BootstrapResult {
  motebitId: string;
  deviceId: string;
  publicKeyHex: string;
  isFirstLaunch: boolean;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Shared identity bootstrap protocol used by all surfaces (CLI, Desktop).
 *
 * 1. Check config for existing identity
 * 2. If found, verify it exists in DB — return existing
 * 3. If config has ID but DB doesn't, re-create in DB (robustness)
 * 4. On first launch: create identity, generate Ed25519 keypair, register device
 * 5. Persist private key via keyStore, write config via configStore
 */
export async function bootstrapIdentity(opts: {
  surfaceName: string;
  identityStorage: IdentityStorage;
  eventStoreAdapter: EventStoreAdapter;
  configStore: BootstrapConfigStore;
  keyStore: BootstrapKeyStore;
}): Promise<BootstrapResult> {
  const { surfaceName, identityStorage, eventStoreAdapter, configStore, keyStore } = opts;
  const eventStore = new EventStore(eventStoreAdapter);
  const identityManager = new IdentityManager(identityStorage, eventStore);

  const existing = await configStore.read();

  if (existing && existing.motebit_id) {
    // Config has an identity — verify it exists in the DB
    const loaded = await identityManager.load(existing.motebit_id);
    if (loaded) {
      return {
        motebitId: existing.motebit_id,
        deviceId: existing.device_id,
        publicKeyHex: existing.device_public_key,
        isFirstLaunch: false,
      };
    }
    // Config has ID but DB doesn't — re-create in DB using the EXISTING identity
    // from config (e.g. create-motebit wrote config but not DB, or DB was wiped).
    // We must NOT call identityManager.create() because that generates a new UUID.
    const restoredIdentity: MotebitIdentity = {
      motebit_id: existing.motebit_id,
      created_at: Date.now(),
      owner_id: surfaceName,
      version_clock: 0,
    };
    await identityStorage.save(restoredIdentity);

    // Log the restore event
    await eventStore.appendWithClock({
      event_id: generateUUIDv7(),
      motebit_id: existing.motebit_id,
      timestamp: restoredIdentity.created_at,
      event_type: EventType.IdentityCreated,
      payload: { owner_id: surfaceName, restored: true },
      tombstoned: false,
    });

    // Register the device with the existing public key from config
    if (existing.device_public_key) {
      await identityManager.registerDevice(
        existing.motebit_id,
        surfaceName,
        existing.device_public_key,
      );
    }

    return {
      motebitId: existing.motebit_id,
      deviceId: existing.device_id,
      publicKeyHex: existing.device_public_key,
      isFirstLaunch: false,
    };
  }

  // First launch — generate identity + keypair
  const identity = await identityManager.create(surfaceName);
  const keypair = await generateKeypair();
  const pubKeyHex = toHex(keypair.publicKey);
  const privKeyHex = toHex(keypair.privateKey);

  const device = await identityManager.registerDevice(identity.motebit_id, surfaceName, pubKeyHex);

  // Persist private key (surface-specific: OS keyring, encrypted config, etc.)
  await keyStore.storePrivateKey(privKeyHex);

  // Write identity metadata to config (surface-specific: file, Tauri IPC, etc.)
  await configStore.write({
    motebit_id: identity.motebit_id,
    device_id: device.device_id,
    device_public_key: pubKeyHex,
  });

  return {
    motebitId: identity.motebit_id,
    deviceId: device.device_id,
    publicKeyHex: pubKeyHex,
    isFirstLaunch: true,
  };
}

// === Key Rotation ===

export interface RotateIdentityKeysResult {
  /** New Ed25519 keypair */
  newPublicKey: Uint8Array;
  newPrivateKey: Uint8Array;
  newPublicKeyHex: string;
  /** Dual-signed succession record */
  successionRecord: KeySuccessionRecord;
}

/**
 * Generate a new Ed25519 keypair and create a dual-signed succession record.
 * This is the proper way to rotate keys — surfaces should call this instead
 * of importing generateKeypair directly.
 *
 * The caller is responsible for updating the identity file using
 * `rotate()` from `@motebit/identity-file` with the returned keypair
 * and succession record.
 */
export async function rotateIdentityKeys(opts: {
  oldPrivateKey: Uint8Array;
  oldPublicKey: Uint8Array;
  reason?: string;
}): Promise<RotateIdentityKeysResult> {
  const newKeypair = await generateKeypair();

  const successionRecord = await signKeySuccession(
    opts.oldPrivateKey,
    newKeypair.privateKey,
    newKeypair.publicKey,
    opts.oldPublicKey,
    opts.reason,
  );

  return {
    newPublicKey: newKeypair.publicKey,
    newPrivateKey: newKeypair.privateKey,
    newPublicKeyHex: bytesToHex(newKeypair.publicKey),
    successionRecord,
  };
}

// === In-Memory Device Store (fallback when IdentityStorage lacks device methods) ===

class InMemoryDeviceStore {
  private devices = new Map<string, DeviceRegistration>();
  private devicesByToken = new Map<string, DeviceRegistration>();

  saveDevice(device: DeviceRegistration): Promise<void> {
    this.devices.set(device.device_id, { ...device });
    this.devicesByToken.set(device.device_token, { ...device });
    return Promise.resolve();
  }

  loadDevice(deviceId: string): Promise<DeviceRegistration | null> {
    return Promise.resolve(this.devices.get(deviceId) ?? null);
  }

  loadDeviceByToken(token: string): Promise<DeviceRegistration | null> {
    return Promise.resolve(this.devicesByToken.get(token) ?? null);
  }

  listDevices(motebitId: string): Promise<DeviceRegistration[]> {
    return Promise.resolve([...this.devices.values()].filter((d) => d.motebit_id === motebitId));
  }
}
