import { noteSample, perEventMs, type LinkSample } from "./link-estimate.js";
import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import type { CredentialSource, CredentialRequest } from "./credential-source.js";
import type { SeqPullResult, SeqPullSource } from "./seq-cursor.js";
import { assertPushable, type RelayPayloadMode } from "./event-payload.js";
import { sanitizeRelayText } from "./relay-text.js";

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
  /** Max retry attempts on a transient failure within one attempt (default 3). */
  maxRetries?: number;
  /** Base backoff in ms — actual delay is base * 2^attempt + jitter (default 1000) */
  retryBackoffMs?: number;
  /**
   * A request's deadline (#914): the time it may take to get its first byte
   * back, before the adapter ADAPTS — never before it kills the request
   * (round 7). A push that misses it hands its slot on to the next push.
   * Otherwise a small probe asks whether the relay is answering right now,
   * and only if it is — while this request is not — the next pull pages
   * shrink (until answered pages give a per-event estimate) and a second
   * attempt starts beside this one (which may yet complete: it is not cut
   * off). That second attempt is the one stated exception to never sending
   * work in flight again: its first may be on a dead connection. The
   * only kill is the stated exclusion: 64 × this of SILENCE — no byte for
   * the attempt, none on its link. Default 20 000 ms.
   */
  requestTimeoutMs?: number;
  /**
   * The deadline for silence INSIDE a response body: a body whose next chunk
   * is this late has missed its deadline (the same adaptation — never a
   * kill). Default: `requestTimeoutMs`.
   */
  bodyIdleTimeoutMs?: number;
}

/** The default `requestTimeoutMs`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** The relay's largest seq page (services/relay/src/event-seq.ts `EVENT_SEQ_PAGE_MAX`). */
const PULL_PAGE_MAX = 1000;
/** The smallest page a slow pull is re-asked for: one event, on every platform. */
const PULL_PAGE_FLOOR = 1;
/**
 * The only kill of a live attempt (#914 round 7, the stated exclusion): this
 * many deadlines of SILENCE — no byte for the attempt and none on its link.
 * Below it, a deadline adapts and never destroys work that could complete.
 */
const ATTEMPT_CAP_FACTOR = 64;
/** The most concurrent attempts of one request (the original + second attempts). */
const MAX_ATTEMPTS = 8;

/**
 * What a link has taught the adapter (#914 rounds 6–7): the pull page size.
 * Kept per relay stream for the life of the process, NOT per adapter
 * instance — a surface that rebuilds its adapter every cycle (mobile's
 * catch-up) must not start over each time.
 */
interface HttpLinkState {
  pullLimit: number;
  /**
   * When this link last delivered a byte to any request on it (headers, a
   * body chunk, a whole React Native body). A request silent while the link
   * carries other bytes is queued behind them, not dead: its deadline adapts
   * nothing and its silence cap does not run (#914 round 7).
   */
  lastByteAt: number;
  /** Answered pull pages: events carried and time taken — the page-size estimate. */
  pageSamples: LinkSample[];
  /**
   * The link's responses have no body stream (React Native): no progress is
   * seen before the whole page arrives, so a miss is the only early signal.
   */
  opaque: boolean;
  /** A response (headers) has arrived on this link at least once. */
  answered: boolean;
  /** Request attempts on the wire on this link, across every adapter for it. */
  inFlight: number;
  /** Attempts whose body is streaming in on this link right now. */
  bodies: number;
  /** The liveness probe on the wire for this link, shared by every request waiting on it. */
  probe: Promise<boolean> | null;
}

/**
 * A pull page is sized, from the per-event estimate, to arrive within this
 * many deadlines — far inside the 64 of silence at which an attempt is given up.
 */
const PAGE_BUDGET_DEADLINES = 16;
const httpLinkStates = new Map<string, HttpLinkState>();

/** A request ended by its owner (its sync cycle was abandoned). Nothing adapts. */
class RequestAbortedError extends Error {}

/** An attempt that reached the cap — the stated exclusion. */
class RequestTimeoutError extends Error {}

/** A second attempt ended because another attempt of the same request won. */
class RequestSupersededError extends Error {}

/**
 * One attempt on the wire. Why it was aborted is recorded HERE, by whoever
 * aborts it, before `abort()` — never read back from `signal.reason`, which
 * React Native's AbortController (abort-controller@3.0.0) does not carry
 * (#914 round 7).
 */
