/**
 * Anchor-submit pacing — how fast the relay's anchoring streams may spend RPC.
 *
 * Every anchoring stream (federation settlement, agent settlement, credential,
 * identity-log, transparency, revocation) writes through ONE shared
 * `ChainAnchorSubmitter`, and each memo is a full sign/submit path against the
 * RPC (blockhash, preflight simulation, send, confirm). Before this module every
 * loop retried its WHOLE backlog of signed-but-unsubmitted anchors on every
 * tick. Against a rate-limited RPC that is a 429 storm in which nothing lands
 * and which repeats every cycle (staging, 2026-10-05: ~47 identity-log submits
 * in ~1-2 s); against an unfunded fee payer it is one guaranteed-failing round
 * trip per anchor, every cycle, with no circuit.
 *
 * The contract (pacing only — WHAT is anchored, and in what order, is unchanged):
 *
 *   1. **Serial, capped.** Submits through one submitter are serialized (one in
 *      flight across all streams), and one stream makes at most
 *      `maxSubmitsPerCycle` attempts per tick. A backlog drains oldest-first over
 *      successive ticks; nothing is dropped, skipped or reordered.
 *   2. **Rate-limited / unavailable ⇒ stop and back off.** A 429 or an RPC
 *      reachability error ends the cycle at that anchor and opens a backoff
 *      shared by every stream on the submitter: exponential from `baseBackoffMs`,
 *      jittered into [½·d, d], capped at `maxBackoffMs`. While it holds, no
 *      stream touches the RPC. When it lapses the next attempt is the probe.
 *   3. **Deterministic ⇒ one attempt, one warning.** An error that will fail for
 *      every anchor (unfunded fee payer, network-label mismatch) ends the cycle
 *      after that single attempt with ONE structured warning and holds every
 *      stream for `deterministicHoldMs` (less than one loop tick), so the next
 *      cycle retries once.
 *   4. Any other error is per-anchor: logged by the stream, the cycle continues
 *      (bounded by the cap).
 *
 * State is per submitter object (a WeakMap), so every stream handed the same
 * submitter shares one backoff with no wiring, and a fresh submitter (a test)
 * starts clean. In-memory by design: a restart starts closed and the first
 * failing attempt re-opens it.
 *
 * Not `@motebit/circuit-breaker`: that engine is per-peer with a FIXED reset
 * timeout and a failure-count threshold; this is one shared RPC whose first 429
 * must stop the cycle and whose backoff must grow across cycles.
 */

import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "anchor-submit-pacing" });

/** How a submit failure affects the rest of the cycle. */
export type AnchorSubmitErrorClass =
  /** RPC said slow down (HTTP 429 / rate limit). Back off exponentially. */
  | "rate_limited"
  /** RPC unreachable / 5xx / timed out before sending. Back off exponentially. */
  | "unavailable"
  /** Will fail for every anchor until an operator acts. One attempt per cycle. */
  | "deterministic"
  /** Anything else — specific to this anchor/attempt; the cycle continues. */
  | "other";

const NETWORK_UNRESOLVED = /refuses to write: the rpc's network is unknown/i;
const RATE_LIMITED = /\b429\b|too many requests|rate[ -]?limit/i;
const DETERMINISTIC =
  /no record of a prior credit|insufficient (funds|lamports)|insufficientfunds|insufficient funds for (fee|rent)|refuses to write: the network|refuses to write: declared network .* but the rpc serves|disagrees with|network mismatch/i;
const UNAVAILABLE =
  /fetch failed|econnrefused|econnreset|etimedout|enotfound|eai_again|socket hang up|network ?error|\b50[234]\b|service unavailable|bad gateway|gateway time-?out|failed to get recent blockhash/i;

/** Classify a submit error by its message (the web3 client's errors are strings). */
export function classifyAnchorSubmitError(err: unknown): AnchorSubmitErrorClass {
  const msg = err instanceof Error ? err.message : String(err);
  // The submitter refused before writing because the network-id read failed.
  // That read has its own supervised, time-bounded retry (`solana-network`
  // loop, rule 27) and must heal anchoring without waiting out a backoff.
  if (NETWORK_UNRESOLVED.test(msg)) return "other";
  if (RATE_LIMITED.test(msg)) return "rate_limited";
  if (DETERMINISTIC.test(msg)) return "deterministic";
  if (UNAVAILABLE.test(msg)) return "unavailable";
  return "other";
}

