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
  /**
   * How long a request attempt may wait for the credential, and for the
   * response's first byte (its status and headers), before it is abandoned
   * (#914 round 2). A timed-out attempt is not retried here; a timed-out PULL
   * is re-asked for a smaller page. Without a bound, one black-holed push
   * held the push slot and every later sync joined the stuck cycle.
   * Default 20 000 ms.
   */
  requestTimeoutMs?: number;
  /**
   * How long the response BODY may go without a single byte (#914 round 3).
   * Reset on every chunk: a body that keeps arriving is never cut off,
   * however long it takes in total (a 1000-event page on a slow link). Only a
   * stalled body is. Default: `requestTimeoutMs`.
   */
  bodyIdleTimeoutMs?: number;
}

/** The default `requestTimeoutMs`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** The relay's largest seq page (services/relay/src/event-seq.ts `EVENT_SEQ_PAGE_MAX`). */
const PULL_PAGE_MAX = 1000;
/** The smallest page a timed-out pull is re-asked for: one event, on every platform. */
const PULL_PAGE_FLOOR = 1;
/**
 * How far a deadline may be stretched (#914 round 5). A bound that cannot
 * observe progress — React Native's fetch resolves only when the whole
 * response has arrived — must never make impossible what an unbounded
 * request would finish: a one-event page (or a one-event push) that times
 * out doubles its deadline, up to this factor, and resets on a success.
 */
const MAX_DEADLINE_FACTOR = 64;

/**
 * What a link has taught the adapter (#914 round 6): the pull page size and
 * the deadline stretches. Kept per relay stream for the life of the process,
 * NOT per adapter instance — a surface that rebuilds its adapter every cycle
 * (mobile's catch-up) must not start over each time, or a slow link that
 * needs more than one cycle to learn is never learned.
 */
interface HttpLinkState {
  pullLimit: number;
  /** The pull deadline's stretch (1 = `requestTimeoutMs`). */
  pullDeadlineFactor: number;
  /** The push deadline's stretch. */
  pushDeadlineFactor: number;
}
const httpLinkStates = new Map<string, HttpLinkState>();

/** A request ended by its owner (its sync cycle was abandoned) — not a timeout: nothing stretches. */
class RequestAbortedError extends Error {}

/** A request attempt abandoned at `requestTimeoutMs`. */
class RequestTimeoutError extends Error {}

