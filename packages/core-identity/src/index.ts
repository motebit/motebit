import type { MoteIdentity, EventLogEntry } from "@mote/sdk";
import { EventType } from "@mote/sdk";
import type { EventStore } from "@mote/event-log";

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
  save(identity: MoteIdentity): Promise<void>;
  load(moteId: string): Promise<MoteIdentity | null>;
  loadByOwner(ownerId: string): Promise<MoteIdentity | null>;
}

// === In-Memory Storage (for testing) ===

export class InMemoryIdentityStorage implements IdentityStorage {
  private identities = new Map<string, MoteIdentity>();

  async save(identity: MoteIdentity): Promise<void> {
    this.identities.set(identity.mote_id, { ...identity });
  }

  async load(moteId: string): Promise<MoteIdentity | null> {
    return this.identities.get(moteId) ?? null;
  }

  async loadByOwner(ownerId: string): Promise<MoteIdentity | null> {
    for (const identity of this.identities.values()) {
      if (identity.owner_id === ownerId) {
        return identity;
      }
    }
    return null;
  }
}

// === Identity Manager ===

export class IdentityManager {
  constructor(
    private storage: IdentityStorage,
    private eventStore: EventStore,
  ) {}

  /**
   * Create a new Mote identity. The mote_id is immutable once created.
   */
  async create(ownerId: string): Promise<MoteIdentity> {
    const identity: MoteIdentity = {
      mote_id: generateUUIDv7(),
      created_at: Date.now(),
      owner_id: ownerId,
      version_clock: 0,
    };

    await this.storage.save(identity);

    const clock = await this.eventStore.getLatestClock(identity.mote_id);
    const event: EventLogEntry = {
      event_id: generateUUIDv7(),
      mote_id: identity.mote_id,
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
  async load(moteId: string): Promise<MoteIdentity | null> {
    return this.storage.load(moteId);
  }

  /**
   * Load identity by owner. Returns null if not found.
   */
  async loadByOwner(ownerId: string): Promise<MoteIdentity | null> {
    return this.storage.loadByOwner(ownerId);
  }

  /**
   * Increment the version clock and persist.
   */
  async incrementClock(moteId: string): Promise<number> {
    const identity = await this.storage.load(moteId);
    if (identity === null) {
      throw new Error(`Identity not found: ${moteId}`);
    }
    identity.version_clock += 1;
    await this.storage.save(identity);
    return identity.version_clock;
  }

  /**
   * Export identity as a plain JSON-serializable object.
   */
  async export(moteId: string): Promise<MoteIdentity | null> {
    return this.storage.load(moteId);
  }
}
