import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import type { CredentialSource, CredentialRequest } from "./credential-source.js";
import type { SeqPullResult, SeqPullSource } from "./seq-cursor.js";
import { assertPushable, type RelayPayloadMode } from "./event-payload.js";

/** Drop the relay's transport `seq` from an entry before it is stored anywhere. */
function stripSeq(e: EventLogEntry & { seq?: unknown }): EventLogEntry {
  if (!("seq" in e)) return e;
  const { seq: _seq, ...entry } = e;
  return entry;
}

export interface HttpAdapterConfig {
  baseUrl: string;
  motebitId: string;
  authToken?: string;
  /**
   * Dynamic credential provider — takes precedence over authToken. Resolved
   * per request, so a rotating short-lived token never goes stale; on a
   * 401/403 the adapter asks it ONCE more and retries (#927).
   */
  credentialSource?: CredentialSource;
  /**
   * What this transport may push (#928). `e2e`: only E2E envelopes — a
   * plaintext payload is refused before it leaves the device. A surface that
   * holds a sync encryption key MUST build its transports in `e2e` mode.
   * Default `raw` (a surface with no key).
   */
  payloads?: RelayPayloadMode;
  /** Max retry attempts on transient failure (default 3) */
  maxRetries?: number;
  /** Base backoff in ms — actual delay is base * 2^attempt + jitter (default 1000) */
  retryBackoffMs?: number;
}

/**
 * The most push requests one adapter has on the wire at once. One: events
 * reach the relay in the order they were appended (clock order, from the
 * sync engine), exactly as the sequential push before #914 delivered them —
 * a client still pulling by clock never sees a later clock land first.
 */
const MAX_CONCURRENT_PUSHES = 1;