/** Thrown, without touching the RPC, while the shared backoff holds. */
export class AnchorSubmitDeferredError extends Error {
  constructor(readonly retryAt: number) {
    super(`anchor submission deferred: RPC backoff until ${new Date(retryAt).toISOString()}`);
    this.name = "AnchorSubmitDeferredError";
  }
}

export interface AnchorSubmitPacerOptions {
  /** First backoff after a rate-limit/unavailable error. Default 60 s (one loop tick). */
  baseBackoffMs?: number;
  /** Ceiling on any backoff. Default 30 min. */
  maxBackoffMs?: number;
  /** Hold after a deterministic error. Default 50 s — under one 60 s tick, so the next cycle retries. */
  deterministicHoldMs?: number;
  /** Attempts one stream may make per cycle. Default 5. */
  maxSubmitsPerCycle?: number;
  now?: () => number;
  /** Uniform [0,1) source for jitter. */
  random?: () => number;
}

export class AnchorSubmitPacer {
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly deterministicHoldMs: number;
  readonly maxSubmitsPerCycle: number;
  private readonly now: () => number;
  private readonly random: () => number;

  private blockedUntil = 0;
  private consecutiveBackoffs = 0;
  /** Serializes submits across every stream sharing the submitter. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Errors this pacer already logged — the stream does not log them again. */
  private readonly reported = new WeakSet<object>();
  /** Per-anchor submits queued or in flight, keyed `stream\0id` (single-flight). */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(opts: AnchorSubmitPacerOptions = {}) {
    this.baseBackoffMs = opts.baseBackoffMs ?? 60_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30 * 60_000;
    this.deterministicHoldMs = opts.deterministicHoldMs ?? 50_000;
    this.maxSubmitsPerCycle = opts.maxSubmitsPerCycle ?? 5;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
  }

  /** True when no backoff holds — a stream may attempt a submit now. */
  canAttempt(): boolean {
    return this.now() >= this.blockedUntil;
  }

  /** When the current hold lapses (0 when none has been set). */
  get retryAt(): number {
    return this.blockedUntil;
  }

  /** Whether this error was already logged by the pacer (the stream should not re-log it). */
  wasReported(err: unknown): boolean {
    return typeof err === "object" && err !== null && this.reported.has(err);
  }

  /**
   * Run one RPC submit under the pacing contract: serialized, refused without
   * an RPC call while a hold applies (`gate`), outcome recorded. `gate: false`
   * is for one-shot urgent writes (revocation) that must not be deferred: they
   * still serialize and still feed the backoff.
   */
  async submit<T>(
    stream: string,
    subject: string,
    fn: () => Promise<T>,
    opts: { gate?: boolean } = {},
  ): Promise<T> {
    const out = await this.enqueue(stream, subject, fn, opts.gate ?? true, null);
    return (out as { result: T }).result;
  }

  /**
   * Run one anchor's RPC submit exactly once. The anchoring loops read their
   * `status = 'signed'` backlog BEFORE waiting in the serial chain, and a tick
   * can start while the previous one is still draining, so the same row can
   * reach here more than once. Two guards, both at the executor:
   *
   *   - `stillPending` is re-read inside the chain, immediately before the RPC
   *     call; a row another submit already landed makes no call
   *     (`{ submitted: false }`) and records nothing on the backoff.
   *   - single-flight per `(stream, id)`: a second caller while one is queued or
   *     in flight joins it instead of enqueueing another copy (`run` includes
   *     the caller's own row update, so once the key is released the row is
   *     already confirmed and every later read sees it).
   */
  submitOnce<R>(stream: string, id: string, run: () => Promise<R>): Promise<R> {
    const key = `${stream}\0${id}`;
    const held = this.inFlight.get(key);
    if (held) return held as Promise<R>;
    const p = run().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
    return p;
  }

  /** Paced submit that first re-checks, inside the serial chain, that the anchor is still unsubmitted. */
  async submitIfPending<T>(
    stream: string,
    subject: string,
    stillPending: () => boolean,
    fn: () => Promise<T>,
  ): Promise<{ submitted: true; result: T } | { submitted: false }> {
    return this.enqueue(stream, subject, fn, true, stillPending);
  }