/** `work`, or a RequestTimeoutError after `ms` — whichever settles first. */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RequestTimeoutError(`${what} timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
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
  private requestTimeoutMs: number;
  private bodyIdleTimeoutMs: number;
  /** The page size pulls ask for; halved after a timed-out pull, doubled back after a good one. */
  /** Requests on the wire, so an abandoned cycle's can be ended (`abortInFlight`). */
  private inFlightRequests = new Set<AbortController>();
  /** Told of every sign of life on the wire (attempt, headers, body chunk) — the sync engine's watchdog. */
  private activityListeners = new Set<() => void>();
  /** What this transport may push — see `HttpAdapterConfig.payloads`. */
  readonly payloads: RelayPayloadMode;

  /** This relay stream's learned state, shared by every adapter for it in the process. */
  private get link(): HttpLinkState {
    const key = `${this.baseUrl}#${this.motebitId}`;
    let st = httpLinkStates.get(key);
    if (!st) {
      st = { pullLimit: PULL_PAGE_MAX, pullDeadlineFactor: 1, pushDeadlineFactor: 1 };
      httpLinkStates.set(key, st);
    }
    return st;
  }

  constructor(config: HttpAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.motebitId = config.motebitId;
    this.authToken = config.authToken;
    this.credentialSource = config.credentialSource;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBackoffMs = config.retryBackoffMs ?? 1_000;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.bodyIdleTimeoutMs = config.bodyIdleTimeoutMs ?? this.requestTimeoutMs;
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
    let failed: Error | null = null;
    const init = { method: "POST", body: JSON.stringify({ events: [entry] }) };
    try {
      let res: Response;
      try {
        res = await this.authedFetch(url, init, this.link.pushDeadlineFactor);
      } catch (err: unknown) {
        // One event is the smallest push there is. A timeout stretches the
        // deadline — but only when the relay is shown to be answering (a
        // slow link, not a dead relay): a stretch earned against a dead
        // endpoint would hold the push slot long after it recovers.
        if (!(err instanceof RequestTimeoutError) || !(await this.relayAnswers())) throw err;
        this.link.pushDeadlineFactor = Math.min(
          MAX_DEADLINE_FACTOR,
          this.link.pushDeadlineFactor * 2,
        );
        res = await this.authedFetch(url, init, this.link.pushDeadlineFactor);
      }
      if (!res.ok) {
        throw new Error(`Push failed: ${res.status} ${res.statusText}`);
      }
      this.link.pushDeadlineFactor = 1;
    } catch (err: unknown) {
      failed = err instanceof Error ? err : new Error(String(err));
      throw failed;
    } finally {
      this.releasePushSlot(failed);
    }
  }

  /**
   * Is the relay answering at all? One small request (the clock), at the base
   * deadline, never stretched. A link too slow for a big page or push still
   * answers it; a dead or black-holed relay does not. Only then may a
   * deadline stretch (#914 round 6).
   */
  private async relayAnswers(): Promise<boolean> {
    try {
      await this.boundedFetch(`${this.baseUrl}/sync/${this.motebitId}/clock`, {
        method: "GET",
        headers: await this.boundedHeaders(),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * End every request on the wire, and every push waiting for the slot
   * (#914 round 6): the sync engine calls this when its stall watchdog
   * abandons a cycle, so an abandoned cycle's request never holds the push
   * slot against the next one. Nothing is stretched or shrunk by it.
   */
  abortInFlight(): void {
    const err = new RequestAbortedError("sync request abandoned with its sync cycle");
    for (const c of this.inFlightRequests) c.abort(err);
    this.inFlightRequests.clear();
    for (const w of this.pushWaiters.splice(0)) w.fail(err);
  }

  private pushesInFlight = 0;
  private pushWaiters: Array<{ go: () => void; fail: (err: Error) => void }> = [];

  private acquirePushSlot(): Promise<void> {
    if (this.pushesInFlight < MAX_CONCURRENT_PUSHES) {
      this.pushesInFlight++;
      return Promise.resolve();
    }
    return new Promise((go, fail) => this.pushWaiters.push({ go, fail }));
  }

  /**
   * Hand the slot on. After a failed push, the pushes already waiting behind
   * it fail at once: they were appended together (one sync batch), the relay
   * just failed, and the sync engine re-pushes them — one timeout per batch,
   * never one per event.
   */
  private releasePushSlot(failed: Error | null): void {
    if (failed) {
      const waiting = this.pushWaiters.splice(0);
      for (const w of waiting) {
        w.fail(
          new Error(`Push not sent: an earlier push failed (${failed.message})`, { cause: failed }),
        );
      }
      this.pushesInFlight--;
      return;
    }
    const next = this.pushWaiters.shift();
    if (next) next.go();
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
   * Subscribe to wire activity: a request attempt starting (a retry, the
   * re-ask after a 401), its headers arriving, each body chunk. The sync
   * engine's stall watchdog counts these as progress, so a slow but live
   * request is never mistaken for a stalled one (#914 round 3).
   */
  onActivity(listener: () => void): () => void {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  private active(): void {
    for (const l of this.activityListeners) {
      try {
        l();
      } catch {
        // a listener never breaks a request
      }
    }
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
    // A page that times out is re-asked smaller, halving down to a floor
    // (#914 round 3): on a slow link a whole 1000-event page may not start in
    // time, and asking for it again would fail the same way forever.
    let res: Response;
    let stretched = false;
    let answering: boolean | null = null; // asked at most once per call
    for (;;) {
      const link = this.link;
      const limit = link.pullLimit;
      const url =
        `${this.baseUrl}/sync/${this.motebitId}/pull` +
        `?after_seq=${afterSeq}&after_clock=${fallbackAfterClock}` +
        (limit < PULL_PAGE_MAX ? `&limit=${limit}` : "");
      try {
        res = await this.authedFetch(url, { method: "GET" }, link.pullDeadlineFactor);
      } catch (err: unknown) {
        if (!(err instanceof RequestTimeoutError)) throw err;
        // Shrink or stretch only for a relay that is answering: a dead one
        // costs one failed page and one failed probe, never a series.
        answering ??= await this.relayAnswers();
        if (!answering) throw err;
        if (limit > PULL_PAGE_FLOOR) {
          link.pullLimit = Math.max(PULL_PAGE_FLOOR, Math.floor(limit / 2));
          continue;
        }
        // At one event there is nothing left to shrink: stretch the deadline
        // instead (#914 round 5), so a one-event page always completes on a
        // link that delivers it at all.
        // One stretch per call, remembered across calls: a dead relay costs
        // each pull one extra attempt, never an unbounded series.
        if (link.pullDeadlineFactor < MAX_DEADLINE_FACTOR) {
          link.pullDeadlineFactor *= 2;
          if (!stretched) {
            stretched = true;
            continue;
          }
        }
        throw err;
      }
      if (res.ok) {
        link.pullLimit = Math.min(PULL_PAGE_MAX, limit * 2);
        link.pullDeadlineFactor = 1;
      }
      break;
    }
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
  private async authedFetch(
    url: string,
    init: Omit<RequestInit, "headers">,
    deadlineFactor = 1,
  ): Promise<Response> {
    const res = await this.fetchWithRetry(
      url,
      { ...init, headers: await this.boundedHeaders() },
      deadlineFactor,
    );
    if ((res.status === 401 || res.status === 403) && this.credentialSource) {
      this.active();
      return this.fetchWithRetry(
        url,
        { ...init, headers: await this.boundedHeaders() },
        deadlineFactor,
      );
    }
    return res;
  }

  /**
   * One attempt, bounded without bounding a live body (#914 round 3): the
   * response must START (status + headers) within `requestTimeoutMs`, and
   * the body may then take as long as it keeps arriving — it fails only when
   * no byte comes for `bodyIdleTimeoutMs`. The abort signal ends a real
   * fetch; the race also ends one that ignores its signal.
   */
  private async boundedFetch(
    url: string,
    init: RequestInit,
    deadlineFactor = 1,
  ): Promise<Response> {
    // The bounds that cannot observe progress are stretched by the factor;
    // the body idle bound observes every chunk and needs no stretch.
    const deadline = this.requestTimeoutMs * deadlineFactor;
    const ctrl = new AbortController();
    this.inFlightRequests.add(ctrl);
    let fire!: (err: Error) => void;
    const timedOut = new Promise<never>((_, reject) => (fire = reject));
    timedOut.catch(() => {});
    // Ended by its owner (`abortInFlight`): the race ends too, even for a
    // fetch that ignores its signal.
    ctrl.signal.addEventListener("abort", () => {
      const reason: unknown = ctrl.signal.reason;
      if (reason instanceof RequestAbortedError) fire(reason);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, what: string): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const err = new RequestTimeoutError(`sync request ${what} after ${ms} ms`);
        ctrl.abort(err);
        fire(err);
      }, ms);
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      this.active();
      arm(deadline, `${new URL(url).pathname}: no response`);
      const r = await Promise.race([fetch(url, { ...init, signal: ctrl.signal }), timedOut]);
      this.active();
      const nullBody = [101, 204, 205, 304].includes(r.status);
      const chunks: Uint8Array[] = [];
      if (!nullBody && r.body) {
        reader = r.body.getReader();
        for (;;) {
          arm(this.bodyIdleTimeoutMs, `${new URL(url).pathname}: body stalled`);
          const { done, value } = await Promise.race([reader.read(), timedOut]);
          if (done) break;
          chunks.push(value);
          this.active();
        }
        reader = undefined;
      } else if (!nullBody) {
        // No body stream: React Native's fetch (whatwg-fetch) gives a
        // Response without `body` — it buffers the whole body (XHR) before
        // resolving. Read it whole, bounded by one overall deadline: there
        // are no chunks to measure progress by (#914 round 4).
        // Read as TEXT: whatwg-fetch's arrayBuffer() needs FileReader's
        // readAsArrayBuffer, which not every React Native build has; text()
        // is what its json() uses. Sync bodies are JSON.
        arm(deadline, `${new URL(url).pathname}: body not read`);
        const text = await Promise.race([r.text(), timedOut]);
        this.active();
        return new Response(text, {
          status: r.status,
          statusText: r.statusText,
          headers: r.headers,
        });
      }
      let size = 0;
      for (const c of chunks) size += c.byteLength;
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      return new Response(nullBody ? null : bytes, {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
      });
    } catch (err: unknown) {
      if (reader) void reader.cancel().catch(() => {});
      if (err instanceof RequestTimeoutError) throw err;
      if (ctrl.signal.reason instanceof RequestAbortedError) throw ctrl.signal.reason;
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new RequestTimeoutError(`sync request aborted: ${err.message}`, { cause: err });
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlightRequests.delete(ctrl);
    }
  }

  /** The headers, with the credential lookup bounded (a hanging source never wedges a sync). */
  private boundedHeaders(): Promise<Record<string, string>> {
    return withTimeout(this.headers(), this.requestTimeoutMs, "sync credential");
  }

  /**
   * Fetch with exponential backoff + jitter on transient errors.
   * Retries on network failures and 5xx/429/408 responses.
   * Non-retryable HTTP errors (4xx) return immediately.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    deadlineFactor = 1,
  ): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.boundedFetch(url, init, deadlineFactor);
        if (res.ok || !isRetryable(res.status) || attempt === this.maxRetries) {
          return res;
        }
        // Retryable HTTP error — backoff and retry
        await backoffDelay(attempt, this.retryBackoffMs);
      } catch (err: unknown) {
        // A request that timed out is not retried here: its cost was the bound.
        if (err instanceof RequestTimeoutError) throw err;
        // Network error (DNS, connection refused)
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
