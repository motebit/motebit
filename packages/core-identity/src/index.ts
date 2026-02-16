import type { MotebitIdentity, EventLogEntry } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";

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

// === Identity Storage Interface ===

export interface IdentityStorage {
  save(identity: MotebitIdentity): Promise<void>;
  load(motebitId: string): Promise<MotebitIdentity | null>;
  loadByOwner(ownerId: string): Promise<MotebitIdentity | null>;
}

// === In-Memory Storage (for testing) ===

export class InMemoryIdentityStorage implements IdentityStorage {
  private identities = new Map<string, MotebitIdentity>();

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
}

// === Identity Manager ===

export class IdentityManager {
  constructor(
    private storage: IdentityStorage,
    private eventStore: EventStore,
  ) {}

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

    const clock = await this.eventStore.getLatestClock(identity.motebit_id);
    const event: EventLogEntry = {
      event_id: generateUUIDv7(),
      motebit_id: identity.motebit_id,
      timestamp: identity.created_at,
      event_type: EventType.IdentityCreated,
      payload: {
        owner_id: ownerId,
      },
      version_clock: clock + 1,
      tombstoned: false,
    };

    await this.eventStore.append(event);
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
}