  private enqueue<T>(
    stream: string,
    subject: string,
    fn: () => Promise<T>,
    gate: boolean,
    stillPending: (() => boolean) | null,
  ): Promise<{ submitted: true; result: T } | { submitted: false }> {
    const run = async (): Promise<{ submitted: true; result: T } | { submitted: false }> => {
      if (stillPending && !stillPending()) return { submitted: false };
      if (gate && !this.canAttempt()) throw new AnchorSubmitDeferredError(this.blockedUntil);
      try {
        const result = await fn();
        this.recordSuccess();
        return { submitted: true, result };
      } catch (err: unknown) {
        this.recordFailure(stream, subject, err);
        throw err;
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private recordSuccess(): void {
    if (this.consecutiveBackoffs > 0) {
      logger.info("anchoring.submit_recovered", { after_backoffs: this.consecutiveBackoffs });
    }
    this.consecutiveBackoffs = 0;
    this.blockedUntil = 0;
  }

  private recordFailure(stream: string, subject: string, err: unknown): void {
    const cls = classifyAnchorSubmitError(err);
    if (cls === "other") return;
    const now = this.now();
    const error = err instanceof Error ? err.message : String(err);
    if (cls === "deterministic") {
      this.blockedUntil = now + this.deterministicHoldMs;
      logger.warn("anchoring.submit_blocked", {
        reason: cls,
        stream,
        subject,
        error,
        retry_at: this.blockedUntil,
      });
    } else {
      this.consecutiveBackoffs++;
      const exp = Math.min(
        this.maxBackoffMs,
        this.baseBackoffMs * 2 ** Math.min(this.consecutiveBackoffs - 1, 30),
      );
      const delay = Math.max(1, Math.round(exp * (0.5 + 0.5 * this.random())));
      this.blockedUntil = now + delay;
      logger.warn("anchoring.submit_backoff", {
        reason: cls,
        stream,
        subject,
        error,
        consecutive: this.consecutiveBackoffs,
        backoff_ms: delay,
        retry_at: this.blockedUntil,
      });
    }
    if (typeof err === "object" && err !== null) this.reported.add(err);
  }
}

const pacers = new WeakMap<object, AnchorSubmitPacer>();

/** The pacer shared by every stream writing through `submitter`. */
export function anchorSubmitPacerFor(submitter: object): AnchorSubmitPacer {
  let p = pacers.get(submitter);
  if (!p) {
    p = new AnchorSubmitPacer();
    pacers.set(submitter, p);
  }
  return p;
}

/** Install a configured pacer for a submitter (tests, or non-default tuning at boot). */
export function setAnchorSubmitPacer(submitter: object, pacer: AnchorSubmitPacer): void {
  pacers.set(submitter, pacer);
}

/**
 * True when a stream should NOT write its own per-anchor warning for this
 * error: a deferral (no RPC call was made) or an error the pacer already
 * logged as the cycle's one structured warning.
 */
export function anchorSubmitErrorIsQuiet(submitter: object, err: unknown): boolean {
  return (
    err instanceof AnchorSubmitDeferredError || anchorSubmitPacerFor(submitter).wasReported(err)
  );
}

/**
 * Drain one stream's backlog for this cycle: serially, in the given order
 * (callers pass oldest first), at most `maxSubmitsPerCycle` attempts, stopping
 * as soon as the shared hold applies (a rate-limit / unavailable / deterministic
 * failure — by this stream or a sibling). `submitOne` is the stream's own
 * idempotent submit (it records the outcome on the row); untried ids stay
 * pending for a later cycle. `alreadyAttempted` carries attempts this stream
 * made earlier in the same cycle, so two drains in one tick share one cap.
 */
export async function drainAnchorBacklog(
  submitter: object,
  ids: readonly string[],
  submitOne: (id: string) => Promise<unknown>,
  alreadyAttempted = 0,
): Promise<{ attempted: number }> {
  const pacer = anchorSubmitPacerFor(submitter);
  let attempted = alreadyAttempted;
  for (const id of ids) {
    if (attempted >= pacer.maxSubmitsPerCycle) break;
    if (!pacer.canAttempt()) break;
    attempted++;
    await submitOne(id);
  }
  return { attempted };
}
