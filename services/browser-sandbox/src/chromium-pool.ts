/**
 * Chromium session pool — Playwright lifecycle for browser-sandbox.
 *
 * Owns the singleton `Browser` instance + a per-session `BrowserContext`
 * + `Page`. Each session is fully isolated from every other (separate
 * cookie jar, separate localStorage, separate origin storage) — that's
 * the *isolated* in `EMBODIMENT_MODE_CONTRACTS.virtual_browser.source =
 * "isolated-browser"`.
 *
 * Why a `BrowserContext` per session and not a single context with
 * multiple pages: contexts are Playwright's isolation boundary; pages
 * inside the same context share storage. One motebit's cookies leaking
 * into another's session would break the sovereign-floor invariant.
 *
 * v1 limits:
 *   - One page per session (one tab). Multi-tab is a future contract
 *     extension; the wire format already keys by `session_id` so the
 *     graduation is additive.
 *   - Hard cap on concurrent sessions across all callers (config-
 *     driven). Enforced at `openSession` time with `policy_denied`.
 *   - Idle reaper closes contexts whose `lastUsedAt` is older than the
 *     idle threshold — frees Chromium memory if a motebit forgets to
 *     `dispose`. The dispatcher's `dispose` path is the happy case.
 *
 * The browser launcher is injected (`launchBrowser` callback) so tests
 * can pass a mock — real-Playwright integration tests + unit-level
 * tests share the same pool implementation.
 */

import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Cookie, Page } from "playwright-core";

import { ServiceError } from "./errors.js";

/**
 * Persistent-cookies wire shape — what crosses the sandbox→dispatcher
 * HTTP boundary on session open + dispose. Phase 1 of the persistent
 * `user_data_dir` arc (`docs/doctrine/runtime-invariants-over-prompt-
 * rules.md` applied to the cloud-browser surface): cookies-only —
 * the load-bearing primitive for accumulated browsing trust (Google
 * CAPTCHA reputation, logged-in account state, session cookies all
 * live here). Phase 2 expands to full user-data-dir if a real
 * consumer needs it; Phase 3 adds the `/cookies grant` consent gate
 * + encryption at rest.
 *
 * Shape is Playwright's `Cookie` — already JSON-serializable so the
 * wire is straight passthrough. The dispatcher treats cookies as
 * opaque blobs; only the sandbox parses them into Playwright's
 * `BrowserContext.addCookies` / `BrowserContext.cookies` calls.
 */
export type PersistentCookie = Cookie;

export interface BrowserSession {
  readonly sessionId: string;
  /**
   * The motebit identity that owns this session, when the caller
   * authenticated with a relay-signed token (`auth.ts` sets
   * `c.var.motebitId` from the verified `mid` claim). `null` when the
   * caller used the legacy shared bearer (admin/test tooling) — those
   * sessions remain anonymous and are NOT identity-keyed for reuse.
   *
   * Set by `ensureSession`; never mutated after creation. Read by
   * `closeSession` + `reapIdle` to remove the reverse-index entry on
   * teardown so the next `ensureSession` for this motebit allocates
   * fresh.
   */
  readonly motebitId: string | null;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly openedAt: number;
  /** Updated on every action — the idle reaper reads this. */
  lastUsedAt: number;
  /**
   * Cursor coordinates the executor maintains client-side. Playwright
   * does not expose a server-side cursor read; tracking the last
   * pointer destination keeps the `cursor_position` action faithful.
   */
  lastCursorX: number;
  lastCursorY: number;
  /**
   * In-flight action count. Incremented by `beginAction`, decremented
   * in `endAction`'s `finally`. The idle reaper skips sessions with
   * `inFlight > 0` so a slow action whose runtime exceeds the idle
   * window is not torn down mid-execution. Practical mitigation for
   * the touch-then-execute race: `touchSession` updates `lastUsedAt`
   * before the action runs, but if the action takes longer than
   * `idleMs` the reaper would otherwise close the context the
   * executor is still using.
   */
  inFlight: number;
  /**
   * v1.3 — disposer for an active CDP screencast on this session, or
   * null when no consumer is currently streaming. The screencast
   * route sets this on attach and clears it on detach; `closeSession`
   * runs the disposer first so the CDP session is torn down before
   * the BrowserContext is closed (closing the context first leaves
   * the CDP attempt to `Page.stopScreencast` racing with the
   * teardown — best-effort either way, but tearing the screencast
   * down explicitly first avoids spurious teardown errors).
   */
  stopScreencast: (() => Promise<void>) | null;
}