/** Whether an HTTP status is retryable (server error or rate-limited). */
function isRetryable(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/** Sleep with exponential backoff + random jitter (prevents thundering herd). */
function backoffDelay(attempt: number, baseMs: number): Promise<void> {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs; // 0..baseMs
  return new Promise((resolve) => setTimeout(resolve, exponential + jitter));
}

/**
 * EventStoreAdapter that calls the Motebit API's sync endpoints over HTTP.
 * Retries transient failures with exponential backoff + jitter.
 */
export class HttpEventStoreAdapter implements EventStoreAdapter, SeqPullSource {
  private baseUrl: string;
  private motebitId: string;
  private authToken: string | undefined;
  private credentialSource: CredentialSource | undefined;
  private maxRetries: number;
  private retryBackoffMs: number;
  /** What this transport may push — see `HttpAdapterConfig.payloads`. */
  readonly payloads: RelayPayloadMode;

  constructor(config: HttpAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.motebitId = config.motebitId;
    this.authToken = config.authToken;
    this.credentialSource = config.credentialSource;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBackoffMs = config.retryBackoffMs ?? 1_000;
    this.payloads = config.payloads ?? "raw";
  }

  /**
   * Push one event. Resolves only when the relay ACKNOWLEDGED it (a 2xx:
   * stored, or already held — the relay dedups by event_id); anything else
   * throws. The sync engine moves its push cursor on that resolution (#914).
   * Appends made together go out MAX_CONCURRENT_PUSHES at a time, in call
   * order.
   */
  async append(entry: EventLogEntry): Promise<void> {
    // Fail closed BEFORE any byte leaves: an e2e transport never carries plaintext (#928).
    assertPushable([entry], this.payloads);
    const url = `${this.baseUrl}/sync/${this.motebitId}/push`;
    await this.acquirePushSlot();
    try {
      const res = await this.authedFetch(url, {
        method: "POST",
        body: JSON.stringify({ events: [entry] }),
      });
      if (!res.ok) {
        throw new Error(`Push failed: ${res.status} ${res.statusText}`);
      }
    } finally {
      this.releasePushSlot();
    }
  }

  private pushesInFlight = 0;
  private pushWaiters: Array<() => void> = [];

  private acquirePushSlot(): Promise<void> {
    if (this.pushesInFlight < MAX_CONCURRENT_PUSHES) {
      this.pushesInFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.pushWaiters.push(resolve));
  }

  private releasePushSlot(): void {
    const next = this.pushWaiters.shift();
    if (next) next();
    else this.pushesInFlight--;
  }

  async query(filter: EventFilter): Promise<EventLogEntry[]> {
    const afterClock = filter.after_version_clock ?? 0;
    const url = `${this.baseUrl}/sync/${this.motebitId}/pull?after_clock=${afterClock}`;
    const res = await this.authedFetch(url, {
      method: "GET",
    });
    if (!res.ok) {
      throw new Error(`Pull failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { events: EventLogEntry[] };
    return body.events;
  }

  /**
   * The relay stream this adapter reads, in RAW mode: relay origin +
   * identity (#868). An E2E wrapper keys its own cursor separately.
   */
  get seqCursorKey(): string {
    return `raw:${this.baseUrl}#${this.motebitId}`;
  }

  /**
   * Pull by the relay ingest sequence (#868). One request carries both
   * cursors: a relay that serves `after_seq` answers with seq-stamped
   * events; an older relay ignores it and answers `after_clock` exactly as
   * `query` would. Each event's `seq` is carried beside it and stripped from
   * the entry — it is transport metadata, never part of a stored entry. A
   * seq page with an entry lacking an integer seq is refused whole.
   */
  async pullAfterSeq(afterSeq: number, fallbackAfterClock: number): Promise<SeqPullResult> {
    const url =
      `${this.baseUrl}/sync/${this.motebitId}/pull` +
      `?after_seq=${afterSeq}&after_clock=${fallbackAfterClock}`;
    const res = await this.authedFetch(url, {
      method: "GET",
    });
    if (!res.ok) {
      throw new Error(`Pull failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
      events: Array<EventLogEntry & { seq?: unknown }>;
      next_seq?: unknown;
      has_more?: unknown;
      latest_seq?: unknown;
    };
    const events = Array.isArray(body.events) ? body.events : [];
    if (typeof body.next_seq !== "number" || typeof body.latest_seq !== "number") {
      // An older relay: no seq in the answer. It served the clock query.
      return { kind: "clock", events: events.map(stripSeq) };
    }
    const entries = events.map((e) => {
      if (typeof e.seq !== "number" || !Number.isSafeInteger(e.seq)) {
        throw new Error("Pull failed: a seq page entry carries no integer seq");
      }
      return { seq: e.seq, event: stripSeq(e) };
    });
    return {
      kind: "seq",
      entries,
      nextSeq: body.next_seq,
      hasMore: body.has_more === true,
      latestSeq: body.latest_seq,
    };
  }

  async getLatestClock(_motebitId: string): Promise<number> {
    const url = `${this.baseUrl}/sync/${this.motebitId}/clock`;
    const res = await this.authedFetch(url, {
      method: "GET",
    });
    if (!res.ok) {
      throw new Error(`Clock failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { latest_clock: number };
    return body.latest_clock;
  }

  async tombstone(_eventId: string, _motebitId: string): Promise<void> {
    // No-op for MVP — tombstoning is a local operation
  }

  /**
   * One authenticated request (#927). Headers are resolved per attempt from
   * the credential source. A 401/403 — what a relay answers an expired
   * short-lived token — is met by asking the source ONCE more and retrying;
   * a second refusal is returned to the caller, which throws it. Never
   * swallowed here. A static `authToken` cannot be refreshed, so its refusal
   * is returned as is.
   */
  private async authedFetch(url: string, init: Omit<RequestInit, "headers">): Promise<Response> {
    const res = await this.fetchWithRetry(url, { ...init, headers: await this.headers() });
    if ((res.status === 401 || res.status === 403) && this.credentialSource) {
      return this.fetchWithRetry(url, { ...init, headers: await this.headers() });
    }
    return res;
  }

  /**
   * Fetch with exponential backoff + jitter on transient errors.
   * Retries on network failures and 5xx/429/408 responses.
   * Non-retryable HTTP errors (4xx) return immediately.
   */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, init);
        if (res.ok || !isRetryable(res.status) || attempt === this.maxRetries) {
          return res;
        }
        // Retryable HTTP error — backoff and retry
        await backoffDelay(attempt, this.retryBackoffMs);
      } catch (err: unknown) {
        // Network error (DNS, connection refused, timeout)
        lastError =
          err instanceof Error ? err : new Error("Network request failed", { cause: err });
        if (attempt === this.maxRetries) break;
        await backoffDelay(attempt, this.retryBackoffMs);
      }
    }
    throw lastError ?? new Error(`Request failed after ${this.maxRetries} retries: ${url}`);
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const token = await this.resolveToken();
    if (token != null && token !== "") {
      h["Authorization"] = `Bearer ${token}`;
    }
    return h;
  }

  private async resolveToken(): Promise<string | null> {
    if (this.credentialSource) {
      const request: CredentialRequest = { serverUrl: this.baseUrl };
      return this.credentialSource.getCredential(request);
    }
    return this.authToken ?? null;
  }
}
