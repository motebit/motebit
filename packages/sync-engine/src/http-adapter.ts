import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";

export interface HttpAdapterConfig {
  baseUrl: string;
  motebitId: string;
  authToken?: string;
  /** Max retry attempts on transient failure (default 3) */
  maxRetries?: number;
  /** Base backoff in ms — actual delay is base * 2^attempt + jitter (default 1000) */
  retryBackoffMs?: number;
}

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
export class HttpEventStoreAdapter implements EventStoreAdapter {
  private baseUrl: string;
  private motebitId: string;
  private authToken: string | undefined;
  private maxRetries: number;
  private retryBackoffMs: number;

  constructor(config: HttpAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.motebitId = config.motebitId;
    this.authToken = config.authToken;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBackoffMs = config.retryBackoffMs ?? 1_000;
  }

  async append(entry: EventLogEntry): Promise<void> {
    const url = `${this.baseUrl}/sync/${this.motebitId}/push`;
    const res = await this.fetchWithRetry(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ events: [entry] }),
    });
    if (!res.ok) {
      throw new Error(`Push failed: ${res.status} ${res.statusText}`);
    }
  }

  async query(filter: EventFilter): Promise<EventLogEntry[]> {
    const afterClock = filter.after_version_clock ?? 0;
    const url = `${this.baseUrl}/sync/${this.motebitId}/pull?after_clock=${afterClock}`;
    const res = await this.fetchWithRetry(url, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Pull failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { events: EventLogEntry[] };
    return body.events;
  }

  async getLatestClock(_motebitId: string): Promise<number> {
    const url = `${this.baseUrl}/sync/${this.motebitId}/clock`;
    const res = await this.fetchWithRetry(url, {
      method: "GET",
      headers: this.headers(),
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

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken != null && this.authToken !== "") {
      h["Authorization"] = `Bearer ${this.authToken}`;
    }
    return h;
  }
}
