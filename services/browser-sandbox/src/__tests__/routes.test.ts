/**
 * HTTP-level tests for the browser-sandbox routes.
 *
 * Uses Hono's in-process `app.fetch` so the server doesn't need to
 * bind a real port. The `BrowserPool` is faked to skip real Chromium
 * — the route layer's job is auth + dispatch + error envelope, which
 * is what we exercise here. Real-Playwright tests live separately.
 *
 * Asserts:
 *   - GET /health is unauthenticated
 *   - protected routes return 401 + permission_denied envelope
 *     without bearer
 *   - happy paths return the wire shape `CloudBrowserDispatcher` reads
 *   - error paths return the structured `{ error: { reason } }` envelope
 *     with the right HTTP status
 */

import { describe, it, expect, beforeEach } from "vitest";

import { buildApp } from "../routes.js";
import type { BrowserSandboxConfig } from "../env.js";
import type { BrowserPool, BrowserSession } from "../chromium-pool.js";
import { ServiceError } from "../errors.js";

const TEST_TOKEN = "test-token-1234567890abcdef";

const TEST_CONFIG: BrowserSandboxConfig = {
  apiToken: TEST_TOKEN,
  port: 0,
  maxConcurrentSessions: 4,
  sessionIdleMs: 60_000,
  viewportWidth: 1280,
  viewportHeight: 800,
};

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

interface FakePoolState {
  sessions: Map<string, BrowserSession>;
  openSessionImpl: () => Promise<BrowserSession>;
}

function makeFakePool(): { pool: BrowserPool; state: FakePoolState } {
  const sessions = new Map<string, BrowserSession>();
  let counter = 0;
  const fakeOpen = async (): Promise<BrowserSession> => {
    const id = `fake-session-${++counter}`;
    const session = {
      sessionId: id,
      page: {
        viewportSize: () => ({ width: 1280, height: 800 }),
        screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        mouse: {
          click: async () => undefined,
          dblclick: async () => undefined,
          move: async () => undefined,
          down: async () => undefined,
          up: async () => undefined,
          wheel: async () => undefined,
        },
        keyboard: {
          type: async () => undefined,
          press: async () => undefined,
        },
      },
      context: {},
      openedAt: 1_000_000,
      lastUsedAt: 1_000_000,
      lastCursorX: 0,
      lastCursorY: 0,
      inFlight: 0,
    } as unknown as BrowserSession;
    sessions.set(id, session);
    return session;
  };

  const state: FakePoolState = { sessions, openSessionImpl: fakeOpen };

  const pool = {
    openSession: () => state.openSessionImpl(),
    getSession: (id: string) => sessions.get(id) ?? null,
    touchSession: () => undefined,
    closeSession: async (id: string) => {
      sessions.delete(id);
    },
    size: () => sessions.size,
    reapIdle: async () => undefined,
    shutdown: async () => undefined,
    start: async () => undefined,
    beginAction: (id: string) => {
      const s = sessions.get(id);
      if (s) (s as { inFlight: number }).inFlight += 1;
    },
    endAction: (id: string) => {
      const s = sessions.get(id);
      if (s && (s as { inFlight: number }).inFlight > 0) {
        (s as { inFlight: number }).inFlight -= 1;
      }
    },
  } as unknown as BrowserPool;

  return { pool, state };
}

describe("browser-sandbox routes", () => {
  let pool: BrowserPool;
  let state: FakePoolState;

  beforeEach(() => {
    ({ pool, state } = makeFakePool());
  });

  describe("GET /health", () => {
    it("returns ok without auth", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; service: string };
      expect(body).toMatchObject({ ok: true, service: "browser-sandbox" });
    });
  });

  describe("auth", () => {
    it("rejects /sessions/ensure without bearer (401 + permission_denied)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/ensure", { method: "POST" });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason).toBe("permission_denied");
    });

    it("rejects /sessions/:id/actions without bearer", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/abc/actions", { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("rejects with wrong bearer", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/ensure", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token-but-same-length-ish-length" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /sessions/ensure", () => {
    it("returns session_id + display", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        session_id: string;
        display: { width: number; height: number; scaling_factor: number };
      };
      expect(body.session_id).toBe("fake-session-1");
      expect(body.display).toEqual({ width: 1280, height: 800, scaling_factor: 1 });
    });

    it("maps pool errors to the right wire envelope", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      state.openSessionImpl = async () => {
        throw new ServiceError("policy_denied", "concurrent session cap reached (4)");
      };
      const res = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { reason: string; message: string } };
      expect(body.error.reason).toBe("policy_denied");
      expect(body.error.message).toContain("cap reached");
    });
  });

  describe("POST /sessions/:id/actions", () => {
    it("executes a screenshot action and returns wire shape", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      // Open session first
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };

      const res = await app.request(`/sessions/${session_id}/actions`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: { kind: "screenshot" } }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { kind: string; bytes_base64: string };
      expect(body.kind).toBe("screenshot");
      expect(typeof body.bytes_base64).toBe("string");
    });

    it("returns 404 + session_closed for unknown session id", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/nope/actions", {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: { kind: "screenshot" } }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason).toBe("session_closed");
    });

    it("returns 501 + not_supported for malformed action body", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };

      const res = await app.request(`/sessions/${session_id}/actions`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason).toBe("not_supported");
    });

    it("decrements inFlight on a happy-path action (begin/end discipline)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      expect(session.inFlight).toBe(0);

      const res = await app.request(`/sessions/${session_id}/actions`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: { kind: "screenshot" } }),
      });
      expect(res.status).toBe(200);
      // After the action returns, inFlight has returned to zero.
      expect(session.inFlight).toBe(0);
    });

    it("decrements inFlight when executeAction throws — finally discipline", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;

      // Force the executor to throw by replacing page.mouse.click. The
      // route's `finally` branch MUST decrement inFlight even though
      // the response goes through the platform_blocked error path.
      (session.page as unknown as { mouse: { click: () => Promise<void> } }).mouse.click =
        async () => {
          throw new Error("simulated chromium crash");
        };

      const res = await app.request(`/sessions/${session_id}/actions`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          action: { kind: "click", target: { x: 1, y: 1 } },
        }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason).toBe("platform_blocked");
      // The thrown executor MUST NOT leak an in-flight count — otherwise
      // the reaper would skip this session forever after a crash.
      expect(session.inFlight).toBe(0);
    });
  });

  describe("DELETE /sessions/:id", () => {
    it("returns 204 and removes the session", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };

      expect(state.sessions.has(session_id)).toBe(true);
      const res = await app.request(`/sessions/${session_id}`, {
        method: "DELETE",
        headers: authHeader(),
      });
      expect(res.status).toBe(204);
      expect(state.sessions.has(session_id)).toBe(false);
    });

    it("is idempotent for unknown session id", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/never-existed", {
        method: "DELETE",
        headers: authHeader(),
      });
      expect(res.status).toBe(204);
    });
  });

  describe("global error handler", () => {
    it("maps unstructured errors to platform_blocked", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      state.openSessionImpl = async () => {
        throw new Error("Chromium crashed unexpectedly");
      };
      const res = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { reason: string; message: string } };
      expect(body.error.reason).toBe("platform_blocked");
      expect(body.error.message).toContain("Chromium crashed");
    });
  });
});
