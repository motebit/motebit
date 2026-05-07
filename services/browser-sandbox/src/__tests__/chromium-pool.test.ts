/**
 * `BrowserPool` unit tests — exercise the lifecycle (open / get /
 * touch / close / shutdown / reap) against a fake Browser. Real-
 * Playwright integration coverage lives behind a separate
 * `*.integration.test.ts` so the unit-test loop stays fast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";

import { BrowserPool } from "../chromium-pool.js";
import { ServiceError } from "../errors.js";

interface FakeBrowserState {
  contexts: Set<BrowserContext>;
  newContextCalls: Array<{ width: number; height: number }>;
  closed: boolean;
}

function makeFakeBrowser(): { browser: Browser; state: FakeBrowserState } {
  const state: FakeBrowserState = {
    contexts: new Set(),
    newContextCalls: [],
    closed: false,
  };
  const browser = {
    newContext: vi.fn(async (opts: { viewport: { width: number; height: number } }) => {
      state.newContextCalls.push(opts.viewport);
      const context: Partial<BrowserContext> = {
        newPage: vi.fn(async () => ({}) as unknown as Page),
        close: vi.fn(async () => {
          state.contexts.delete(context as BrowserContext);
        }),
      };
      state.contexts.add(context as BrowserContext);
      return context as BrowserContext;
    }),
    close: vi.fn(async () => {
      state.closed = true;
    }),
  } as unknown as Browser;
  return { browser, state };
}

const CONFIG = {
  maxConcurrent: 3,
  idleMs: 60_000,
  viewportWidth: 1280,
  viewportHeight: 800,
};

describe("BrowserPool", () => {
  let now = 1_000_000;
  let pool: BrowserPool;
  let fake: ReturnType<typeof makeFakeBrowser>;

  beforeEach(async () => {
    now = 1_000_000;
    fake = makeFakeBrowser();
    pool = new BrowserPool(CONFIG, { now: () => now });
    await pool.start(async () => fake.browser);
  });

  describe("openSession", () => {
    it("creates a new isolated context with the configured viewport", async () => {
      const session = await pool.openSession();
      expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(fake.state.newContextCalls).toEqual([{ width: 1280, height: 800 }]);
      expect(pool.size()).toBe(1);
    });

    it("each session is isolated (its own context)", async () => {
      await pool.openSession();
      await pool.openSession();
      expect(fake.state.contexts.size).toBe(2);
    });

    it("rejects with policy_denied at the concurrent cap", async () => {
      await pool.openSession();
      await pool.openSession();
      await pool.openSession();
      await expect(pool.openSession()).rejects.toMatchObject({
        name: "ServiceError",
        reason: "policy_denied",
      });
      expect(pool.size()).toBe(3);
    });

    it("rejects with platform_blocked when not started", async () => {
      const unstarted = new BrowserPool(CONFIG, { now: () => now });
      await expect(unstarted.openSession()).rejects.toMatchObject({
        name: "ServiceError",
        reason: "platform_blocked",
      });
    });
  });

  describe("getSession / touchSession", () => {
    it("returns null for unknown session id", () => {
      expect(pool.getSession("nope")).toBeNull();
    });

    it("touchSession bumps lastUsedAt", async () => {
      const session = await pool.openSession();
      const opened = session.lastUsedAt;
      now += 5000;
      pool.touchSession(session.sessionId);
      expect(session.lastUsedAt).toBe(opened + 5000);
    });

    it("touchSession on unknown id is a no-op", () => {
      expect(() => pool.touchSession("nope")).not.toThrow();
    });
  });

  describe("closeSession", () => {
    it("removes the session and closes its context", async () => {
      const session = await pool.openSession();
      await pool.closeSession(session.sessionId);
      expect(pool.size()).toBe(0);
      expect(fake.state.contexts.size).toBe(0);
    });

    it("is idempotent for already-closed session", async () => {
      const session = await pool.openSession();
      await pool.closeSession(session.sessionId);
      await expect(pool.closeSession(session.sessionId)).resolves.toBeUndefined();
    });
  });

  describe("reapIdle", () => {
    it("closes sessions older than idleMs", async () => {
      const fresh = await pool.openSession();
      now += 30_000;
      const stale = await pool.openSession();
      // Walk past the idle threshold of `fresh` but not `stale`.
      now += 40_000;
      await pool.reapIdle();
      expect(pool.getSession(fresh.sessionId)).toBeNull();
      expect(pool.getSession(stale.sessionId)).not.toBeNull();
    });

    it("does nothing when no sessions are idle", async () => {
      await pool.openSession();
      await pool.reapIdle();
      expect(pool.size()).toBe(1);
    });
  });

  describe("shutdown", () => {
    it("closes every session and the browser", async () => {
      await pool.openSession();
      await pool.openSession();
      await pool.shutdown();
      expect(pool.size()).toBe(0);
      expect(fake.state.closed).toBe(true);
    });

    it("subsequent openSession after shutdown rejects with platform_blocked", async () => {
      await pool.shutdown();
      await expect(pool.openSession()).rejects.toMatchObject({ reason: "platform_blocked" });
    });
  });
});

describe("ServiceError name marker", () => {
  it("sets a stable name (cross-realm safe)", () => {
    const err = new ServiceError("session_closed", "x");
    expect(err.name).toBe("ServiceError");
  });
});
