import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import { encrypt, decrypt, type EncryptedPayload } from "@motebit/crypto";

export interface EncryptedAdapterConfig {
  /** The underlying adapter to wrap */
  inner: EventStoreAdapter;
  /** 256-bit symmetric key for this motebit */
  key: Uint8Array;
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
 * Wraps an EventStoreAdapter with event-level encryption.
 * Encrypts the `payload` field before writing, decrypts after reading.
 * All other fields (event_id, motebit_id, timestamp, version_clock, event_type) remain in cleartext
 * so the relay can index/filter without decryption.
 */
export class EncryptedEventStoreAdapter implements EventStoreAdapter {
  private inner: EventStoreAdapter;
  private key: Uint8Array;

  constructor(config: EncryptedAdapterConfig) {
    this.inner = config.inner;
    this.key = config.key;
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

  async getLatestClock(motebitId: string): Promise<number> {
    return this.inner.getLatestClock(motebitId);
  }

  async tombstone(eventId: string, motebitId: string): Promise<void> {
    return this.inner.tombstone(eventId, motebitId);
  }

  private async encryptPayload(payload: Record<string, unknown>): Promise<string> {
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await encrypt(plaintext, this.key);
    return JSON.stringify({
      c: toBase64(encrypted.ciphertext),
      n: toBase64(encrypted.nonce),
      t: toBase64(encrypted.tag),
    });
  }

  private async decryptEntry(entry: EventLogEntry): Promise<EventLogEntry> {
    const payload = entry.payload;
    if (payload._encrypted == null || payload._encrypted === false) return entry;

    const data = JSON.parse(payload._data as string) as { c: string; n: string; t: string };
    const encrypted: EncryptedPayload = {
      ciphertext: fromBase64(data.c),
      nonce: fromBase64(data.n),
      tag: fromBase64(data.t),
    };
    const plaintext = await decrypt(encrypted, this.key);
    const decrypted = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    return { ...entry, payload: decrypted };
  }
}

/**
 * Standalone decryption for individual events received via WebSocket onEvent callback.
 * Decrypts the payload in-place if it was encrypted; passes through unencrypted events.
 */
export async function decryptEventPayload(
  event: EventLogEntry,
  key: Uint8Array,
): Promise<EventLogEntry> {
  const payload = event.payload;
  if (payload._encrypted == null || payload._encrypted === false) return event;

  const data = JSON.parse(payload._data as string) as { c: string; n: string; t: string };
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
