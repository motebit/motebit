import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import { encrypt, decrypt, type EncryptedPayload } from "@motebit/encryption";
import { isSeqPullSource, type SeqPullResult } from "./seq-cursor.js";
import { classifyEventPayload, encodeEnvelopeData, parseEnvelopeData } from "./event-payload.js";

/**
 * Provides versioned encryption keys for key rotation.
 * getCurrentKey() returns the active key for encryption.
 * getKey(version) retrieves any historical key for decryption.
 */
export interface KeyProvider {
  getCurrentKey(): { key: Uint8Array; version: number };
  getKey(version: number): Uint8Array | null;
}

/** Optional warn logger matching the runtime pluggable logger convention. */
export interface EncryptedAdapterLogger {
  warn(message: string): void;
}

export interface EncryptedAdapterConfig {
  /** The underlying adapter to wrap */
  inner: EventStoreAdapter;
  /** 256-bit symmetric key for this motebit (sugar for single-key provider at version 1) */
  key?: Uint8Array;
  /** Versioned key provider for key rotation support */
  keyProvider?: KeyProvider;
  /** Optional logger for diagnostics (defaults to silent — no console output) */
  logger?: EncryptedAdapterLogger;
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

const noopLogger: EncryptedAdapterLogger = { warn: () => {} };

/**
 * The decrypt paths' reading of a payload, through the ONE predicate
 * (`classifyEventPayload`, #928). A payload that carries the E2E marker but is
 * not the envelope is refused — never decrypted, never passed through as
 * plaintext (it used to be decrypted by one reader and applied as plaintext
 * by the other).
 */
function envelopeForm(payload: unknown): "e2e" | "plaintext" {
  const form = classifyEventPayload(payload);
  if (form === "malformed") {
    throw new Error("encrypted-adapter: payload carries the E2E marker but is not an E2E envelope");
  }
  return form;
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
  private logger: EncryptedAdapterLogger;

  constructor(config: EncryptedAdapterConfig) {
    this.inner = config.inner;
    this.logger = config.logger ?? noopLogger;
    if (config.keyProvider) {
      this.keyProvider = config.keyProvider;
    } else if (config.key) {
      this.keyProvider = singleKeyProvider(config.key);
    } else {
      throw new Error("EncryptedAdapterConfig requires either 'key' or 'keyProvider'");
    }
  }

  /**
   * Wire activity of the inner adapter, when it reports any (the HTTP
   * adapter does) — the sync engine's watchdog counts it as progress.
   */
  onActivity(listener: () => void): () => void {
    const inner = this.inner as EventStoreAdapter & {
      onActivity?: (l: () => void) => () => void;
    };
    return typeof inner.onActivity === "function" ? inner.onActivity(listener) : () => {};
  }

  /** End the inner adapter's requests on the wire, when it can (the sync engine's abandoned cycle). */
  abortInFlight(): void {
    (this.inner as { abortInFlight?: () => void }).abortInFlight?.();
  }

  /** Settles when the previous append has been handed to the inner adapter. */
  private handedOn: Promise<void> = Promise.resolve();

  /**
   * Encrypt and push. Appends reach the inner adapter in CALL order (#914
   * round 2): encryptions run concurrently and may finish in any order, but
   * each is handed on only after the one called before it — so the sync
   * engine's clock order is the order the relay receives, which a client
   * still pulling by clock relies on.
   */
  async append(entry: EventLogEntry): Promise<void> {
    const before = this.handedOn;
    let handOn!: () => void;
    this.handedOn = new Promise<void>((resolve) => (handOn = resolve));
    let pushed: Promise<void>;
    try {
      const encrypted = await this.encryptPayload(entry.payload);
      await before;
      pushed = this.inner.append({ ...entry, payload: { _encrypted: true, _data: encrypted } });
    } finally {
      handOn();
    }
    await pushed;
  }

  async query(filter: EventFilter): Promise<EventLogEntry[]> {
    const entries = await this.inner.query(filter);
    return Promise.all(entries.map((e) => this.decryptEntry(e)));
  }

  /**
   * The E2E-mode seq-cursor key over the inner source's stream, when the
   * inner adapter pulls by the relay ingest sequence (#868); otherwise
   * undefined, and this adapter is not a seq source. Distinct from the raw
   * key, so a raw pull over the same store never advances this cursor.
   */
  get seqCursorKey(): string | undefined {
    return isSeqPullSource(this.inner) ? `e2e:${this.inner.seqCursorKey}` : undefined;
  }

  /**
   * Pull by seq through the inner source. Returns the TRANSPORT form —
   * payloads still encrypted — so the caller can drop events it already
   * holds BEFORE decrypting any; `decodeEvent` decrypts one at a time.
   */
  async pullAfterSeq(afterSeq: number, fallbackAfterClock: number): Promise<SeqPullResult> {
    if (!isSeqPullSource(this.inner)) {
      throw new Error("encrypted-adapter: the inner adapter does not pull by seq");
    }
    return this.inner.pullAfterSeq(afterSeq, fallbackAfterClock);
  }

  /** Decrypt one pulled entry; throws when it cannot (the caller records and moves past it). */
  decodeEvent(event: EventLogEntry): Promise<EventLogEntry> {
    return this.decryptEntry(event);
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
    await this.inner.append({ ...encEntry, version_clock: assigned });
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
    return encodeEnvelopeData(await encrypt(plaintext, key), version);
  }

  private async decryptEntry(entry: EventLogEntry): Promise<EventLogEntry> {
    return openEnvelope(entry, this.keyProvider, this.logger);
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
  logger: EncryptedAdapterLogger = noopLogger,
): Promise<EventLogEntry> {
  const provider: KeyProvider =
    keyOrProvider instanceof Uint8Array ? singleKeyProvider(keyOrProvider) : keyOrProvider;
  return openEnvelope(event, provider, logger);
}

/**
 * The one decrypt path: plaintext passes, the exact envelope is opened, and
 * anything else carrying the marker is refused (through `envelopeForm`).
 */
async function openEnvelope(
  entry: EventLogEntry,
  provider: KeyProvider,
  logger: EncryptedAdapterLogger,
): Promise<EventLogEntry> {
  const payload = entry.payload;
  if (envelopeForm(payload) === "plaintext") return entry;
  // envelopeForm returned "e2e", so `_data` parses.
  const data = parseEnvelopeData(payload._data)!;
  // Legacy data has no version field — treat as version 1
  const version = data.version ?? 1;
  if (data.version == null) {
    logger.warn("encrypted-adapter: decrypting unversioned payload, assuming key version 1");
  }
  const key = provider.getKey(version);
  if (key == null) {
    throw new Error(`Encryption key not found for version ${version}`);
  }
  const encrypted: EncryptedPayload = {
    ciphertext: data.ciphertext,
    nonce: data.nonce,
    tag: data.tag,
  };
  const plaintext = await decrypt(encrypted, key);
  return {
    ...entry,
    payload: JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>,
  };
}