interface Attempt {
  ctrl: AbortController;
  /** Set before `ctrl.abort()`: the owner (an abandoned cycle), the cap, or a sibling that won. */
  abortedBy: "owner" | "cap" | "superseded" | null;
  startedAt: number;
  /** The last sign of progress: the start, the headers, each body chunk. */
  progressAt: number;
  /** When the current deadline window began (a miss restarts it; progress does too). */
  windowFrom: number;
  /** Headers received: the body-silence deadline applies from here. */
  answered: boolean;
  /** The liveness probe: its answer says the relay answers, not that the link carries our bytes. */
  probe?: true;
  /** Its body is streaming in (counted in the link's `bodies`). */
  inBody?: true;
}

/**
 * The most push requests one adapter has on the wire at once (second
 * attempts of the same push aside). One: events reach the relay in the
 * order they were appended — a client still pulling by clock never sees a
 * later clock land first.
 */
const MAX_CONCURRENT_PUSHES = 1;
/**
 * The most pushes that missed their deadline and still run while newer ones
 * go out (#914 round 7): a slow relay's answers overlap, bounded.
 */
const MAX_OVERLAPPING_PUSHES = 8;

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
 *
 * The liveness law (#914 round 7): a deadline changes ADAPTATION only — it
 * never destroys work that is progressing or could still complete. A
 * request that misses its deadline keeps going; the adapter halves the next
 * pull page and, when the relay is shown answering meanwhile, starts a
 * second attempt beside it. The first to complete wins and the others are
 * ended. An attempt is killed only by its owner (the sync engine abandoning
 * its cycle) or at 64 × the deadline.
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
  /** Every attempt on the wire, so an abandoned cycle's can be ended and live work reported. */
  private attempts = new Set<Attempt>();
  /** Told of every sign of life on the wire (attempt, headers, body chunk) — the sync engine's watchdog. */
  private activityListeners = new Set<() => void>();
  /** What this transport may push — see `HttpAdapterConfig.payloads`. */
  readonly payloads: RelayPayloadMode;

  /**
   * An answered pull page teaches the page size (#914 round 7). With a
   * per-event estimate, the next pages carry what arrives within
   * PAGE_BUDGET_DEADLINES; without one, a full page — or any page that
   * never missed its deadline — doubles the size, so a second size is soon
   * answered and the estimate exists.
   */
  private learnPage(n: number, ms: number, grow: boolean): void {
    const link = this.link;
    if (n > 0) noteSample(link.pageSamples, n, ms);
    const per = perEventMs(link.pageSamples);
    if (per !== null) {
      const budget = this.requestTimeoutMs * PAGE_BUDGET_DEADLINES;
      const fits = per > 0 ? Math.floor(budget / per) : PULL_PAGE_MAX;
      link.pullLimit = Math.max(PULL_PAGE_FLOOR, Math.min(PULL_PAGE_MAX, fits));
    } else if (grow || n >= link.pullLimit) {
      link.pullLimit = Math.min(PULL_PAGE_MAX, link.pullLimit * 2);
    }
  }

  /**
   * Is this relay stream's link carrying bytes to us right now (or, while a
   * request is on it, unable to say — a React Native link shows none until
   * a body is whole)? A second reader of the same pages should wait rather
   * than share it.
   */
  linkBusy(): boolean {
    const link = this.link;
    if (link.bodies > 0) return true;
    // A link that shows nothing before a whole body — or has never answered,
    // so what it shows is unknown — is busy while anything is on it.
    return (link.opaque || !link.answered) && link.inFlight > 0;
  }

  /** A byte arrived for `a`: progress for it, life for the link, activity for the watchdog. */
  private heard(a: Attempt): void {
    a.progressAt = Date.now();
    // A probe's answer says the relay is up, not that this cycle's work
    // moved: it is neither the link's bytes nor the watchdog's progress.
    if (a.probe) return;
    this.link.lastByteAt = a.progressAt;
    this.active();
  }

  /**
   * When `a` was last heard from — or the link it shares, if more recently:
   * an attempt queued behind the link's other bytes is not silent.
   */
  private heardAt(a: Attempt): number {
    return Math.max(a.progressAt, this.link.lastByteAt);
  }

  /** This relay stream's learned state, shared by every adapter for it in the process. */
  private get link(): HttpLinkState {
    const key = `${this.baseUrl}#${this.motebitId}`;
    let st = httpLinkStates.get(key);
    if (!st) {
      st = {
        pullLimit: PULL_PAGE_MAX,
        lastByteAt: 0,
        pageSamples: [],
        opaque: false,
        answered: false,
        inFlight: 0,
        bodies: 0,
        probe: null,
      };
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
    // A push that misses its deadline keeps going — and hands its slot on,
    // so a slow relay's answers overlap instead of queueing one behind
    // another (#914 round 7). While the relay answers in time, pushes go out
    // one at a time, in call order.
    let released = false;
    const handOn = setTimeout(() => {
      released = true;
      this.releasePushSlot(null, true);
    }, this.requestTimeoutMs);
    try {
      const res = await this.request(() => ({
        url,
        init: { method: "POST", body: JSON.stringify({ events: [entry] }) },
      }));
      if (!res.ok) {
        throw new Error(`Push failed: ${res.status} ${sanitizeRelayText(res.statusText)}`);
      }
    } catch (err: unknown) {
      failed = err instanceof Error ? err : new Error(String(err));
      throw failed;
    } finally {
      clearTimeout(handOn);
      if (!released) this.releasePushSlot(failed);
      else {
        this.overlapping--;
        if (failed) this.failWaiting(failed);
        else this.wakeWaiter();
      }
    }
  }

  /**
   * End every attempt on the wire, and every push waiting for the slot
   * (#914 round 6): the sync engine calls this when its stall watchdog
   * abandons a cycle. Nothing adapts because of it.
   */
  abortInFlight(): void {
    for (const a of this.attempts) {
      a.abortedBy = "owner";
      a.ctrl.abort();
    }
    this.attempts.clear();
    const err = new RequestAbortedError("sync request abandoned with its sync cycle");
    for (const w of this.pushWaiters.splice(0)) w.fail(err);
  }

  /**
   * Is there request work on the wire that may still complete (under the
   * cap)? The sync engine's stall watchdog asks, so a slow but live request
   * is never abandoned as a stall (#914 round 7).
   */
  hasLiveWork(): boolean {
    const now = Date.now();
    for (const a of this.attempts) {
      if (a.abortedBy === null && now - this.heardAt(a) < this.capMs) return true;
    }
    return false;
  }

  private get capMs(): number {
    return this.requestTimeoutMs * ATTEMPT_CAP_FACTOR;
  }

  private pushesInFlight = 0;
  private pushWaiters: Array<{ go: () => void; fail: (err: Error) => void }> = [];

  private acquirePushSlot(): Promise<void> {
    if (this.pushesInFlight < MAX_CONCURRENT_PUSHES && this.overlapping < MAX_OVERLAPPING_PUSHES) {
      this.pushesInFlight++;
      return Promise.resolve();
    }
    return new Promise((go, fail) => this.pushWaiters.push({ go, fail }));
  }

  /**
   * Hand the slot on. After a failed push, the pushes already waiting behind
   * it fail at once: they were appended together (one sync batch), the relay
   * just failed, and the sync engine re-pushes them.
   */
  private releasePushSlot(failed: Error | null, early = false): void {
    if (early) this.overlapping++;
    if (failed) {
      this.failWaiting(failed);
      this.pushesInFlight--;
      return;
    }
    const next = this.overlapping < MAX_OVERLAPPING_PUSHES ? this.pushWaiters.shift() : undefined;
    if (next) next.go();
    else this.pushesInFlight--;
  }

  private failWaiting(failed: Error): void {
    for (const w of this.pushWaiters.splice(0)) {
      w.fail(
        new Error(`Push not sent: an earlier push failed (${failed.message})`, { cause: failed }),
      );
    }
  }

  /** A slot freed while the overlap cap held a waiter back: let it go now. */
  private wakeWaiter(): void {
    if (this.pushesInFlight >= MAX_CONCURRENT_PUSHES || this.overlapping >= MAX_OVERLAPPING_PUSHES)
      return;
    const next = this.pushWaiters.shift();
    if (!next) return;
    this.pushesInFlight++;
    next.go();
  }

  /** Pushes that missed their deadline and still run beside newer ones. */
  private overlapping = 0;

  async query(filter: EventFilter): Promise<EventLogEntry[]> {
    const afterClock = filter.after_version_clock ?? 0;
    const url = `${this.baseUrl}/sync/${this.motebitId}/pull?after_clock=${afterClock}`;
    const res = await this.request(() => ({ url, init: { method: "GET" } }));
    if (!res.ok) {
      throw new Error(`Pull failed: ${res.status} ${sanitizeRelayText(res.statusText)}`);
    }
    const body = (await res.json()) as { events: EventLogEntry[] };
    return body.events;
  }

  /**
   * Subscribe to wire activity: an attempt starting, its headers arriving,
   * each body chunk. The sync engine's stall watchdog counts these as
   * progress (#914 round 3).
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
   *
   * The page size is learned per link (#914 round 7, `learnPage`): from
   * answered pages once two sizes give a per-event estimate; before that,
   * doubled after a full page or one that never missed, and halved (down to
   * one event) on a miss that is the page's own — the relay's probe answers
   * while the page does not — or on any miss where the link shows no
   * progress before a whole body (React Native) or has never answered. A
   * second attempt, when one starts, asks for the page size then current.
   * The attempt already on the wire is never cut off.
   */
  async pullAfterSeq(afterSeq: number, fallbackAfterClock: number): Promise<SeqPullResult> {
    const link = this.link;
    const started = Date.now();
    let silent = false;
    const halve = (): void => {
      link.pullLimit = Math.max(PULL_PAGE_FLOOR, Math.floor(link.pullLimit / 2));
    };
    const res = await this.request(
      () => {
        const limit = link.pullLimit;
        return {
          url:
            `${this.baseUrl}/sync/${this.motebitId}/pull` +
            `?after_seq=${afterSeq}&after_clock=${fallbackAfterClock}` +
            (limit < PULL_PAGE_MAX ? `&limit=${limit}` : ""),
          init: { method: "GET" },
        };
      },
      // Until answered pages of two sizes give an estimate: a miss the relay's
      // probe shows is the page's own (the relay answers others) halves the
      // next pages…
      () => {
        // (A miss the path below already halved for is not halved twice.)
        if (link.opaque || !link.answered) return;
        if (perEventMs(link.pageSamples) === null) halve();
      },
      // …and on a link that shows no progress before the whole page (React
      // Native), or has never answered at all (what it shows is not known
      // yet), any miss does — it is the only signal there is.
      () => {
        silent = true;
        if ((link.opaque || !link.answered) && perEventMs(link.pageSamples) === null) halve();
      },
    );
    if (!res.ok) {
      throw new Error(`Pull failed: ${res.status} ${sanitizeRelayText(res.statusText)}`);
    }
    const body = (await res.json()) as {
      events: Array<EventLogEntry & { seq?: unknown }>;
      next_seq?: unknown;
      has_more?: unknown;
      latest_seq?: unknown;
    };
    const events = Array.isArray(body.events) ? body.events : [];
    this.learnPage(events.length, Date.now() - started, body.has_more === true || !silent);
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
    const res = await this.request(() => ({ url, init: { method: "GET" } }));
    if (!res.ok) {
      throw new Error(`Clock failed: ${res.status} ${sanitizeRelayText(res.statusText)}`);
    }
    const body = (await res.json()) as { latest_clock: number };
    return body.latest_clock;
  }

  async tombstone(_eventId: string, _motebitId: string): Promise<void> {
    // No-op for MVP — tombstoning is a local operation
  }

  /**
   * One request, run under the liveness law (#914 round 7). The first
   * attempt starts at once. Whenever the newest attempt misses its deadline
   * (no first byte in `requestTimeoutMs`, or a body silent for
   * `bodyIdleTimeoutMs`), `onSilent` is told, and a small probe (one per link at a time) asks
   * whether the relay is answering right now; only if it is — while this
   * request is not — `onMiss` adapts and a second attempt starts beside the
   * first (up to MAX_ATTEMPTS). No attempt is cut off for missing a
   * deadline. The first to complete wins and the others are ended; the
   * request fails only when every attempt has failed.
   */
  private request(
    make: () => { url: string; init: Omit<RequestInit, "headers" | "signal"> },
    onMiss?: () => void,
    onSilent?: () => void,
  ): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const mine = new Set<Attempt>();
      let settled = false;
      let watch: ReturnType<typeof setTimeout> | null = null;
      let probing = false;

      const finish = (winner?: Attempt): void => {
        settled = true;
        if (watch) clearTimeout(watch);
        for (const a of mine) {
          if (a !== winner && a.abortedBy === null) {
            a.abortedBy = "superseded";
            a.ctrl.abort();
          }
        }
      };
      const newest = (): Attempt | undefined => [...mine].pop();

      const start = (): void => {
        const { url, init } = make();
        const a: Attempt = {
          ctrl: new AbortController(),
          abortedBy: null,
          startedAt: Date.now(),
          progressAt: Date.now(),
          windowFrom: Date.now(),
          answered: false,
        };
        mine.add(a);
        this.attempts.add(a);
        this.attempt(url, init, a).then(
          (res) => {
            if (settled) return;
            finish(a);
            resolve(res);
          },
          (err: unknown) => {
            mine.delete(a);
            if (settled) return;
            if (err instanceof RequestAbortedError) {
              // Its owner ended it (`abortError` classified it): so ends the request.
              finish();
              reject(err);
              return;
            }
            if (mine.size === 0) {
              finish();
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          },
        );
        arm();
      };

      const arm = (): void => {
        if (watch) clearTimeout(watch);
        const a = newest();
        if (!a) return;
        const limit = a.answered ? this.bodyIdleTimeoutMs : this.requestTimeoutMs;
        const from = Math.max(a.progressAt, a.windowFrom);
        watch = setTimeout(check, Math.max(1, from + limit - Date.now()));
      };

      const check = (): void => {
        watch = null;
        if (settled) return;
        const a = newest();
        if (!a) return;
        const limit = a.answered ? this.bodyIdleTimeoutMs : this.requestTimeoutMs;
        if (Date.now() - Math.max(a.progressAt, a.windowFrom) < limit) {
          arm();
          return;
        }
        // Missed: never kill. Ask whether the relay is answering right now.
        onSilent?.();
        a.windowFrom = Date.now(); // one miss per deadline, not one per tick
        arm();
        if (probing) return;
        probing = true;
        void this.relayAnswers().then((answering) => {
          probing = false;
          // A relay that is slow to answer anything (the probe too) is waited
          // on: nothing adapts, nothing starts beside it. Only a relay that
          // answers others while this request is silent is evidence that the
          // request is too big for the link (adapt: `onMiss`) or on a dead
          // connection (a second attempt beside it).
          if (settled || !answering) return;
          onMiss?.();
          const b = newest();
          if (b && !b.answered && mine.size < MAX_ATTEMPTS) start();
        });
      };

      start();
    });
  }

  /**
   * Is the relay answering right now? One small request (the clock), which
   * must answer within one deadline. Only a diagnostic — its own abort at
   * that deadline destroys nothing.
   */
  private relayAnswers(): Promise<boolean> {
    // One probe per link at a time: every request waiting shares its answer.
    const link = this.link;
    if (link.probe) return link.probe;
    const probe = this.probeOnce().finally(() => {
      if (link.probe === probe) link.probe = null;
    });
    link.probe = probe;
    return probe;
  }

  private async probeOnce(): Promise<boolean> {
    const a: Attempt = {
      ctrl: new AbortController(),
      abortedBy: null,
      startedAt: Date.now(),
      progressAt: Date.now(),
      windowFrom: Date.now(),
      answered: false,
      probe: true,
    };
    const timer = setTimeout(() => {
      a.abortedBy = "cap";
      a.ctrl.abort();
    }, this.requestTimeoutMs);
    try {
      const res = await this.fetchOnce(
        `${this.baseUrl}/sync/${this.motebitId}/clock`,
        { method: "GET" },
        a,
      );
      return res.status > 0;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One attempt: credential, fetch (retrying a transient failure), the 401
   * re-ask (#927), the whole body. Aborted only by its owner, a winning
   * sibling, or the cap — classified by `a.abortedBy`, never `signal.reason`.
   */
  private async attempt(
    url: string,
    init: Omit<RequestInit, "headers" | "signal">,
    a: Attempt,
  ): Promise<Response> {
    // The cap is on SILENCE, never on total time: an attempt that keeps
    // making progress (headers, body chunks) is never given up (#914 round 7).
    const cap = setInterval(() => {
      if (a.abortedBy !== null || Date.now() - this.heardAt(a) < this.capMs) return;
      a.abortedBy = "cap";
      a.ctrl.abort();
    }, this.requestTimeoutMs);
    const link = this.link;
    link.inFlight++;
    try {
      this.active();
      let res = await this.fetchWithRetry(url, init, a);
      if ((res.status === 401 || res.status === 403) && this.credentialSource) {
        this.active();
        res = await this.fetchWithRetry(url, init, a);
      }
      return res;
    } finally {
      clearInterval(cap);
      this.attempts.delete(a);
      link.inFlight--;
      if (a.inBody) link.bodies--;
    }
  }

  /** Fetch with exponential backoff + jitter on a transient failure, inside one attempt. */
  private async fetchWithRetry(
    url: string,
    init: Omit<RequestInit, "headers" | "signal">,
    a: Attempt,
  ): Promise<Response> {
    let lastError: Error | undefined;
    for (let retry = 0; retry <= this.maxRetries; retry++) {
      try {
        const res = await this.fetchOnce(url, init, a);
        if (res.ok || !isRetryable(res.status) || retry === this.maxRetries) return res;
        await backoffDelay(retry, this.retryBackoffMs);
      } catch (err: unknown) {
        if (a.abortedBy !== null) throw err; // ended on purpose: no retry
        lastError =
          err instanceof Error ? err : new Error("Network request failed", { cause: err });
        if (retry === this.maxRetries) break;
        await backoffDelay(retry, this.retryBackoffMs);
      }
    }
    throw lastError ?? new Error(`Request failed after ${this.maxRetries} retries: ${url}`);
  }

  /**
   * THE one place an abort is classified (#914 round 8): by the flag its
   * aborter set BEFORE calling `abort()` — never by `signal.reason`, which
   * React Native's AbortController (abort-controller@3.0.0) does not carry.
   * Null when the attempt was not aborted. Every path that ends an attempt
   * on an abort — the race in `fetchOnce`, its catch — throws what this
   * returns, and `request` reads only the error's class.
   */
  private abortError(a: Attempt, cause?: unknown): Error | null {
    const opts = cause === undefined ? undefined : { cause };
    switch (a.abortedBy) {
      case "owner":
        return new RequestAbortedError("sync request abandoned with its sync cycle", opts);
      case "cap":
        return new RequestTimeoutError(`sync request silent for ${this.capMs} ms`, opts);
      case "superseded":
        return new RequestSupersededError("sync request superseded", opts);
      case null:
        return null;
    }
  }

  /**
   * One fetch and its whole body. Progress (headers, each chunk) is recorded
   * on the attempt. An abort ends the race even for a fetch that ignores its
   * signal; why it was aborted is read from `a.abortedBy`.
   */
  private async fetchOnce(
    url: string,
    init: Omit<RequestInit, "headers" | "signal">,
    a: Attempt,
  ): Promise<Response> {
    let fire!: (err: Error) => void;
    const ended = new Promise<never>((_, reject) => (fire = reject));
    ended.catch(() => {});
    const onAbort = (): void => {
      fire(this.abortError(a) ?? new Error("sync request aborted"));
    };
    if (a.ctrl.signal.aborted) onAbort();
    a.ctrl.signal.addEventListener("abort", onAbort);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // The credential is inside the race too: a lookup that hangs ends with its attempt.
      const headers = await Promise.race([this.headers(), ended]);
      const r = await Promise.race([
        fetch(url, { ...init, headers, signal: a.ctrl.signal }),
        ended,
      ]);
      a.answered = true;
      if (!a.probe) this.link.answered = true;
      this.heard(a);
      const nullBody = [101, 204, 205, 304].includes(r.status);
      if (nullBody) {
        return new Response(null, {
          status: r.status,
          statusText: r.statusText,
          headers: r.headers,
        });
      }
      if (!r.body) {
        this.link.opaque = true;
        // React Native's fetch (whatwg-fetch) has no body stream: it
        // resolves only once the whole body arrived. Read it as TEXT
        // (whatwg-fetch's arrayBuffer() needs FileReader.readAsArrayBuffer,
        // which not every React Native build has; json() uses text()).
        const text = await Promise.race([r.text(), ended]);
        this.heard(a);
        return new Response(text, {
          status: r.status,
          statusText: r.statusText,
          headers: r.headers,
        });
      }
      if (!a.probe && !a.inBody) {
        a.inBody = true;
        this.link.bodies++;
      }
      reader = r.body.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), ended]);
        if (done) break;
        chunks.push(value);
        this.heard(a);
      }
      reader = undefined;
      let size = 0;
      for (const c of chunks) size += c.byteLength;
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      return new Response(bytes, {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
      });
    } catch (err: unknown) {
      if (reader) void reader.cancel().catch(() => {});
      throw this.abortError(a, err) ?? err;
    } finally {
      a.ctrl.signal.removeEventListener("abort", onAbort);
    }
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
