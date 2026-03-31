import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import { encrypt, decrypt, type EncryptedPayload } from "@motebit/crypto";

/**
 * Provides versioned encryption keys for key rotation.
 * getCurrentKey() returns the active key for encryption.
 * getKey(version) retrieves any historical key for decryption.
 */
export interface KeyProvider {
  getCurrentKey(): { key: Uint8Array; version: number };
  getKey(version: number): Uint8Array | null;
}

export interface EncryptedAdapterConfig {
  /** The underlying adapter to wrap */
  inner: EventStoreAdapter;
  /** 256-bit symmetric key for this motebit (sugar for single-key provider at version 1) */
  key?: Uint8Array;
  /** Versioned key provider for key rotation support */
  keyProvider?: KeyProvider;
}

// Portable base64 helpers that work in both Node.js and React Native
function toBase64(arr: Uint8Array): string {
  if (typeof globalThis.Buffer !== "undefined") {
    return globalThis.Buffer.from(arr).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]!);
  }
  return btoa(binary);
}

function fromBase64(str: string): Uint8Array {
  if (typeof globalThis.Buffer !== "undefined") {
    return new Uint8Array(globalThis.Buffer.from(str, "base64"));
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Creates a KeyProvider from a single static key (backward-compatible sugar).
 */
function singleKeyProvider(key: Uint8Array): KeyProvider {
  return {
    getCurrentKey: () => ({ key, version: 1 }),
    getKey: (version: number) => (version === 1 ? key : null),
  };
}

/**
 * Wraps an EventStoreAdapter with event-level encryption.
 * Encrypts the `payload` field before writing, decrypts after reading.
 * All other fields (event_id, motebit_id, timestamp, version_clock, event_type) remain in cleartext
 * so the relay can index/filter without decryption.
 *
 * Supports key versioning: each encrypted payload embeds the key version used.
 * On decrypt, the correct key is resolved via the KeyProvider. Legacy data without
 * a version field is treated as version 1.
 */
export class EncryptedEventStoreAdapter implements EventStoreAdapter {
  private inner: EventStoreAdapter;
  private keyProvider: KeyProvider;

  constructor(config: EncryptedAdapterConfig) {
    this.inner = config.inner;
    if (config.keyProvider) {
      this.keyProvider = config.keyProvider;
    } else if (config.key) {
      this.keyProvider = singleKeyProvider(config.key);
    } else {
      throw new Error("EncryptedAdapterConfig requires either 'key' or 'keyProvider'");
    }
  }

  async append(entry: EventLogEntry): Promise<void> {
    const encrypted = await this.encryptPayload(entry.payload);
    const encEntry: EventLogEntry = {
      ...entry,
      payload: { _encrypted: true, _data: encrypted } as unknown as Record<string, unknown>,
    };
    await this.inner.append(encEntry);
  }

  async query(filter: EventFilter): Promise<EventLogEntry[]> {
    const entries = await this.inner.query(filter);
    return Promise.all(entries.map((e) => this.decryptEntry(e)));
  }

  async appendWithClock(entry: Omit<EventLogEntry, "version_clock">): Promise<number> {
    const encrypted = await this.encryptPayload(entry.payload);
    const encEntry = {
      ...entry,
      payload: { _encrypted: true, _data: encrypted } as unknown as Record<string, unknown>,
    };
    if (this.inner.appendWithClock) {
      return this.inner.appendWithClock(encEntry);
    }
    // Fallback: non-atomic
    const clock = await this.inner.getLatestClock(entry.motebit_id);
    const assigned = clock + 1;
    await this.inner.append({ ...encEntry, version_clock: assigned } as EventLogEntry);
    return assigned;
  }

  async getLatestClock(motebitId: string): Promise<number> {
    return this.inner.getLatestClock(motebitId);
  }

  async tombstone(eventId: string, motebitId: string): Promise<void> {
    return this.inner.tombstone(eventId, motebitId);
  }

  private async encryptPayload(payload: Record<string, unknown>): Promise<string> {
    const { key, version } = this.keyProvider.getCurrentKey();
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await encrypt(plaintext, key);
    return JSON.stringify({
      c: toBase64(encrypted.ciphertext),
      n: toBase64(encrypted.nonce),
      t: toBase64(encrypted.tag),
      v: version,
    });
  }

  private async decryptEntry(entry: EventLogEntry): Promise<EventLogEntry> {
    const payload = entry.payload;
    if (payload._encrypted == null || payload._encrypted === false) return entry;

    const data = JSON.parse(payload._data as string) as {
      c: string;
      n: string;
      t: string;
      v?: number;
    };
    // Legacy data has no version field — treat as version 1
    const version = data.v ?? 1;
    if (data.v == null) {
      console.warn("encrypted-adapter: decrypting unversioned payload, assuming key version 1");
    }
    const key = this.keyProvider.getKey(version);
    if (key == null) {
      throw new Error(`Encryption key not found for version ${version}`);
    }
    const encrypted: EncryptedPayload = {
      ciphertext: fromBase64(data.c),
      nonce: fromBase64(data.n),
      tag: fromBase64(data.t),
    };
    const plaintext = await decrypt(encrypted, key);
    const decrypted = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    return { ...entry, payload: decrypted };
  }
}

/**
 * Standalone decryption for individual events received via WebSocket onEvent callback.
 * Decrypts the payload in-place if it was encrypted; passes through unencrypted events.
 * Accepts either a plain key (backward-compatible, treated as version 1) or a KeyProvider.
 */
export async function decryptEventPayload(
  event: EventLogEntry,
  keyOrProvider: Uint8Array | KeyProvider,
): Promise<EventLogEntry> {
  const payload = event.payload;
  if (payload._encrypted == null || payload._encrypted === false) return event;

  const provider: KeyProvider =
    keyOrProvider instanceof Uint8Array ? singleKeyProvider(keyOrProvider) : keyOrProvider;

  const data = JSON.parse(payload._data as string) as {
    c: string;
    n: string;
    t: string;
    v?: number;
  };
  const version = data.v ?? 1;
  if (data.v == null) {
    console.warn("encrypted-adapter: decrypting unversioned event payload, assuming key version 1");
  }
  const key = provider.getKey(version);
  if (key == null) {
    throw new Error(`Encryption key not found for version ${version}`);
  }
  const encrypted: EncryptedPayload = {
    ciphertext: fromBase64(data.c),
    nonce: fromBase64(data.n),
    tag: fromBase64(data.t),
  };
  const plaintext = await decrypt(encrypted, key);
  return {
    ...event,
    payload: JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>,
  };
}
