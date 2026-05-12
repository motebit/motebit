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

export class BrowserPool {
  private browser: Browser | null = null;
  private readonly sessions = new Map<string, BrowserSession>();
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
