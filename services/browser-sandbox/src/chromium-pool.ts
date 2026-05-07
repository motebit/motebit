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
import type { Browser, BrowserContext, Page } from "playwright-core";

import { ServiceError } from "./errors.js";

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
   */
  async openSession(): Promise<BrowserSession> {
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
    });
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
   * Tear down a single session. Idempotent — closing an already-closed
   * session is a no-op (mirrors the dispatcher's idempotent dispose).
   */
  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    try {
      await s.context.close();
    } catch {
      // best-effort teardown; the entry is already removed from the map
    }
  }

  /**
   * Walk the session map and close everything older than the idle
   * threshold. Called from the boot-side reaper interval; exposed
   * publicly for deterministic tests.
   */
  async reapIdle(): Promise<void> {
    const cutoff = this.now() - this.config.idleMs;
    const expired: string[] = [];
    for (const [id, s] of this.sessions) {
      if (s.lastUsedAt < cutoff) expired.push(id);
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
