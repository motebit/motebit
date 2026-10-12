/**
 * RelaySession — one relay attempt, and the ONLY door to the relay.
 *
 * Relay OFF kept losing to in-flight work: a registration, a permission
 * prompt, a token fetch, a retry timer or a command reply that resumed after
 * OFF and touched the relay anyway. Guarding each await by hand missed one
 * every round. The degree of freedom removed here: relay work can only be
 * performed through a LIVE session object, and once the session is disposed
 * nothing it started can act.
 *
 *   - `fetch` / `run` / `token` reject once disposed (and `fetch` aborts any
 *     request still in flight), so a continuation that resumes after OFF
 *     throws instead of reaching the relay;
 *   - `setTimeout` / `setInterval` are owned — dispose cancels every one;
 *   - every relay adapter is BUILT on the session: its requests go through
 *     `fetch`, its credentials through `token` — never the global fetch,
 *     never a static token (an encrypting push resumes between its own
 *     awaits, past any check at its door);
 *   - `guard(obj)` additionally wraps an adapter so none of its methods can
 *     run (or hand back a result) after dispose;
 *   - `own(disposer)` hands the session every other handle (the WebSocket,
 *     delegation, the push lifecycle, engines) to release on dispose;
 *   - `status` is how the session reports; it says nothing once disposed.
 *
 * `dispose()` is synchronous: OFF disposes FIRST, then does its own (bounded,
 * fail-soft) cleanup with values captured beforehand.
 */

/** Thrown into every relay continuation that resumes after its session ended. */
export class RelaySessionDisposedError extends Error {
  constructor() {
    super("relay session ended (relay off or restarted)");
    this.name = "RelaySessionDisposedError";
  }
}

export function isRelaySessionDisposed(err: unknown): boolean {
  return err instanceof RelaySessionDisposedError;
}

/** The slice of a session that relay-touching collaborators (push) receive. */
export interface RelayChannel {
  readonly live: boolean;
  fetch: typeof fetch;
}

type Timer = ReturnType<typeof setTimeout>;

export class RelaySession<S extends string = string> implements RelayChannel {
  private _live = true;
  private readonly abort = new AbortController();
  private readonly timeouts = new Set<Timer>();
  private readonly intervals = new Set<ReturnType<typeof setInterval>>();
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly onStatus: (status: S) => void = () => {}) {}

  get live(): boolean {
    return this._live;
  }

  /** Aborted at dispose — hand it to anything that takes a signal. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  assertLive(): void {
    if (!this._live) throw new RelaySessionDisposedError();
  }

  /** Await `work`, then fail if the session ended meanwhile. */
  async run<T>(work: Promise<T> | (() => Promise<T>)): Promise<T> {
    this.assertLive();
    const value = await (typeof work === "function" ? work() : work);
    this.assertLive();
    return value;
  }

  /** A credential minter that mints nothing for a disposed session. */
  token<A extends unknown[]>(
    mint: (...args: A) => Promise<string>,
  ): (...args: A) => Promise<string> {
    return (...args: A) => this.run(() => mint(...args));
  }

  /** The session's fetch: refused once disposed, aborted by dispose. */
  readonly fetch: typeof fetch = (input, init) => {
    if (!this._live) return Promise.reject(new RelaySessionDisposedError());
    const ctl = new AbortController();
    const onAbort = (): void => ctl.abort();
    this.abort.signal.addEventListener("abort", onAbort);
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) ctl.abort();
      else outer.addEventListener("abort", onAbort);
    }
    return fetch(input, { ...init, signal: ctl.signal })
      .then((res) => {
        this.assertLive();
        return res;
      })
      .finally(() => {
        this.abort.signal.removeEventListener("abort", onAbort);
        outer?.removeEventListener("abort", onAbort);
      });
  };

  /** An owned timeout: cancelled by dispose, never fires after it. Returns its cancel. */
  setTimeout(fn: () => void, ms: number): () => void {
    if (!this._live) return () => {};
    const t: Timer = setTimeout(() => {
      this.timeouts.delete(t);
      if (this._live) fn();
    }, ms);
    this.timeouts.add(t);
    return () => {
      clearTimeout(t);
      this.timeouts.delete(t);
    };
  }

  /** An owned interval: cancelled by dispose, never fires after it. */
  setInterval(fn: () => void, ms: number): void {
    if (!this._live) return;
    const t = setInterval(() => {
      if (this._live) fn();
    }, ms);
    this.intervals.add(t);
  }

  /** Released at dispose (immediately when already disposed). */
  own(disposer: () => void): void {
    if (!this._live) {
      safely(disposer);
      return;
    }
    this.disposers.push(disposer);
  }

  /**
   * `target` with every method gated on this session: a call after dispose
   * never reaches it and gets a rejected promise, and a result that arrives
   * after dispose is refused. Never a synchronous throw: library timers (the
   * sync engine's stall watchdog asks `hasLiveWork()`) call adapter methods
   * after OFF, and a throw there is an uncaught exception, not a refusal.
   *
   * Defense in depth only: the adapters' own I/O goes through `fetch` and
   * `token` — the guard is not what keeps a request from leaving.
   */
  guard<T extends object>(target: T): T {
    return new Proxy(target, {
      get: (obj, prop) => {
        const value: unknown = Reflect.get(obj, prop, obj);
        if (typeof value !== "function") return value;
        return (...args: unknown[]): unknown => {
          if (!this._live) return refused();
          const out: unknown = (value as (...a: unknown[]) => unknown).apply(obj, args);
          if (out instanceof Promise) {
            return out.then((v: unknown) => {
              this.assertLive();
              return v;
            });
          }
          return out;
        };
      },
    });
  }

  /** Report a status — silent once disposed. */
  status(status: S): void {
    if (this._live) this.onStatus(status);
  }

  /**
   * End the session, synchronously: aborts in-flight fetches, cancels every
   * timer, releases every owned handle (last owned, first released).
   */
  dispose(): void {
    if (!this._live) return;
    this._live = false;
    this.abort.abort();
    for (const t of this.timeouts) clearTimeout(t);
    this.timeouts.clear();
    for (const t of this.intervals) clearInterval(t);
    this.intervals.clear();
    for (const d of this.disposers.splice(0).reverse()) safely(d);
  }
}

/** A disposed-session refusal no caller is obliged to observe. */
function refused(): Promise<never> {
  const p = Promise.reject(new RelaySessionDisposedError());
  p.catch(() => {});
  return p;
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch (err: unknown) {
    // eslint-disable-next-line no-console -- a failed release never blocks the rest of OFF
    console.warn("[relay] release failed:", err instanceof Error ? err.message : String(err));
  }
}
