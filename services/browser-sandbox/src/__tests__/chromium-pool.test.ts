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

    it("is idempotent for already-closed session — returns [] cookies (Phase 1)", async () => {
      const session = await pool.openSession();
      await pool.closeSession(session.sessionId);
      // Phase 1 cookie persistence: closeSession returns the final
      // cookie jar before tearing down. On an already-closed (or
      // unknown) session there's nothing to extract; returns [].
      await expect(pool.closeSession(session.sessionId)).resolves.toEqual([]);
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

    it("does NOT reap a session with an in-flight action", async () => {
      const session = await pool.openSession();
      pool.beginAction(session.sessionId);
      // Walk past the idle threshold while the action is still running.
      now += 90_000;
      await pool.reapIdle();
      expect(pool.getSession(session.sessionId)).not.toBeNull();
      expect(session.inFlight).toBe(1);
    });

    it("reaps after the in-flight action completes and the idle window passes", async () => {
      const session = await pool.openSession();
      pool.beginAction(session.sessionId);
      now += 90_000;
      pool.endAction(session.sessionId);
      // `lastUsedAt` was set at openSession (still 1_000_000); the
      // session is past the 60_000 idle cutoff and now has 0 in-flight.
      await pool.reapIdle();
      expect(pool.getSession(session.sessionId)).toBeNull();
    });

    it("respects nested in-flight counts (concurrent actions on the same session)", async () => {
      const session = await pool.openSession();
      pool.beginAction(session.sessionId);
      pool.beginAction(session.sessionId);
      expect(session.inFlight).toBe(2);
      now += 90_000;
      await pool.reapIdle();
      expect(pool.getSession(session.sessionId)).not.toBeNull();
      pool.endAction(session.sessionId);
      expect(session.inFlight).toBe(1);
      await pool.reapIdle();
      expect(pool.getSession(session.sessionId)).not.toBeNull();
      pool.endAction(session.sessionId);
      expect(session.inFlight).toBe(0);
      await pool.reapIdle();
      expect(pool.getSession(session.sessionId)).toBeNull();
    });
  });

  describe("beginAction / endAction", () => {
    it("endAction is a no-op on a counter already at zero", async () => {
      const session = await pool.openSession();
      pool.endAction(session.sessionId);
      expect(session.inFlight).toBe(0);
    });

    it("begin/end on unknown session id is a no-op (defensive)", () => {
      expect(() => pool.beginAction("nope")).not.toThrow();
      expect(() => pool.endAction("nope")).not.toThrow();
    });
  });

  describe("ensureSession (identity-keyed dedup)", () => {
    // Pin from 2026-05-12. Tier 3 fix for the "page reload allocates a
    // fresh Chromium context" leak class. Same motebit + extant
    // session = same session returned. Cap measures motebits per
    // machine, not tabs per machine. Doctrine: "Persistent sovereign
    // identity — a cryptographic entity across time and devices, not
    // a session token" (CLAUDE.md).

    it("first call allocates; same motebit second call returns the same session", async () => {
      const mid = "motebit-aaaaaaaa";
      const first = await pool.ensureSession({ motebitId: mid });
      const second = await pool.ensureSession({ motebitId: mid });
      expect(second.sessionId).toBe(first.sessionId);
      // Critical: only ONE Chromium context allocated, not two.
      expect(fake.state.contexts.size).toBe(1);
      expect(pool.size()).toBe(1);
      // Reuse path bumps lastUsedAt — the keepalive equivalent for
      // ensure-driven reuse, prevents the reaper from sweeping a
      // session a motebit just touched.
      now += 5000;
      const third = await pool.ensureSession({ motebitId: mid });
      expect(third.lastUsedAt).toBe(now);
    });

    it("different motebits get different sessions (no cross-identity bleed)", async () => {
      const a = await pool.ensureSession({ motebitId: "motebit-aaa" });
      const b = await pool.ensureSession({ motebitId: "motebit-bbb" });
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(pool.size()).toBe(2);
    });

    it("session attributes carry motebitId for closeSession's reverse-index cleanup", async () => {
      const session = await pool.ensureSession({ motebitId: "motebit-ccc" });
      expect(session.motebitId).toBe("motebit-ccc");
    });

    it("legacy openSession leaves motebitId null (admin/test path)", async () => {
      const session = await pool.openSession();
      expect(session.motebitId).toBeNull();
    });

    it("closeSession removes the reverse-index entry — next ensure allocates fresh", async () => {
      const mid = "motebit-ddd";
      const first = await pool.ensureSession({ motebitId: mid });
      await pool.closeSession(first.sessionId);
      const second = await pool.ensureSession({ motebitId: mid });
      // Different session id — fresh allocation, not a stale-id return.
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(pool.size()).toBe(1);
    });

    it("reapIdle cleans the reverse index too — next ensure allocates fresh", async () => {
      const mid = "motebit-eee";
      const first = await pool.ensureSession({ motebitId: mid });
      // Walk past the idle threshold so the reaper sweeps `first`.
      now += 90_000;
      await pool.reapIdle();
      expect(pool.getSession(first.sessionId)).toBeNull();
      const second = await pool.ensureSession({ motebitId: mid });
      expect(second.sessionId).not.toBe(first.sessionId);
    });

    it("concurrent-ensure race: two simultaneous calls for the same motebit return ONE session", async () => {
      // Inject a slow `newContext` to widen the race window. Without
      // the in-flight lock both calls miss the cache, both call
      // openSession, both allocate Chromium contexts, the second's
      // sessionByMotebit.set clobbers the first → orphan leaked.
      const slowFake = makeFakeBrowser();
      const slowPool = new BrowserPool(CONFIG, { now: () => now });
      const origNewContext = slowFake.browser.newContext as unknown as (
        ...args: unknown[]
      ) => unknown;
      slowFake.browser.newContext = vi.fn(async (...args: unknown[]) => {
        // Yield to let the second caller arrive at ensureSession before
        // this one finishes openSession.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return (origNewContext as (...a: unknown[]) => Promise<BrowserContext>)(...args);
      }) as unknown as typeof slowFake.browser.newContext;
      await slowPool.start(async () => slowFake.browser);

      const mid = "motebit-fff";
      const [a, b] = await Promise.all([
        slowPool.ensureSession({ motebitId: mid }),
        slowPool.ensureSession({ motebitId: mid }),
      ]);

      expect(a.sessionId).toBe(b.sessionId);
      // The load-bearing assertion: only ONE Chromium context was
      // allocated, not two. (newContext called once.)
      expect(slowFake.state.newContextCalls.length).toBe(1);
      expect(slowFake.state.contexts.size).toBe(1);
      expect(slowPool.size()).toBe(1);
      await slowPool.shutdown();
    });

    it("liveness fall-through: dead session (page closed) triggers fresh allocation", async () => {
      const mid = "motebit-ggg";
      const first = await pool.ensureSession({ motebitId: mid });
      // Mutate the page mock to report closed — simulates a page that
      // crashed or was force-closed since the session was cached.
      (first.page as unknown as { isClosed: () => boolean }).isClosed = () => true;
      const second = await pool.ensureSession({ motebitId: mid });
      // Second call must allocate fresh, not return the dead session.
      expect(second.sessionId).not.toBe(first.sessionId);
      // The dead session entry stays in the map (closeSession ownership);
      // we only own the reverse index. Two contexts in the map; the
      // dead one will be reaped on idle timeout.
      expect(pool.size()).toBe(2);
    });

    it("legacy bearer (openSession) and ensureSession can coexist on the same pool", async () => {
      // Legacy admin call.
      const legacy = await pool.openSession();
      // Identity-attributed call.
      const identity = await pool.ensureSession({ motebitId: "motebit-hhh" });
      expect(legacy.sessionId).not.toBe(identity.sessionId);
      expect(legacy.motebitId).toBeNull();
      expect(identity.motebitId).toBe("motebit-hhh");
      // closeSession on legacy doesn't disturb the identity index.
      await pool.closeSession(legacy.sessionId);
      const sameIdentity = await pool.ensureSession({ motebitId: "motebit-hhh" });
      expect(sameIdentity.sessionId).toBe(identity.sessionId);
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