export interface BrowserPoolConfig {
  readonly maxConcurrent: number;
  readonly idleMs: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/**
 * Time source — injectable for deterministic tests of the idle reaper.
 */
export interface BrowserPoolDeps {
  readonly now?: () => number;
}

/**
 * Liveness probe for a cached session. Returns false when the session's
 * page is observably closed; true otherwise (including when the
 * `isClosed` method is unavailable, for fake-browser tests). Defensive
 * — designed to fail OPEN (treat unknown as alive) rather than closed,
 * because a false-negative ("session is dead, allocate fresh") leaks a
 * Chromium context but a false-positive ("session is alive, return it")
 * surfaces immediately on the next action and the caller can recover.
 *
 * The next-action surface for a dead session is `ServiceError(
 * "session_closed", …)` from the route layer's `getSession` lookup
 * (see `routes.ts:/sessions/:id/actions`); the dispatcher already maps
 * that to a clean recovery path in `CloudBrowserDispatcher`.
 */
function isSessionAlive(s: BrowserSession): boolean {
  // Page-level liveness: Playwright's `Page.isClosed()` returns true
  // when the page has been closed (navigation panic, manual close).
  // Optional-chain handles fake-browser pages without the method.
  try {
    const closed = (s.page as { isClosed?: () => boolean }).isClosed?.();
    if (closed === true) return false;
  } catch {
    // If the probe itself throws, the underlying object is in an
    // unhappy state — treat as dead and let the caller allocate fresh.
    return false;
  }
  return true;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private readonly sessions = new Map<string, BrowserSession>();
  /**
   * Reverse index: motebit identity → active session id. The load-
   * bearing primitive for identity-keyed session reuse — `ensureSession`
   * checks this before allocating, returning the existing session when
   * present so a single motebit reloading the page / opening multiple
   * tabs / restarting the dev server doesn't multiply Chromium contexts
   * against the `maxConcurrent` cap. The cap thus measures concurrent
   * MOTEBITS-per-machine, not concurrent TABS-per-machine.
   *
   * Doctrine: "Persistent sovereign identity — a cryptographic entity
   * across time and devices, not a session token" (`CLAUDE.md`).
   * Identity is the foundational primitive; session id is an internal
   * handle. Allocation by `randomUUID` first + identity decorative is
   * the inversion this index corrects.
   */
  private readonly sessionByMotebit = new Map<string, string>();
  /**
   * In-flight allocations indexed by motebit identity. Two simultaneous
   * `ensureSession` calls for the same motebit on a fresh-process
   * scenario both miss the cache; without this lock both call
   * `openSession`, both allocate Chromium contexts, the second's
   * `sessionByMotebit.set` clobbers the first → orphan session leaked
   * immediately to the 10-minute reaper. The lock dedupes the in-flight
   * promise: second caller awaits the first's allocation and gets the
   * same session.
   */
  private readonly inFlightByMotebit = new Map<string, Promise<BrowserSession>>();
  private readonly config: BrowserPoolConfig;
  private readonly now: () => number;

  constructor(config: BrowserPoolConfig, deps: BrowserPoolDeps = {}) {
    this.config = config;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Launch the underlying browser. Caller supplies the launcher so
   * tests inject a mock and prod injects `chromium.launch`.
   */
  async start(launchBrowser: () => Promise<Browser>): Promise<void> {
    if (this.browser !== null) return;
    this.browser = await launchBrowser();
  }

  /**
   * Allocate a new isolated session. Throws `policy_denied` when the
   * concurrent-session cap is reached — that surfaces to the
   * dispatcher as 429 → `ComputerFailureReason.policy_denied`.
   *
   * Phase 1 cookie persistence: when `opts.initialCookies` is
   * supplied, the new context's cookie jar is seeded from it via
   * `context.addCookies` BEFORE the first page navigates. The
   * caller (dispatcher) supplies cookies the runtime has persisted
   * from a prior session's close response — the load-bearing
   * primitive for "accumulated browsing trust." Without cookies,
   * the context starts empty (current behavior, fail-soft).
   */
  async openSession(
    opts: {
      readonly initialCookies?: readonly PersistentCookie[];
      /**
       * Identity to attribute this session to. When non-null, the
       * caller is responsible for keeping the `sessionByMotebit` index
       * coherent — in practice that means `openSession` is called via
       * `ensureSession` for the relay-signed path. Direct callers of
       * `openSession` (legacy bearer / admin tooling) leave this null
       * and the session stays anonymous.
       */
      readonly motebitId?: string | null;
    } = {},
  ): Promise<BrowserSession> {
    if (this.browser === null) {
      throw new ServiceError("platform_blocked", "BrowserPool not started");
    }
    if (this.sessions.size >= this.config.maxConcurrent) {
      throw new ServiceError(
        "policy_denied",
        `concurrent session cap reached (${this.config.maxConcurrent})`,
      );
    }
    const context = await this.browser.newContext({
      viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
      // Quality-of-baseline browser fingerprint — pairs with the
      // stealth plugin applied at index.ts module load. Default
      // Chromium leaks `HeadlessChrome/...` in the user-agent;
      // replacing it with a current Chrome UA is the single most
      // commonly-checked signal. Linux UA chosen to match the actual
      // Fly runtime so OS-claimed-by-UA stays consistent with other
      // OS-fingerprint signals (font lists, WebGL renderer). Locale
      // + timezone supplied for the same consistency reason. None of
      // this defeats determined bot detection; it removes the most
      // obvious tells.
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
    });
    // Seed the cookie jar from persisted cookies (Phase 1). Best-
    // effort: a malformed cookie shouldn't break session creation —
    // log and continue. Real-world cookies from prior Playwright
    // sessions are always well-formed since they came from
    // `context.cookies()` originally.
    if (opts.initialCookies && opts.initialCookies.length > 0) {
      try {
        await context.addCookies(opts.initialCookies as Cookie[]);
      } catch {
        // Best-effort seed; if Playwright rejects (e.g., an expired
        // cookie has shifted format), the session still opens. The
        // accumulated-trust property degrades to "no cookies this
        // session" rather than "session can't open."
      }
    }
    const page = await context.newPage();
    const sessionId = randomUUID();
    const opened = this.now();
    const session: BrowserSession = {
      sessionId,
      motebitId: opts.motebitId ?? null,
      context,
      page,
      openedAt: opened,
      lastUsedAt: opened,
      lastCursorX: 0,
      lastCursorY: 0,
      inFlight: 0,
      stopScreencast: null,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Identity-keyed session reuse. Returns the existing session for the
   * given motebit identity if one exists and is alive; allocates a
   * fresh session via `openSession` otherwise. The load-bearing fix
   * for the "page reload allocates a fresh Chromium context" leak
   * class — the same motebit reloading / opening tabs / restarting
   * the dev server reuses one session instead of multiplying them
   * against the `maxConcurrent` cap.
   *
   * Three correctness gotchas, each addressed:
   *
   *   1. Concurrent-ensure race. Two simultaneous calls for the same
   *      motebit on a fresh process both miss the cache → both call
   *      `openSession` → both allocate Chromium contexts → second
   *      `sessionByMotebit.set` clobbers the first → orphan leaked.
   *      The `inFlightByMotebit` lock dedupes: second caller awaits
   *      the first's allocation promise and receives the same
   *      session.
   *
   *   2. Stale entry. A cached session whose underlying `BrowserContext`
   *      crashed (Chromium OOM, page navigation panic) leaves the
   *      session entry in the map while the context is unusable. The
   *      liveness probe (`page.isClosed()`) catches the
   *      common cases; fall through to fresh allocation when dead.
   *      Defensive against missing `isClosed` in fake-browser tests
   *      (treats absent method as alive).
   *
   *   3. Index-storage coherence. `closeSession` reads `session.motebitId`
   *      and removes the reverse-index entry; `reapIdle` calls
   *      `closeSession` so the same cleanup runs there. Without this,
   *      the next `ensureSession` for the motebit would return a
   *      stale id that no longer exists in `this.sessions`, falling
   *      through to `getSession === null` and allocating fresh anyway
   *      — correct outcome, but the index would accumulate dangling
   *      entries.
   *
   * Direct `openSession` callers (legacy bearer / admin tooling) keep
   * the anonymous-allocation path unchanged. This is dualAuth applied
   * to allocation: relay-signed → identity-keyed dedup; legacy bearer
   * → fresh-every-call.
   */
  async ensureSession(opts: {
    readonly motebitId: string;
    readonly initialCookies?: readonly PersistentCookie[];
  }): Promise<BrowserSession> {
    const { motebitId } = opts;

    // Race-protection: if an allocation for this motebit is already
    // in flight, await it instead of starting a second.
    const pending = this.inFlightByMotebit.get(motebitId);
    if (pending) return pending;

    // Cache hit path. Verify the session is alive before returning —
    // an entry whose `BrowserContext` crashed since last use must
    // fall through to fresh allocation.
    const existingId = this.sessionByMotebit.get(motebitId);
    if (existingId !== undefined) {
      const existing = this.sessions.get(existingId);
      if (existing && isSessionAlive(existing)) {
        existing.lastUsedAt = this.now();
        return existing;
      }
      // Stale entry — index points to a session that's gone or dead.
      // Clear the index and fall through to fresh allocation. (If the
      // session entry existed but the context is dead, leave the
      // session map entry alone — `closeSession` ownership; we only
      // own the reverse index.)
      this.sessionByMotebit.delete(motebitId);
    }

    // Fresh allocation behind the in-flight lock. Use a Promise.resolve
    // wrapper so the lock is set BEFORE the openSession await yields
    // — concurrent callers that arrive during the await observe the
    // lock and join.
    const allocation = (async () => {
      try {
        const session = await this.openSession({
          initialCookies: opts.initialCookies,
          motebitId,
        });
        this.sessionByMotebit.set(motebitId, session.sessionId);
        return session;
      } finally {
        this.inFlightByMotebit.delete(motebitId);
      }
    })();
    this.inFlightByMotebit.set(motebitId, allocation);
    return allocation;
  }

  /** Direct lookup. `null` if absent — caller maps to `session_closed`. */
  getSession(sessionId: string): BrowserSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Mark a session as just-used so the idle reaper doesn't reap it. */
  touchSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastUsedAt = this.now();
  }

  /**
   * Mark the start of an action against a session. The route handler
   * MUST pair this with `endAction` in a `finally` block so the
   * counter returns to zero even when `executeAction` throws.
   */
  beginAction(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.inFlight += 1;
  }

  /**
   * Mark the end of an action. Idempotent at zero — a decrement on a
   * counter that's already zero stays at zero (defensive against a
   * caller pairing wrong, though the gate test exercises the
   * happy-path discipline).
   */
  endAction(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s && s.inFlight > 0) s.inFlight -= 1;
  }

  /**
   * Tear down a single session. Idempotent — closing an already-closed
   * session is a no-op (mirrors the dispatcher's idempotent dispose).
   *
   * Phase 1 cookie persistence: BEFORE `context.close()`, captures the
   * final cookie-jar state via `context.cookies()` and returns it.
   * The caller (route handler) puts the cookies in the DELETE
   * response so the dispatcher can persist them. Returns an empty
   * array when the session is unknown or when cookie extraction
   * fails — the latter is best-effort, fail-soft (a teardown should
   * not block on cookie-export errors).
   */
  async closeSession(sessionId: string): Promise<PersistentCookie[]> {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    this.sessions.delete(sessionId);
    // Index coherence: if this session was identity-attributed, drop
    // the reverse index entry so the next `ensureSession` for the
    // motebit allocates fresh instead of returning a dead id.
    // Defensive against multi-session-per-motebit interleavings (which
    // the lock prevents but the type system doesn't enforce): only
    // delete when the index actually points to THIS session id.
    if (s.motebitId !== null) {
      const indexed = this.sessionByMotebit.get(s.motebitId);
      if (indexed === sessionId) {
        this.sessionByMotebit.delete(s.motebitId);
      }
    }
    // v1.3 — stop the CDP screencast (if any) before tearing down the
    // BrowserContext, so the screencast disposer runs against a still-
    // attached CDP session instead of racing context teardown.
    if (s.stopScreencast) {
      try {
        await s.stopScreencast();
      } catch {
        // Best-effort. Already on the close path; the context teardown
        // below will collect any residue.
      }
    }
    // Capture cookies BEFORE closing the context — once closed, the
    // cookie API throws. Best-effort: a failed export returns []
    // and the caller persists empty (semantically: no accumulated
    // state to carry forward this session).
    let cookies: PersistentCookie[] = [];
    try {
      cookies = await s.context.cookies();
    } catch {
      // Fall through — empty cookies is honest.
    }
    try {
      await s.context.close();
    } catch {
      // best-effort teardown; the entry is already removed from the map
    }
    return cookies;
  }

  /**
   * Walk the session map and close everything older than the idle
   * threshold AND with no in-flight actions. Called from the
   * boot-side reaper interval; exposed publicly for deterministic
   * tests. Sessions with `inFlight > 0` are deliberately spared even
   * if their `lastUsedAt` is past the cutoff — `touchSession` runs
   * before `executeAction`, so a slow action whose runtime exceeds
   * the idle window would otherwise have its context torn down
   * mid-execution.
   */
  async reapIdle(): Promise<void> {
    const cutoff = this.now() - this.config.idleMs;
    const expired: string[] = [];
    for (const [id, s] of this.sessions) {
      if (s.lastUsedAt < cutoff && s.inFlight === 0) expired.push(id);
    }
    await Promise.all(expired.map((id) => this.closeSession(id)));
  }

  /**
   * Close every session and the browser itself. Called on
   * SIGINT/SIGTERM from `index.ts`.
   */
  async shutdown(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.closeSession(id)));
    if (this.browser !== null) {
      try {
        await this.browser.close();
      } catch {
        // ignore — we're shutting down anyway
      }
      this.browser = null;
    }
  }

  /** Test helper — current session count. */
  size(): number {
    return this.sessions.size;
  }
}
